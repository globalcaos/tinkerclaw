/**
 * FORK 2026-07-31 (adversarial review) — recency gate on dangling tinker-bridge
 * tool starts in restart recovery.
 *
 * Lives in its OWN file: main-session-restart-recovery.test.ts has uncommitted
 * peer work; main-session-restart-recovery.interrupted-tool.test.ts is committed
 * and must stay green. Harness conventions match the interrupted-tool sibling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { appendInterruptedRun } from "./interrupted-run-ledger.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

// Same choice as interrupted-tool.test.ts: mock the ledger and assert call shape.
vi.mock("./interrupted-run-ledger.js", () => ({
  appendInterruptedRun: vi.fn(async () => {}),
  resolveInterruptedRunLedgerPath: vi.fn(() => "/dev/null"),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-recovery-stale-dangling-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStore(sessionsDir: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(store, null, 2));
}

type RawEntry = Record<string, unknown>;

/**
 * TREE format (header + id/parentId entries) so readSessionMessages takes the
 * tree branch and DROPS custom records — same load-bearing setup as the
 * interrupted-tool sibling.
 */
function sessionHeader(sessionId: string): RawEntry {
  return {
    type: "session",
    version: "3",
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: tmpDir,
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: unknown,
  timestampMs: number,
): RawEntry {
  return { type: "message", id, parentId, timestamp: new Date(timestampMs).toISOString(), message };
}

function toolCustomEntry(
  id: string,
  parentId: string | null,
  data: Record<string, unknown>,
  timestampMs: number,
): RawEntry {
  return {
    type: "custom",
    customType: "tinker-bridge-tool",
    id,
    parentId,
    timestamp: new Date(timestampMs).toISOString(),
    data,
  };
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  entries: RawEntry[],
): Promise<void> {
  const lines = [sessionHeader(sessionId), ...entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${lines}\n`);
}

/**
 * `parentId` exists so a fixture that OPENS with a stale tool record can chain
 * off it instead of forming a second root. A two-root transcript is not
 * well-formed; if pi-coding-agent's SessionManager ever rejects one, `open()`
 * throws, `readSessionMessages` silently falls back to its FLAT branch, and that
 * branch renders tinker-bridge tool records as synthetic `tool_use` messages —
 * which would hide the very blind spot these tests exist to pin and make them
 * pass for the wrong reason. Measured today: chain and forest both yield the
 * same 2 messages with a text-only assistant tail; the chain just cannot
 * regress that way.
 */
function idleCompletedTurnEntries(startedAt: number, parentId: string | null = null): RawEntry[] {
  return [
    messageEntry(
      "m1",
      parentId,
      { role: "user", content: "say hi", timestamp: startedAt + 100 },
      startedAt + 100,
    ),
    messageEntry(
      "m2",
      "m1",
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi — nothing in flight." }],
        timestamp: startedAt + 1_000,
      },
      startedAt + 1_000,
    ),
  ];
}

function interruptedTurnEntries(startedAt: number): RawEntry[] {
  return [
    messageEntry(
      "m1",
      null,
      { role: "user", content: "run the tool", timestamp: startedAt },
      startedAt,
    ),
    messageEntry(
      "m2",
      "m1",
      {
        role: "assistant",
        content: [{ type: "text", text: "On it - running the command now." }],
        timestamp: startedAt + 1_000,
      },
      startedAt + 1_000,
    ),
  ];
}

function toolStartEntry(params: {
  id?: string;
  parentId?: string | null;
  toolCallId: string;
  startedAt: number;
  runId?: string;
  name?: string;
  omitStartedAt?: boolean;
}): RawEntry {
  const data: Record<string, unknown> = {
    runId: params.runId ?? "r-1",
    phase: "start",
    toolCallId: params.toolCallId,
    name: params.name ?? "Bash",
    args: { command: "ls" },
  };
  if (!params.omitStartedAt) {
    data.startedAt = params.startedAt;
  }
  return toolCustomEntry(
    params.id ?? "c1",
    params.parentId === undefined ? "m2" : params.parentId,
    data,
    params.startedAt,
  );
}

function runningAbortedEntry(
  startedAt: number | undefined,
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  const base: Record<string, unknown> = {
    sessionId: "main-session",
    updatedAt: typeof startedAt === "number" ? startedAt : Date.now(),
    status: "running",
    abortedLastRun: true,
    ...extra,
  };
  if (typeof startedAt === "number") {
    base.startedAt = startedAt;
  }
  return base as SessionEntry;
}

describe("main-session restart recovery - stale dangling tool starts", () => {
  // THE REGRESSION THIS FIXES. Without the recency gate, an old unpaired start
  // forces resume forever and settleIdleSession becomes unreachable.
  // Before the fix this returns recovered:1 (phantom resume). After: skipped+settled.
  it("settles idle when the only dangling start is older than the interrupted run", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
    await writeTranscript(sessionsDir, "main-session", [
      // OLD unpaired start from a previous run — permanent evidence, not this run.
      toolStartEntry({
        id: "c-old",
        parentId: null,
        toolCallId: "tc-stale",
        startedAt: T - 3_600_000,
        runId: "r-old",
        name: "Bash",
      }),
      // Current run completed with text-only assistant tail (idle). Chained off
      // the stale record so the transcript keeps a SINGLE root.
      ...idleCompletedTurnEntries(T, "c-old"),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // Genuine M17: dangling start belongs to THIS run → still force resume.
  it("still resumes when dangling.startedAt >= entry.startedAt (current-run mid-tool)", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(T),
      toolStartEntry({
        toolCallId: "tc-1",
        startedAt: T + 1_200,
      }),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).not.toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // Boundary: equal timestamps still count as current-run (>= is inclusive).
  it("resumes when dangling.startedAt === entry.startedAt exactly", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(T),
      toolStartEntry({
        toolCallId: "tc-boundary",
        startedAt: T,
      }),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).not.toBe("done");
  });

  // Conservative policy: missing data.startedAt → drop dangling, settle idle.
  it("treats a start record missing data.startedAt as stale and settles idle", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
    await writeTranscript(sessionsDir, "main-session", [
      ...idleCompletedTurnEntries(T),
      toolStartEntry({
        id: "c-no-ts",
        parentId: "m2",
        toolCallId: "tc-no-ts",
        startedAt: T + 1_200,
        omitStartedAt: true,
      }),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // Conservative policy: missing entry.startedAt → drop dangling, settle idle.
  it("treats a store entry missing startedAt as stale and settles idle", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(undefined) });
    await writeTranscript(sessionsDir, "main-session", [
      ...idleCompletedTurnEntries(T),
      toolStartEntry({
        toolCallId: "tc-1",
        startedAt: T + 1_200,
      }),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // Ledger must not be polluted with discarded stale records.
  it("does not ledger a discarded stale dangling start", async () => {
    const sessionsDir = await makeSessionsDir();
    const T = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
    await writeTranscript(sessionsDir, "main-session", [
      toolStartEntry({
        id: "c-old",
        parentId: null,
        toolCallId: "tc-stale",
        startedAt: T - 3_600_000,
        runId: "r-old",
      }),
      ...idleCompletedTurnEntries(T, "c-old"),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(appendInterruptedRun).not.toHaveBeenCalled();
  });
});
