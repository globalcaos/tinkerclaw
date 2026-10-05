import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createPreparingPromptTracker,
  drainForRestart,
  isRestartDrainActive,
  PREPARING_PARTICIPANT_ID,
  registerRestartDrainParticipant,
  releaseRestartDrain,
  type RestartDrainReport,
  type RestartDrainResult,
} from "./restart-drain.js";

// Before each test as well as after: vitest runs a worker's files against one global
// (isolate: false), and chat.ts registers the `preparing` participant there when it loads.
beforeEach(() => __testing.reset());
afterEach(() => {
  vi.useRealTimers();
  __testing.reset();
});

describe("restart drain", () => {
  it("runs every participant within one budget and sums their reports", async () => {
    registerRestartDrainParticipant("embedded", {
      drain: async () => ({ held: ["a"], ended: ["b"], unfinished: [] }),
      release: () => {},
    });
    registerRestartDrainParticipant("cc-bridge", {
      drain: async () => ({ held: ["c"], ended: [], unfinished: ["d"] }),
      release: () => {},
    });
    const r = await drainForRestart(1_000);
    expect(r).toMatchObject({ held: 2, ended: 1, unfinished: 1 });
    expect(Object.keys(r.byParticipant).toSorted()).toEqual(["cc-bridge", "embedded"]);
    expect(isRestartDrainActive()).toBe(true);
  });

  it("a participant that throws counts as empty and never blocks the others", async () => {
    registerRestartDrainParticipant("bad", {
      drain: async () => {
        throw new Error("boom");
      },
      release: () => {},
    });
    registerRestartDrainParticipant("good", {
      drain: async () => ({ held: ["x"], ended: [], unfinished: [] }),
      release: () => {},
    });
    expect((await drainForRestart(10)).held).toBe(1);
  });

  it("release clears the active flag and releases every participant", async () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error("cannot");
    });
    registerRestartDrainParticipant("a", {
      drain: async () => ({ held: [], ended: [], unfinished: [] }),
      release: a,
    });
    registerRestartDrainParticipant("b", {
      drain: async () => ({ held: [], ended: [], unfinished: [] }),
      release: b,
    });
    await drainForRestart(10);
    await releaseRestartDrain();
    expect(isRestartDrainActive()).toBe(false);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unregister removes only the participant it registered", async () => {
    const off = registerRestartDrainParticipant("p", {
      drain: async () => ({ held: ["1"], ended: [], unfinished: [] }),
      release: () => {},
    });
    off();
    expect((await drainForRestart(10)).held).toBe(0);
  });
});

// FORK 2026-10-01 (lifecycles.md L4b; bug-log.md [chat-divergence] cause 6): a prompt acked and still
// preparing is a turn no runner participant knows about yet. CONTROL: on the parent tree there is
// no tracker, so the drain reports nothing for a prompt that is still preparing.
describe("restart drain: prompts still preparing", () => {
  const capture = () => {
    const warned: string[] = [];
    return {
      warned,
      log: {
        warn: (line: string) => {
          warned.push(line);
        },
      },
    };
  };

  it("a prompt still preparing when the budget runs out is reported unfinished, and logged once with its session", async () => {
    vi.useFakeTimers();
    const { warned, log } = capture();
    const tracker = createPreparingPromptTracker();
    registerRestartDrainParticipant(PREPARING_PARTICIPANT_ID, tracker.participant);
    // The 2026-09-30 shape: acked, then 30 s in a memory-flush compaction before its first call.
    const release = tracker.track({
      promptKey: "a247f622",
      sessionKey: "agent:main:tinker:mt79j0oy",
      since: Date.now(),
      log,
    });
    setTimeout(release, 30_000);

    const drained = drainForRestart(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await drained;

    expect(result.byParticipant[PREPARING_PARTICIPANT_ID]).toEqual({
      held: [],
      ended: [],
      unfinished: ["a247f622"],
    });
    expect(result.unfinished).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(
      /^restart drain \(preparing\): UNFINISHED key=a247f622 sessionKey=agent:main:tinker:mt79j0oy preparingMs=5000 /,
    );

    // When it does leave preparation, the tracker lets go of it.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(tracker.list()).toEqual([]);
  });

  it("a prompt whose run starts inside the budget is reported ended, and the drain returns then", async () => {
    vi.useFakeTimers();
    const { warned, log } = capture();
    const tracker = createPreparingPromptTracker();
    registerRestartDrainParticipant(PREPARING_PARTICIPANT_ID, tracker.participant);
    const release = tracker.track({ promptKey: "k-starts", sessionKey: "agent:main:main", log });
    // chat.send's onAgentRunStart: the run reaches its first model call, where the runner holds it.
    setTimeout(release, 1_000);

    let result: RestartDrainResult | undefined;
    void drainForRestart(5_000).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(result?.byParticipant[PREPARING_PARTICIPANT_ID]).toEqual({
      held: [],
      ended: ["k-starts"],
      unfinished: [],
    });
    expect(result?.ms).toBeLessThan(5_000);
    expect(warned).toEqual([]);
  });

  it("a prompt acked while the drain waits is waited for too", async () => {
    vi.useFakeTimers();
    const { log } = capture();
    const tracker = createPreparingPromptTracker();
    const releaseFirst = tracker.track({ promptKey: "k-before", sessionKey: "s", log });
    let report: RestartDrainReport | undefined;
    void tracker.drain(10_000).then((r) => {
      report = r;
    });
    let releaseSecond: () => void = () => {};
    setTimeout(() => {
      releaseSecond = tracker.track({ promptKey: "k-during", sessionKey: "s", log });
    }, 500);
    setTimeout(() => releaseFirst(), 1_000);
    setTimeout(() => releaseSecond(), 2_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(report).toEqual({ held: [], ended: ["k-before", "k-during"], unfinished: [] });
  });

  it("each release drops only its own entry, any number of times; a prompt with no key is not tracked", () => {
    const { log } = capture();
    const tracker = createPreparingPromptTracker();
    const first = tracker.track({ promptKey: "same", sessionKey: "s", since: 1, log });
    const second = tracker.track({ promptKey: "same", sessionKey: "s", since: 2, log });
    const keyless = tracker.track({ promptKey: "  ", sessionKey: "s", log });
    first();
    first();
    keyless();
    expect(tracker.list()).toEqual([{ promptKey: "same", sessionKey: "s", since: 2 }]);
    second();
    expect(tracker.list()).toEqual([]);
  });

  it("with nothing preparing it answers at once, and has nothing to release", async () => {
    vi.useFakeTimers();
    const { log } = capture();
    const tracker = createPreparingPromptTracker();
    tracker.track({ promptKey: "gone", sessionKey: "s", log })();
    let report: RestartDrainReport | undefined;
    void tracker.drain(60_000).then((r) => {
      report = r;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toEqual({ held: [], ended: [], unfinished: [] });
    expect(() => tracker.participant.release()).not.toThrow();
  });

  it("a `preparing` participant left by an earlier test file is dropped when this module is evaluated again", async () => {
    // What chat.dedup.test.ts leaves behind: a tracker whose sends never settle. Without the drop,
    // every later drain in the same worker waits out its budget (forever, under fake timers).
    registerRestartDrainParticipant(PREPARING_PARTICIPANT_ID, {
      drain: () => new Promise<RestartDrainReport>(() => {}),
      release: () => {},
    });
    vi.resetModules();
    const fresh = await import("./restart-drain.js");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      fresh.drainForRestart(10),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the drain waited on a stale `preparing` tracker")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    expect(result.byParticipant[PREPARING_PARTICIPANT_ID]).toBeUndefined();
  });

  it("a log sink that throws breaks neither the drain nor the send that ended it", async () => {
    vi.useFakeTimers();
    const broken = {
      warn: () => {
        throw new Error("sink down");
      },
    };
    const tracker = createPreparingPromptTracker();
    const release = tracker.track({ promptKey: "k", sessionKey: "s", log: broken });
    let report: RestartDrainReport | undefined;
    void tracker.drain(1_000).then((r) => {
      report = r;
    });
    expect(() => release()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toEqual({ held: [], ended: ["k"], unfinished: [] });

    tracker.track({ promptKey: "stuck", sessionKey: "s", log: broken });
    let late: RestartDrainReport | undefined;
    void tracker.drain(1_000).then((r) => {
      late = r;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(late).toEqual({ held: [], ended: [], unfinished: ["stuck"] });
  });
});
