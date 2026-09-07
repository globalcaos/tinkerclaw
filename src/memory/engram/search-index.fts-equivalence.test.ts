/**
 * FORK 2026-08-22 — equivalence tests for the two `ftsSearch` optimisations.
 *
 * Both are exact-equivalence claims, so both need an oracle that can fail:
 *
 *   1. `content.toLowerCase()` per event per search  ->  memoised per event.
 *   2. `content.split(term).length - 1`              ->  an indexOf stepping loop.
 *
 * (2) is the subtle one. `split` on a string separator is non-overlapping and left to
 * right; a stepping loop must agree on repeats, overlaps, empty results and terms that
 * are longer than the haystack. The property test below drives both against random
 * strings from a tiny alphabet, which is where overlap cases actually occur.
 *
 * The scoring path is also exercised end to end through the real store, so a change that
 * kept `countOccurrences` honest but broke its wiring still fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { countOccurrences, ftsSearch } from "./search-index.js";

/** The ORIGINAL counting expression, kept as the oracle. Do not "optimise" this one. */
function splitCount(haystack: string, term: string): number {
  return haystack.split(term).length - 1;
}

/**
 * The SHIPPED function, imported — not a local transcription of it.
 *
 * The first version of this file defined its own copy of the loop and compared THAT to
 * `split`. It passed, and it kept passing when the shipped `countOccurrences` was
 * deliberately broken to count overlapping matches: the test was asserting that a copy in
 * the test file was correct, which is a fact about the test file. Import the real one.
 */
const loopCount = countOccurrences;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("occurrence counting: loop agrees with split", () => {
  it("agrees on the hand-picked edge cases", () => {
    const cases: Array<[string, string]> = [
      ["aaa", "a"], // repeats
      ["aaa", "aa"], // OVERLAPPING — split takes the non-overlapping reading
      ["aaaa", "aa"],
      ["abcabc", "abc"],
      ["", "a"], // empty haystack
      ["abc", "abc"], // whole string
      ["abc", "abcd"], // term longer than haystack
      ["abc", "z"], // no match
      ["aXaXa", "X"],
      ["....", "."], // regex-special char used as a literal
      ["a.b.c", "."],
      ["$^*+?()[]{}|", "*"],
    ];
    for (const [hay, term] of cases) {
      expect(loopCount(hay, term), `hay=${JSON.stringify(hay)} term=${JSON.stringify(term)}`).toBe(
        splitCount(hay, term),
      );
    }
  });

  it("returns 0 for an empty term instead of hanging", () => {
    // The loop steps by term.length; a zero-length step never advances. ftsSearch filters
    // terms to 3+ chars so this is unreachable there, but the function is exported.
    // Guarded rather than matched to split's character-count reading — see the source.
    expect(countOccurrences("abc", "")).toBe(0);
    expect(countOccurrences("", "")).toBe(0);
  });

  it("agrees on random strings over a tiny alphabet (where overlaps happen)", () => {
    const rng = makeRng(20260822);
    const alphabet = "aab ";
    for (let i = 0; i < 500; i++) {
      const hayLen = Math.floor(rng() * 40);
      const termLen = 1 + Math.floor(rng() * 3);
      const hay = Array.from(
        { length: hayLen },
        () => alphabet[Math.floor(rng() * alphabet.length)],
      ).join("");
      const term = Array.from(
        { length: termLen },
        () => alphabet[Math.floor(rng() * alphabet.length)],
      ).join("");
      expect(loopCount(hay, term), `hay=${JSON.stringify(hay)} term=${JSON.stringify(term)}`).toBe(
        splitCount(hay, term),
      );
    }
  });
});

// ─── the scoring path, end to end through a real store ───────────────────────

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-fts-test-"));
  store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function append(text: string, turnId: number) {
  store.append({
    turnId,
    sessionKey: "test-session",
    kind: "user_message",
    content: text,
    tokens: estimateTokens(text),
    metadata: { importance: 5 },
  });
}

describe("ftsSearch scoring is unchanged by the memoisation", () => {
  it("is stable across repeated calls — the memo must not drift the score", () => {
    append("the retrieval retrieval retrieval pipeline", 1);
    append("a single retrieval mention", 2);
    append("nothing relevant at all", 3);

    const first = ftsSearch(store, "retrieval pipeline", 10);
    const second = ftsSearch(store, "retrieval pipeline", 10);
    const third = ftsSearch(store, "retrieval pipeline", 10);

    expect(second.map((r) => [r.event.content, r.score])).toEqual(
      first.map((r) => [r.event.content, r.score]),
    );
    expect(third.map((r) => [r.event.content, r.score])).toEqual(
      first.map((r) => [r.event.content, r.score]),
    );
  });

  it("still ranks term frequency above a single mention", () => {
    append("the retrieval retrieval retrieval pipeline", 1);
    append("a single retrieval mention", 2);
    const results = ftsSearch(store, "retrieval", 10);
    expect(results.length).toBe(2);
    expect(results[0].event.content).toContain("retrieval retrieval retrieval");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("matches case-insensitively, which is what the lowercasing is for", () => {
    append("RETRIEVAL Pipeline In Caps", 1);
    expect(ftsSearch(store, "retrieval", 10).length).toBe(1);
  });

  it("scores an OVERLAPPING term the way split did", () => {
    // The discriminating case for the counting change, driven through the real scoring
    // path rather than the helper: "aaaaaa" contains "aaa" twice non-overlapping (what
    // split reports) but four times if you step by one. The two readings give different
    // frequency bonuses, so a wrong step shows up as a wrong score here.
    append("aaaaaa", 1);
    const [result] = ftsSearch(store, "aaa", 10);
    const content = "aaaaaa";
    const occurrences = content.split("aaa").length - 1;
    const expected =
      1.0 + Math.log2(occurrences + 1) * 0.5 + (1.0 - 0 / Math.max(content.length, 1)) * 0.3;
    expect(result.score).toBeCloseTo(expected, 10);
  });

  it("sees events appended AFTER an earlier search (memo must not pin the event list)", () => {
    append("first retrieval note", 1);
    expect(ftsSearch(store, "retrieval", 10).length).toBe(1);
    append("second retrieval note", 2);
    expect(ftsSearch(store, "retrieval", 10).length).toBe(2);
  });
});
