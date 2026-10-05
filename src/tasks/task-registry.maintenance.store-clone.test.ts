import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import {
  clearSessionStoreCacheForTest,
  hasSessionStoreEntry,
  loadSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

// FORK 2026-09-23 — the maintenance sweep asks "does this subagent/cli task still
// have a session?" for every stale task. It used to structuredClone the whole
// sessions.json per task (seen in a live CPU profile); membership needs no clone.

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

const GRACE_EXPIRED_MS = 10 * 60_000;

function makeStaleSubagentTask(childSessionKey: string): TaskRecord {
  const now = Date.now();
  return {
    taskId: `task-clone-${Math.random().toString(36).slice(2)}`,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey,
    task: "clone check",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - GRACE_EXPIRED_MS,
    startedAt: now - GRACE_EXPIRED_MS,
    lastEventAt: now - GRACE_EXPIRED_MS,
  };
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) {
      deepFreeze(child, seen);
    }
    Object.freeze(value);
  }
  return value;
}

function installRuntime(params: { tasks: TaskRecord[]; storePath: string }) {
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));
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
    // The REAL accessor, against a real store file.
    hasSessionStoreEntry,
    resolveStorePath: () => params.storePath,
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      const [kind, agentId, ...rest] = (sessionKey ?? "").split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => Array.from(currentTasks.values()),
    markTaskLostById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, status: "lost" as const, endedAt: patch.endedAt };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    markTaskTerminalById: () => null,
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: () => null,
    isCronRuntimeAuthoritative: () => true,
    resolveCronStorePath: () => path.join(path.dirname(params.storePath), "cron-jobs.json"),
    loadCronStoreSync: () => ({ version: 1, jobs: [] }),
    resolveCronRunLogPath: ({ jobId }) => jobId,
    readCronRunLogEntriesSync: () => [],
  };
  setTaskRegistryMaintenanceRuntimeForTests(runtime);
  return { currentTasks };
}

describe("task maintenance hasBackingSession", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-maint-store-clone-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopTaskRegistryMaintenanceForTests();
    resetTaskRegistryMaintenanceRuntimeForTests();
    clearSessionStoreCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks membership without cloning (or mutating) the cached store", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:still-here": { sessionId: "s-here", updatedAt: 3 },
      "agent:main:main": { sessionId: "s-main", updatedAt: 2 },
      "agent:main:other": { sessionId: "s-other", updatedAt: 1 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));
    // Warm the cache; the second clone:false read is the cache's own object.
    loadSessionStore(storePath, { clone: false });
    const cached = deepFreeze(loadSessionStore(storePath, { clone: false }));
    const storeKeys = Object.keys(store);

    // Mixed case on purpose: the lookup has always matched keys case-insensitively.
    const kept = makeStaleSubagentTask("agent:main:subagent:Still-Here");
    const orphaned = makeStaleSubagentTask("agent:main:subagent:gone");
    const { currentTasks } = installRuntime({ tasks: [kept, orphaned], storePath });

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });

    expect(currentTasks.get(kept.taskId)?.status).toBe("running");
    expect(currentTasks.get(orphaned.taskId)?.status).toBe("lost");
    const wholeStoreClones = cloneSpy.mock.calls.filter(
      ([arg]) =>
        arg === cached ||
        (!!arg && typeof arg === "object" && storeKeys.every((key) => Object.hasOwn(arg, key))),
    );
    expect(wholeStoreClones).toHaveLength(0);
    expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
  });
});
