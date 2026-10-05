/**
 * FORK 2026-09-23 — exact candidate prefilter for `ftsSearch` (plan task 14).
 *
 * `ftsSearch` scores an event against each query term with `content.indexOf(term)`, and an
 * event that contains no query term scores 0 and is dropped. Measured on the architect's live
 * cc-experience store (10,173 events, 69.7M chars) against synthetic 2k-12k-char prompts, only
 * 16-24% of (event, distinct term) pairs are hits, yet every pair cost a full scan of the event
 * text. This index answers "can `term` possibly occur in event e?" without reading e.
 *
 * SHAPE: hashed trigram -> bitset of events. Every trigram (three consecutive UTF-16 code units)
 * of an event's lower-cased content sets that event's bit in its bucket's row. A term can occur
 * in an event only if EVERY trigram of the term does, so the AND of the term's rows is a
 * SUPERSET of the events containing it. Hashing only adds false positives (two trigrams sharing
 * a bucket), never false negatives, and the scorer still runs the exact indexOf math on every
 * candidate — so a false positive costs time, never a different result.
 *
 * Why hashed bit rows and not exact postings lists: exact (event, trigram) postings on that store
 * are 13.3M entries (~53 MB as Uint32); these rows are a fixed 1 KiB per event (~10 MB there),
 * an AND covers 32 events per operation, and appending an event is O(its length) with nothing
 * to rebalance.
 *
 * Whitespace trigrams are not indexed. Query terms come from `split(/\s+/)`, so no term contains
 * a whitespace code unit and no such trigram is ever looked up. (Skipping only the ASCII subset
 * of `\s` is still exact: an index may omit any trigram that no term can contain.)
 */
import type { MemoryEvent } from "./event-types.js";

/** log2 of the bucket count. 8,192 buckets = 1 KiB of index per event once blocks are full. */
const BUCKET_BITS = 13;
const BUCKET_COUNT = 1 << BUCKET_BITS;
/** Widest block, in 32-bit words per bucket row (256 events per block). */
const MAX_BLOCK_WORDS = 8;

/**
 * Events [start, start + 32 * words). Bucket b's row is rows[b * words, (b + 1) * words).
 * Blocks double in width (1, 2, 4, 8 words) so a small store does not pay for 256 events.
 * Every block starts on a multiple of 32, so its words line up with a candidate bitset's.
 */
interface Block {
  start: number;
  words: number;
  rows: Uint32Array;
}

function isIndexSeparator(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

function bucketOf(c0: number, c1: number, c2: number): number {
  let x = Math.imul(c0, 0x9e3779b1);
  x = Math.imul(x ^ c1, 0x85ebca77);
  x = Math.imul(x ^ c2, 0xc2b2ae3d);
  return (x ^ (x >>> 15)) >>> (32 - BUCKET_BITS);
}

/** Test hook: the bucket a trigram lands in (for an independent oracle). */
export function __trigramBucketForTest(c0: number, c1: number, c2: number): number {
  return bucketOf(c0, c1, c2);
}

export class TrigramIndex {
  /** The events indexed so far, by position — references only, kept to verify a corpus. */
  private readonly indexed: MemoryEvent[] = [];
  private blocks: Block[] = [];

  get size(): number {
    return this.indexed.length;
  }

  /**
   * Keep the index only while `events` agrees with it at every position both cover — i.e. one
   * is a prefix of the other, which is what an append-only store produces for a newer OR an
   * older snapshot. A dropped, replaced or reordered event discards the index.
   *
   * Identity, not content: a new store instance re-parses its file into new objects (and gets
   * a new index anyway), and the lower-case memo this index is built from is keyed the same way.
   *
   * Returns false when it discarded something.
   */
  reconcile(events: readonly MemoryEvent[]): boolean {
    const shared = Math.min(this.indexed.length, events.length);
    for (let i = 0; i < shared; i++) {
      if (this.indexed[i] !== events[i]) {
        this.indexed.length = 0;
        this.blocks = [];
        return false;
      }
    }
    return true;
  }

  /** Index the next event. `lowered` must be `event.content.toLowerCase()`. */
  append(event: MemoryEvent, lowered: string): void {
    const e = this.indexed.length;
    let block = this.blocks[this.blocks.length - 1];
    if (!block || e >= block.start + block.words * 32) {
      const words = block ? Math.min(MAX_BLOCK_WORDS, block.words * 2) : 1;
      block = { start: e, words, rows: new Uint32Array(BUCKET_COUNT * words) };
      this.blocks.push(block);
    }
    const { rows, words } = block;
    const local = e - block.start;
    const word = local >>> 5;
    const bit = 1 << (local & 31);
    let c0 = lowered.charCodeAt(0);
    let c1 = lowered.charCodeAt(1);
    for (let i = 2; i < lowered.length; i++) {
      const c2 = lowered.charCodeAt(i);
      if (!isIndexSeparator(c0) && !isIndexSeparator(c1) && !isIndexSeparator(c2)) {
        rows[bucketOf(c0, c1, c2) * words + word] |= bit;
      }
      c0 = c1;
      c1 = c2;
    }
    this.indexed.push(event);
  }

  /**
   * A bitset over the indexed events (event e is bit `e & 31` of word `e >>> 5`) that is a
   * SUPERSET of the events whose lower-cased content contains `term` (itself lower-cased).
   */
  candidates(term: string): Uint32Array {
    const out = new Uint32Array((this.indexed.length + 31) >>> 5);
    const buckets: number[] = [];
    // A seen-set, not buckets.includes(): that was O(term length x distinct buckets), ~0.3 s
    // unpausable for a pasted 100k-char blob (final fix wave). Same buckets, same order.
    const seen = new Uint8Array(BUCKET_COUNT);
    for (let i = 2; i < term.length; i++) {
      const c0 = term.charCodeAt(i - 2);
      const c1 = term.charCodeAt(i - 1);
      const c2 = term.charCodeAt(i);
      if (isIndexSeparator(c0) || isIndexSeparator(c1) || isIndexSeparator(c2)) {
        // Unreachable for `split(/\s+/)` terms. Never guess: every event stays a candidate.
        return out.fill(0xffffffff);
      }
      const b = bucketOf(c0, c1, c2);
      if (seen[b] === 0) {
        seen[b] = 1;
        buckets.push(b);
      }
    }
    if (buckets.length === 0) {
      // Shorter than a trigram: nothing to test, so nothing can be ruled out.
      return out.fill(0xffffffff);
    }
    for (const { start, words, rows } of this.blocks) {
      const base = start >>> 5;
      for (let w = 0; w < words && base + w < out.length; w++) {
        let acc = -1;
        for (let k = 0; k < buckets.length && acc !== 0; k++) {
          acc &= rows[buckets[k] * words + w];
        }
        out[base + w] = acc;
      }
    }
    return out;
  }

  /** Bytes held by the bit rows. Event content is never copied; `indexed` holds references. */
  byteSize(): number {
    let bytes = 0;
    for (const block of this.blocks) {
      bytes += block.rows.byteLength;
    }
    return bytes;
  }
}
