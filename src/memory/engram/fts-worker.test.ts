/**
 * FORK 2026-09-23 — the engram FTS worker thread (plan task 16).
 *
 * The worker must return EXACTLY what `ftsSearch` returns for the caller's snapshot — the same
 * events (the caller's own objects), in the same order, with Object.is-equal scores — while the
 * scan itself runs off the main thread. These tests run the real worker (fts-worker.ts, started
 * through tsx from source) against file-backed stores, and pin the ways its view of the file can
 * differ from the caller's: appends between requests, a second writer, a store-object swap, a
 * half-written line, a replaced file. The failure paths use stub workers.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { EventKind, MemoryEvent } from "./event-types.js";
import {
  createFtsWorkerClient,
  FTS_WORKER_MAX_OLD_GENERATION_MB,
  FTS_WORKER_TIMEOUT_MS,
  FtsWorkerError,
  ftsSearchOffThread,
  type FtsWorkerClient,
  type FtsWorkerFailureKind,
  resolveFtsWorkerEntry,
  setFtsWorkerForTest,
  spawnFtsWorker,
} from "./fts-worker-client.js";
import { createFtsWorkerHandler, fingerprintEvents } from "./fts-worker-core.js";
import { ftsSearch, type SearchFilters, type SearchResult } from "./search-index.js";

// ─── corpus ──────────────────────────────────────────────────────────────────

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Case folding that changes length (İ, the Kelvin sign), ß/SS, Greek, CJK, astral code points and
// combining marks: text where a byte-level mistake in the worker's line reader would show.
const WORDS = [
  "retrieval",
  "pack",
  "gateway",
  "session",
  "refresh",
  "trigram",
  "candidate",
  "scheduler",
  "event-loop",
  "readAll()",
  "v2.3.4",
  "aaaa",
  "abab",
  "banana",
  "nana",
  "café",
  "CAFÉ",
  "Straße",
  "STRASSE",
  "İstanbul",
  "Kelvin",
  "ΣΊΣΥΦΟΣ",
  "σίσυφος",
  "日本語テキスト",
  "テキスト",
  "rocket🚀launch",
  "𝒳𝒴𝒵",
  "éclair",
  "éclair",
];
const SEPARATORS = [" ", " ", " ", "\n", "\t", "\r\n", " ", "　", ""];
const KINDS: EventKind[] = ["user_message", "agent_message", "tool_result", "system_event"];
const T0 = Date.UTC(2026, 0, 1);

let seq = 0;
function makeEvent(rng: () => number, sessionKey: string): MemoryEvent {
  seq++;
  let content = "";
  const n = rng() < 0.05 ? 0 : 1 + Math.floor(rng() * 40);
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    content +=
      (rng() < 0.15 ? w.toUpperCase() : w) + SEPARATORS[Math.floor(rng() * SEPARATORS.length)];
  }
  return {
    id: `evt-${String(seq).padStart(6, "0")}`,
    timestamp: new Date(T0 + seq * 60_000).toISOString(),
    turnId: seq,
    sessionKey,
    kind: KINDS[Math.floor(rng() * KINDS.length)],
    content,
    tokens: estimateTokens(content),
    metadata: { importance: 5, ...(rng() < 0.5 ? { taskId: rng() < 0.5 ? "t1" : "t2" } : {}) },
  };
}

function randomQuery(rng: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rng() * 20);
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    const r = rng();
    if (r < 0.5) {
      parts.push(w);
    } else if (r < 0.8) {
      const from = Math.floor(rng() * w.length);
      parts.push(w.slice(from, from + 3 + Math.floor(rng() * 5)));
    } else if (r < 0.9) {
      parts.push(w.toUpperCase());
    } else {
      parts.push(["zzz", "no-such-term", "ab"][Math.floor(rng() * 3)]);
    }
    if (rng() < 0.2) {
      parts.push(parts[parts.length - 1]);
    }
  }
  return parts.join(" ");
}

const FILTERS: Array<SearchFilters | undefined> = [
  undefined,
  { taskId: "t1" },
  { kinds: ["user_message", "tool_result"] },
  {
    since: new Date(T0 + 100 * 60_000).toISOString(),
    until: new Date(T0 + 400 * 60_000).toISOString(),
  },
  { taskId: "t2", kinds: ["agent_message", "system_event"] },
];
const ALL = Number.MAX_SAFE_INTEGER;

function fill(store: EventStore, rng: () => number, count: number): void {
  for (let i = 0; i < count; i++) {
    store.appendRaw(makeEvent(rng, store.sessionKey));
  }
}

function expectSameHits(actual: SearchResult[], expected: SearchResult[], label: string): void {
  expect(actual.length, `${label}: hit count`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].event, `${label}: event #${i}`).toBe(expected[i].event);
    expect(Object.is(actual[i].score, expected[i].score), `${label}: score #${i}`).toBe(true);
    expect(actual[i].matchType, `${label}: matchType #${i}`).toBe("fts");
  }
}

/** Worker vs in-thread over `queries` random queries x every filter x three topN. */
async function assertParity(
  client: FtsWorkerClient,
  store: EventStore,
  rng: () => number,
  queries: number,
): Promise<void> {
  let compared = 0;
  let nonEmpty = 0;
  for (let q = 0; q < queries; q++) {
    const query = randomQuery(rng);
    for (const filters of FILTERS) {
      for (const topN of [ALL, 20, 3]) {
        const label = `query ${JSON.stringify(query)} filters=${JSON.stringify(filters)} topN=${topN}`;
        const expected = ftsSearch(store, query, topN, filters);
        expectSameHits(await client.search(store, query, topN, filters), expected, label);
        compared++;
        if (expected.length > 0) {
          nonEmpty++;
        }
      }
    }
  }
  // Power guard: a battery of empty results would pass against a worker that finds nothing.
  expect(nonEmpty / compared).toBeGreaterThan(0.5);
}

/** A store whose events the test controls, pointing at whatever file it names. */
function fakeStore(filePath: string, events: MemoryEvent[]): EventStore {
  return {
    filePath,
    sessionKey: "fake",
    append: () => {
      throw new Error("not used");
    },
    appendRaw: () => {
      throw new Error("not used");
    },
    readAll: () => [...events],
    readByKind: () => [],
    readRange: () => [],
    readById: () => undefined,
    count: () => events.length,
  };
}

async function expectFailure(promise: Promise<unknown>, kind: FtsWorkerFailureKind): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected a rejection of kind ${kind}`).toBeInstanceOf(FtsWorkerError);
  expect((err as FtsWorkerError).kind).toBe(kind);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fts-worker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── the real worker ─────────────────────────────────────────────────────────

describe("FTS worker thread — exact parity with ftsSearch", () => {
  let client: FtsWorkerClient;
  beforeAll(() => {
    client = createFtsWorkerClient();
  });
  afterAll(async () => {
    await client.shutdown();
  });

  it("returns the caller's own events, in order, with identical scores", async () => {
    const rng = makeRng(1);
    const store = createEventStore({ baseDir: dir, sessionKey: "parity" });
    fill(store, rng, 600);
    await assertParity(client, store, rng, 30);
  });

  it("stays exact as the same store appends between requests", async () => {
    const rng = makeRng(2);
    const store = createEventStore({ baseDir: dir, sessionKey: "grow" });
    fill(store, rng, 400);
    await assertParity(client, store, rng, 8);
    fill(store, rng, 150);
    await assertParity(client, store, rng, 8);
    fill(store, rng, 1);
    await assertParity(client, store, rng, 4);
  });

  it("answers for an OLDER snapshot while another writer has appended to the file", async () => {
    const rng = makeRng(3);
    const store = createEventStore({ baseDir: dir, sessionKey: "two-writers" });
    fill(store, rng, 400);
    expect(store.count()).toBe(400); // loads the cache: from here on this object sees 400
    fill(createEventStore({ baseDir: dir, sessionKey: "two-writers" }), rng, 80);

    await assertParity(client, store, rng, 8);
    // The file now holds 480; a fresh object sees them all, and so must the worker.
    const fresh = createEventStore({ baseDir: dir, sessionKey: "two-writers" });
    expect(fresh.count()).toBe(480);
    await assertParity(client, fresh, rng, 8);
  });

  it("maps hits onto the NEW store object after a swap for the same file", async () => {
    const rng = makeRng(4);
    const first = createEventStore({ baseDir: dir, sessionKey: "swap" });
    fill(first, rng, 300);
    await assertParity(client, first, rng, 4);
    const second = createEventStore({ baseDir: dir, sessionKey: "swap" });
    // expectSameHits compares identity, so this fails if hits came back as `first`'s objects.
    await assertParity(client, second, rng, 8);
  });

  it("ignores a half-written trailing line until its newline lands", async () => {
    const rng = makeRng(5);
    const store = createEventStore({ baseDir: dir, sessionKey: "partial" });
    fill(store, rng, 300);
    expect(store.count()).toBe(300);
    // Cut the BYTES, as a writer's buffer flush would — possibly inside a multi-byte character.
    const line = Buffer.from(`${JSON.stringify(makeEvent(rng, "partial"))}\n`);
    const cut = Math.floor(line.length / 2);
    appendFileSync(store.filePath, line.subarray(0, cut));

    await assertParity(client, store, rng, 6);
    appendFileSync(store.filePath, line.subarray(cut));
    const complete = createEventStore({ baseDir: dir, sessionKey: "partial" });
    expect(complete.count()).toBe(301);
    await assertParity(client, complete, rng, 6);
  });

  it("refuses, with kind 'view', a snapshot that is not the file's prefix", async () => {
    const rng = makeRng(6);
    const store = createEventStore({ baseDir: dir, sessionKey: "view" });
    fill(store, rng, 250);
    const events = store.readAll();
    const query = "retrieval pack gateway session";

    const edited = events.map((e, i) => (i === 100 ? { ...e, content: `${e.content} extra` } : e));
    await expectFailure(client.search(fakeStore(store.filePath, edited), query, 20), "view");

    const ahead = [...events, makeEvent(rng, "view")];
    await expectFailure(client.search(fakeStore(store.filePath, ahead), query, 20), "view");

    await expectFailure(
      client.search(fakeStore(join(dir, "events", "absent.jsonl"), events), query, 20),
      "view",
    );
    // The refusals left the worker healthy.
    expectSameHits(
      await client.search(store, query, 20),
      ftsSearch(store, query, 20),
      "after refusals",
    );
  });
});

// ─── the worker's corpus cache, in-thread ────────────────────────────────────

describe("FTS worker corpus cache", () => {
  function requestFor(store: EventStore, query = "retrieval pack") {
    const events = store.readAll();
    return {
      id: 1,
      filePath: store.filePath,
      query,
      topN: 20,
      count: events.length,
      fingerprint: fingerprintEvents(events),
    };
  }

  function corpusOf(response: ReturnType<ReturnType<typeof createFtsWorkerHandler>>) {
    if (!response.ok) {
      throw new Error(`unexpected refusal: ${response.kind} ${response.message}`);
    }
    return response.corpus;
  }

  it("tail-reads appended lines instead of re-reading the file", () => {
    const rng = makeRng(7);
    const handle = createFtsWorkerHandler();
    const store = createEventStore({ baseDir: dir, sessionKey: "tail" });
    fill(store, rng, 50);
    expect(corpusOf(handle(requestFor(store)))).toEqual({ events: 50, loads: 1 });
    fill(store, rng, 20);
    expect(corpusOf(handle(requestFor(store)))).toEqual({ events: 70, loads: 1 });
    // An OLDER snapshot after the file grew is answered from the same corpus.
    const older = fakeStore(store.filePath, store.readAll().slice(0, 30));
    expect(corpusOf(handle(requestFor(older)))).toEqual({ events: 70, loads: 1 });
  });

  it("re-reads from byte 0 when the file is replaced or truncated", () => {
    const rng = makeRng(8);
    const handle = createFtsWorkerHandler();
    const store = createEventStore({ baseDir: dir, sessionKey: "replace" });
    fill(store, rng, 40);
    expect(corpusOf(handle(requestFor(store))).loads).toBe(1);

    // Same length, new inode: only the identity check can notice.
    const tmp = `${store.filePath}.tmp`;
    writeFileSync(tmp, readFileSync(store.filePath));
    renameSync(tmp, store.filePath);
    expect(corpusOf(handle(requestFor(store)))).toEqual({ events: 40, loads: 2 });

    // Truncated in place to its first 10 lines.
    const lines = readFileSync(store.filePath, "utf-8").split("\n").slice(0, 10);
    writeFileSync(store.filePath, `${lines.join("\n")}\n`);
    const shorter = createEventStore({ baseDir: dir, sessionKey: "replace" });
    expect(corpusOf(handle(requestFor(shorter)))).toEqual({ events: 10, loads: 3 });
  });

  it("fails a request whose file has a line that does not parse, and starts over next time", () => {
    const rng = makeRng(9);
    const handle = createFtsWorkerHandler();
    const store = createEventStore({ baseDir: dir, sessionKey: "garbage" });
    fill(store, rng, 20);
    const request = requestFor(store);
    const good = readFileSync(store.filePath, "utf-8");
    writeFileSync(store.filePath, `${good}{not json\n`);
    const refused = handle(request);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.kind).toBe("request");

    writeFileSync(store.filePath, good);
    expect(corpusOf(handle(requestFor(store)))).toEqual({ events: 20, loads: 2 });
  });

  // FORK 2026-09-24 — ruling R34: a corpus the file no longer matches (rewritten in place: same
  // inode, no shrink, so the identity/size checks keep it) is dropped and re-read ONCE before a
  // refusal; it used to be refused until an eviction or a restart, i.e. searched in-thread.
  describe("a snapshot the corpus does not match (R34: re-read once)", () => {
    const ev = (n: number, content: string): MemoryEvent => ({
      id: `s-${String(n).padStart(3, "0")}`,
      timestamp: new Date(T0 + n * 1000).toISOString(),
      turnId: n,
      sessionKey: "stale",
      kind: "agent_message",
      content,
      tokens: 1,
      metadata: {},
    });
    const write = (path: string, events: MemoryEvent[]) =>
      writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    /** Event 19 is long, so its bytes can be re-cut into two events. */
    const base = () =>
      Array.from({ length: 20 }, (_, i) =>
        ev(i, `retrieval pack ${"a".repeat(i === 19 ? 400 : 10)}`),
      );

    it("a same-size in-place rewrite is re-read, then answered", () => {
      const handle = createFtsWorkerHandler();
      const path = join(dir, "stale.jsonl");
      const before = base();
      write(path, before);
      expect(corpusOf(handle(requestFor(fakeStore(path, before))))).toEqual({
        events: 20,
        loads: 1,
      });
      // Event 5 one char longer, event 6 one shorter: same bytes, same inode, new fingerprint.
      const after = base();
      after[5] = ev(5, `${after[5].content}a`);
      after[6] = ev(6, after[6].content.slice(0, -1));
      write(path, after);
      expect(corpusOf(handle(requestFor(fakeStore(path, after))))).toEqual({
        events: 20,
        loads: 2,
      });
    });

    it("a stale corpus holding FEWER events than the snapshot is re-read too", () => {
      const handle = createFtsWorkerHandler();
      const path = join(dir, "stale.jsonl");
      const before = base();
      write(path, before);
      handle(requestFor(fakeStore(path, before)));
      // The same bytes re-cut into 21 events (event 19 split in two): same size, same inode.
      const line19 = `${JSON.stringify(before[19])}\n`.length;
      const split = [...before.slice(0, 19), ev(19, "retrieval"), ev(20, "")];
      const pad = line19 - `${JSON.stringify(split[19])}\n${JSON.stringify(split[20])}\n`.length;
      split[20] = ev(20, "p".repeat(pad));
      write(path, split);
      expect(corpusOf(handle(requestFor(fakeStore(path, split))))).toEqual({
        events: 21,
        loads: 2,
      });
    });

    it("refuses 'view' when the snapshot still does not match after the one re-read", () => {
      const handle = createFtsWorkerHandler();
      const path = join(dir, "stale.jsonl");
      const events = base();
      write(path, events);
      expect(corpusOf(handle(requestFor(fakeStore(path, events)))).loads).toBe(1);
      const edited = events.map((e, i) => (i === 3 ? ev(3, `${e.content} extra`) : e));
      const refused = handle(requestFor(fakeStore(path, edited)));
      expect(!refused.ok && refused.kind).toBe("view");
      // Exactly one extra full read for that request, and the corpus still serves the file.
      expect(corpusOf(handle(requestFor(fakeStore(path, events))))).toEqual({
        events: 20,
        loads: 2,
      });
    });
  });

  it("keeps at most maxFiles files, dropping the least recently searched", () => {
    const rng = makeRng(10);
    const handle = createFtsWorkerHandler({ maxFiles: 2 });
    const [a, b, c] = ["a", "b", "c"].map((key) => {
      const store = createEventStore({ baseDir: dir, sessionKey: key });
      fill(store, rng, 10);
      return store;
    });
    for (const store of [a, b, a, c]) {
      handle(requestFor(store));
    }
    // c evicted b (least recent), not a.
    expect(corpusOf(handle(requestFor(a))).loads).toBe(1);
    expect(corpusOf(handle(requestFor(b))).loads).toBe(2);
  });
});

// ─── where the worker entry is found ─────────────────────────────────────────

describe("resolveFtsWorkerEntry", () => {
  function touch(relative: string): string {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    return path;
  }
  const url = (relative: string) => pathToFileURL(join(dir, relative)).href;

  it("from TypeScript source: the sibling fts-worker.ts, to be run through tsx", () => {
    const entry = resolveFtsWorkerEntry(url("src/memory/engram/fts-worker-client.ts"));
    expect(entry).toEqual({
      url: new URL(url("src/memory/engram/fts-worker.ts")),
      typescript: true,
    });
  });

  it("from a module emitted beside the worker in dist/: the sibling fts-worker.js", () => {
    const worker = touch("dist/memory/engram/fts-worker.js");
    const entry = resolveFtsWorkerEntry(url("dist/memory/engram/fts-worker-client.js"));
    expect(entry).toEqual({ url: pathToFileURL(worker), typescript: false });
  });

  it("from a chunk elsewhere in dist/: memory/engram/fts-worker.js up to three levels up", () => {
    const worker = touch("dist/memory/engram/fts-worker.js");
    // The first is where the build actually put the client's code: a hashed chunk at the root.
    for (const chunk of [
      "dist/fts-worker-client--ylzFdaN.js",
      "dist/plugin-sdk/x.js",
      "dist/extensions/p/q/y.js",
    ]) {
      expect(resolveFtsWorkerEntry(url(chunk)), chunk).toEqual({
        url: pathToFileURL(worker),
        typescript: false,
      });
    }
  });

  it("throws when no worker entry exists, which the client reports as a spawn failure", () => {
    expect(() => resolveFtsWorkerEntry(url("dist/memory/engram/fts-worker-client.js"))).toThrow(
      /fts worker entry not found/,
    );
    touch("dist/memory/engram/fts-worker.js");
    // Four levels up is past the search.
    expect(() => resolveFtsWorkerEntry(url("dist/a/b/c/d/chunk.js"))).toThrow(
      /fts worker entry not found/,
    );
  });
});

// ─── failure handling, with stub workers ─────────────────────────────────────

const STUB_PREAMBLE = `const { parentPort } = require("node:worker_threads");`;
const ANSWERS_EMPTY = `${STUB_PREAMBLE} parentPort.on("message", (r) => parentPort.postMessage({ id: r.id, ok: true, hits: [], corpus: { events: 0, loads: 1 } }));`;
const EXITS = `${STUB_PREAMBLE} parentPort.on("message", () => process.exit(3));`;
const THROWS = `${STUB_PREAMBLE} parentPort.on("message", () => { throw new Error("boom"); });`;
const SILENT = `${STUB_PREAMBLE} parentPort.on("message", () => {});`;
const WRONG_HIT = `${STUB_PREAMBLE} parentPort.on("message", (r) => parentPort.postMessage({ id: r.id, ok: true, hits: [{ pos: 0, id: "someone-else", score: 1 }], corpus: { events: 1, loads: 1 } }));`;

describe("FTS worker client — failures", () => {
  const QUERY = "retrieval pack";
  const store = fakeStore("(unused by stubs)", [makeEvent(makeRng(11), "stub")]);

  function stubs(...codes: string[]) {
    const spawned: Worker[] = [];
    const exits: Array<Promise<number>> = [];
    return {
      spawned,
      exits,
      spawn: () => {
        const code = codes[Math.min(spawned.length, codes.length - 1)];
        const w = new Worker(code, { eval: true });
        exits.push(new Promise((resolve) => w.once("exit", resolve)));
        spawned.push(w);
        return w;
      },
    };
  }

  function clock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("a spawn failure rejects 'spawn', then holds off respawning for the backoff", async () => {
    const time = clock();
    let calls = 0;
    const client = createFtsWorkerClient({
      now: time.now,
      respawnBackoffMs: 60_000,
      spawn: () => {
        calls++;
        if (calls === 1) {
          throw new Error("no entry");
        }
        return new Worker(ANSWERS_EMPTY, { eval: true });
      },
    });
    await expectFailure(client.search(store, QUERY, 5), "spawn");
    time.advance(59_999);
    await expectFailure(client.search(store, QUERY, 5), "backoff");
    expect(calls).toBe(1);
    time.advance(1);
    await expect(client.search(store, QUERY, 5)).resolves.toEqual([]);
    expect(calls).toBe(2);
    await client.shutdown();
  });

  it("a crash rejects every request in flight with 'crash', and respawns only after the backoff", async () => {
    const time = clock();
    const { spawn, spawned } = stubs(EXITS, ANSWERS_EMPTY);
    const client = createFtsWorkerClient({ now: time.now, respawnBackoffMs: 60_000, spawn });
    await Promise.all([
      expectFailure(client.search(store, QUERY, 5), "crash"),
      expectFailure(client.search(store, QUERY, 5), "crash"),
    ]);
    await expectFailure(client.search(store, QUERY, 5), "backoff");
    expect(spawned).toHaveLength(1);
    time.advance(60_000);
    await expect(client.search(store, QUERY, 5)).resolves.toEqual([]);
    expect(spawned).toHaveLength(2);
    await client.shutdown();
  });

  it("an uncaught exception in the worker rejects 'error'", async () => {
    const { spawn } = stubs(THROWS);
    const client = createFtsWorkerClient({ spawn });
    await expectFailure(client.search(store, QUERY, 5), "error");
    await expectFailure(client.search(store, QUERY, 5), "backoff");
  });

  it("R34: the default timeout is 120 s (a cold 70M-char corpus load must fit in it)", () => {
    expect(FTS_WORKER_TIMEOUT_MS).toBe(120_000);
  });

  it("a request past the timeout rejects 'timeout' and the worker is terminated", async () => {
    const { spawn, exits } = stubs(SILENT);
    const client = createFtsWorkerClient({ spawn, timeoutMs: 150 });
    const started = Date.now();
    await expectFailure(client.search(store, QUERY, 5), "timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(await exits[0]).toBe(1); // terminate() ends a thread with exit code 1
    await expectFailure(client.search(store, QUERY, 5), "backoff");
  });

  it("shutdown rejects the request in flight with 'shutdown' and does NOT hold off a respawn", async () => {
    const { spawn, spawned } = stubs(SILENT, ANSWERS_EMPTY);
    const client = createFtsWorkerClient({ spawn });
    const inFlight = expectFailure(client.search(store, QUERY, 5), "shutdown");
    await client.shutdown();
    await inFlight;
    await expect(client.search(store, QUERY, 5)).resolves.toEqual([]);
    expect(spawned).toHaveLength(2);
    await client.shutdown();
  });

  it("a hit that is not the snapshot's event rejects 'view'", async () => {
    const { spawn } = stubs(WRONG_HIT);
    const client = createFtsWorkerClient({ spawn });
    await expectFailure(client.search(store, QUERY, 5), "view");
    await client.shutdown();
  });

  // FORK 2026-09-24 — ruling R35: the worker's heap is capped, so an out-of-memory corpus load ends
  // the WORKER (a failure the client already handles) instead of growing a second unbounded heap.
  it("R35: the worker is started with a 2048 MB old-generation cap", () => {
    expect(FTS_WORKER_MAX_OLD_GENERATION_MB).toBe(2048);
    const seen: Array<{ entry: URL | string; options: WorkerOptions }> = [];
    spawnFtsWorker((entry, options) => {
      seen.push({ entry, options });
      return {} as Worker; // never started
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 2048 });
    expect(seen[0].options.eval).toBe(true); // from TS source: the tsx bootstrap
  });

  it("R35: a worker that runs out of its heap fails the request, and the pack falls back in-thread", async () => {
    const OOM = `${STUB_PREAMBLE} parentPort.on("message", () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(0)); });`;
    const client = createFtsWorkerClient({
      spawn: () => new Worker(OOM, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } }),
    });
    const failure = await client.search(store, QUERY, 5).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(FtsWorkerError);
    expect(["error", "crash"]).toContain((failure as FtsWorkerError).kind);
    // The process-wide path turns that into "search in-thread" (undefined), and never rejects.
    const oomAgain = createFtsWorkerClient({
      spawn: () => new Worker(OOM, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } }),
    });
    setFtsWorkerForTest({ client: oomAgain, log: () => {} });
    try {
      await expect(ftsSearchOffThread(store, QUERY, 5)).resolves.toBeUndefined();
    } finally {
      setFtsWorkerForTest();
      await oomAgain.shutdown();
    }
  });

  it("a query with no 3+ char term resolves [] without starting a worker", async () => {
    let calls = 0;
    const client = createFtsWorkerClient({
      spawn: () => {
        calls++;
        throw new Error("must not spawn");
      },
    });
    await expect(client.search(store, "ab cd e", 5)).resolves.toEqual([]);
    expect(calls).toBe(0);
  });
});

// ─── the point of it all ─────────────────────────────────────────────────────

describe("FTS worker — the main event loop stays responsive", () => {
  // FORK 2026-09-24 (final fix wave, T16 minor) — the power bar used to be a fixed worker time on a
  // fixed 4,000-event corpus (`workerMs >= 500`), which fails on hardware fast enough to finish the
  // scan sooner. The corpus now grows until the SAME search, run in-thread, stalls the loop past
  // the bar; that in-thread stall is both the power check and the CONTROL.
  const STALL_BAR_MS = 400;
  const MAX_EVENTS = 16_000;

  it(
    "p99 loop delay < 50 ms during a worker FTS that stalls the loop > 400 ms in-thread (CONTROL)",
    {
      timeout: 180_000,
    },
    async () => {
      const rng = makeRng(12);
      const vocabulary = Array.from({ length: 3000 }, () => {
        let w = "";
        const len = 4 + Math.floor(rng() * 6);
        for (let i = 0; i < len; i++) {
          w += String.fromCharCode(97 + Math.floor(rng() * 26));
        }
        return w;
      });
      const pick = () => vocabulary[Math.floor(rng() * vocabulary.length)];
      const query = Array.from({ length: 400 }, pick).join(" ");
      const lines: string[] = [];
      const grow = (to: number) => {
        for (let i = lines.length; i < to; i++) {
          const content = Array.from({ length: 700 }, pick).join(" ");
          lines.push(
            JSON.stringify({
              id: `big-${String(i).padStart(6, "0")}`,
              timestamp: new Date(T0 + i * 1000).toISOString(),
              turnId: i,
              sessionKey: "big",
              kind: "agent_message",
              content,
              tokens: estimateTokens(content),
              metadata: {},
            }),
          );
        }
      };

      // The histogram's first tick only arms it, so each window opens and closes with an idle
      // stretch: a stall right after enable() would otherwise go unrecorded.
      const idle = () => new Promise((resolve) => setTimeout(resolve, 40));

      // CONTROL, and the power check: double the corpus until the in-thread scan (index build
      // included, as on a fresh store) stalls the loop past the bar.
      let store: EventStore | undefined;
      let expected: SearchResult[] = [];
      let inThreadMaxMs = 0;
      for (let size = 4000; ; size *= 2) {
        grow(size);
        store = createEventStore({ baseDir: dir, sessionKey: `big-${size}` });
        writeFileSync(store.filePath, `${lines.join("\n")}\n`);
        expect(store.count()).toBe(size); // the main thread's own parse happens here, not below
        const inThread = monitorEventLoopDelay({ resolution: 10 });
        inThread.enable();
        await idle();
        expected = ftsSearch(store, query, 50);
        await idle();
        inThread.disable();
        inThreadMaxMs = inThread.max / 1e6;
        if (inThreadMaxMs > STALL_BAR_MS || size >= MAX_EVENTS) {
          break;
        }
      }
      expect(
        inThreadMaxMs,
        `the in-thread control must stall the loop > ${STALL_BAR_MS} ms (corpus capped at ${MAX_EVENTS} events)`,
      ).toBeGreaterThan(STALL_BAR_MS);
      expect(expected.length).toBe(50);

      const client = createFtsWorkerClient();
      try {
        // Warm up: spawn, parse the file and build the worker's index outside the measurement.
        await client.search(store, vocabulary[0], 5);

        const onWorker = monitorEventLoopDelay({ resolution: 10 });
        onWorker.enable();
        await idle();
        const viaWorker = await client.search(store, query, 50);
        await idle();
        onWorker.disable();

        expectSameHits(viaWorker, expected, "big corpus");
        if (availableParallelism() >= 2) {
          // With one core the OS, not the worker, decides who runs; the claim needs a second one.
          expect(onWorker.percentile(99) / 1e6).toBeLessThan(50);
        }
      } finally {
        await client.shutdown();
      }
    },
  );
});
