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
 * FORK 2026-09-08 — a FOURTH guard, the boot-storm window. The three above
 * still let ONE interruption produce TWO different answers: boot #1 resumed
 * the turn, a systemd restart storm ("Scheduled restart" every 10 s) killed
 * that resumed run, and boot #2 found it `running` with a resumable tail — the
 * resume's own [System] row — and resumed it again (journal: 10:16:41 AND
 * 10:19:25 on 09-01; the ClawHub tab 41 s apart on 09-07). No toolCallId is
 * involved on that path, so guard 3 never sees it. `lastResumeAt` is written
 * where the dispatch happens and both boot sweeps hold back inside
 * RESUME_COOLDOWN_MS.
 *
 * Harness conventions match the stale-dangling / interrupted-tool siblings.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, loadSessionStore } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import {
  RESUME_COOLDOWN_MS,
  buildResumeMessage,
  hostBootedAtMs,
  markRunningMainSessionsAsInterrupted,
  rebootedAtMs,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";

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
  // A host up for a month: every interruption seeded below happened after this boot, so the
  // plain "gateway restarted" path holds on any machine, however recently it booted.
  vi.spyOn(os, "uptime").mockReturnValue(30 * 24 * 3600);
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

/**
 * Both RPCs ack normally. Explicit because `vi.clearAllMocks()` clears recorded
 * calls but NOT implementations, so the ECONNREFUSED implementation an earlier
 * test installs would otherwise leak into every test declared after it.
 */
function mockGatewayOk(): void {
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }) as never);
}

const THREE_MINUTES = 3 * 60_000;
const ELEVEN_MINUTES = 11 * 60_000;

/**
 * The BOOT-STORM shape: a plain gateway restart with NO tool records, so neither
 * `restartResumeToolCallId` nor the idle check applies. The user prompt is the
 * tail (tinker-bridge mid-flight) — a genuine interruption that resumes with the
 * "[System] The gateway restarted…" prompt, the exact row that appeared twice
 * in the 09-01 transcript.
 */
function midFlightEntries(interruptedAt: number): RawEntry[] {
  return [
    messageEntry(
      "m1",
      null,
      { role: "user", content: "run the tool", timestamp: interruptedAt },
      interruptedAt,
    ),
  ];
}

/** What boot #1's resume appends: its own [System] row, still a `user` tail. */
function resumedTurnEntries(interruptedAt: number, resumedAt: number): RawEntry[] {
  return [
    ...midFlightEntries(interruptedAt),
    messageEntry(
      "m2",
      "m1",
      {
        role: "user",
        content: "[System] The gateway restarted and interrupted your previous turn. Resume it.",
        timestamp: resumedAt,
      },
      resumedAt,
    ),
  ];
}

async function seedRestartInterruptedSession(interruptedAt: number): Promise<string> {
  const sessionsDir = await makeSessionsDir();
  await writeStore(sessionsDir, { "agent:main:main": runningAbortedEntry(interruptedAt) });
  await writeTranscript(sessionsDir, "main-session", midFlightEntries(interruptedAt));
  return sessionsDir;
}

/**
 * Boot #1 has already resumed the session (`lastResumeAt` ≈ now). Re-create what
 * boot #2's sweeps see `elapsedMs` later when the restart storm killed THAT
 * resumed run: the entry is `running` again with the resumed run's own
 * `startedAt`, the stale-lock sweep has re-armed `abortedLastRun`, and the
 * transcript tail is the resume's [System] row. Elapsed time is simulated by
 * ageing `lastResumeAt` rather than faking the clock — the module reads
 * Date.now() against the store, and the store is the only input under test.
 */
async function rebootAfter(
  sessionsDir: string,
  interruptedAt: number,
  elapsedMs: number,
): Promise<void> {
  const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
  const entry = store["agent:main:main"] as SessionEntry;
  expect(typeof entry.lastResumeAt).toBe("number");
  const lastResumeAt = (entry.lastResumeAt as number) - elapsedMs;
  const resumedRunStartedAt = lastResumeAt + 1_000;
  await writeStore(sessionsDir, {
    "agent:main:main": {
      ...entry,
      status: "running",
      abortedLastRun: true,
      startedAt: resumedRunStartedAt,
      lastResumeAt,
    } as SessionEntry,
  });
  await writeTranscript(
    sessionsDir,
    "main-session",
    resumedTurnEntries(interruptedAt, resumedRunStartedAt),
  );
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
        // FORK 2026-09-08 — this second boot must sit OUTSIDE the boot-storm
        // window: inside it, even a NEW dangling call is the first resume's own
        // run dying in the storm and is held back on purpose (pinned below).
        lastResumeAt: Date.now() - RESUME_COOLDOWN_MS - 60_000,
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

describe("main-session restart recovery - the boot-storm window", () => {
  // The two boot tests below are tuned to this number; if it moves, move them.
  it("holds the window at ten minutes", () => {
    expect(RESUME_COOLDOWN_MS).toBe(10 * 60_000);
  });

  // DEFECT 4 (measured 2026-09-08): ONE interruption, TWO different answers.
  // agent:main:tinker:mthk0fck was resumed at 09-01 10:16:41 AND 10:19:25 —
  // 2m44s apart — with a "[System] The gateway restarted" row and a full answer
  // after each. Boot #2 runs the real boot order: the running-at-boot sweep,
  // then recovery. Red before the window: agentDispatches() reaches 2.
  it("boot #2 three minutes after boot #1 does not dispatch a second resume", async () => {
    const interruptedAt = Date.now() - THREE_MINUTES - 10_000;
    const sessionsDir = await seedRestartInterruptedSession(interruptedAt);
    mockGatewayOk();

    const first = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    expect(first).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(agentDispatches()).toHaveLength(1);

    await rebootAfter(sessionsDir, interruptedAt, THREE_MINUTES);
    const sweep = await markRunningMainSessionsAsInterrupted({ sessionsDir });
    const second = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(sweep.marked).toBe(0);
    expect(agentDispatches()).toHaveLength(1);
    expect(second).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    // The window DEFERS; it does not settle. The flag stays armed so the first
    // boot after the window still resumes a genuinely unfinished turn.
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]?.status).toBe("running");
  });

  // The window is a boot-storm bound, not a mute: past it, a session still
  // flagged running + aborted is a real unfinished turn and must be resumed —
  // on the plain restart path, and the window re-arms from THIS dispatch.
  it("boot #2 eleven minutes later does", async () => {
    const interruptedAt = Date.now() - ELEVEN_MINUTES - 10_000;
    const sessionsDir = await seedRestartInterruptedSession(interruptedAt);
    mockGatewayOk();

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    expect(agentDispatches()).toHaveLength(1);

    await rebootAfter(sessionsDir, interruptedAt, ELEVEN_MINUTES);
    const sweep = await markRunningMainSessionsAsInterrupted({ sessionsDir });
    const before = Date.now();
    const second = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(sweep.marked).toBe(0); // already armed by the stale-lock sweep
    expect(agentDispatches()).toHaveLength(2);
    expect(second).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const message = String(
      (agentDispatches()[1] as { params?: { message?: unknown } }).params?.message ?? "",
    );
    expect(message).toContain("The gateway restarted");
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:main"]?.lastResumeAt).toBeGreaterThanOrEqual(before);
  });

  // Guard (4), the graceful-restart sweep on its own: a `running` entry whose
  // resume we dispatched inside the window IS that resume's run. Re-marking it
  // is what handed recovery the second turn.
  it("the running-at-boot sweep does not re-mark a run resumed inside the window", async () => {
    const sessionsDir = await makeSessionsDir();
    const lastResumeAt = Date.now() - THREE_MINUTES;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: lastResumeAt,
        startedAt: lastResumeAt + 1_000,
        status: "running",
        abortedLastRun: false,
        lastResumeAt,
      } as SessionEntry,
    });

    const result = await markRunningMainSessionsAsInterrupted({ sessionsDir });

    expect(result).toEqual({ marked: 0, skipped: 1 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("the running-at-boot sweep marks a run resumed outside the window", async () => {
    const sessionsDir = await makeSessionsDir();
    const lastResumeAt = Date.now() - ELEVEN_MINUTES;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: lastResumeAt,
        startedAt: lastResumeAt + 1_000,
        status: "running",
        abortedLastRun: false,
        lastResumeAt,
      } as SessionEntry,
    });

    const result = await markRunningMainSessionsAsInterrupted({ sessionsDir });

    expect(result).toEqual({ marked: 1, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  // Ordering: the window sits AFTER the idle check. A resumed turn that FINISHED
  // before the next boot has nothing to resume and must still settle to done —
  // holding it back would leave a completed turn flagged for ten minutes.
  it("still settles a resumed turn that completed inside the window", async () => {
    const sessionsDir = await makeSessionsDir();
    const lastResumeAt = Date.now() - THREE_MINUTES;
    const resumedRunStartedAt = lastResumeAt + 1_000;
    await writeStore(sessionsDir, {
      "agent:main:main": runningAbortedEntry(resumedRunStartedAt, { lastResumeAt }),
    });
    await writeTranscript(sessionsDir, "main-session", [
      ...resumedTurnEntries(lastResumeAt - 10_000, resumedRunStartedAt),
      messageEntry(
        "m3",
        "m2",
        {
          role: "assistant",
          content: [{ type: "text", text: "Resumed and finished." }],
          timestamp: resumedRunStartedAt + 2_000,
        },
        resumedRunStartedAt + 2_000,
      ),
    ]);
    mockGatewayOk();

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(agentDispatches()).toHaveLength(0);
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });
});

// FORK 2026-10-01 — a freeze and power-off was resumed as "The gateway restarted" (AcmeVision
// worker, interrupted 06:35, back 07:13); the agent recorded the wrong cause and did not know
// its /tmp files were gone. The turn's newest transcript entry against this boot tells them apart.
describe("main-session restart recovery - a reboot is not a gateway restart", () => {
  const dispatchedMessage = () =>
    String((agentDispatches()[0] as { params?: { message?: unknown } }).params?.message ?? "");

  it("names the reboot and when the machine came back", async () => {
    await seedRestartInterruptedSession(Date.now() - 5 * 60_000);
    mockGatewayOk();
    vi.spyOn(os, "uptime").mockReturnValue(2 * 60); // booted 2 min ago, after the turn's last entry

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    const message = dispatchedMessage();
    expect(message).toMatch(
      /^\[System\] The machine was shut down or rebooted \(it was back at \d\d:\d\d\), so the gateway restarted and interrupted your previous turn\. Every process the turn started is gone; check \/tmp before trusting files there\. Resume it/,
    );
    // The Tinker UI recognises the resume notice by this clause (tinker-ui/src/fractal-prompt-strip.ts).
    expect(message).toMatch(/The gateway restarted and interrupted your previous turn/i);
  });

  it("keeps the plain wording when the machine stayed up", async () => {
    await seedRestartInterruptedSession(Date.now() - 5 * 60_000);
    mockGatewayOk();

    await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    const message = dispatchedMessage();
    expect(message).toMatch(
      /^\[System\] The gateway restarted and interrupted your previous turn\. Resume it/,
    );
    expect(message).not.toContain("rebooted");
  });

  it("adds the reboot after a dangling tool's sentence", () => {
    const message = buildResumeMessage({ name: "Bash", toolCallId: "tc-1" }, Date.now());
    expect(message).toMatch(
      /^\[System\] Your previous turn stopped while the tool `Bash` \(tc-1\) was still running, so its result never arrived\. The machine was shut down or rebooted meanwhile \(it was back at \d\d:\d\d\)\. Every process the turn started is gone/,
    );
    expect(buildResumeMessage({ name: "Bash", toolCallId: "tc-1" }, null)).not.toContain(
      "rebooted",
    );
  });

  it("calls it a reboot only when the turn's newest entry predates the boot", () => {
    expect(hostBootedAtMs(10_000, 4)).toBe(6_000);
    expect(rebootedAtMs(1_000, 6_000)).toBe(6_000);
    expect(rebootedAtMs(7_000, 6_000)).toBeNull();
    expect(rebootedAtMs(undefined, 6_000)).toBeNull();
  });
});
