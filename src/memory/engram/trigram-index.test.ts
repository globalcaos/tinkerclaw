/**
 * FORK 2026-09-23 — the trigram index behind the FTS prefilter (plan task 14).
 *
 * Its one correctness duty is to be a SUPERSET: every event whose lower-cased content contains
 * a term must be a candidate for it. These tests pin that directly (every event x every term,
 * including substrings that start inside a surrogate pair), then show the index is worth having
 * (it prunes, and it has false positives — which is why the scorer still runs indexOf), that it
 * extends in place on append and resets on a rewrite, and that its memory does not follow the
 * size of the text.
 */
import { describe, expect, it } from "vitest";
import type { MemoryEvent } from "./event-types.js";
import { __trigramBucketForTest, TrigramIndex } from "./trigram-index.js";

function ev(id: number, content: string): MemoryEvent {
  return {
    id: `e${id}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
    turnId: id,
    sessionKey: "t",
    kind: "user_message",
    content,
    tokens: 1,
    metadata: { importance: 5 },
  };
}

function has(bits: Uint32Array, e: number): boolean {
  return (bits[e >>> 5] & (1 << (e & 31))) !== 0;
}

function build(events: MemoryEvent[]): TrigramIndex {
  const index = new TrigramIndex();
  for (const e of events) {
    index.append(e, e.content.toLowerCase());
  }
  return index;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = "abcde fgh\tij\nklmnopqrstuvwxyz0123456789.,-_éßİΣ日本🚀 　";

function randomText(rng: () => number, maxLen: number): string {
  const chars = [...ALPHABET];
  let out = "";
  const len = Math.floor(rng() * maxLen);
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(rng() * chars.length)];
  }
  return rng() < 0.2 ? out.toUpperCase() : out;
}

describe("TrigramIndex.candidates", () => {
  it("is a superset of the events containing the term — every event x every term", () => {
    const rng = makeRng(42);
    const events = Array.from({ length: 700 }, (_, i) => ev(i, randomText(rng, 400)));
    const index = build(events);
    const lowered = events.map((e) => e.content.toLowerCase());

    // Terms that DO occur: slices of the corpus itself, whitespace-free like split(/\s+/) terms,
    // cut at arbitrary code-unit offsets (so some start or end inside a surrogate pair).
    const terms = new Set<string>();
    while (terms.size < 400) {
      const text = lowered[Math.floor(rng() * lowered.length)];
      const from = Math.floor(rng() * text.length);
      const term = text.slice(from, from + 3 + Math.floor(rng() * 6)).split(/\s+/)[0];
      if (term.length >= 3) {
        terms.add(term);
      }
    }
    let checkedHits = 0;
    for (const term of terms) {
      const bits = index.candidates(term);
      for (let e = 0; e < events.length; e++) {
        if (lowered[e].includes(term)) {
          checkedHits++;
          expect(has(bits, e), `event ${e} contains ${JSON.stringify(term)}`).toBe(true);
        }
      }
    }
    // Each term hits at least the event it was cut from; many hit others too.
    expect(checkedHits).toBeGreaterThan(terms.size);
  });

  it("prunes: a term found in few events rules out most of the corpus", () => {
    const events = Array.from({ length: 500 }, (_, i) =>
      ev(i, i % 100 === 7 ? `the rare zyxwvut marker ${i}` : `the common text of event ${i}`),
    );
    const index = build(events);
    const bits = index.candidates("zyxwvut");
    let candidates = 0;
    for (let e = 0; e < events.length; e++) {
      candidates += has(bits, e) ? 1 : 0;
    }
    expect(candidates).toBeGreaterThanOrEqual(5);
    expect(candidates).toBeLessThan(25);
  });

  it("CONTROL: has false positives, which is why the scorer still runs indexOf", () => {
    // Every trigram of "abcd" occurs ("abc", "bcd") without the term itself.
    const index = build([ev(0, "abc bcd"), ev(1, "abcd"), ev(2, "xyz")]);
    const bits = index.candidates("abcd");
    expect([has(bits, 0), has(bits, 1), has(bits, 2)]).toEqual([true, true, false]);
  });

  // FORK 2026-09-24 (task 14 deferred minor, final fix wave) — candidates() deduplicated a term's
  // buckets with Array.includes: O(term length x distinct buckets), ~0.5 s unpausable for a pasted
  // 100k-char base64 blob. The result must not change with the dedup, so a LINEAR oracle — each
  // event's own bucket set, from its text — decides the exact expected bitset, bit for bit.
  it("a 100k-char whitespace-free term completes with exactly the oracle's candidates", () => {
    const rng = makeRng(7);
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const blob = Array.from({ length: 100_000 }, () => b64[Math.floor(rng() * 64)]).join("");
    const events = [
      ev(0, `payload ${blob} end`),
      ev(1, blob.slice(0, 50_000)),
      ...Array.from({ length: 70 }, (_, i) => ev(i + 2, randomText(rng, 3000))),
    ];
    const index = build(events);
    const term = blob.toLowerCase();

    const isSep = (c: number) => c === 32 || (c >= 9 && c <= 13);
    const bucketsOf = (text: string) => {
      const out = new Set<number>();
      for (let i = 2; i < text.length; i++) {
        const [c0, c1, c2] = [text.charCodeAt(i - 2), text.charCodeAt(i - 1), text.charCodeAt(i)];
        if (!isSep(c0) && !isSep(c1) && !isSep(c2)) {
          out.add(__trigramBucketForTest(c0, c1, c2));
        }
      }
      return out;
    };
    const termBuckets = [...bucketsOf(term)];
    expect(termBuckets.length).toBeGreaterThan(4000); // the dedup really had work to do

    const bits = index.candidates(term);
    for (let e = 0; e < events.length; e++) {
      const own = bucketsOf(events[e].content.toLowerCase());
      const expected = termBuckets.every((b) => own.has(b));
      expect(has(bits, e), `event ${e}`).toBe(expected);
    }
    expect(has(bits, 0)).toBe(true); // it holds the term
    expect(has(bits, 1)).toBe(false); // half of it is not enough
  });

  it("never rules anything out for a term it cannot test", () => {
    const index = build([ev(0, "alpha"), ev(1, "beta")]);
    for (const term of ["ab", "has space", "tab\there"]) {
      const bits = index.candidates(term);
      expect([has(bits, 0), has(bits, 1)], JSON.stringify(term)).toEqual([true, true]);
    }
  });
});

describe("TrigramIndex.reconcile", () => {
  it("keeps the index when the corpus only grew (or is an older, shorter snapshot)", () => {
    const events = [ev(0, "alpha"), ev(1, "beta")];
    const index = build(events);
    const grown = [...events, ev(2, "gamma")];
    expect(index.reconcile(grown)).toBe(true);
    expect(index.size).toBe(2);
    index.append(grown[2], "gamma");
    expect(index.reconcile(events)).toBe(true); // a scan that started before the append
    expect(index.size).toBe(3);
    expect(has(index.candidates("gamma"), 2)).toBe(true);
  });

  it("discards the index when an event it covers was dropped, replaced or moved", () => {
    const events = [ev(0, "alpha"), ev(1, "beta"), ev(2, "gamma")];
    for (const rewritten of [
      events.slice(1),
      [events[0], ev(9, "beta"), events[2]], // same text, different object
      [events[1], events[0], events[2]],
    ]) {
      const index = build(events);
      expect(index.reconcile(rewritten)).toBe(false);
      expect(index.size).toBe(0);
      expect(index.byteSize()).toBe(0);
    }
  });
});

describe("TrigramIndex memory", () => {
  it("costs 1 KiB per event in full blocks, whatever the length of the text", () => {
    const short = build(Array.from({ length: 480 }, (_, i) => ev(i, "x")));
    const long = build(Array.from({ length: 480 }, (_, i) => ev(i, "lorem ipsum ".repeat(2000))));
    // Blocks of 32 + 64 + 128 + 256 events = 480 events, 8,192 buckets x 4 bytes per word.
    expect(short.byteSize()).toBe(480 * 1024);
    expect(long.byteSize()).toBe(short.byteSize());
  });

  it("a small store pays only for its first block", () => {
    expect(build([ev(0, "one event")]).byteSize()).toBe(32 * 1024);
  });
});
