/**
 * FORK 2026-09-23 — the async pack assembly runs its FTS in the worker thread (plan task 16).
 *
 * `assembleRetrievalPackAsync` must still resolve to the string `assembleRetrievalPack` returns,
 * now with its FTS answered by the worker — and when the worker cannot answer (it failed, or the
 * kill switch is set), by the in-thread scan. FORK 2026-09-24 (ruling R34): every fallback is
 * logged at info, at most one line per failure kind per minute, with running counters; the kill
 * switch is not a fallback and logs nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { EventKind } from "./event-types.js";
import {
  createFtsWorkerClient,
  FTS_FALLBACK_LOG_INTERVAL_MS,
  FTS_WORKER_ENV,
  FtsWorkerError,
  setFtsWorkerForTest,
  type FtsWorkerClient,
  type FtsWorkerFailureKind,
} from "./fts-worker-client.js";
import { assembleRetrievalPack, assembleRetrievalPackAsync } from "./retrieval-integration.js";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  "retrieval",
  "pack",
  "gateway",
  "session",
  "refresh",
  "trigram",
  "candidate",
  "scheduler",
  "worker",
  "thread",
  "engram",
  "corpus",
  "Straße",
  "İstanbul",
  "日本語",
  "rocket🚀",
];
const KINDS: EventKind[] = ["user_message", "agent_message", "tool_result"];

function seed(store: EventStore, rng: () => number, count: number): void {
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(rng() * 30);
    const content = Array.from({ length: n }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(
      " ",
    );
    store.append({
      turnId: i,
      sessionKey: store.sessionKey,
      kind: KINDS[Math.floor(rng() * KINDS.length)],
      content,
      tokens: estimateTokens(content),
      metadata: { importance: 5, ...(rng() < 0.4 ? { taskId: "t1" } : {}) },
    });
  }
}

function query(rng: () => number): string {
  return Array.from({ length: 1 + Math.floor(rng() * 12) }, () =>
    WORDS[Math.floor(rng() * WORDS.length)].slice(0, 3 + Math.floor(rng() * 6)),
  ).join(" ");
}

const OPTIONS = [{ maxTokens: 4096 }, { maxTokens: 700 }, { maxTokens: 4096, taskId: "t1" }];

/** Every query x option: the async pack equals the sync one. Returns how many were non-empty. */
async function assertSamePacks(store: EventStore, rng: () => number, queries: number) {
  let nonEmpty = 0;
  for (let q = 0; q < queries; q++) {
    const text = query(rng);
    for (const options of OPTIONS) {
      const expected = assembleRetrievalPack(text, store, options);
      expect(await assembleRetrievalPackAsync(text, store, options), JSON.stringify(text)).toBe(
        expected,
      );
      if (expected) {
        nonEmpty++;
      }
    }
  }
  return nonEmpty;
}

/** A client that records calls and delegates, or fails with the given kinds in turn. */
function scriptedClient(
  behaviour: Array<FtsWorkerFailureKind | Error | "delegate">,
  real?: FtsWorkerClient,
) {
  const calls: string[] = [];
  const client: FtsWorkerClient = {
    search(store, text, topN, filters) {
      const step = behaviour[Math.min(calls.length, behaviour.length - 1)];
      calls.push(typeof step === "string" ? step : "throw");
      if (step === "delegate") {
        return real!.search(store, text, topN, filters);
      }
      return Promise.reject(
        step instanceof Error ? step : new FtsWorkerError(step, `scripted ${step}`),
      );
    },
    shutdown: () => real?.shutdown() ?? Promise.resolve(),
  };
  return { client, calls };
}

let dir: string;
let warnings: string[];
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pack-fts-worker-"));
  warnings = [];
  savedEnv = process.env[FTS_WORKER_ENV];
  delete process.env[FTS_WORKER_ENV];
});

afterEach(() => {
  vi.useRealTimers();
  setFtsWorkerForTest();
  if (savedEnv === undefined) {
    delete process.env[FTS_WORKER_ENV];
  } else {
    process.env[FTS_WORKER_ENV] = savedEnv;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("assembleRetrievalPackAsync with the FTS worker", () => {
  it("is byte-identical to the synchronous pack, with every FTS answered by the worker", async () => {
    const real = createFtsWorkerClient();
    const { client, calls } = scriptedClient(["delegate"], real);
    setFtsWorkerForTest({ client, log: (m) => warnings.push(m) });
    try {
      const rng = makeRng(21);
      const store = createEventStore({ baseDir: dir, sessionKey: "pack" });
      seed(store, rng, 500);
      const nonEmpty = await assertSamePacks(store, rng, 20);
      expect(nonEmpty).toBeGreaterThan(30); // power: not a battery of empty packs
      expect(calls).toHaveLength(60); // 20 queries x 3 options, none fell back
      expect(warnings).toEqual([]);

      // New events reach the worker's answer, and an appended-to store still matches.
      seed(store, rng, 60);
      await assertSamePacks(store, rng, 5);
      expect(warnings).toEqual([]);
    } finally {
      await real.shutdown();
    }
  });

  it("builds the pack from the worker's answer, not from a second in-thread search", async () => {
    // A client that answers "no hits" for a query the corpus does match: only a pack built from
    // the worker's answer comes out empty.
    const client: FtsWorkerClient = {
      search: async () => [],
      shutdown: async () => {},
    };
    setFtsWorkerForTest({ client, log: (m) => warnings.push(m) });
    const store = createEventStore({ baseDir: dir, sessionKey: "answer" });
    seed(store, makeRng(25), 300);
    expect(assembleRetrievalPack("retrieval pack", store, OPTIONS[0])).not.toBe("");
    expect(await assembleRetrievalPackAsync("retrieval pack", store, OPTIONS[0])).toBe("");
    expect(warnings).toEqual([]);
  });

  it("falls back in-thread on every failure, logging each kind at most once a minute with counters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000_000);
    const { client, calls } = scriptedClient([
      "spawn",
      "spawn",
      "backoff",
      "crash",
      "timeout",
      "view",
      "view",
      "request",
      "shutdown",
      "error",
      new TypeError("thrown on this thread"),
      "timeout",
    ]);
    setFtsWorkerForTest({ client, log: (m) => warnings.push(m) });
    const rng = makeRng(22);
    const store = createEventStore({ baseDir: dir, sessionKey: "fallback" });
    seed(store, rng, 400);

    for (let i = 0; i < 12; i++) {
      const text = query(rng);
      expect(await assembleRetrievalPackAsync(text, store, OPTIONS[0])).toBe(
        assembleRetrievalPack(text, store, OPTIONS[0]),
      );
    }
    expect(calls).toHaveLength(12);
    const kinds = () => warnings.map((w) => /^FTS worker (\w+) failure/.exec(w)?.[1]);
    // Every kind is a fallback to the in-thread scan, backoff and shutdown included; the TypeError
    // counts as a failed request. Repeats inside the minute (spawn, view, request, timeout) are
    // counted, not logged.
    expect(kinds()).toEqual([
      "spawn",
      "backoff",
      "crash",
      "timeout",
      "view",
      "request",
      "shutdown",
      "error",
    ]);
    expect(warnings[0]).toContain("fallbacks=1 spawn=1");
    expect(warnings[7]).toContain("fallbacks=10 error=1");

    // A minute later the same kind is logged again, with the running counters.
    vi.setSystemTime(5_000_000 + FTS_FALLBACK_LOG_INTERVAL_MS);
    await assembleRetrievalPackAsync(query(rng), store, OPTIONS[0]); // the script repeats "timeout"
    expect(kinds()).toHaveLength(9);
    expect(warnings[8]).toMatch(/^FTS worker timeout failure/);
    expect(warnings[8]).toContain("fallbacks=13 timeout=3");
    expect(FTS_FALLBACK_LOG_INTERVAL_MS).toBe(60_000);
  });

  it(`${FTS_WORKER_ENV}=0 keeps the FTS on the main thread without touching the worker`, async () => {
    const { client, calls } = scriptedClient(["spawn"]);
    setFtsWorkerForTest({ client, log: (m) => warnings.push(m) });
    process.env[FTS_WORKER_ENV] = "0";
    const rng = makeRng(23);
    const store = createEventStore({ baseDir: dir, sessionKey: "kill-switch" });
    seed(store, rng, 400);
    expect(await assertSamePacks(store, rng, 5)).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    expect(warnings).toEqual([]);

    // CONTROL: the same client IS consulted once the switch is off.
    delete process.env[FTS_WORKER_ENV];
    await assembleRetrievalPackAsync("retrieval pack", store, OPTIONS[0]);
    expect(calls).toEqual(["spawn"]);
  });

  it("does not consult the worker for a store small enough for one in-thread slice", async () => {
    const { client, calls } = scriptedClient(["spawn"]);
    setFtsWorkerForTest({ client, log: (m) => warnings.push(m) });
    const rng = makeRng(24);
    const store = createEventStore({ baseDir: dir, sessionKey: "small" });
    seed(store, rng, 200);
    await assertSamePacks(store, rng, 3);
    expect(calls).toEqual([]);
    seed(store, rng, 1); // 201 events: past the single-slice size
    await assembleRetrievalPackAsync("retrieval pack", store, OPTIONS[0]);
    expect(calls).toEqual(["spawn"]);
  });
});
