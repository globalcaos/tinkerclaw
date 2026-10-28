// FORK 2026-10-25 — the Fractal waits for the end of the task (fractal-defer.ts).
import { describe, expect, it } from "vitest";
import {
  coveredDigestLines,
  createFractalDeferrer,
  FRACTAL_DEFER_MAX_MS,
  FRACTAL_DEFERRED_KEY,
  FRACTAL_WAKE_GRACE_MS,
  type FractalDecisionReport,
  type FractalFire,
  fractalDeferVerdict,
  liveBackgroundCount,
  liveLongjobCount,
  mergeTrails,
} from "./fractal-defer.js";
import { trailDigestLines } from "./fractal-turn.js";
import type { LongjobJob } from "./longjob-rows.js";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

// app.ts sessionKeyMatches: equal, or one is the other with an `agent:<id>:` prefix.
const matches = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);

const CHAT = "tinker:abc";
const CANON = "agent:main:tinker:abc";

function harness(storage = memoryStorage()) {
  const h = {
    clock: 1_800_000_000_000,
    jobs: [] as LongjobJob[],
    listAnswers: true,
    background: [] as LongjobJob[],
    backgroundAnswers: true,
    live: false,
    fired: [] as FractalFire[],
    logs: [] as string[],
    reports: [] as FractalDecisionReport[],
    storage,
  };
  const deferrer = createFractalDeferrer({
    storage,
    now: () => h.clock,
    listJobs: async (key) =>
      h.listAnswers ? h.jobs.filter((j) => matches(j.session ?? "", key)) : null,
    listBackground: async (key) =>
      h.backgroundAnswers ? h.background.filter((j) => matches(j.session ?? "", key)) : null,
    turnLive: () => h.live,
    matches,
    fire: (f) => h.fired.push(f),
    log: (l) => h.logs.push(l),
    report: (r) => h.reports.push(r),
  });
  return { h, deferrer };
}

/** A Claude Code background task as the bridge lists it (ccBridge.backgroundTasks). */
function bgTask(over: Partial<LongjobJob> = {}): LongjobJob {
  return {
    id: "b1x",
    label: "pnpm test",
    kind: "background",
    session: CANON,
    status: "running",
    startedAt: 1_800_000_000_000 - 30_000,
    ...over,
  };
}

function job(over: Partial<LongjobJob> = {}): LongjobJob {
  return {
    id: "build",
    session: CANON,
    status: "running",
    startedAt: 1_800_000_000_000 - 60_000,
    updatedAt: 1_800_000_000_000 - 2_000,
    intervalMs: 5000,
    ...over,
  };
}

const terminal = (runId: string) => ({
  sessionKey: CANON,
  runId,
  scope: { kind: "session" as const },
});

describe("Fractal waits for the end of the task", () => {
  it("no job running: fires at once, as before", async () => {
    const { h, deferrer } = harness();
    expect(
      await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 1, prompt: "do x" }),
    ).toBe("fired");
    expect(h.fired).toEqual([
      { parentRunId: "p1", sessionKey: CHAT, armedAt: 1, prompt: "do x", aliases: [] },
    ]);
    expect(deferrer.pending()).toBe(false);
  });

  it("job running → no fire; job done + the wake's turn ended → ONE fire", async () => {
    const { h, deferrer } = harness();
    h.jobs = [job()];
    expect(
      await deferrer.armedRunEnded({
        runId: "p1",
        sessionKey: CHAT,
        armedAt: 5,
        prompt: "build it",
        reply: "Started the build.",
      }),
    ).toBe("deferred");
    expect(h.fired).toHaveLength(0);
    expect(h.logs).toContain("[fractal-turn] deferred: 1 job running (prompt run p1)");
    expect(deferrer.pending()).toBe(true);

    // Still running a minute later: the timer's checks fire nothing.
    h.clock += 60_000;
    await deferrer.check();
    expect(h.fired).toHaveLength(0);

    // The job ends (its state is written before the wake), the wake turn runs and ends.
    h.clock += 10_000;
    h.jobs = [job({ status: "done" })];
    h.live = true;
    await deferrer.check();
    expect(h.fired).toHaveLength(0); // the wake's turn is still running
    h.clock += 30_000;
    h.live = false;
    expect(
      deferrer.turnEnded({ ...terminal("longjob-1761-ab12cd"), reply: "Build passed, merged." }),
    ).toBe(true);
    await deferrer.check();
    await deferrer.check();
    expect(h.fired).toEqual([
      {
        parentRunId: "p1",
        sessionKey: CHAT,
        armedAt: 5,
        prompt: "build it",
        reply: "Build passed, merged.",
        aliases: [],
        runs: [
          { runId: "p1", kind: "prompt" },
          { runId: "longjob-1761-ab12cd", kind: "wake" },
        ],
      },
    ]);
    expect(h.logs.at(-1)).toBe(
      "[fractal-turn] task over (wake-ended): one reflection for 2 turn(s), parent p1",
    );
    expect(deferrer.pending()).toBe(false);
    expect(h.storage.getItem(FRACTAL_DEFERRED_KEY)).toBeNull();
  });

  it("prompts that end while the job runs join the deferral: one reflection, the newest is the parent", async () => {
    const { h, deferrer } = harness();
    h.jobs = [job()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5, prompt: "start" });
    h.clock += 20_000;
    // Every terminal is noted first (onEvent), then the armed path runs 1.5 s later.
    deferrer.turnEnded(terminal("p2"));
    await deferrer.armedRunEnded({
      runId: "p2",
      sessionKey: CANON,
      armedAt: 9,
      prompt: "and the docs?",
      aliases: ["q7"],
    });
    expect(h.fired).toHaveLength(0);
    h.clock += 20_000;
    h.jobs = [];
    deferrer.turnEnded(terminal("longjob-9-zz"));
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({
      parentRunId: "p2",
      armedAt: 5,
      prompt: "start\n\nand the docs?",
      aliases: ["p1", "q7"],
    });
    expect(h.fired[0].runs?.map((r) => r.kind)).toEqual(["prompt", "prompt", "wake"]);
  });

  it("a wake folded into a running turn is handled when that turn ends", async () => {
    const { h, deferrer } = harness();
    h.jobs = [job()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    h.clock += 5_000;
    h.jobs = [];
    // The wake's early final says it was steered into the running turn: no turn ended yet.
    deferrer.turnEnded({
      sessionKey: CANON,
      runId: "longjob-1-x",
      scope: { kind: "prompt", key: "longjob-1-x", disposition: "steered" },
    });
    h.live = true;
    await deferrer.check();
    expect(h.fired).toHaveLength(0);
    h.clock += 5_000;
    h.live = false;
    deferrer.turnEnded(terminal("host-run"));
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0].runs).toEqual([
      { runId: "p1", kind: "prompt" },
      { runId: "host-run", kind: "wake" },
    ]);
  });

  it("no wake ever shows on this page: fires after the grace period, once the chat is idle", async () => {
    const { h, deferrer } = harness();
    h.jobs = [job()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    h.jobs = [];
    h.clock += FRACTAL_WAKE_GRACE_MS - 1_000;
    await deferrer.check();
    expect(h.fired).toHaveLength(0);
    h.clock += 2_000;
    h.live = true;
    await deferrer.check();
    expect(h.fired).toHaveLength(0);
    h.live = false;
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
    expect(h.logs.at(-1)).toContain("task over (no-wake)");
  });

  it("a job list that does not answer: the turn's end fires (fail open), a check keeps waiting", async () => {
    const { h, deferrer } = harness();
    h.listAnswers = false;
    expect(await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 })).toBe(
      "fired",
    );

    const second = harness();
    second.h.jobs = [job()];
    await second.deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    second.h.listAnswers = false;
    second.h.clock += FRACTAL_WAKE_GRACE_MS * 2;
    await second.deferrer.check();
    expect(second.h.fired).toHaveLength(0);
    second.h.clock += FRACTAL_DEFER_MAX_MS;
    await second.deferrer.check();
    expect(second.h.fired).toHaveLength(1);
  });

  it("two tabs share one deferral: only one of them fires", async () => {
    const storage = memoryStorage();
    const a = harness(storage);
    const b = harness(storage);
    a.h.jobs = [job()];
    await a.deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    for (const t of [a, b]) {
      t.h.clock += 10_000;
      t.h.jobs = [];
      t.deferrer.turnEnded(terminal("longjob-2-y"));
    }
    await Promise.all([a.deferrer.check(), b.deferrer.check()]);
    expect(a.h.fired.length + b.h.fired.length).toBe(1);
  });

  it("other sessions' terminals and Fractal runs are not part of the task", () => {
    const { deferrer } = harness();
    expect(deferrer.turnEnded(terminal("longjob-3-z"))).toBe(false);
    expect(deferrer.turnEnded({ ...terminal("fractal-p1") })).toBe(false);
  });
});

describe("Fractal waits for background tasks too (2026-10-25)", () => {
  it("a live background task holds the reflection; its bg-turn wake ends the task: ONE fire", async () => {
    const { h, deferrer } = harness();
    h.background = [bgTask()];
    expect(
      await deferrer.armedRunEnded({
        runId: "p1",
        sessionKey: CHAT,
        armedAt: 5,
        prompt: "test it",
      }),
    ).toBe("deferred");
    expect(h.fired).toHaveLength(0);
    expect(h.logs).toContain("[fractal-turn] deferred: 1 background task running (prompt run p1)");

    // The task ends with no turn open: the CLI answers on its own and the bridge wakes the chat.
    h.clock += 60_000;
    h.background = [];
    await deferrer.check();
    expect(h.fired).toHaveLength(0); // no wake has ended yet
    h.live = true;
    await deferrer.check();
    expect(h.fired).toHaveLength(0);
    h.clock += 5_000;
    h.live = false;
    expect(
      deferrer.turnEnded({ ...terminal("bg-turn-bgt-mh1-ab12cd"), reply: "Tests passed." }),
    ).toBe(true);
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({ parentRunId: "p1", reply: "Tests passed." });
    expect(h.fired[0].runs).toEqual([
      { runId: "p1", kind: "prompt" },
      { runId: "bg-turn-bgt-mh1-ab12cd", kind: "wake" },
    ]);
    expect(h.logs.at(-1)).toContain("task over (wake-ended)");
  });

  it("a long job and a background task: over only when both are", async () => {
    const { h, deferrer } = harness();
    h.jobs = [job()];
    h.background = [bgTask()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    expect(h.logs).toContain(
      "[fractal-turn] deferred: 1 job and 1 background task running (prompt run p1)",
    );
    h.clock += 10_000;
    h.jobs = [];
    deferrer.turnEnded(terminal("longjob-5-q"));
    await deferrer.check();
    expect(h.fired).toHaveLength(0); // the background task still runs
    expect(h.logs.at(-1)).toBe(`[fractal-turn] deferred: 1 background task running (${CHAT})`);
    h.clock += 10_000;
    h.background = [];
    deferrer.turnEnded(terminal("bg-turn-bgt-2-zz"));
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
  });

  it("a background task that ends inside a running turn: that turn's end is the wake", async () => {
    const { h, deferrer } = harness();
    h.background = [bgTask()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    h.clock += 10_000;
    // The owner asks something else; while that turn runs, the task ends and is told to it.
    h.live = true;
    h.background = [];
    await deferrer.check();
    expect(h.fired).toHaveLength(0);
    h.clock += 10_000;
    h.live = false;
    deferrer.turnEnded(terminal("host-run"));
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0].runs?.at(-1)).toEqual({ runId: "host-run", kind: "wake" });
  });

  it("a wake prompt steered into a running turn is handled when that turn ends", async () => {
    const { h, deferrer } = harness();
    h.background = [bgTask()];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    h.clock += 5_000;
    h.background = [];
    deferrer.turnEnded({
      sessionKey: CANON,
      runId: "bg-turn-bgt-3-x",
      scope: { kind: "prompt", key: "bg-turn-bgt-3-x", disposition: "steered" },
    });
    h.clock += 5_000;
    deferrer.turnEnded(terminal("host-run"));
    await deferrer.check();
    expect(h.fired).toHaveLength(1);
  });

  it("a background list that does not answer: the turn's end fires (fail open), a check keeps waiting", async () => {
    const { h, deferrer } = harness();
    h.backgroundAnswers = false;
    expect(await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 })).toBe(
      "fired",
    );

    const second = harness();
    second.h.background = [bgTask()];
    await second.deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    second.h.background = [];
    second.h.backgroundAnswers = false;
    second.h.clock += FRACTAL_WAKE_GRACE_MS * 2;
    await second.deferrer.check();
    expect(second.h.fired).toHaveLength(0);
    second.h.clock += FRACTAL_DEFER_MAX_MS;
    await second.deferrer.check();
    expect(second.h.fired).toHaveLength(1);
  });

  it("reports each decision for the journal: fired, deferred, task-over", async () => {
    const { h, deferrer } = harness();
    await deferrer.armedRunEnded({ runId: "p0", sessionKey: CHAT, armedAt: 1 });
    h.jobs = [job()];
    h.background = [bgTask(), bgTask({ id: "w2" })];
    await deferrer.armedRunEnded({ runId: "p1", sessionKey: CHAT, armedAt: 5 });
    h.clock += 10_000;
    h.jobs = [];
    await deferrer.check();
    h.clock += 5_000;
    h.background = [];
    deferrer.turnEnded(terminal("bg-turn-bgt-4-y"));
    await deferrer.check();
    expect(h.reports).toEqual([
      { decision: "fired", sessionKey: CHAT, parentRunId: "p0", longjobs: 0, background: 0 },
      { decision: "deferred", sessionKey: CHAT, parentRunId: "p1", longjobs: 1, background: 2 },
      { decision: "deferred", sessionKey: CHAT, parentRunId: "p1", longjobs: 0, background: 2 },
      {
        decision: "task-over",
        sessionKey: CHAT,
        parentRunId: "p1",
        longjobs: 0,
        background: 0,
        why: "wake-ended",
      },
    ]);
  });
});

describe("Fractal deferral: pieces", () => {
  it("a job whose worker stopped writing holds nothing", () => {
    const now = 1_800_000_000_000;
    expect(liveLongjobCount([job()], now)).toBe(1);
    expect(liveLongjobCount([job({ updatedAt: now - 11 * 60_000 })], now)).toBe(0);
    expect(liveLongjobCount([job({ status: "done" })], now)).toBe(0);
    // A slow job (5-minute interval) is given six of its own intervals.
    expect(
      liveLongjobCount([job({ updatedAt: now - 20 * 60_000, intervalMs: 300_000 })], now),
    ).toBe(1);
  });

  it("long jobs and background tasks are counted apart", () => {
    const now = 1_800_000_000_000;
    const both = [job(), bgTask(), bgTask({ id: "w2", status: "done" })];
    expect(liveLongjobCount(both, now)).toBe(1);
    expect(liveBackgroundCount(both)).toBe(1);
    // A background task has no state writes to age: it is live while the bridge lists it.
    expect(liveBackgroundCount([bgTask({ startedAt: now - 20 * 3_600_000 })])).toBe(1);
  });

  it("the verdict: jobs, then background tasks, then a running turn, then the wake", () => {
    const rec = { sessionKey: CHAT, since: 0, runs: [], jobsSeenAt: 100, jobs: 0 };
    expect(fractalDeferVerdict(rec, { jobs: 2, turnLive: false, now: 200 })).toEqual({
      fire: false,
      why: "jobs",
    });
    expect(fractalDeferVerdict(rec, { jobs: 0, background: 1, turnLive: true, now: 200 })).toEqual({
      fire: false,
      why: "background",
    });
    expect(
      fractalDeferVerdict(
        { ...rec, wakeEndedAt: 150 },
        { jobs: 0, background: 1, turnLive: false, now: 200 },
      ),
    ).toEqual({ fire: false, why: "background" });
    expect(
      fractalDeferVerdict(rec, {
        jobs: 0,
        background: 3,
        turnLive: false,
        now: FRACTAL_DEFER_MAX_MS + 1,
      }),
    ).toEqual({ fire: true, why: "too-long" });
    expect(fractalDeferVerdict(rec, { jobs: 0, turnLive: true, now: 200 })).toEqual({
      fire: false,
      why: "turn",
    });
    expect(fractalDeferVerdict(rec, { jobs: 0, turnLive: false, now: 200 })).toEqual({
      fire: false,
      why: "wake",
    });
    expect(
      fractalDeferVerdict({ ...rec, wakeEndedAt: 150 }, { jobs: 0, turnLive: false, now: 200 }),
    ).toEqual({ fire: true, why: "wake-ended" });
    // A wake that ended BEFORE the jobs were last seen was an earlier job's.
    expect(
      fractalDeferVerdict({ ...rec, wakeEndedAt: 90 }, { jobs: 0, turnLive: false, now: 200 }),
    ).toEqual({ fire: false, why: "wake" });
  });

  it("merges the covered trails for the gate", () => {
    expect(mergeTrails([null, null])).toBeNull();
    expect(
      mergeTrails([
        { calls: 2, tokensIn: 100, tokensOut: 10, durationMs: 1000, tools: [{ name: "Bash" }] },
        null,
        { calls: 1, tokensIn: 50, tokensOut: 5, tools: [{ name: "Read", isError: true }] },
      ]),
    ).toEqual({
      calls: 3,
      tokensIn: 150,
      tokensOut: 15,
      durationMs: 1000,
      tools: [{ name: "Bash" }, { name: "Read", isError: true }],
    });
  });

  it("one turn keeps the old digest; several get a block each", () => {
    const trail = { calls: 1, tokensIn: 1000, tokensOut: 100, tools: [] };
    expect(coveredDigestLines([{ kind: "prompt", trail }])).toEqual(trailDigestLines(trail));
    const lines = coveredDigestLines([
      { kind: "prompt", trail },
      { kind: "wake", trail: null },
    ]);
    expect(lines[0]).toContain("long jobs and background tasks");
    expect(lines[0]).toContain("covers 2 turns of one task");
    expect(lines).toContain("- Turn 1 (owner prompt):");
    expect(lines).toContain("- Turn 2 (wake: a long job or background task ended):");
    expect(lines).toContain("  - No tool calls.");
  });
});
