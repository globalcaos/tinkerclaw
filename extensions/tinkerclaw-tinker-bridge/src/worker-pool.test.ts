import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkerPool } from "./worker-pool.js";
import type { WorkerSpawnParams } from "./worker.js";

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
