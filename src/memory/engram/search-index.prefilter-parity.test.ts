/**
 * FORK 2026-09-23 — the trigram prefilter must not change a single FTS result (plan task 14).
 *
 * `ftsSearch` now skips (event, term) pairs the trigram index rules out. That is an exact-
 * equivalence claim, so it is pinned against the ORACLE: `ftsSearchLinear`, the full scan every
 * event against every term, exported from search-index.ts rather than copied here. Every
 * comparison is on event IDENTITY and Object.is on the score, in order, and most run with an
 * unbounded topN so every hit is compared, not just the head.
 *
 * The corpus is built to hit the places an index is most likely to diverge from `indexOf`:
 * case folding that changes length (İ -> i̇, K -> k), astral code points (surrogate pairs),
 * combining marks, non-ASCII whitespace (which the index does NOT skip, while `split(/\s+/)`
 * does), words glued without a separator, 3-char terms, overlapping repeats, empty and 1-2 char
 * events, and filters. It is then GROWN (the incremental path) and REWRITTEN (the rebuild path).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { EventKind, MemoryEvent } from "./event-types.js";
import { ftsSearchChunked } from "./retrieval-integration.js";
import {
  ftsSearch,
  ftsSearchLinear,
  type SearchFilters,
  type SearchResult,
} from "./search-index.js";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  // plain and technical
  "the",
  "and",
  "retrieval",
  "pack",
  "gateway",
  "session",
  "refresh",
  "trigram",
  "index",
  "posting",
  "candidate",
  "scheduler",
  "event-loop",
  "readAll()",
  "x.y.z",
  "foo,bar",
  "(paren)",
  "1234567",
  "v2.3.4",
  // overlaps and repeats
  "aaaa",
  "aaaaaa",
  "abab",
  "ababab",
  "abcabc",
  "nana",
  "banana",
  // unicode: accents, sharp s, case folding that changes length, Kelvin sign, Greek, CJK.
  // Invisible differences are real: the formatter writes \u escapes as literal characters, so
  // "Kelvin" below starts with U+212A (lower-cases to "k") and the first "éclair" is
  // "e" + U+0301 while the second is a precomposed U+00E9.
  "café",
  "CAFÉ",
  "naïve",
  "Straße",
  "STRASSE",
  "İstanbul",
  "Kelvin",
  "ΣΊΣΥΦΟΣ",
  "σίσυφος",
  "日本語テキスト",
  "テキスト",
  // astral (surrogate pairs) and combining marks
  "rocket🚀launch",
  "🚀🚀🚀",
  "𝒳𝒴𝒵",
  "éclair",
  "éclair",
];

// The 8th and 9th entries are U+00A0 and U+3000: whitespace to `split(/\s+/)`, but NOT skipped
// by the trigram index (it skips ASCII whitespace only). "" glues two words together.
const SEPARATORS = [" ", " ", " ", "\n", "\t", "  ", "\r\n", " ", "　", ""];
const KINDS: EventKind[] = ["user_message", "agent_message", "tool_result", "system_event"];

function randomContent(rng: () => number): string {
  const shape = rng();
  if (shape < 0.04) {
    return "";
  }
  if (shape < 0.08) {
    return WORDS[Math.floor(rng() * WORDS.length)].slice(0, 1 + Math.floor(rng() * 2));
  }
  const n = 1 + Math.floor(rng() * 40);
  let out = "";
  for (let i = 0; i < n; i++) {
    let w = WORDS[Math.floor(rng() * WORDS.length)];
    if (rng() < 0.15) {
      w = w.toUpperCase();
    }
    out += w + SEPARATORS[Math.floor(rng() * SEPARATORS.length)];
  }
  return out;
}

let seq = 0;
function makeEvent(rng: () => number, sessionKey: string): MemoryEvent {
  const content = randomContent(rng);
  seq++;
  return {
    id: `evt-${String(seq).padStart(6, "0")}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + seq * 60_000).toISOString(),
    turnId: seq,
    sessionKey,
    kind: KINDS[Math.floor(rng() * KINDS.length)],
    content,
    tokens: estimateTokens(content),
    metadata: { importance: 5, ...(rng() < 0.5 ? { taskId: rng() < 0.5 ? "t1" : "t2" } : {}) },
  };
}

function randomQuery(rng: () => number): string {
  const n = 1 + Math.floor(rng() * 25);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    const r = rng();
    if (r < 0.45) {
      parts.push(w);
    } else if (r < 0.8) {
      // A substring — including ones that start or end inside a surrogate pair.
      const from = Math.floor(rng() * w.length);
      parts.push(w.slice(from, from + 3 + Math.floor(rng() * 5)));
    } else if (r < 0.9) {
      parts.push(w.toUpperCase());
    } else {
      parts.push(["zzz", "qqqq", "xyzzy", "ab", "a", "no-such-term"][Math.floor(rng() * 6)]);
    }
    if (rng() < 0.2) {
      parts.push(parts[parts.length - 1]); // repeated term: multiplicity > 1
    }
  }
  return parts.join(rng() < 0.5 ? " " : "\n\t ");
}

const FILTERS: Array<SearchFilters | undefined> = [
  undefined,
  { taskId: "t1" },
  { kinds: ["user_message", "tool_result"] },
  { since: "2026-01-01T02:00:00.000Z", until: "2026-01-01T08:00:00.000Z" },
  { taskId: "t2", kinds: ["agent_message", "system_event"], since: "2026-01-01T01:00:00.000Z" },
];

function expectSameHits(actual: SearchResult[], expected: SearchResult[], label: string): void {
  expect(actual.length, `${label}: hit count`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].event, `${label}: event #${i}`).toBe(expected[i].event);
    expect(Object.is(actual[i].score, expected[i].score), `${label}: score #${i}`).toBe(true);
    expect(actual[i].matchType).toBe(expected[i].matchType);
  }
}

/** Runs the whole battery and returns how many comparisons had at least one hit. */
function assertParity(store: EventStore, rng: () => number, queries: number): number {
  let nonEmpty = 0;
  for (let q = 0; q < queries; q++) {
    const query = randomQuery(rng);
    for (const filters of FILTERS) {
      for (const topN of [Number.MAX_SAFE_INTEGER, 20, 3]) {
        const label = `query #${q} ${JSON.stringify(query)} filters=${JSON.stringify(filters)} topN=${topN}`;
        const expected = ftsSearchLinear(store, query, topN, filters);
        expectSameHits(ftsSearch(store, query, topN, filters), expected, label);
        if (expected.length > 0) {
          nonEmpty++;
        }
      }
    }
  }
  return nonEmpty;
}

/** A store whose contents the test controls, so it can do what an append-only file cannot. */
function mutableStore(events: MemoryEvent[]): EventStore {
  return {
    filePath: "(in-memory)",
    sessionKey: "mutable",
    append: () => {
      throw new Error("not used");
    },
    appendRaw: (e) => {
      events.push(e);
    },
    readAll: () => [...events],
    readByKind: (kind) => events.filter((e) => e.kind === kind),
    readRange: (a, b) => events.filter((e) => e.turnId >= a && e.turnId <= b),
    readById: (id) => events.find((e) => e.id === id),
    count: () => events.length,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-prefilter-parity-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ftsSearch (prefiltered) === ftsSearchLinear (oracle)", () => {
  it("agrees on a varied corpus that spans several index blocks, then after it grows", () => {
    const rng = makeRng(20260923);
    const store = createEventStore({ baseDir: tmpDir, sessionKey: "parity" });
    // 600 events crosses the 32 / 96 / 224 / 480 block boundaries.
    for (let i = 0; i < 600; i++) {
      store.appendRaw(makeEvent(rng, "parity"));
    }
    const nonEmpty = assertParity(store, rng, 60);
    // Guard against a vacuous pass: most comparisons must actually have hits to compare.
    expect(nonEmpty).toBeGreaterThan(60 * FILTERS.length * 3 * 0.5);

    // The incremental path: the index is extended, not rebuilt, and must still agree —
    // including for events appended into a partially filled block and into a new one.
    for (let i = 0; i < 150; i++) {
      store.appendRaw(makeEvent(rng, "parity"));
    }
    assertParity(store, rng, 30);
    store.appendRaw(makeEvent(rng, "parity"));
    assertParity(store, rng, 10);
  });

  it("agrees when the corpus is rewritten under the index (drop, replace, shrink, reorder)", () => {
    const rng = makeRng(7);
    const events: MemoryEvent[] = [];
    for (let i = 0; i < 300; i++) {
      events.push(makeEvent(rng, "mutable"));
    }
    const store = mutableStore(events);

    assertParity(store, rng, 10);
    events.shift(); // dropped from the front: every position shifts
    assertParity(store, rng, 10);
    events[137] = makeEvent(rng, "mutable"); // replaced in the middle
    assertParity(store, rng, 10);
    events.length = 120; // shrunk
    assertParity(store, rng, 10);
    events.reverse(); // reordered
    assertParity(store, rng, 10);
    for (let i = 0; i < 40; i++) {
      events.push(makeEvent(rng, "mutable"));
    }
    assertParity(store, rng, 10);
  });

  it("agrees across a fresh store instance over the same file (new objects, new index)", () => {
    const rng = makeRng(99);
    const first = createEventStore({ baseDir: tmpDir, sessionKey: "reload" });
    for (let i = 0; i < 250; i++) {
      first.appendRaw(makeEvent(rng, "reload"));
    }
    assertParity(first, rng, 10);
    const reloaded = createEventStore({ baseDir: tmpDir, sessionKey: "reload" });
    assertParity(reloaded, rng, 10);
  });

  it("returns [] without reading the store when no term has 3+ chars, as before", () => {
    const store = mutableStore([makeEvent(makeRng(1), "short")]);
    store.readAll = () => {
      throw new Error("the store must not be read for a query with no 3+ char term");
    };
    expect(ftsSearch(store, "a ab  \n", 10)).toEqual([]);
    expect(ftsSearchLinear(store, "a ab  \n", 10)).toEqual([]);
  });
});

// ─── the live path: the time-sliced scan the pack assembler awaits ─────────────

describe("ftsSearchChunked (paused after every event) === ftsSearchLinear", () => {
  const ALL = Number.MAX_SAFE_INTEGER;

  it("agrees across queries and filters, and really does hand the loop back", async () => {
    const rng = makeRng(4242);
    const store = createEventStore({ baseDir: tmpDir, sessionKey: "chunked" });
    for (let i = 0; i < 450; i++) {
      store.appendRaw(makeEvent(rng, "chunked"));
    }
    let loopTurns = 0;
    let probing = true;
    const probe = async () => {
      while (probing) {
        await yieldToEventLoop();
        loopTurns++;
      }
    };
    const probeDone = probe();
    for (let q = 0; q < 12; q++) {
      const query = randomQuery(rng);
      for (const filters of FILTERS) {
        const label = `query #${q} ${JSON.stringify(query)} filters=${JSON.stringify(filters)}`;
        const expected = ftsSearchLinear(store, query, ALL, filters);
        expectSameHits(await ftsSearchChunked(store, query, ALL, filters, 0), expected, label);
        expectSameHits(
          await ftsSearchChunked(store, query, 20, filters, 0),
          expected.slice(0, 20),
          `${label} topN=20`,
        );
      }
    }
    probing = false;
    await probeDone;
    // Paused after every event: the two unfiltered searches per query alone score 450 events
    // each. A scan that never paused would let the probe turn about once per search (~120).
    expect(loopTurns).toBeGreaterThan(12 * 450);
  });

  it("stays exact when the store grows and is searched while a scan is paused", async () => {
    const rng = makeRng(5);
    const store = createEventStore({ baseDir: tmpDir, sessionKey: "grows" });
    for (let i = 0; i < 300; i++) {
      store.appendRaw(makeEvent(rng, "grows"));
    }
    const query = "the retrieval banana café 🚀🚀 aaaa straße";
    const before = ftsSearchLinear(store, query, ALL);
    const paused = ftsSearchChunked(store, query, ALL, undefined, 0);
    await yieldToEventLoop();
    await yieldToEventLoop();
    // Another search extends the SHARED index past the paused scan's snapshot.
    for (let i = 0; i < 100; i++) {
      store.appendRaw(makeEvent(rng, "grows"));
    }
    expectSameHits(ftsSearch(store, query, ALL), ftsSearchLinear(store, query, ALL), "grown");
    expectSameHits(await paused, before, "paused scan keeps its own snapshot");
  });

  it("two paused scans of incompatible snapshots both finish, and both stay exact", async () => {
    // Each resume finds the shared index rebuilt for the OTHER snapshot. Discarding it and
    // starting over on every resume would let the two scans undo each other forever.
    const rng = makeRng(8);
    const events: MemoryEvent[] = [];
    for (let i = 0; i < 300; i++) {
      events.push(makeEvent(rng, "mutable"));
    }
    const store = mutableStore(events);
    const query = "the retrieval banana café aaaa straße テキスト";
    const expectedFirst = ftsSearchLinear(store, query, ALL);
    const first = ftsSearchChunked(store, query, ALL, undefined, 0);
    await yieldToEventLoop();
    events.reverse();
    const expectedSecond = ftsSearchLinear(store, query, ALL);
    const second = ftsSearchChunked(store, query, ALL, undefined, 0);
    const [a, b] = await Promise.all([first, second]);
    expectSameHits(a, expectedFirst, "first scan");
    expectSameHits(b, expectedSecond, "second scan");
  }, 20_000);

  // Paused 3 turns in = mid index build (it must re-verify the index on resume); 400 turns in =
  // mid scoring (its candidate bitsets must already be its own).
  for (const pausedTurns of [3, 400]) {
    it(`stays exact when another search discards the shared index (paused ${pausedTurns} turns in)`, async () => {
      const rng = makeRng(6);
      const events: MemoryEvent[] = [];
      for (let i = 0; i < 300; i++) {
        events.push(makeEvent(rng, "mutable"));
      }
      const store = mutableStore(events);
      const query = "the and gateway nana ΣΊΣΥΦΟΣ テキスト x.y.z";
      const before = ftsSearchLinear(store, query, ALL);
      const paused = ftsSearchChunked(store, query, ALL, undefined, 0);
      for (let i = 0; i < pausedTurns; i++) {
        await yieldToEventLoop();
      }
      events.reverse();
      events.splice(10, 5, makeEvent(rng, "mutable"));
      events.push(makeEvent(rng, "mutable"), makeEvent(rng, "mutable"));
      expectSameHits(ftsSearch(store, query, ALL), ftsSearchLinear(store, query, ALL), "rewritten");
      expectSameHits(await paused, before, "paused scan keeps its own snapshot");
    });
  }
});
