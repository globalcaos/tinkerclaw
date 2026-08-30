/**
 * FORK 2026-07-31 — regression cover for the tinker-bridge "interrupted
 * mid-tool" blind spot in restart recovery.
 *
 * Lives in its OWN file (not main-session-restart-recovery.test.ts) because that
 * file has uncommitted work from a parallel session.
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

// CHOICE (of the two options in the spec): mock the ledger and assert the
// RECORDS, not the file. The recovery entry point takes an explicit `stateDir`,
// but the ledger resolves its own path from the environment — in-test the two
// disagree, so a file-readback assertion would either read the real state dir or
// silently find nothing. Asserting the call shape is the part this unit owns;
// the on-disk jsonl format is the ledger module's own test's job.
vi.mock("./interrupted-run-ledger.js", () => ({
  appendInterruptedRun: vi.fn(async () => {}),
  resolveInterruptedRunLedgerPath: vi.fn(() => "/dev/null"),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-recovery-interrupted-tool-"));
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
 * The transcript writer emits the pi-coding-agent TREE format (a
 * `{type:"session"}` header plus `{type,id,parentId,...}` entries) rather than
 * the flat `{message:{...}}` shape used by the sibling test file. That is
 * load-bearing, not cosmetic: `readSessionMessages` only takes its tree branch
 * when the file carries id/parentId entries, and ONLY the tree branch DROPS
 * `custom` records. Its flat fallback renders tinker-bridge tool entries into
 * synthetic `tool_use` messages — which would hide the very blind spot under
 * test and make these cases pass for the wrong reason.
 *
 * The header mirrors a real on-disk transcript (`version` is the STRING "3").
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
 * The exact tail SIGTERM leaves behind: the user prompt, then the assistant's
 * already-streamed TEXT (persisted), and nothing else in `messages` — the tool
 * block only ever existed as a `custom` record.
 */
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

function toolStartEntry(startedAt: number): RawEntry {
  return toolCustomEntry(
    "c1",
    "m2",
    {
      runId: "r-1",
      phase: "start",
      toolCallId: "tc-1",
      name: "Bash",
      args: { command: "ls" },
      startedAt: startedAt + 1_200,
    },
    startedAt + 1_200,
  );
}

function toolResultEntry(startedAt: number): RawEntry {
  return toolCustomEntry(
    "c2",
    "c1",
    {
      runId: "r-1",
      phase: "result",
      toolCallId: "tc-1",
      result: "file-a\nfile-b",
      isError: false,
      endedAt: startedAt + 1_800,
    },
    startedAt + 1_800,
  );
}

function runningAbortedEntry(startedAt: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "main-session",
    updatedAt: startedAt,
    startedAt,
    status: "running",
    abortedLastRun: true,
    ...extra,
  } as SessionEntry;
}

describe("main-session restart recovery - interrupted mid-tool (tinker-bridge)", () => {
  // THE REGRESSION. Before the 2026-07-31 probe this returned
  // {recovered:0, failed:0, skipped:1} and settled the entry to status:'done':
  // the dangling tool call is invisible to `messages`, so the text-only
  // assistant tail looked idle and the turn was silently abandoned.
  it("resumes a session SIGTERMed mid-tool (dangling tinker-bridge tool record)", async () => {
    const sessionsDir = await makeSessionsDir();
    const startedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(startedAt) });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(startedAt),
      toolStartEntry(startedAt),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const agentCall = vi.mocked(callGateway).mock.calls.find((c) => c[0].method === "agent");
    expect(agentCall?.[0].params).toMatchObject({
      sessionKey: "agent:main:main",
      deliver: false,
      lane: "main",
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    // The entry must NOT have been settled as idle.
    expect(store["agent:main:main"]?.status).not.toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // NO REGRESSION on the idle path: the tool completed, so the text-only tail
  // really is a finished turn and must still be skipped + settled.
  it("still settles an idle session when the tool call has a matching result record", async () => {
    const sessionsDir = await makeSessionsDir();
    const startedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(startedAt) });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(startedAt),
      toolStartEntry(startedAt),
      toolResultEntry(startedAt),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(appendInterruptedRun).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // A session with no custom records at all must behave exactly as it did before
  // the probe existed.
  it("leaves a transcript without any custom records on the pre-existing idle path", async () => {
    const sessionsDir = await makeSessionsDir();
    const startedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(startedAt) });
    await writeTranscript(sessionsDir, "main-session", interruptedTurnEntries(startedAt));

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(appendInterruptedRun).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("ledgers a detected record and then a resumed record for the dangling call", async () => {
    const sessionsDir = await makeSessionsDir();
    const startedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, {
      "agent:main:main": runningAbortedEntry(startedAt, {
        providerOverride: "xai",
        modelOverride: "grok-4.5",
      }),
    });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(startedAt),
      toolStartEntry(startedAt),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const records = vi.mocked(appendInterruptedRun).mock.calls.map((call) => call[0]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      action: "detected",
      detector: "dangling-tinker-bridge-tool",
      sessionKey: "agent:main:main",
      sessionId: "main-session",
      runId: "r-1",
      toolCallId: "tc-1",
      toolName: "Bash",
      toolStartedAt: startedAt + 1_200,
      provider: "xai",
      model: "grok-4.5",
    });
    expect(typeof records[0]?.ts).toBe("number");
    expect(records[1]).toMatchObject({
      action: "resumed",
      detector: "dangling-tinker-bridge-tool",
      sessionKey: "agent:main:main",
      toolCallId: "tc-1",
    });
  });
});
