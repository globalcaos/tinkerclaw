/**
 * FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/logging.md §4.8 and §4.9 (§9 steps 5 and 8): the FTS
 * worker's rows. The events writer is replaced by a recorder, so the rows themselves are asserted.
 * The `stats` round trip runs the REAL worker (fts-worker.ts through tsx, as fts-worker.test.ts
 * does); the failure paths use stub workers.
 *
 * CONTROL. Before this change there is no `stats` message, no threadStats, no
 * readFtsWorkerThreadStats and no row out of this module: every test here fails there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmitEventRecord } from "../../infra/events/emit.js";

const recorded = vi.hoisted(() => ({
  rows: [] as Array<{ name: string; record: Record<string, unknown> }>,
}));

vi.mock("../../infra/events/emit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/events/emit.js")>()),
  emitEvent: (name: string, record: EmitEventRecord = {}) => {
    recorded.rows.push({ name, record: { ...record } });
  },
}));

import { createEventStore, type EventStore } from "./event-store.js";
import {
  createFtsWorkerClient,
  FTS_WORKER_ENV,
  type FtsWorkerClient,
  FtsWorkerError,
  flushFtsRequestRollup,
  ftsSearchOffThread,
  readFtsWorkerThreadStats,
  setFtsWorkerForTest,
  spawnFtsWorker,
} from "./fts-worker-client.js";

const MiB = 1024 * 1024;
const QUERY = "retrieval pack";
const STUB_PREAMBLE = `const { parentPort } = require("node:worker_threads");`;
/** Answers every search with no hits, and never answers a stats probe. */
const ANSWERS_SEARCHES_ONLY = `${STUB_PREAMBLE} parentPort.on("message", (r) => { if (r.type === "stats") return; parentPort.postMessage({ id: r.id, ok: true, hits: [], corpus: { events: 0, loads: 1 } }); });`;
const EXITS = `${STUB_PREAMBLE} parentPort.on("message", () => process.exit(3));`;

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  recorded.rows.length = 0;
  dir = mkdtempSync(join(tmpdir(), "fts-worker-client-"));
  savedEnv = process.env[FTS_WORKER_ENV];
  delete process.env[FTS_WORKER_ENV];
});

afterEach(() => {
  setFtsWorkerForTest();
  if (savedEnv === undefined) {
    delete process.env[FTS_WORKER_ENV];
  } else {
    process.env[FTS_WORKER_ENV] = savedEnv;
  }
  rmSync(dir, { recursive: true, force: true });
});

function rowsNamed(name: string): Array<{ name: string; record: Record<string, unknown> }> {
  return recorded.rows.filter((row) => row.name === name);
}

function storeWithOneEvent(sessionKey: string): EventStore {
  const store = createEventStore({ baseDir: dir, sessionKey });
  store.append({
    turnId: 1,
    sessionKey,
    kind: "user_message",
    content: "retrieval pack gateway refresh",
    tokens: 6,
    metadata: { importance: 5 },
  });
  return store;
}

describe("the stats message — a round trip through the real worker", () => {
  it("answers from the worker's OWN isolate, and a probe never starts a worker", async () => {
    // The real fts-worker entry, under a distinctive 256 MB old-generation cap: a heap limit in
    // that band can only be the worker's isolate, never the test runner's.
    const client = createFtsWorkerClient({
      spawn: () =>
        spawnFtsWorker(
          (entry, options) =>
            new Worker(entry, { ...options, resourceLimits: { maxOldGenerationSizeMb: 256 } }),
        ),
    });
    try {
      await expect(client.threadStats(5_000)).resolves.toBeNull(); // nothing runs yet
      expect(rowsNamed("worker.spawn")).toHaveLength(0);

      await client.search(storeWithOneEvent("stats"), QUERY, 5);
      const stats = await client.threadStats(30_000);
      expect(stats).not.toBeNull();
      const isolate = stats?.isolate ?? null;
      expect(isolate).not.toBeNull();
      expect(isolate?.heapLimitBytes).toBeGreaterThanOrEqual(256 * MiB);
      expect(isolate?.heapLimitBytes).toBeLessThan(512 * MiB);
      expect(isolate?.usedHeapBytes).toBeGreaterThan(0);
      expect(isolate?.uptimeMs).toBeGreaterThan(0);
      // Its own clock: the thread started after this one, so its uptime is the shorter.
      expect(isolate?.uptimeMs).toBeLessThan(performance.now());
      expect(stats?.memBytes).toBe((isolate?.totalHeapBytes ?? 0) + (isolate?.externalBytes ?? 0));
      expect(stats?.peakBytes).toBe(stats?.memBytes);
      expect(stats?.requestsServed).toBe(1);

      const spawns = rowsNamed("worker.spawn");
      expect(spawns).toHaveLength(1);
      expect(spawns[0].record).toMatchObject({
        workerId: stats?.workerId,
        label: "fts_thread",
        fields: { resumed: false },
      });
    } finally {
      await client.shutdown();
    }
    const exits = rowsNamed("worker.exit");
    expect(exits).toHaveLength(1);
    expect(exits[0].record).toMatchObject({ label: "clean", fields: { turns_served: 1 } });
    expect(exits[0].record.n3).toBeGreaterThan(0); // the last probed memory rides the exit row
  });
});

describe("the stats probe is soft", () => {
  it("a probe the worker leaves unanswered reads as unavailable, and the worker keeps serving", async () => {
    const spawned: Worker[] = [];
    const client = createFtsWorkerClient({
      spawn: () => {
        const w = new Worker(ANSWERS_SEARCHES_ONLY, { eval: true });
        spawned.push(w);
        return w;
      },
    });
    const store = storeWithOneEvent("soft");
    try {
      await expect(client.search(store, QUERY, 5)).resolves.toEqual([]);
      await expect(client.threadStats(100)).resolves.toMatchObject({
        isolate: null,
        memBytes: null,
        requestsServed: 1,
      });
      await expect(client.search(store, QUERY, 5)).resolves.toEqual([]);
      expect(spawned).toHaveLength(1);
      expect(rowsNamed("worker.exit")).toHaveLength(0);
    } finally {
      await client.shutdown();
    }
  });

  it("a crash writes worker.exit with class crash and the exit code, and leaves nothing to probe", async () => {
    const client = createFtsWorkerClient({ spawn: () => new Worker(EXITS, { eval: true }) });
    await expect(client.search(storeWithOneEvent("crash"), QUERY, 5)).rejects.toBeInstanceOf(
      FtsWorkerError,
    );
    const exits = rowsNamed("worker.exit");
    expect(exits).toHaveLength(1);
    expect(exits[0].record).toMatchObject({ label: "crash", n1: 3, fields: { turns_served: 0 } });
    await expect(client.threadStats()).resolves.toBeNull();
  });
});

describe("the fts.* rows of the process-wide path", () => {
  it("writes every fallback as a row, even while the journal line is rate-limited", async () => {
    const lines: string[] = [];
    const client: FtsWorkerClient = {
      search: async () => {
        throw new FtsWorkerError("crash", "stub");
      },
      shutdown: async () => {},
    };
    setFtsWorkerForTest({ client, log: (message) => lines.push(message) });
    const store = storeWithOneEvent("fallback");
    await expect(ftsSearchOffThread(store, QUERY, 5)).resolves.toBeUndefined();
    await expect(ftsSearchOffThread(store, QUERY, 5)).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(rowsNamed("fts.fallback").map((row) => row.record.label)).toEqual(["crash", "crash"]);
  });

  it("rolls requests, worker time, fallbacks and kill-switch calls into one row, stamped at its window's start", async () => {
    let fail = false;
    const client: FtsWorkerClient = {
      search: async () => {
        if (fail) {
          throw new FtsWorkerError("timeout", "stub");
        }
        return [];
      },
      shutdown: async () => {},
    };
    setFtsWorkerForTest({ client, log: () => {} });
    const store = storeWithOneEvent("rollup");
    const before = Date.now();
    await ftsSearchOffThread(store, QUERY, 5);
    await ftsSearchOffThread(store, QUERY, 5);
    fail = true;
    await ftsSearchOffThread(store, QUERY, 5);
    process.env[FTS_WORKER_ENV] = "0";
    await expect(ftsSearchOffThread(store, QUERY, 5)).resolves.toBeUndefined();
    flushFtsRequestRollup();

    const rollups = rowsNamed("fts.request.minute");
    expect(rollups).toHaveLength(1);
    expect(rollups[0].record).toMatchObject({ n1: 3, n3: 1, n4: 1 });
    expect(rollups[0].record.n2).toBeGreaterThanOrEqual(0);
    expect(rollups[0].record.tsMs).toBeGreaterThanOrEqual(before);
    expect(rollups[0].record.tsMs).toBeLessThanOrEqual(Date.now());

    flushFtsRequestRollup(); // an empty window writes nothing
    expect(rowsNamed("fts.request.minute")).toHaveLength(1);
  });

  it("stamps a window at the rollup timer's slice, not at the first call inside it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_790_000_000_000);
      const client: FtsWorkerClient = { search: async () => [], shutdown: async () => {} };
      setFtsWorkerForTest({ client, log: () => {} });
      const store = storeWithOneEvent("anchor");
      await ftsSearchOffThread(store, QUERY, 5); // starts the timer: the first slice opens here
      flushFtsRequestRollup(); // the timer's tick: the next slice opens at 1_790_000_000_000
      vi.setSystemTime(1_790_000_059_000); // a call 59 s into that slice
      await ftsSearchOffThread(store, QUERY, 5);
      flushFtsRequestRollup();
      const rollups = rowsNamed("fts.request.minute");
      expect(rollups).toHaveLength(2);
      expect(rollups[1].record).toMatchObject({ tsMs: 1_790_000_000_000, n1: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("readFtsWorkerThreadStats never starts a worker, and reads a thread-less double as none", async () => {
    await expect(readFtsWorkerThreadStats()).resolves.toBeNull();
    setFtsWorkerForTest({ client: { search: async () => [], shutdown: async () => {} } });
    await expect(readFtsWorkerThreadStats()).resolves.toBeNull();
  });
});
