import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMaxWorkers,
  isOneShotSessionKey,
  SessionWorkerPool,
  type SessionWorkerPoolOptions,
  SWEEP_INTERVAL_MS,
} from "./worker-pool.js";
import type { WorkerSpawnParams } from "./worker.js";

const GiB = 2 ** 30;

// FORK 2026-10-19: the pool also sweeps on a timer and sheds idle workers under memory pressure.
// The policy tests that predate those rules turn both off (no timer, plenty of free memory), so
// only the rule under test acts and the machine's real free memory never decides a result.
const QUIET = { sweepIntervalMs: 0, freeMemBytes: () => 64 * GiB };

// A minimal stand-in for ClaudeCodeWorker. The pool only needs sessionKey,
// isAlive(), isBusy(), kill(), sessionId and on("exit"). No real claude
// subprocess is spawned — eviction policy is what we are testing.
class FakeWorker {
  readonly sessionKey: string;
  readonly thinkLevel?: string;
  sessionId: string | null = null;
  killed = false;
  private busy: boolean;
  constructor(params: WorkerSpawnParams, busy = false) {
    this.sessionKey = params.sessionKey;
    this.thinkLevel = params.thinkLevel;
    this.busy = busy;
  }
  isAlive(): boolean {
    return !this.killed;
  }
  isBusy(): boolean {
    return this.busy;
  }
  setBusy(b: boolean): void {
    this.busy = b;
  }
  kill(): void {
    this.killed = true;
  }
  on(): void {
    /* exit handler unused in these tests */
  }
  /** When the fake child last printed a line (the pool's clock); 0 = never. */
  activityAt = 0;
  lastActivityAt(): number {
    return this.activityAt;
  }
}

function makeParams(sessionKey: string, thinkLevel?: string, model?: string): WorkerSpawnParams {
  return { sessionKey, cwd: "/tmp", thinkLevel, model } as WorkerSpawnParams;
}

describe("SessionWorkerPool eviction policy", () => {
  let clock: number;
  const created: FakeWorker[] = [];

  beforeEach(() => {
    clock = 0;
    created.length = 0;
  });

  function makePool(opts: { maxWorkers?: number; idleTtlMs?: number } = {}) {
    return new SessionWorkerPool({
      ...QUIET,
      now: () => clock,
      maxWorkers: opts.maxWorkers ?? 32,
      idleTtlMs: opts.idleTtlMs ?? 15 * 60_000,
      createWorker: (params) => {
        const w = new FakeWorker(params);
        created.push(w);
        return w as unknown as ReturnType<SessionWorkerPool["getOrCreate"]>;
      },
    });
  }

  it("reaps an idle, non-busy worker on the next getOrCreate after the TTL", () => {
    const pool = makePool({ idleTtlMs: 1_000 });
    const a = pool.get("A") ?? (pool.getOrCreate(makeParams("A")) as unknown as FakeWorker);

    clock = 2_000; // A has now been idle longer than the 1s TTL
    pool.getOrCreate(makeParams("B"));

    expect(a.killed).toBe(true);
    expect(pool.get("A")).toBeUndefined();
    expect(pool.get("B")).toBeDefined();
  });

  // FORK 2026-10-01 (bug-log [pool-sweep-kills-working-child]): at 14:29:33 the sweep stopped a
  // child still running a background Workflow after its turn, and another working a turn the
  // gateway was not tracking. Both were printing; neither was idle. CONTROL: before the fix the
  // first test fails, the worker is killed.
  it("does NOT reap a non-busy worker whose child is still printing", () => {
    const pool = makePool({ idleTtlMs: 1_000 });
    const a = pool.getOrCreate(makeParams("A")) as unknown as FakeWorker;

    clock = 60_000;
    a.activityAt = 59_500; // a line half a second ago, long after its last turn
    pool.getOrCreate(makeParams("B"));

    expect(a.killed).toBe(false);
    expect(pool.get("A")).toBeDefined();
  });

  it("reaps it once its output has been quiet past the TTL", () => {
    const pool = makePool({ idleTtlMs: 1_000 });
    const a = pool.getOrCreate(makeParams("A")) as unknown as FakeWorker;

    clock = 60_000;
    a.activityAt = 58_000;
    pool.getOrCreate(makeParams("B"));

    expect(a.killed).toBe(true);
  });

  it("evicts the quietest worker first when over the cap", () => {
    const pool = makePool({ maxWorkers: 2, idleTtlMs: 60 * 60_000 });
    const a = pool.getOrCreate(makeParams("A")) as unknown as FakeWorker;
    clock = 1_000;
    const b = pool.getOrCreate(makeParams("B")) as unknown as FakeWorker;
    a.activityAt = 5_000; // A's child is printing; B has been quiet since its turn
    clock = 6_000;
    pool.getOrCreate(makeParams("C"));

    expect(a.killed).toBe(false);
    expect(b.killed).toBe(true);
  });

  it("does NOT reap an idle worker that is still busy with a turn", () => {
    const pool = makePool({ idleTtlMs: 1_000 });
    const a = pool.getOrCreate(makeParams("A")) as unknown as FakeWorker;
    a.setBusy(true);

    clock = 60_000;
    pool.getOrCreate(makeParams("B"));

    expect(a.killed).toBe(false);
    expect(pool.get("A")).toBeDefined();
  });

  it("enforces an LRU cap, evicting the least-recently-used non-busy worker", () => {
    const pool = makePool({ maxWorkers: 2, idleTtlMs: 60 * 60_000 });

    clock = 1;
    const a = pool.getOrCreate(makeParams("A")) as unknown as FakeWorker;
    clock = 2;
    pool.getOrCreate(makeParams("B"));
    clock = 3;
    pool.getOrCreate(makeParams("C")); // exceeds cap of 2 → evict LRU (A)

    expect(a.killed).toBe(true);
    expect(pool.get("A")).toBeUndefined();
    expect(pool.get("B")).toBeDefined();
    expect(pool.get("C")).toBeDefined();
  });

  it("returns the same live worker for a repeated sessionKey without recreating it", () => {
    const pool = makePool();
    const first = pool.getOrCreate(makeParams("A"));
    const second = pool.getOrCreate(makeParams("A"));

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
  });

  it("recreates a warm idle worker when thinkLevel changes", () => {
    const pool = makePool();
    pool.getOrCreate(makeParams("A", "low"));
    const first = created[0];
    expect(first.isBusy()).toBe(false);

    pool.getOrCreate(makeParams("A", "high"));

    // The stale-level worker is evicted and a fresh one spawned in its place.
    expect(first.killed).toBe(true);
    expect(created).toHaveLength(2);
    const second = created[1];
    expect(second).not.toBe(first);
    expect(second.thinkLevel).toBe("high");
    expect(pool.get("A")).toBe(second as unknown as ReturnType<SessionWorkerPool["getOrCreate"]>);
  });

  it("recreates a warm idle worker when the model changes (no thinkLevel change)", () => {
    const pool = makePool();
    pool.getOrCreate(makeParams("A", "low", "claude-code/claude-sonnet-4-5"));
    const first = created[0];
    expect(first.isBusy()).toBe(false);

    pool.getOrCreate(makeParams("A", "low", "claude-code/claude-opus-4-8"));

    // Same think level, but the model pin changed → the warm worker is evicted
    // and a fresh one spawned, instead of lagging a turn.
    expect(first.killed).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(first);
  });

  it("does NOT recreate a BUSY worker on think-level change; records pending", () => {
    const pool = makePool();
    const first = pool.getOrCreate(makeParams("A", "low")) as unknown as FakeWorker;
    first.setBusy(true);

    const same = pool.getOrCreate(makeParams("A", "high")) as unknown as FakeWorker;

    // A busy worker can't be recycled mid-turn — same instance, still alive,
    // and the desired level is parked for the worker to pick up next turn.
    expect(same).toBe(first);
    expect(first.killed).toBe(false);
    expect(created).toHaveLength(1);
    expect(pool.takeThinkLevelPending("A")).toEqual({ requested: "high", running: "low" });
  });

  it("does NOT recycle on a cosmetic off/empty/undefined level change", () => {
    const pool = makePool();
    const first = pool.getOrCreate(makeParams("A", "off")) as unknown as FakeWorker;
    expect(first.isBusy()).toBe(false);

    const same = pool.getOrCreate(makeParams("A", "")) as unknown as FakeWorker;

    // off / "" / undefined all mean "no thinking budget" — treat as equal so
    // a no-op toggle doesn't pointlessly kill a warm worker.
    expect(same).toBe(first);
    expect(first.killed).toBe(false);
    expect(created).toHaveLength(1);
  });

  // FORK 2026-10-09 (effort per turn): an adaptive-effort model takes each turn's level on its live
  // process (worker.ts applyTurnEffort), so a level change must not cost it a cold respawn.
  // CONTROL: before this change the first test fails, the worker is killed and a second spawned.
  it("keeps a warm adaptive-effort worker when only the think level changes", () => {
    const pool = makePool();
    const get = (level: string) =>
      pool.getOrCreate(makeParams("A", level, "claude-opus-5-5")) as unknown as FakeWorker;
    const first = get("low");

    const same = get("max");

    expect(same).toBe(first);
    expect(first.killed).toBe(false);
    expect(created).toHaveLength(1);
    expect(pool.takeThinkLevelPending("A")).toBeUndefined();
  });

  it("parks no pending level for a BUSY adaptive-effort worker", () => {
    const pool = makePool();
    const get = (level: string) =>
      pool.getOrCreate(
        makeParams("A", level, "claude-code/claude-sonnet-5-5"),
      ) as unknown as FakeWorker;
    const first = get("low");
    first.setBusy(true);

    const same = get("high");

    expect(same).toBe(first);
    expect(created).toHaveLength(1);
    expect(pool.takeThinkLevelPending("A")).toBeUndefined();
  });

  it("still respawns an older model on a think-level change (its budget is baked in at spawn)", () => {
    const pool = makePool();
    const first = pool.getOrCreate(
      makeParams("A", "low", "claude-sonnet-4-6"),
    ) as unknown as FakeWorker;

    pool.getOrCreate(makeParams("A", "high", "claude-sonnet-4-6"));

    expect(first.killed).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1].thinkLevel).toBe("high");
  });

  it("still respawns an adaptive-effort worker when the model changes", () => {
    const pool = makePool();
    const first = pool.getOrCreate(
      makeParams("A", "high", "claude-opus-5-5"),
    ) as unknown as FakeWorker;

    pool.getOrCreate(makeParams("A", "high", "claude-sonnet-5-5"));

    expect(first.killed).toBe(true);
    expect(created).toHaveLength(2);
  });
});

// FORK 2026-09-30 (lifecycles.md L4b): workers the last gateway left on the file transport.
describe("SessionWorkerPool adopted workers", () => {
  class FileFake extends FakeWorker {
    detached = false;
    constructor(
      sessionKey: string,
      readonly openclawSessionKey: string,
      busy = false,
    ) {
      super({ sessionKey, cwd: "/tmp" } as WorkerSpawnParams, busy);
    }
    isFileTransport(): boolean {
      return !this.detached;
    }
    detach(): void {
      this.detached = true;
    }
  }

  function makePool() {
    const created: FakeWorker[] = [];
    const pool = new SessionWorkerPool({
      ...QUIET,
      createWorker: (params) => {
        const w = new FakeWorker(params);
        created.push(w);
        return w as unknown as ReturnType<SessionWorkerPool["getOrCreate"]>;
      },
    });
    return { pool, created };
  }

  it("hands an adopted worker to its session's first turn even when the pool key changed", () => {
    const { pool, created } = makePool();
    const adopted = new FileFake("tinker-sp-old", "agent:main:tinker:x", true);
    pool.adopt(adopted, { model: "m" });

    // an upgrade changed the system prompt, so the stream derives a new pool key
    const got = pool.getOrCreate({
      sessionKey: "tinker-sp-new",
      cwd: "/tmp",
      model: "m",
      openclawSessionKey: "agent:main:tinker:x",
    } as WorkerSpawnParams);

    expect(got).toBe(adopted);
    expect(created).toHaveLength(0); // no second claude on the same CLI session
    expect(pool.get("tinker-sp-old")).toBeUndefined();
  });

  it("keeps file workers attached at SIGTERM (the drain needs them) and lets go of them at exit", () => {
    const { pool } = makePool();
    const file = new FileFake("tinker-sp-f", "agent:main:tinker:f");
    pool.adopt(file, {});
    const pipe = pool.getOrCreate(makeParams("tinker-sp-p")) as unknown as FakeWorker;

    pool.killAll({ keepFileWorkers: true });
    expect(pipe.killed).toBe(true);
    expect(file.detached).toBe(false);
    expect(pool.fileWorkers()).toHaveLength(1);

    pool.killAll();
    expect(file.detached).toBe(true);
    expect(file.killed).toBe(false); // never killed: the next gateway adopts it
  });
});

// bug-log [twin-worker-on-prompt-change] (2026-10-15): another chat appended a line to TOOLS.md,
// the Jira tab's next turn hashed to a new pool key, and a second claude resumed the same CLI
// session while the first, busy with a background Workflow, kept running it too.
describe("SessionWorkerPool one worker per chat", () => {
  class ChatFake extends FakeWorker {
    readonly openclawSessionKey?: string;
    readonly openclawSessionId?: string;
    readonly resumeSessionId?: string;
    constructor(params: WorkerSpawnParams) {
      super(params);
      this.openclawSessionKey = params.openclawSessionKey;
      this.openclawSessionId = params.openclawSessionId;
      this.resumeSessionId = params.resumeSessionId;
    }
  }

  function makePool() {
    const created: ChatFake[] = [];
    const pool = new SessionWorkerPool({
      ...QUIET,
      createWorker: (params) => {
        const w = new ChatFake(params);
        created.push(w);
        return w as unknown as ReturnType<SessionWorkerPool["getOrCreate"]>;
      },
    });
    return { pool, created };
  }

  const chatParams = (
    sessionKey: string,
    openclawSessionKey = "agent:main:tinker:jira",
    openclawSessionId = "conv-1",
  ) =>
    ({
      sessionKey,
      cwd: "/tmp",
      model: "m",
      openclawSessionKey,
      openclawSessionId,
    }) as WorkerSpawnParams;

  it("hands a busy worker to its chat's next turn when the pool key changed", () => {
    const { pool, created } = makePool();
    const first = pool.getOrCreate(chatParams("tinker-sp-old")) as unknown as ChatFake;
    first.setBusy(true); // a background Workflow is still running in it

    const got = pool.getOrCreate(chatParams("tinker-sp-new"));

    expect(got).toBe(first);
    expect(created).toHaveLength(1); // no second claude on the same CLI session
    expect(first.killed).toBe(false);
    expect(pool.get("tinker-sp-new")).toBe(first);
    expect(pool.get("tinker-sp-old")).toBeUndefined();
  });

  it("replaces an idle worker of the same chat, resuming its CLI session, when the pool key changed", () => {
    const { pool, created } = makePool();
    const first = pool.getOrCreate(chatParams("tinker-sp-old")) as unknown as ChatFake;
    first.sessionId = "cli-1";

    const got = pool.getOrCreate(chatParams("tinker-sp-new")) as unknown as ChatFake;

    expect(got).not.toBe(first);
    expect(first.killed).toBe(true); // the old prompt's process does not run beside the new one
    expect(created).toHaveLength(2);
    expect(got.resumeSessionId).toBe("cli-1");
    expect(pool.get("tinker-sp-old")).toBeUndefined();
  });

  it("respawns the claimed worker with the new prompt once it is idle, resuming its CLI session", () => {
    const { pool, created } = makePool();
    const first = pool.getOrCreate(chatParams("tinker-sp-old")) as unknown as ChatFake;
    first.sessionId = "cli-1";
    first.setBusy(true);
    pool.getOrCreate(chatParams("tinker-sp-new")); // the busy worker takes this turn

    first.setBusy(false); // the Workflow ended
    const got = pool.getOrCreate(chatParams("tinker-sp-new")) as unknown as ChatFake;

    expect(first.killed).toBe(true);
    expect(created).toHaveLength(2);
    expect(got.resumeSessionId).toBe("cli-1");
    expect(pool.getOrCreate(chatParams("tinker-sp-new"))).toBe(got); // and then it stays warm
  });

  it("gives a reset tab (new conversation id) its own worker, never the old CLI session", () => {
    const { pool, created } = makePool();
    const old = pool.getOrCreate(chatParams("tinker-sp-old")) as unknown as ChatFake;
    old.sessionId = "cli-1";

    const got = pool.getOrCreate(
      chatParams("tinker-sp-new", "agent:main:tinker:jira", "conv-2"),
    ) as unknown as ChatFake;

    expect(got).not.toBe(old);
    expect(created).toHaveLength(2);
    expect(got.resumeSessionId).not.toBe("cli-1");
  });

  it("leaves another chat's worker alone", () => {
    const { pool, created } = makePool();
    const other = pool.getOrCreate(
      chatParams("tinker-sp-a", "agent:main:tinker:other"),
    ) as unknown as ChatFake;
    other.setBusy(true);

    const got = pool.getOrCreate(chatParams("tinker-sp-b"));

    expect(got).not.toBe(other);
    expect(other.killed).toBe(false);
    expect(created).toHaveLength(2);
  });
});

// FORK 2026-10-19 (JarvisPi OOM, 21:12): 22 idle `temp:jev-explain:<runId>` workers and 4 idle
// `agent:main:fractal:<id>` workers held 11.3 GB RSS plus all 2 GB of swap on the 16 GB Pi, and the
// kernel killed the gateway. Each of those sessions runs once; the pool parked them for 15 min and
// swept only inside getOrCreate.
describe("SessionWorkerPool 2026-10-19 rules: one-shot sessions, timed sweep, memory pressure", () => {
  // The real worker carries its canonical session key (worker.ts `openclawSessionKey`).
  class KeyedFake extends FakeWorker {
    readonly openclawSessionKey?: string;
    constructor(params: WorkerSpawnParams) {
      super(params);
      this.openclawSessionKey = params.openclawSessionKey;
    }
  }

  let clock: number;
  let free: number;

  beforeEach(() => {
    clock = 0;
    free = 64 * GiB;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePool(opts: SessionWorkerPoolOptions = {}) {
    return new SessionWorkerPool({
      now: () => clock,
      maxWorkers: 32,
      idleTtlMs: 15 * 60_000,
      sweepIntervalMs: 0,
      freeMemBytes: () => free,
      memoryFloorBytes: 2 * GiB,
      createWorker: (params) =>
        new KeyedFake(params) as unknown as ReturnType<SessionWorkerPool["getOrCreate"]>,
      ...opts,
    });
  }

  /** A turn for pool key `key` (getOrCreate, which also sweeps); `canonical` = openclaw session key. */
  const turn = (pool: SessionWorkerPool, key: string, canonical?: string) =>
    pool.getOrCreate({
      ...makeParams(key),
      openclawSessionKey: canonical,
    } as WorkerSpawnParams) as unknown as KeyedFake;

  it("names one-shot sessions: temp:* and *:fractal:*", () => {
    expect(isOneShotSessionKey("temp:jev-explain:x")).toBe(true);
    expect(isOneShotSessionKey("agent:main:fractal:y")).toBe(true);
    expect(isOneShotSessionKey("agent:main:tinker:z")).toBe(false);
    expect(isOneShotSessionKey("tinker-sp-1a2b3c4d")).toBe(false);
  });

  it("retires an idle one-shot worker (Jev explanation, Fractal) after 61 s; a chat worker idle as long stays", () => {
    const pool = makePool();
    const jev = turn(pool, "temp:jev-explain:x");
    const fractal = turn(pool, "agent:main:fractal:y");
    const chat = turn(pool, "agent:main:tinker:z");

    clock = 59_000;
    turn(pool, "agent:main:tinker:other"); // a sweep inside the one-shot TTL
    expect(jev.killed).toBe(false);
    expect(fractal.killed).toBe(false);

    clock = 61_000;
    turn(pool, "agent:main:tinker:other");

    expect(jev.killed).toBe(true);
    expect(fractal.killed).toBe(true);
    expect(chat.killed).toBe(false);
    expect(pool.get("temp:jev-explain:x")).toBeUndefined();
    expect(pool.get("agent:main:fractal:y")).toBeUndefined();
    expect(pool.get("agent:main:tinker:z")).toBeDefined();
  });

  // In production the pool key is the stream's `tinker-sp-<hash>`; only the canonical session key
  // the worker carries says it ran a Jev explanation.
  it("reads the one-shot rule from the canonical session key under a hashed pool key", () => {
    const pool = makePool();
    const jev = turn(pool, "tinker-sp-0000a001", "temp:jev-explain:jev-explain-1-abc");
    const chat = turn(pool, "tinker-sp-0000a002", "agent:main:tinker:z");

    clock = 61_000;
    turn(pool, "tinker-sp-0000a003", "agent:main:tinker:other");

    expect(jev.killed).toBe(true);
    expect(chat.killed).toBe(false);
  });

  it("never retires a busy one-shot worker", () => {
    const pool = makePool();
    const jev = turn(pool, "temp:jev-explain:x");
    jev.setBusy(true);

    clock = 10 * 60_000;
    turn(pool, "agent:main:tinker:other");

    expect(jev.killed).toBe(false);
    expect(pool.get("temp:jev-explain:x")).toBeDefined();
  });

  it("counts a one-shot child's output as activity", () => {
    const pool = makePool();
    const fractal = turn(pool, "agent:main:fractal:y");
    fractal.activityAt = 30_000; // still printing after its turn

    clock = 61_000; // 61 s after the turn, 31 s after the last line
    turn(pool, "agent:main:tinker:other");

    expect(fractal.killed).toBe(false);
  });

  it("sweeps on its own timer, so a quiet house still retires one-shot workers", () => {
    vi.useFakeTimers();
    const pool = makePool({ sweepIntervalMs: SWEEP_INTERVAL_MS });
    expect(vi.getTimerCount()).toBe(0); // lazy: no worker, no timer
    const jev = turn(pool, "temp:jev-explain:x");
    const chat = turn(pool, "agent:main:tinker:z");
    expect(vi.getTimerCount()).toBe(1); // armed once, by the first worker

    clock = 61_000; // and no getOrCreate from here on
    expect(jev.killed).toBe(false);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(jev.killed).toBe(true);
    expect(chat.killed).toBe(false);
    pool.dispose();
  });

  it("retires an adopted one-shot worker by the same rule; adopt() arms the timer", () => {
    vi.useFakeTimers();
    const pool = makePool({ sweepIntervalMs: SWEEP_INTERVAL_MS });
    const left = new KeyedFake({
      ...makeParams("tinker-sp-0000b001"),
      openclawSessionKey: "agent:main:fractal:P1",
    });
    pool.adopt(left, {});
    expect(vi.getTimerCount()).toBe(1);

    clock = 61_000;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(left.killed).toBe(true);
    expect(pool.get("tinker-sp-0000b001")).toBeUndefined();
    pool.dispose();
  });

  it("stops the timer on dispose() and on killAll(); sweepIntervalMs 0 never starts one", () => {
    vi.useFakeTimers();
    turn(makePool(), "agent:main:tinker:z"); // sweepIntervalMs: 0
    expect(vi.getTimerCount()).toBe(0);

    const a = makePool({ sweepIntervalMs: SWEEP_INTERVAL_MS });
    const jev = turn(a, "temp:jev-explain:x");
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
    clock = 61_000;
    vi.advanceTimersByTime(3 * SWEEP_INTERVAL_MS);
    expect(jev.killed).toBe(false); // no sweep ran

    const b = makePool({ sweepIntervalMs: SWEEP_INTERVAL_MS });
    turn(b, "agent:main:tinker:z");
    expect(vi.getTimerCount()).toBe(1);
    b.killAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("under memory pressure stops at most 2 idle workers a sweep, one-shot first, then the quietest; never busy, fresh or the one asked for", () => {
    // TTLs out of the way: only the pressure rule acts here.
    const pool = makePool({ idleTtlMs: 60 * 60_000, oneShotIdleTtlMs: 60 * 60_000 });
    const asking = turn(pool, "agent:main:tinker:asking"); // the quietest of all until it is asked for
    clock = 1_000;
    const chatOld = turn(pool, "agent:main:tinker:old");
    clock = 2_000;
    const busyJev = turn(pool, "temp:jev-explain:busy");
    busyJev.setBusy(true);
    clock = 3_000;
    const chatMid = turn(pool, "agent:main:tinker:mid");
    clock = 4_000;
    const fractal = turn(pool, "agent:main:fractal:f");
    clock = 270_000;
    const fresh = turn(pool, "agent:main:tinker:fresh"); // idle 30 s at the sweep below

    clock = 300_000;
    free = 1 * GiB; // under the 2 GiB floor
    turn(pool, "agent:main:tinker:asking");

    expect(fractal.killed).toBe(true); // one-shot first
    expect(chatOld.killed).toBe(true); // then the least recently seen
    expect(chatMid.killed).toBe(false); // a third is over the 2 a sweep
    expect(busyJev.killed).toBe(false);
    expect(fresh.killed).toBe(false);
    expect(asking.killed).toBe(false);

    // Still under the floor: the next sweep measures again and takes the next one.
    clock = 301_000;
    turn(pool, "agent:main:tinker:asking");

    expect(chatMid.killed).toBe(true);
    expect(fresh.killed).toBe(false); // idle 31 s, under PRESSURE_MIN_IDLE_MS
    expect(busyJev.killed).toBe(false);
    expect(asking.killed).toBe(false);
  });

  it("stops nothing for memory when free memory is at or above the floor", () => {
    const pool = makePool({ idleTtlMs: 60 * 60_000, oneShotIdleTtlMs: 60 * 60_000 });
    const jev = turn(pool, "temp:jev-explain:x");
    const chat = turn(pool, "agent:main:tinker:z");

    clock = 10 * 60_000;
    free = 2 * GiB; // exactly the floor
    turn(pool, "agent:main:tinker:other");

    expect(jev.killed).toBe(false);
    expect(chat.killed).toBe(false);
  });

  it("scales the default cap with RAM: one worker per GiB, between 4 and 32", () => {
    expect(defaultMaxWorkers(2 * GiB)).toBe(4);
    expect(defaultMaxWorkers(15.84 * GiB)).toBe(15); // the Pi
    expect(defaultMaxWorkers(128 * GiB)).toBe(32);
  });
});
