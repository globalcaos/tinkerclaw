/**
 * The background pack refresh is the gateway's largest single CPU cost: a full-corpus FTS scan
 * per refresh, measured at 15-239 s of chunked main-thread work, and refreshes from several tabs
 * used to OVERLAP because each stale tab's turn started its own. `createPackRefreshScheduler`
 * makes them single-flight, coalesced and rate-limited per session. These tests pin each of
 * those properties with the real timers faked, so "never overlaps" is checked across simulated
 * minutes rather than inferred from one tick.
 */
import { readFileSync } from "node:fs";
import type { EventStore } from "openclaw/plugin-sdk/memory-engram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CachedPack,
  createPackRefreshScheduler,
  createPackWriter,
  PACK_REFRESH_MIN_INTERVAL_MS,
  PACK_REFRESH_WATCHDOG_MS,
  packRefreshInputs,
} from "../index.js";

type Args = { sessionKey: string; tag: string };

type Deferred = { resolve: () => void; reject: (err: unknown) => void };

/** A `run` whose every call stays in flight until the test settles it. */
function controllableRun() {
  const started: string[] = [];
  const pending = new Map<string, Deferred>();
  let active = 0;
  let maxActive = 0;
  const run = (args: Args): Promise<void> => {
    started.push(args.tag);
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve, reject) => {
      pending.set(args.tag, { resolve, reject });
    }).finally(() => {
      active--;
    });
  };
  return {
    run,
    started,
    maxActive: () => maxActive,
    finish(tag: string) {
      const d = pending.get(tag);
      if (!d) {
        throw new Error(`run ${tag} was never started`);
      }
      d.resolve();
    },
    fail(tag: string, err: unknown) {
      pending.get(tag)?.reject(err);
    },
  };
}

/**
 * Runs everything due now. The scheduler starts work on setImmediate, and fake timers place a
 * zero-delay timer created DURING a tick 1 ms later — so a 0 ms advance would leave it unrun and
 * let every "has not started" assertion below pass vacuously. 1 ms reaches it.
 */
const flush = () => vi.advanceTimersByTimeAsync(1);

const req = (sessionKey: string, tag: string): [string, Args] => [sessionKey, { sessionKey, tag }];

describe("createPackRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs on the caller's tick", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    expect(h.started).toEqual([]);
    await flush();
    expect(h.started).toEqual(["a1"]);
  });

  it("never overlaps: a second session starts only after the first ends", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    s.request(...req("B", "b1"));
    await flush();
    expect(h.started).toEqual(["a1"]);

    // A request arriving mid-run pumps the queue again — that pump must not start B either.
    s.request(...req("C", "c1"));
    await flush();
    expect(h.started).toEqual(["a1"]);

    // However long A runs (short of the R38 watchdog), nothing starts beside it.
    await vi.advanceTimersByTimeAsync(PACK_REFRESH_WATCHDOG_MS - 1_000);
    expect(h.started).toEqual(["a1"]);

    h.finish("a1");
    await flush();
    expect(h.started).toEqual(["a1", "b1"]);
    h.finish("b1");
    await flush();
    expect(h.started).toEqual(["a1", "b1", "c1"]);
    h.finish("c1");
    await flush();
    expect(h.maxActive()).toBe(1);
  });

  it("CONTROL: the harness does detect overlap — the pre-task shape runs both at once", async () => {
    // The shape this replaces: one setImmediate per request, guarded only per session. Without
    // this control the test above could pass on a harness that simply never observed overlap.
    const h = controllableRun();
    const inFlight = new Set<string>();
    const legacyRequest = (sessionKey: string, args: Args) => {
      setImmediate(() => {
        if (inFlight.has(sessionKey)) {
          return;
        }
        inFlight.add(sessionKey);
        void h.run(args).finally(() => inFlight.delete(sessionKey));
      });
    };
    legacyRequest(...req("A", "a1"));
    legacyRequest(...req("B", "b1"));
    await flush();
    expect(h.started).toEqual(["a1", "b1"]);
    expect(h.maxActive()).toBe(2);
  });

  it("is FIFO across sessions", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    s.request(...req("B", "b1"));
    s.request(...req("C", "c1"));
    await flush();
    h.finish("a1");
    await flush();
    h.finish("b1");
    await flush();
    expect(h.started).toEqual(["a1", "b1", "c1"]);
  });

  it("coalesces a QUEUED session: 3 rapid requests -> 1 run with the latest args", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    await flush();
    s.request(...req("B", "b1"));
    s.request(...req("B", "b2"));
    s.request(...req("B", "b3"));
    h.finish("a1");
    await flush();
    expect(h.started).toEqual(["a1", "b3"]);
    h.finish("b3");
    await vi.advanceTimersByTimeAsync(10 * PACK_REFRESH_MIN_INTERVAL_MS);
    expect(h.started).toEqual(["a1", "b3"]);
  });

  it("a replaced request keeps its place in the queue (latest args, original position)", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    await flush();
    s.request(...req("B", "b1"));
    s.request(...req("C", "c1"));
    s.request(...req("B", "b2"));
    h.finish("a1");
    await flush();
    h.finish("b2");
    await flush();
    expect(h.started).toEqual(["a1", "b2", "c1"]);
  });

  it("folds requests made DURING a run into exactly one follow-up, with the latest args", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    await flush();
    s.request(...req("A", "a2"));
    s.request(...req("A", "a3"));
    h.finish("a1");
    await flush();
    // The follow-up is a new refresh of the same session, so the interval applies to it.
    expect(h.started).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(PACK_REFRESH_MIN_INTERVAL_MS);
    expect(h.started).toEqual(["a1", "a3"]);
    h.finish("a3");
    await vi.advanceTimersByTimeAsync(10 * PACK_REFRESH_MIN_INTERVAL_MS);
    expect(h.started).toEqual(["a1", "a3"]);
  });

  it("honours the per-session minimum interval, measured from the END of the last run", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    await flush();
    // A long run (inside the R38 watchdog): the interval must count from its end, not its start.
    await vi.advanceTimersByTimeAsync(2 * PACK_REFRESH_MIN_INTERVAL_MS);
    h.finish("a1");
    // The run settles in microtasks at this fake instant, before the clock moves again.
    const endedAt = Date.now();
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    s.request(...req("A", "a2"));
    await vi.advanceTimersByTimeAsync(endedAt + PACK_REFRESH_MIN_INTERVAL_MS - 1 - Date.now());
    expect(h.started).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.started).toEqual(["a1", "a2"]);
  });

  it("a session waiting out its interval does not hold up other sessions", async () => {
    const h = controllableRun();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: () => false });
    s.request(...req("A", "a1"));
    await flush();
    h.finish("a1");
    await flush();
    s.request(...req("A", "a2")); // queued first, but not due for 60 s
    s.request(...req("B", "b1"));
    await flush();
    expect(h.started).toEqual(["a1", "b1"]);
  });

  it("a cold placeholder bypasses the interval — its first pack is not held back", async () => {
    const h = controllableRun();
    const cold = new Set<string>();
    const s = createPackRefreshScheduler<Args>({ run: h.run, isCold: (k) => cold.has(k) });
    s.request(...req("A", "a1"));
    await flush();
    h.finish("a1");
    await flush();

    // The refresh failed and the placeholder was re-seeded: the session holds nothing to serve.
    cold.add("A");
    s.request(...req("A", "a2"));
    await flush();
    expect(h.started).toEqual(["a1", "a2"]);
  });

  it("a refresh that throws or rejects does not wedge the queue", async () => {
    const errors: string[] = [];
    const started: string[] = [];
    const s = createPackRefreshScheduler<Args>({
      run: async (args) => {
        started.push(args.tag);
        if (args.tag === "a1") {
          throw new Error("boom");
        }
      },
      isCold: () => false,
      onError: (key, err) => errors.push(`${key}:${String(err)}`),
    });
    const syncThrow = createPackRefreshScheduler<Args>({
      run: (args) => {
        started.push(args.tag);
        if (args.tag === "c1") {
          throw new Error("sync boom");
        }
        return Promise.resolve();
      },
      isCold: () => false,
      onError: (key, err) => errors.push(`${key}:${String(err)}`),
    });
    s.request(...req("A", "a1"));
    s.request(...req("B", "b1"));
    syncThrow.request(...req("C", "c1"));
    syncThrow.request(...req("D", "d1"));
    await flush();
    await flush();
    expect(started).toEqual(["a1", "c1", "b1", "d1"]);
    expect(errors).toEqual(["A:Error: boom", "C:Error: sync boom"]);
  });

  // FORK 2026-09-24 — ruling R38: one refresh that never settles used to hold the single-flight
  // slot forever, so no session's pack was ever refreshed again until a restart.
  describe("watchdog (R38)", () => {
    const watched = (h: ReturnType<typeof controllableRun>, log: string[]) =>
      createPackRefreshScheduler<Args>({
        run: h.run,
        isCold: () => false,
        onAbandoned: (key, ms) => log.push(`abandoned ${key} after ${ms}`),
        onLateSettle: (key) => log.push(`late ${key}`),
      });

    it("abandons a refresh unsettled after 180 s: the queue moves on", async () => {
      expect(PACK_REFRESH_WATCHDOG_MS).toBe(180_000);
      const h = controllableRun();
      const log: string[] = [];
      const s = watched(h, log);
      s.request(...req("A", "a1"));
      s.request(...req("B", "b1"));
      await flush();
      await vi.advanceTimersByTimeAsync(PACK_REFRESH_WATCHDOG_MS - 10);
      expect(h.started).toEqual(["a1"]); // CONTROL: before the watchdog, B still waits
      await vi.advanceTimersByTimeAsync(20);
      expect(h.started).toEqual(["a1", "b1"]);
      expect(log).toEqual([`abandoned A after ${PACK_REFRESH_WATCHDOG_MS}`]);
    });

    it("a late settle of the abandoned refresh is ignored (logged once), not a second end", async () => {
      const h = controllableRun();
      const log: string[] = [];
      const s = watched(h, log);
      s.request(...req("A", "a1"));
      await flush();
      await vi.advanceTimersByTimeAsync(PACK_REFRESH_WATCHDOG_MS + 1);
      s.request(...req("B", "b1"));
      s.request(...req("C", "c1"));
      await flush();
      expect(h.started).toEqual(["a1", "b1"]);
      h.finish("a1"); // the abandoned run finally settles while B holds the slot
      await flush();
      expect(h.started).toEqual(["a1", "b1"]); // it freed nothing: C still waits for B
      expect(log).toEqual([`abandoned A after ${PACK_REFRESH_WATCHDOG_MS}`, "late A"]);
      h.finish("b1");
      await flush();
      expect(h.started).toEqual(["a1", "b1", "c1"]);
      expect(log).toHaveLength(2);
    });

    it("control: a refresh that settles in time is never abandoned", async () => {
      const h = controllableRun();
      const log: string[] = [];
      const s = watched(h, log);
      s.request(...req("A", "a1"));
      await flush();
      await vi.advanceTimersByTimeAsync(PACK_REFRESH_WATCHDOG_MS - 10);
      h.finish("a1");
      await vi.advanceTimersByTimeAsync(10 * PACK_REFRESH_WATCHDOG_MS);
      expect(log).toEqual([]);
    });
  });

  // FORK 2026-09-24 — ruling R38: a queued refresh can wait past a CC-experience reload
  // (getCcExperienceStore drops its memoised store when the file changes). Stores captured at
  // REQUEST time pinned the superseded object and the refresh indexed it anyway.
  describe("stores are resolved when the refresh runs (R38)", () => {
    const fakeStore = (name: string, events: number) =>
      ({ filePath: name, count: () => events }) as unknown as EventStore;

    it("a queued refresh searches the store current when it STARTS, with its count", async () => {
      const h = controllableRun();
      let cc = fakeStore("cc-old", 10);
      const session = fakeStore("session", 3);
      type RArgs = Args & {
        resolveStores?: () => { store: EventStore; ccStore: EventStore };
        captured?: { store: EventStore; ccStore: EventStore };
      };
      const ran: Record<string, EventStore> = {};
      const s = createPackRefreshScheduler<RArgs>({
        run: (args) => {
          if (args.tag === "a1") {
            return h.run(args);
          }
          // R38 shape: resolve now. The pre-R38 shape carried the objects from request time.
          const inputs = args.resolveStores
            ? packRefreshInputs(args.resolveStores)
            : { ccStore: args.captured!.ccStore };
          ran[args.tag] = inputs.ccStore;
          if (args.resolveStores) {
            expect(inputs).toMatchObject({ store: session, eventCount: 3, ccCount: 12 });
          }
          return Promise.resolve();
        },
        isCold: () => false,
      });
      s.request("A", { sessionKey: "A", tag: "a1" });
      s.request("B", {
        sessionKey: "B",
        tag: "b1",
        resolveStores: () => ({ store: session, ccStore: cc }),
      });
      // CONTROL: the old shape, captured at request time.
      s.request("C", { sessionKey: "C", tag: "c1", captured: { store: session, ccStore: cc } });
      await flush();
      cc = fakeStore("cc-new", 12); // the CC store reloads while B and C wait behind A
      h.finish("a1");
      await flush();
      await flush();
      expect(ran.b1?.filePath).toBe("cc-new");
      expect(ran.c1?.filePath).toBe("cc-old"); // the superseded store the old shape indexed
    });
  });
});

// -- Pack writes (FORK 2026-09-24, R38 follow-up) ------------------------------------------------
//
// A pack refresh the watchdog ABANDONED must not overwrite newer state when it finally settles.
// PACK_REFRESH_WATCHDOG_MS frees the single-flight slot but cannot cancel the refresh, which can
// settle minutes later (FTS worker timeout + in-thread fallback). Before `createPackWriter` it then
// wrote unconditionally — cache AND disk — so the OLDER query's pack replaced the one a newer
// refresh had built; and a late FAILURE dropped the cold placeholder a newer refresh was about to
// replace.
//
// These drive the REAL scheduler on faked timers, at the shipped constants, with a `run` shaped
// like refreshPackInBackground (begin -> await -> commit, or dropFailedPlaceholder on failure), so
// each claim is checked against the real abandonment sequence. The RED claims have a CONTROL that
// runs the pre-fix unconditional write through the same harness, so they cannot pass on a harness
// that never reproduces the overwrite. The last block pins that the production refresh really
// writes through the writer. The end-to-end write path (a refresh lands and is served next turn,
// across a restart) is index.cold-pack.test.ts.

const S = "agent:main:main";

const realPack = (pack: string, builtAtMs: number): CachedPack => ({
  pack,
  eventCount: 1,
  ccEventCount: 0,
  builtAtMs,
});

const placeholder = (builtAtMs: number): CachedPack => ({
  pack: "",
  eventCount: 1,
  ccEventCount: 0,
  builtAtMs,
  seeded: true,
});

/**
 * One session's refreshes through the real scheduler. Each run is shaped like
 * refreshPackInBackground: number itself, wait for the test to settle it, then commit its pack —
 * or, on failure, drop the placeholder. `unguarded` (the CONTROL) is the pre-fix write.
 */
function writerHarness(initial: CachedPack, mode: "guarded" | "unguarded" = "guarded") {
  const cache = new Map<string, CachedPack>([[S, initial]]);
  const persisted: string[] = [];
  const log: string[] = [];
  const gates = new Map<string, Deferred>();
  const writer = createPackWriter({
    cache,
    persist: (_sessionKey, entry) => {
      persisted.push(entry.pack);
    },
    log: (message) => {
      log.push(message);
    },
  });
  const scheduler = createPackRefreshScheduler<Args>({
    run: async ({ tag }) => {
      const runSeq = writer.begin(S);
      try {
        await new Promise<void>((resolve, reject) => {
          gates.set(tag, { resolve, reject });
        });
        const entry = realPack(tag, Date.now());
        if (mode === "guarded") {
          writer.commit(S, runSeq, entry);
        } else {
          cache.set(S, entry);
          persisted.push(entry.pack);
        }
      } catch {
        if (mode === "guarded") {
          writer.dropFailedPlaceholder(S, runSeq);
        } else if (cache.get(S)?.seeded) {
          cache.delete(S);
        }
      }
    },
    isCold: (key) => cache.get(key)?.seeded === true,
  });
  const gate = (tag: string): Deferred => {
    const g = gates.get(tag);
    if (!g) {
      throw new Error(`run ${tag} was never started`);
    }
    return g;
  };
  return {
    cache,
    persisted,
    log,
    started: () => [...gates.keys()],
    request: (tag: string) => scheduler.request(S, { sessionKey: S, tag }),
    finish: async (tag: string) => {
      gate(tag).resolve();
      await flush();
    },
    fail: async (tag: string) => {
      gate(tag).reject(new Error(`${tag} failed`));
      await flush();
    },
  };
}

/** a1 outlives the watchdog (abandoned for the queue, still in flight); then a2 starts. */
async function abandonA1ThenStartA2(h: ReturnType<typeof writerHarness>): Promise<void> {
  h.request("a1");
  await flush();
  expect(h.started()).toEqual(["a1"]);
  await vi.advanceTimersByTimeAsync(PACK_REFRESH_WATCHDOG_MS + 1);
  h.request("a2");
  // A warm session waits out the interval from a1's abandonment; a cold one is due at once.
  await vi.advanceTimersByTimeAsync(PACK_REFRESH_MIN_INTERVAL_MS + 10);
  expect(h.started()).toEqual(["a1", "a2"]);
}

describe("createPackWriter: an abandoned refresh cannot overwrite newer state (R38 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const old = () => realPack("old", Date.now() - 10 * 60_000);

  it("an abandoned refresh settling AFTER a newer one wrote leaves the newer pack, in cache and on disk", async () => {
    const h = writerHarness(old());
    await abandonA1ThenStartA2(h);
    await h.finish("a2");
    expect(h.cache.get(S)?.pack).toBe("a2");
    await h.finish("a1"); // the abandoned run finally settles
    expect(h.cache.get(S)?.pack).toBe("a2");
    expect(h.persisted).toEqual(["a2"]);
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain(`superseded pack refresh NOT written session=${S}`);
  });

  it("CONTROL: the pre-fix unconditional write puts the older pack back, in cache and on disk", async () => {
    const h = writerHarness(old(), "unguarded");
    await abandonA1ThenStartA2(h);
    await h.finish("a2");
    await h.finish("a1");
    expect(h.cache.get(S)?.pack).toBe("a1");
    expect(h.persisted).toEqual(["a2", "a1"]);
  });

  it("an abandoned refresh settling WHILE the newer one runs does not write either", async () => {
    // Every pack change respawns the claude-cli worker and rewrites the prompt-cache prefix, so a
    // superseded pack landing moments before the newer one would pay that twice for nothing.
    const h = writerHarness(old());
    await abandonA1ThenStartA2(h);
    await h.finish("a1");
    expect(h.cache.get(S)?.pack).toBe("old");
    expect(h.persisted).toEqual([]);
    expect(h.log).toHaveLength(1);
    await h.finish("a2");
    expect(h.cache.get(S)?.pack).toBe("a2");
    expect(h.persisted).toEqual(["a2"]);
  });

  it("an abandoned refresh nothing newer has started still writes: its pack is the freshest there is", async () => {
    // tookMs=238676 is the slowest refresh measured on the live gateway (the scheduler header):
    // abandoned at 180 s, it settles before a warm session's successor is even due at ~240 s.
    const h = writerHarness(old());
    h.request("a1");
    await flush();
    await vi.advanceTimersByTimeAsync(238_676 - 1);
    h.request("a2");
    await h.finish("a1");
    expect(h.started()).toEqual(["a1"]);
    expect(h.cache.get(S)?.pack).toBe("a1");
    expect(h.persisted).toEqual(["a1"]);
    expect(h.log).toEqual([]);
  });

  it("a normal refresh still writes, to the cache and to disk", async () => {
    const h = writerHarness(old());
    h.request("a1");
    await flush();
    await h.finish("a1");
    expect(h.cache.get(S)?.pack).toBe("a1");
    expect(h.persisted).toEqual(["a1"]);
    expect(h.log).toEqual([]);
  });

  it("a cold placeholder is replaced by the first real pack", async () => {
    const h = writerHarness(placeholder(Date.now()));
    h.request("a1");
    await flush();
    await h.finish("a1");
    expect(h.cache.get(S)).toMatchObject({ pack: "a1" });
    expect(h.cache.get(S)?.seeded).toBeUndefined();
    expect(h.persisted).toEqual(["a1"]);
  });

  it("a placeholder is replaced even by a superseded refresh: some memory beats none", async () => {
    const h = writerHarness(placeholder(Date.now()));
    await abandonA1ThenStartA2(h);
    await h.finish("a1");
    expect(h.cache.get(S)?.pack).toBe("a1");
    await h.finish("a2");
    expect(h.cache.get(S)?.pack).toBe("a2");
    expect(h.persisted).toEqual(["a1", "a2"]);
    expect(h.log).toEqual([]);
  });

  it("an abandoned refresh FAILING while a newer one runs keeps the placeholder the newer one replaces", async () => {
    const h = writerHarness(placeholder(Date.now()));
    await abandonA1ThenStartA2(h);
    await h.fail("a1");
    expect(h.cache.get(S)?.seeded).toBe(true);
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain(`superseded pack refresh failed session=${S}`);
    await h.finish("a2");
    expect(h.cache.get(S)?.pack).toBe("a2");
  });

  it("CONTROL: the pre-fix failure path drops the newer refresh's placeholder", async () => {
    const h = writerHarness(placeholder(Date.now()), "unguarded");
    await abandonA1ThenStartA2(h);
    await h.fail("a1");
    expect(h.cache.has(S)).toBe(false);
  });

  it("a failed refresh that is still the latest drops the placeholder, so the next turn retries", async () => {
    const h = writerHarness(placeholder(Date.now()));
    h.request("a1");
    await flush();
    await h.fail("a1");
    expect(h.cache.has(S)).toBe(false);
    expect(h.log).toEqual([]);
  });
});

// The cases above prove createPackWriter; these prove the production refresh uses it. A direct
// `packCache.set` or `persistPack(...)` left beside the commit would keep every case above green.
describe("refreshPackInBackground writes only through packWriter (wiring)", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  const start = source.indexOf("async function refreshPackInBackground(");
  const end = source.indexOf("const packRefreshScheduler = createPackRefreshScheduler");
  const body = source.slice(start, end);

  it("numbers the run before reading its inputs, commits and drops through the writer", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("packWriter.commit(sessionKey, runSeq, entry)");
    expect(body).toContain("packWriter.dropFailedPlaceholder(sessionKey, runSeq)");
    const begin = body.indexOf("packWriter.begin(sessionKey)");
    expect(begin).toBeGreaterThan(0);
    expect(begin).toBeLessThan(body.indexOf("packRefreshInputs("));
    expect(body).not.toMatch(/packCache\.(set|delete)\(/u);
  });

  it("nothing calls persistPack directly: its one appearance with a call paren is its definition", () => {
    expect(source.match(/\bpersistPack\(/gu)).toHaveLength(1);
  });
});
