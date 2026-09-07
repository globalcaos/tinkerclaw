/**
 * FORK 2026-09-04 (measured incident: "the tab is in a loop — an
 * automated system message appears without any need and wakes up opus to say
 * there was nothing to do").
 *
 * ONE stuck tinker-bridge tool call (Bash toolu_018k5JCL5vfd…, started 10:25)
 * produced SIX full Opus turns across two boots. The chain:
 *
 *   1. `resumeMainSession` awaits the `agent` RPC with a 10 s timeout, but that
 *      RPC does not ack until the turn is under way. Under a busy event loop
 *      the ack misses 10 s, the call rejects — yet the prompt was ALREADY
 *      delivered (three forensic dumps, one per "failed" attempt, prove it).
 *   2. A false `failed` makes the scheduler retry (MAX_RECOVERY_RETRIES = 3),
 *      and each retry re-detects the same dangling call and re-sends the same
 *      prompt → 3 identical prompts per boot.
 *   3. `abortedLastRun` is only cleared on the success path, so the session
 *      stays `running` + aborted and the next boot repeats the whole thing.
 *
 * A resume prompt is an instruction to CONTINUE work, so a duplicate is an
 * instruction to redo it. These tests pin the three guards that stop it.
 *
 * Harness conventions match the stale-dangling / interrupted-tool siblings.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, loadSessionStore } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

vi.mock("./interrupted-run-ledger.js", () => ({
  appendInterruptedRun: vi.fn(async () => {}),
  resolveInterruptedRunLedgerPath: vi.fn(() => "/dev/null"),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-recovery-resume-loop-"));
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

/** TREE format, so readSessionMessages drops `custom` records — the blind spot. */
function toolStartEntry(params: {
  id?: string;
  parentId?: string | null;
  toolCallId: string;
  startedAt: number;
}): RawEntry {
  return {
    type: "custom",
    customType: "tinker-bridge-tool",
    id: params.id ?? "c1",
    parentId: params.parentId === undefined ? "m2" : params.parentId,
    timestamp: new Date(params.startedAt).toISOString(),
    data: {
      runId: "r-1",
      phase: "start",
      toolCallId: params.toolCallId,
      name: "Bash",
      args: { command: "ls" },
      startedAt: params.startedAt,
    },
  };
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

function runningAbortedEntry(startedAt: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "main-session",
    startedAt,
    updatedAt: startedAt,
    status: "running",
    abortedLastRun: true,
    ...extra,
  } as SessionEntry;
}

/** The exact shape `callGateway` rejects with when its own timer fires. */
function gatewayTimeout(): Error {
  return new Error("gateway timeout after 10000ms\nconnected to ws://127.0.0.1:18789");
}

function agentDispatches(): unknown[] {
  return vi
    .mocked(callGateway)
    .mock.calls.map(([opts]) => opts)
    .filter((opts) => (opts as { method?: string }).method === "agent");
}

/** Mock `chat.inject` as fine, `agent` as never acking within the timeout. */
function mockAgentAckTimeout(): void {
  vi.mocked(callGateway).mockImplementation(async (opts: unknown) => {
    if ((opts as { method?: string }).method === "agent") {
      throw gatewayTimeout();
    }
    return {} as never;
  });
}

async function seedStuckMidToolSession(toolCallId: string): Promise<string> {
  const sessionsDir = await makeSessionsDir();
  const T = Date.now() - 10_000;
  await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(T) });
  await writeTranscript(sessionsDir, "main-session", [
    ...interruptedTurnEntries(T),
    toolStartEntry({ toolCallId, startedAt: T + 1_200 }),
  ]);
  return sessionsDir;
}

describe("main-session restart recovery - the phantom resume loop", () => {
  // DEFECT 1. The prompt is delivered before the RPC acks, so a missed ack is
  // "dispatched", never "failed". Reporting `failed` is what arms the retry.
  it("counts a dispatch-ack timeout as recovered, not failed", async () => {
    const sessionsDir = await seedStuckMidToolSession("tc-stuck");
    mockAgentAckTimeout();

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(agentDispatches()).toHaveLength(1);
    // Cleared, so the next boot's recovery gate no longer matches this session.
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  // DEFECT 2. Even inside ONE scheduler pass, a session whose prompt already
  // went out must never be dispatched a second time.
  it("does not re-dispatch to a session already dispatched in this pass", async () => {
    await seedStuckMidToolSession("tc-stuck");
    mockAgentAckTimeout();
    const resumedSessionKeys = new Set<string>();

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir, resumedSessionKeys });
    const second = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      resumedSessionKeys,
    });

    expect(agentDispatches()).toHaveLength(1);
    expect(second.recovered).toBe(0);
  });

  // DEFECT 3. Across boots (fresh resumedSessionKeys, session flagged running
  // again) the SAME stuck tool call must not force a second resume. This is the
  // guard that would have stopped all six turns in the measured incident.
  it("never forces a second resume for the same dangling tool call", async () => {
    const sessionsDir = await seedStuckMidToolSession("tc-stuck");
    mockAgentAckTimeout();

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    expect(agentDispatches()).toHaveLength(1);

    // Next boot: markRunningMainSessionsAsInterrupted re-flags a still-running
    // session, and the stuck tool call is still unpaired in the transcript.
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"] as SessionEntry;
    await writeStore(sessionsDir, {
      "agent:main:main": { ...entry, status: "running", abortedLastRun: true } as SessionEntry,
    });

    const second = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(agentDispatches()).toHaveLength(1);
    expect(second.recovered).toBe(0);
  });

  // The guard is per tool call, not a blanket mute: a genuinely NEW mid-tool
  // interruption on the same session still resumes.
  it("still forces a resume for a different dangling tool call", async () => {
    const sessionsDir = await seedStuckMidToolSession("tc-first");
    mockAgentAckTimeout();

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    expect(agentDispatches()).toHaveLength(1);

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"] as SessionEntry;
    const T = Date.now() - 5_000;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...entry,
        status: "running",
        abortedLastRun: true,
        startedAt: T,
      } as SessionEntry,
    });
    await writeTranscript(sessionsDir, "main-session", [
      ...interruptedTurnEntries(T),
      toolStartEntry({ toolCallId: "tc-second", startedAt: T + 1_200 }),
    ]);

    const second = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(agentDispatches()).toHaveLength(2);
    expect(second.recovered).toBe(1);
  });

  // A hard dispatch error is NOT a timeout: nothing was delivered, so the
  // retry is legitimate and the session must stay flagged for it.
  it("still reports failed when the dispatch itself errors", async () => {
    const sessionsDir = await seedStuckMidToolSession("tc-stuck");
    vi.mocked(callGateway).mockImplementation(async (opts: unknown) => {
      if ((opts as { method?: string }).method === "agent") {
        throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
      }
      return {} as never;
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  // The prompt must not claim a restart when none happened — three turns in the
  // measured incident were spent theorizing about a gateway restart that the
  // PID proved never occurred.
  it("tells a mid-tool resume apart from a restart in the prompt text", async () => {
    await seedStuckMidToolSession("tc-stuck");

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    const [dispatch] = agentDispatches();
    const message = String((dispatch as { params?: { message?: unknown } }).params?.message ?? "");
    expect(message).not.toContain("The gateway restarted");
    expect(message).toContain("Bash");
    expect(message.toLowerCase()).toContain("already complete");
  });
});
