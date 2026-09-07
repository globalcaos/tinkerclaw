/**
 * Test target: src/tasks/task-registry.maintenance.ts (getRestartBlockingTaskSummary)
 * Reason in-scope: fork-touched task-registry maintenance (sibling:
 *               task-registry.maintenance.issue-60299.test.ts).
 * Catches:      tasks stuck in status "running" whose worker died but whose
 *               session-store entry persists on disk — hasBackingSession()
 *               stays true so they are never marked lost, and they used to
 *               veto gateway restarts forever (observed live: "10 task run(s)
 *               active" deferring a restart for 3.5 hours). Stale actives must
 *               be ignored by the restart gate while status displays keep
 *               showing them as running.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import {
  getRestartBlockingTaskSummary,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

const MINUTE_MS = 60_000;
// Fixed reference clock so the blocking/stale split is deterministic.
const NOW = 1_750_000_000_000;
const CHILD_SESSION_KEY = "agent:main:subagent:restart-blocking-test";

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
});

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: CHILD_SESSION_KEY,
    task: "test task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: NOW - 30 * MINUTE_MS,
    startedAt: NOW - 30 * MINUTE_MS,
    lastEventAt: NOW,
    ...overrides,
  };
}

function installRuntime(tasks: TaskRecord[]) {
  // Every task's childSessionKey resolves to a live session-store entry. This
  // reproduces the observed failure shape (worker dead, session entry persists
  // on disk): hasBackingSession() stays true, so the reconcile pass inside
  // getRestartBlockingTaskSummary never marks these tasks lost and the
  // blocking/stale split is decided purely by the freshness chain vs opts.now.
  const sessionStore: Record<string, SessionEntry> = {
    [CHILD_SESSION_KEY]: { sessionId: CHILD_SESSION_KEY, updatedAt: Date.now() },
  };
  const currentTasks = new Map(tasks.map((task) => [task.taskId, { ...task }]));

  const runtime: TaskRegistryMaintenanceRuntime = {
    readAcpSessionEntry: () =>
      ({
        cfg: {} as never,
        storePath: "",
        sessionKey: "",
        storeSessionKey: "",
        entry: undefined,
        storeReadFailed: false,
      }) satisfies AcpSessionStoreEntry,
    loadSessionStore: () => sessionStore,
    resolveStorePath: () => "",
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      if (!sessionKey) {
        return null;
      }
      const [kind, agentId, ...rest] = sessionKey.split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => Array.from(currentTasks.values()),
    markTaskLostById: () => null,
    markTaskTerminalById: () => null,
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: () => null,
    isCronRuntimeAuthoritative: () => true,
    resolveCronStorePath: () => "/tmp/openclaw-test-cron/jobs.json",
    loadCronStoreSync: () => ({ version: 1, jobs: [] }),
    resolveCronRunLogPath: ({ jobId }) => jobId,
    readCronRunLogEntriesSync: () => [],
  };

  setTaskRegistryMaintenanceRuntimeForTests(runtime);
}

describe("getRestartBlockingTaskSummary", () => {
  it("counts a fresh running task as blocking", () => {
    installRuntime([makeTask({ lastEventAt: NOW })]);
    expect(getRestartBlockingTaskSummary({ now: NOW })).toEqual({ blocking: 1, staleIgnored: 0 });
  });

  it("ignores a session-backed running task silent past the stale threshold", () => {
    installRuntime([makeTask({ lastEventAt: NOW - 11 * MINUTE_MS })]);
    expect(getRestartBlockingTaskSummary({ now: NOW })).toEqual({ blocking: 0, staleIgnored: 1 });
    // Status displays are untouched: the reconciled view still shows running.
    expect(reconcileInspectableTasks()).toEqual([expect.objectContaining({ status: "running" })]);
  });

  it("does not count terminal tasks at all", () => {
    installRuntime([
      makeTask({ status: "succeeded", endedAt: NOW - MINUTE_MS, lastEventAt: NOW - MINUTE_MS }),
    ]);
    expect(getRestartBlockingTaskSummary({ now: NOW })).toEqual({ blocking: 0, staleIgnored: 0 });
  });

  it("counts a fresh queued task as blocking", () => {
    installRuntime([
      makeTask({ status: "queued", startedAt: undefined, lastEventAt: undefined, createdAt: NOW }),
    ]);
    expect(getRestartBlockingTaskSummary({ now: NOW })).toEqual({ blocking: 1, staleIgnored: 0 });
  });

  it("respects an opts.staleAfterMs override", () => {
    installRuntime([makeTask({ lastEventAt: NOW - 2 * MINUTE_MS })]);
    expect(getRestartBlockingTaskSummary({ now: NOW })).toEqual({ blocking: 1, staleIgnored: 0 });
    expect(getRestartBlockingTaskSummary({ now: NOW, staleAfterMs: MINUTE_MS })).toEqual({
      blocking: 0,
      staleIgnored: 1,
    });
  });
});
