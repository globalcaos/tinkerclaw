/**
 * logging.md §4.6 turn rows (§9 step 8) — turn-events.ts and the producer sites that call it.
 *
 * CONTROL: before this change none of these sites wrote a row, so every row asserted below is new
 * behaviour. The writer is the real one (emit.ts: catalog lookup, key and value checks, session
 * hashing); only its worker is replaced by a recorder, so each assertion reads exactly what the
 * worker would INSERT.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecProcessOutcome } from "../../agents/bash-tools.exec-runtime.js";
import { markSpan, turnSpanSync } from "../../agents/embedded-agent-runner/run/turn-span.js";
import { wrapToolWithBeforeToolCallHook } from "../../agents/pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { createGatewayBroadcaster } from "../../gateway/server-broadcast.js";
import type { GatewayWsClient } from "../../gateway/server/ws-types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { logHookHandlerSpan } from "../../plugins/turn-phase-emit.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../agent-events.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../diagnostic-events.js";
import { EVENT_CATALOG } from "./catalog.js";
import {
  type EventWireRow,
  flushEventWriter,
  getEventWriterStats,
  resetEventWriterForTest,
  startEventWriter,
  type WriterWorkerRequest,
  type WriterWorkerResponse,
} from "./emit.js";
import {
  recordChatDeliver,
  recordExecDone,
  recordHookSpan,
  recordRunDone,
  recordToolDone,
  recordTurnSpan,
  TURN_EVENT_NAMES,
} from "./turn-events.js";

vi.mock("../../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

type WsSocket = GatewayWsClient["socket"];

const RUN = "run-fixture-1";
const SESSION = "agent:main:tinker:fixture";

interface RecordingWorker extends EventEmitter {
  postMessage(request: WriterWorkerRequest): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

let tmpDir: string;
let inserted: EventWireRow[];

/** The writer's worker, replaced by one that records each INSERT batch and acknowledges it. */
function spawnRecordingWorker(): Worker {
  const fake = new EventEmitter() as RecordingWorker;
  fake.ref = () => {};
  fake.unref = () => {};
  fake.terminate = () => Promise.resolve(0);
  fake.postMessage = (request: WriterWorkerRequest) => {
    if (request.type !== "insert") {
      return;
    }
    inserted.push(...request.rows);
    const response: WriterWorkerResponse = {
      id: request.id,
      ok: true,
      type: "insert",
      inserted: request.rows.length,
    };
    setImmediate(() => fake.emit("message", response));
  };
  return fake as unknown as Worker;
}

async function drain(): Promise<EventWireRow[]> {
  await flushEventWriter();
  return inserted;
}

function parsedFields(row: EventWireRow): Record<string, unknown> | null {
  return row.fields === null ? null : (JSON.parse(row.fields) as Record<string, unknown>);
}

function rowNamed(rows: EventWireRow[], name: string): EventWireRow {
  const row = rows.find((candidate) => candidate.name === name);
  if (!row) {
    throw new Error(`no ${name} row`);
  }
  return row;
}

/** A row fills exactly the slots its catalog row gives a meaning, and no undeclared field key. */
function expectDeclaredShape(row: EventWireRow): void {
  const entry = EVENT_CATALOG.find((event) => event.name === row.name);
  if (!entry) {
    throw new Error(`${row.name} is not declared in catalog.ts`);
  }
  expect(row.kind, row.name).toBe(entry.kind);
  const filled = (value: unknown): boolean => value !== null;
  expect(
    {
      label: filled(row.label),
      dur_ms: filled(row.dur_ms),
      n1: filled(row.n1),
      n2: filled(row.n2),
      n3: filled(row.n3),
      n4: filled(row.n4),
    },
    row.name,
  ).toEqual({
    label: filled(entry.label),
    dur_ms: filled(entry.durMs),
    n1: filled(entry.n1),
    n2: filled(entry.n2),
    n3: filled(entry.n3),
    n4: filled(entry.n4),
  });
  const undeclared = Object.keys(parsedFields(row) ?? {}).filter((key) => !(key in entry.fields));
  expect(undeclared, row.name).toEqual([]);
}

beforeEach(async () => {
  await resetEventWriterForTest();
  tmpDir = mkdtempSync(join(tmpdir(), "turn-events-"));
  inserted = [];
  startEventWriter({
    env: { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") },
    spawn: () => spawnRecordingWorker(),
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
  });
  registerAgentRunContext(RUN, { sessionKey: SESSION });
});

afterEach(async () => {
  await resetEventWriterForTest();
  resetAgentRunContextForTest();
  mockGetGlobalHookRunner.mockReset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("turn rows (logging.md §4.6, §9 step 8)", () => {
  it("owns the six §4.6 rows, each declared in catalog.ts", () => {
    const declared = new Set(EVENT_CATALOG.map((event) => event.name));
    expect(TURN_EVENT_NAMES.filter((name) => !declared.has(name))).toEqual([]);
    expect(new Set(TURN_EVENT_NAMES).size).toBe(6);
  });

  it("a fixture turn writes every row in its declared shape, and the writer drops nothing", async () => {
    const keys = { runId: RUN, sessionKey: SESSION };
    recordTurnSpan(RUN, "tools-build", 42, 3);
    recordTurnSpan(RUN, "skills-load", 0, 0);
    recordHookSpan("before_prompt_build", "fixture-plugin", 17, keys);
    recordRunDone(
      {
        ...keys,
        provider: "anthropic",
        model: "claude-opus-4-8",
        trigger: "user",
        channel: "webchat",
      },
      Date.now() - 900,
      "error",
      new TypeError("fixture failure"),
    );
    recordToolDone(keys, "fixture_tool", "ok", 120);
    recordExecDone(
      {
        status: "failed",
        exitCode: 124,
        durationMs: 30_000,
        timedOut: true,
        failureKind: "overall-timeout",
      },
      23,
      "host",
      "child",
      SESSION,
    );
    recordChatDeliver(
      SESSION,
      { attempted: 2, sent: 1, scopeSkipped: 1, droppedSlow: 0, sendThrew: 0 },
      311,
    );

    const rows = await drain();
    expect(rows.map((row) => [row.name, row.label])).toEqual([
      ["turn.span", "before:tools-build"],
      ["turn.span", "tools-build"],
      ["turn.span", "skills-load"],
      ["hook.span", "before_prompt_build:fixture-plugin"],
      ["run.done", "error"],
      ["tool.done", "fixture_tool"],
      ["exec.done", "overall-timeout"],
      ["chat.deliver", null],
    ]);
    for (const row of rows) {
      expectDeclaredShape(row);
    }
    expect(rows.slice(0, 3).map((row) => row.dur_ms)).toEqual([3, 42, 0]);
    expect(rowNamed(rows, "run.done").dur_ms).toBeGreaterThanOrEqual(900);
    expect(parsedFields(rowNamed(rows, "run.done"))).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      trigger: "user",
      channel: "webchat",
      error_category: "TypeError",
    });
    expect(parsedFields(rowNamed(rows, "tool.done"))).toEqual({ outcome: "ok" });
    expect(rowNamed(rows, "exec.done")).toMatchObject({ dur_ms: 30_000, n1: 124, n2: 23 });
    expect(parsedFields(rowNamed(rows, "exec.done"))).toEqual({
      target: "host",
      mode: "child",
      timed_out: true,
    });
    expect(rowNamed(rows, "chat.deliver")).toMatchObject({ n1: 2, n2: 1, n3: 0, n4: 0 });
    expect(parsedFields(rowNamed(rows, "chat.deliver"))).toEqual({
      scope_skipped: 1,
      text_len: 311,
    });
    // L8: run_id is THE agent run id or nothing — exec.done and chat.deliver hold other id spaces.
    const expectedRunId = (name: string) =>
      name === "exec.done" || name === "chat.deliver" ? null : RUN;
    for (const row of rows) {
      expect(row.run_id, row.name).toBe(expectedRunId(row.name));
    }
    // L4: the session key is hashed and classified, never stored.
    for (const row of rows) {
      expect(row.session_kind, row.name).toBe("tinker");
      expect(row.session_hash, row.name).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(JSON.stringify(rows)).not.toContain(SESSION);
    const stats = getEventWriterStats();
    expect({
      dropped: stats.dropped,
      undeclaredKeys: stats.undeclaredKeys,
      invalidValues: stats.invalidValues,
    }).toEqual({ dropped: 0, undeclaredKeys: 0, invalidValues: 0 });
  });

  it("tool.done and exec.done carry no argument text — no command, params, output, message, reason or path", async () => {
    const secretArgs = { command: "cat /home/fixture/.ssh/id_rsa", token: "sk-fixture-0000" };
    const hookCtx = { sessionKey: SESSION, runId: RUN, loopDetection: { enabled: false } };
    const wrap = (execute: ReturnType<typeof vi.fn>) =>
      wrapToolWithBeforeToolCallHook(
        { name: "fixture_tool", execute } as unknown as AnyAgentTool,
        hookCtx,
      );

    const okResult = { content: [{ type: "text", text: "TOP-SECRET-OUTPUT" }] };
    const succeeding = wrap(vi.fn().mockResolvedValue(okResult));
    await succeeding.execute("call-ok", secretArgs, undefined, undefined);
    const enoent = new TypeError("ENOENT: /home/fixture/.ssh/id_rsa");
    const failing = wrap(vi.fn().mockRejectedValue(enoent));
    const failed = failing.execute("call-error", secretArgs, undefined, undefined);
    await expect(failed).rejects.toThrow(TypeError);
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runBeforeToolCall: async () => ({
        block: true,
        blockReason: "fixture veto of /home/fixture/.ssh/id_rsa",
      }),
    } as unknown as ReturnType<typeof getGlobalHookRunner>);
    const vetoed = vi.fn();
    await wrap(vetoed).execute("call-veto", secretArgs, undefined, undefined);
    expect(vetoed).not.toHaveBeenCalled();

    const outcome: ExecProcessOutcome = {
      status: "failed",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: 5,
      aggregated: "TOP-SECRET-OUTPUT",
      timedOut: true,
      failureKind: "overall-timeout",
      reason: "TOP-SECRET-OUTPUT\n\nCommand timed out in /home/fixture",
    };
    recordExecDone(outcome, secretArgs.command.length, "sandbox", "pty", SESSION);

    const rows = await drain();
    expect(rows.map((row) => [row.name, row.label, parsedFields(row)])).toEqual([
      ["tool.done", "fixture_tool", { outcome: "ok" }],
      ["tool.done", "fixture_tool", { outcome: "error", error_category: "TypeError" }],
      [
        "tool.done",
        "fixture_tool",
        { outcome: "blocked", error_category: "veto:plugin-before-tool-call" },
      ],
      ["exec.done", "overall-timeout", { target: "sandbox", mode: "pty", timed_out: true }],
    ]);
    // A blocked call never ran; its duration is the decision it waited on, never missing.
    expect(typeof rows[2]?.dur_ms).toBe("number");
    expect(rows[3]).toMatchObject({ n1: null, n2: secretArgs.command.length, run_id: null });
    const stored = JSON.stringify(rows);
    for (const fragment of ["id_rsa", "/home/", "sk-fixture", "TOP-SECRET", "ENOENT", "veto of"]) {
      expect(stored).not.toContain(fragment);
    }
  }, 30_000);

  it("turn-span.ts and turn-phase-emit.ts write one row per journal line; a hook off the narration allow-list writes none", async () => {
    // A run id no other span has touched: turn-span.ts keeps each run's last span end in module
    // state with no reset, so a reused id would add a `before:<stage>` gap row to turnSpanSync.
    const run = `run-${randomUUID()}`;
    registerAgentRunContext(run, { sessionKey: SESSION });
    markSpan(run, "fixture-mark", 7);
    turnSpanSync(run, "fixture-sync", () => undefined);
    logHookHandlerSpan("before_prompt_build", "fixture-plugin", 9, {
      runId: run,
      sessionKey: SESSION,
    });
    logHookHandlerSpan("agent_end", "fixture-plugin", 9, { runId: run, sessionKey: SESSION });

    const rows = await drain();
    expect(rows.map((row) => [row.name, row.label, row.run_id])).toEqual([
      ["turn.span", "fixture-mark", run],
      ["turn.span", "fixture-sync", run],
      ["hook.span", "before_prompt_build:fixture-plugin", run],
    ]);
    expect(rows[0]?.dur_ms).toBe(7);
    expect(rows[2]?.dur_ms).toBe(9);
    expect(rows.every((row) => row.session_kind === "tinker")).toBe(true);
  });

  it("chat.deliver: exactly one row per broadcast final, beside its [chat-deliver] line; deltas and other events write none", async () => {
    const client = (connId: string, scope: string): GatewayWsClient => ({
      socket: { bufferedAmount: 0, send: vi.fn(), close: vi.fn() } as unknown as WsSocket,
      connect: { role: "operator", scopes: [scope] } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    });
    const text = "the answer itself, never stored";
    const final = {
      state: "final",
      sessionKey: SESSION,
      runId: RUN,
      message: { content: [{ type: "text", text }] },
    };
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const clients = new Set([
        client("c-read", "operator.read"),
        client("c-pairing", "operator.pairing"),
      ]);
      const { broadcast } = createGatewayBroadcaster({ clients });
      broadcast("chat", { ...final, state: "delta" });
      broadcast("chat", final);
      broadcast("agent", { runId: RUN, sessionKey: SESSION, stream: "assistant", data: {} });
      createGatewayBroadcaster({ clients: new Set() }).broadcast("chat", final);
      const lines = consoleLog.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[chat-deliver] "));
      expect(lines).toHaveLength(2);
    } finally {
      consoleLog.mockRestore();
    }

    const rows = (await drain()).filter((row) => row.name === "chat.deliver");
    expect(rows.map((row) => [row.n1, row.n2, row.n3, row.n4, parsedFields(row)])).toEqual([
      [2, 1, 0, 0, { scope_skipped: 1, text_len: text.length }],
      [0, 0, 0, 0, { scope_skipped: 0, text_len: text.length }],
    ]);
    expect(rows.every((row) => row.run_id === null && row.session_kind === "tinker")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("never stored");
  });
});

describe("CONTROL — why the producers call turn-events.ts directly instead of a bus bridge", () => {
  it("onDiagnosticEvent, the listener §7.5 specifies the bridge on, never delivers a trusted run.completed", () => {
    resetDiagnosticEventsForTest();
    const seen: string[] = [];
    const off = onDiagnosticEvent((event) => {
      seen.push(event.type);
    });
    try {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId: RUN,
        durationMs: 1,
        outcome: "completed",
      });
      emitDiagnosticEvent({
        type: "run.completed",
        runId: RUN,
        durationMs: 1,
        outcome: "completed",
      });
    } finally {
      off();
    }
    // Only the UNTRUSTED twin arrives: the listener works, and the trusted emit attempt.ts really
    // makes is invisible to it — a bridge on it would write zero run.done rows.
    expect(seen).toEqual(["run.completed"]);
  });
});
