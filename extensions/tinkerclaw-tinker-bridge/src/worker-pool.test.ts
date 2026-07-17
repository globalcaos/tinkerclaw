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
