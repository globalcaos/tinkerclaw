/**
 * ENGRAM Phase 1D: Search index for event retrieval.
 * Provides full-text search (FTS) and placeholder for vector search.
 */

import type { EmbeddingCache } from "./embedding-cache.js";
import type { EmbedFn } from "./embedding-worker.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent, EventKind } from "./event-types.js";
import { TrigramIndex } from "./trigram-index.js";

export interface SearchResult {
  event: MemoryEvent;
  score: number;
  matchType: "fts" | "vector";
}

export interface SearchFilters {
  taskId?: string;
  kinds?: EventKind[];
  since?: string;
  until?: string;
}

/**
 * Apply search filters to an event list.
 */
function applyFilters(
  events: ReturnType<EventStore["readAll"]>,
  filters?: SearchFilters,
): ReturnType<EventStore["readAll"]> {
  let filtered = events;
  if (filters?.taskId) {
    filtered = filtered.filter((e) => e.metadata.taskId === filters.taskId);
  }
  if (filters?.kinds) {
    const kindSet = new Set(filters.kinds);
    filtered = filtered.filter((e) => kindSet.has(e.kind));
  }
  if (filters?.since) {
    filtered = filtered.filter((e) => e.timestamp >= filters.since!);
  }
  if (filters?.until) {
    filtered = filtered.filter((e) => e.timestamp <= filters.until!);
  }
  return filtered;
}

/**
 * FORK 2026-08-22 — LOWERCASE ONCE PER EVENT, NOT ONCE PER SEARCH.
 *
 * `ftsSearch` lowercased `event.content` for every event on every call. The architect's
 * live stores are 2,995 events / 15MB (cc-experience) and 2,307 / 6MB (his own session),
 * both scanned in full on every pack build — so each build lowercased ~21MB of text that
 * had not changed since the last build.
 *
 * Keyed on the event OBJECT, not its id: the store hands out entries from a parsed cache,
 * so identity is stable for as long as the cache lives, and a WeakMap lets a dropped cache
 * be collected without a manual eviction policy. Content is immutable once appended
 * (`append`/`appendRaw` only ever push new objects), so a memo can never go stale.
 */
const lowerContentCache = new WeakMap<MemoryEvent, string>();

function lowerContent(event: MemoryEvent): string {
  const cached = lowerContentCache.get(event);
  if (cached !== undefined) {
    return cached;
  }
  const lowered = event.content.toLowerCase();
  lowerContentCache.set(event, lowered);
  return lowered;
}

/**
 * Count non-overlapping occurrences of `term` in `haystack`.
 *
 * Replaces `haystack.split(term).length - 1`, which allocated an array of every substring
 * between matches — on a 15MB corpus, per matching term, per event — purely to read its
 * length. `String.prototype.split` on a string separator scans left to right and does not
 * consider overlapping matches, which is exactly what stepping by `term.length` does, so
 * the count is identical.
 */
export function countOccurrences(haystack: string, term: string): number {
  // An empty term would make the loop below spin forever: indexOf("") returns the search
  // position, and stepping by term.length steps by zero. `ftsSearch` filters terms to
  // 3+ characters so it cannot happen on the live path, but this is exported now and a
  // hang is a far worse failure than a wrong count. Deliberately NOT matching
  // `"abc".split("").length - 1` (which is 2, a character count) — that reading has no
  // meaning as an occurrence count and no caller wants it.
  if (!term) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(term);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(term, idx + term.length);
  }
  return count;
}

interface ParsedQuery {
  /** Distinct terms, first-seen order, each with how often the query repeated it. */
  terms: Array<[string, number]>;
  /** Every 3+ char term INCLUDING repeats — the score's divisor. */
  termCount: number;
}

function parseQuery(query: string): ParsedQuery | undefined {
  const rawTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (rawTerms.length === 0) {
    return undefined;
  }

  // FORK 2026-08-22 — SCORE EACH DISTINCT TERM ONCE, WEIGHTED BY HOW OFTEN IT WAS ASKED.
  //
  // The scoring loop (`rawScore`) runs once per event PER TERM, so its cost is O(events x terms)
  // and `terms` is the whole user prompt. Measured on the architect's live cc-experience store
  // (3,081 events / 15.6MB), holding everything else fixed:
  //
  //     query chars    terms   unique   pack ms
  //            400       51       43       439
  //          4,000      466      176     3,456
  //         12,324    1,358      262    10,261
  //
  // A real turn of his measured 10,735ms at 12,324 chars, so the model is the whole story.
  // Note the fourth column: 1,358 terms but only 262 DISTINCT ones — 5.2x redundancy, and
  // every duplicate re-scanned all 3,081 events.
  //
  // EXACTLY EQUIVALENT, not an approximation. The old loop did `score += contribution` once
  // per occurrence of a term in the array; k occurrences of the same term therefore added
  // k x contribution, and the contribution depends only on (content, term). Multiplying a
  // single evaluation by its multiplicity is the same number. `rawTerms.length` is retained
  // as `termCount` for the normalisation so the divisor is unchanged too — deduping THAT would
  // have silently rescaled every score.
  const termCounts = new Map<string, number>();
  for (const t of rawTerms) {
    termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  }
  return { terms: [...termCounts.entries()], termCount: rawTerms.length };
}

/** False when `ftsSearch` would return [] for any store without reading it (no 3+ char term). */
export function ftsQueryHasTerms(query: string): boolean {
  return parseQuery(query) !== undefined;
}

/**
 * The summed term contributions for one event's lower-cased content — the ONE copy of the FTS
 * scoring rules, shared by the linear scan and the prefiltered one.
 *
 * `masks[j]`, when given, is term j's candidate bitset (see trigram-index.ts) and `e` this
 * event's bit in it. A clear bit means term j cannot occur in `content`, i.e. `indexOf` would
 * return -1 and the loop below would add nothing for it — so skipping it leaves the sum, and
 * the order of its additions, exactly as they were.
 */
function rawScore(
  content: string,
  terms: ReadonlyArray<[string, number]>,
  masks?: readonly Uint32Array[],
  e = 0,
): number {
  const word = e >>> 5;
  const bit = 1 << (e & 31);
  let score = 0;

  for (let j = 0; j < terms.length; j++) {
    if (masks && (masks[j][word] & bit) === 0) {
      continue;
    }
    const [term, multiplicity] = terms[j];
    const firstMatchIdx = content.indexOf(term);
    if (firstMatchIdx !== -1) {
      // Frequency bonus: more occurrences = higher confidence.
      const occurrences = countOccurrences(content, term);
      // Earlier match position indicates higher relevance.
      const contribution =
        1.0 +
        Math.log2(occurrences + 1) * 0.5 +
        (1.0 - firstMatchIdx / Math.max(content.length, 1)) * 0.3;
      // x multiplicity: the old loop added this once per OCCURRENCE of the term in the
      // query, and the value does not depend on which occurrence it was.
      score += contribution * multiplicity;
    }
  }
  return score;
}

/**
 * Push a hit if the event matched anything. Partial matches get a natural penalty via dividing
 * by the total term count. Deliberately `termCount` (every term, repeats included), NOT the
 * deduped count — the divisor is part of the score's meaning and changing it would rescale
 * every result while looking like a tidy-up.
 */
function pushHit(scored: SearchResult[], event: MemoryEvent, raw: number, termCount: number) {
  if (raw > 0) {
    scored.push({ event, score: raw / termCount, matchType: "fts" });
  }
}

function topHits(scored: SearchResult[], topN: number): SearchResult[] {
  // Stable: tied scores keep corpus order.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * The full linear scan — every event against every distinct term. Kept as the ORACLE the
 * prefiltered path is pinned against (search-index.prefilter-parity.test.ts), and as the
 * readable statement of what `ftsSearch` returns. Nothing on a live path should call it.
 */
export function ftsSearchLinear(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
): SearchResult[] {
  const parsed = parseQuery(query);
  if (!parsed) {
    return [];
  }
  const scored: SearchResult[] = [];
  for (const event of applyFilters(store.readAll(), filters)) {
    pushHit(scored, event, rawScore(lowerContent(event), parsed.terms), parsed.termCount);
  }
  return topHits(scored, topN);
}

// FORK 2026-09-23 — THE PREFILTERED SCAN (plan task 14).
//
// MEASURED: `ftsSearch` + `countOccurrences` were ~35-42% of the gateway's main thread in a live
// CPU profile, under the background pack refresh. On a copy of the architect's cc-experience
// store (10,173 events, 69.7M chars) the linear scan took 11.0 / 19.6 / 25.7 s for synthetic
// 2k / 6k / 12k-char prompts (183 / 316 / 432 distinct terms), while only 16-24% of (event, term)
// pairs are actual hits: most of the time went on proving that a term is NOT in an event.
//
// EXACTLY THE SAME RESULTS, not an approximation. An event scores > 0 only through a term it
// contains; the trigram index yields a SUPERSET of the events containing each term; `rawScore`
// skips only terms whose candidate bit is clear, for which the linear loop adds nothing. Events
// are visited in the same (filtered) order, so the stable sort ties identically. Pinned against
// `ftsSearchLinear` by a property test, not by this paragraph.

const trigramIndexes = new WeakMap<EventStore, TrigramIndex>();

/** A search that can be run in slices. `ftsSearch` runs it in one; the async assembler yields. */
export interface FtsScan {
  /** Work until finished or `shouldPause()` returns true. Returns true once finished. */
  step(shouldPause: () => boolean): boolean;
  /** The top `topN` hits. Call once, after `step` has returned true. */
  results(topN: number): SearchResult[];
}

class PrefilteredScan implements FtsScan {
  private masks: Uint32Array[] | undefined;
  private resumed = false;
  private filteredPos = 0;
  private eventPos = 0;
  private readonly scored: SearchResult[] = [];

  constructor(
    private readonly parsed: ParsedQuery,
    /** This scan's snapshot of the corpus — `readAll()` returns a copy. */
    private readonly events: MemoryEvent[],
    private readonly filtered: MemoryEvent[],
    /** Shared with every other scan of the same store — until it is taken away (see step). */
    private index: TrigramIndex,
  ) {}

  step(shouldPause: () => boolean): boolean {
    if (!this.masks) {
      // Re-verified on EVERY resume: while this scan was paused another search of the same store
      // may have extended the shared index with ITS snapshot, or discarded it. Reconciling
      // against this scan's own snapshot, then computing every mask in this same synchronous
      // step, means the masks describe exactly these events.
      if (!this.index.reconcile(this.events) && this.resumed) {
        // Another scan rewrote the shared index under this one, so their snapshots disagree.
        // Two such scans would otherwise discard each other's work on every resume, forever.
        // Finish on a private index instead.
        this.index = new TrigramIndex();
      }
      this.resumed = true;
      while (this.index.size < this.events.length) {
        const event = this.events[this.index.size];
        this.index.append(event, lowerContent(event));
        if (shouldPause()) {
          return false;
        }
      }
      // One pass per term over events/32 words — bounded, so no pause inside it.
      this.masks = this.parsed.terms.map(([term]) => this.index.candidates(term));
    }

    const { events, filtered, masks } = this;
    const { terms, termCount } = this.parsed;
    const unfiltered = filtered === events;
    while (this.filteredPos < filtered.length) {
      const event = filtered[this.filteredPos++];
      if (!unfiltered) {
        // `applyFilters` only removes events, so `filtered` is an order-preserving subsequence of
        // `events` and a forward walk finds each one's position.
        while (this.eventPos < events.length && events[this.eventPos] !== event) {
          this.eventPos++;
        }
      }
      const e = unfiltered ? this.filteredPos - 1 : this.eventPos++;
      const content = lowerContent(event);
      // `e < events.length` always holds; the unmasked branch keeps it exact if it ever did not.
      const raw = e < events.length ? rawScore(content, terms, masks, e) : rawScore(content, terms);
      pushHit(this.scored, event, raw, termCount);
      if (shouldPause()) {
        return false;
      }
    }
    return true;
  }

  results(topN: number): SearchResult[] {
    return topHits(this.scored, topN);
  }
}

/**
 * Start a prefiltered FTS scan. `undefined` when the query has no 3+ char term (no store read),
 * which is `ftsSearch`'s empty result.
 */
export function beginFtsScan(
  store: EventStore,
  query: string,
  filters?: SearchFilters,
): FtsScan | undefined {
  const parsed = parseQuery(query);
  if (!parsed) {
    return undefined;
  }
  const events = store.readAll();
  let index = trigramIndexes.get(store);
  if (!index) {
    index = new TrigramIndex();
    trigramIndexes.set(store, index);
  }
  return new PrefilteredScan(parsed, events, applyFilters(events, filters), index);
}

const neverPause = (): boolean => false;

/**
 * Full-text search over an event store. Scores by term frequency (TF) with a position boost
 * for earlier matches. Returns exactly what {@link ftsSearchLinear} returns, via the trigram
 * prefilter.
 */
export function ftsSearch(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
): SearchResult[] {
  const scan = beginFtsScan(store, query, filters);
  if (!scan) {
    return [];
  }
  scan.step(neverPause);
  return scan.results(topN);
}

/**
 * Cosine similarity between two Float32Arrays.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Vector search using embedding cache.
 * Embeds the query, then computes cosine similarity against all cached event embeddings.
 */
export async function vectorSearch(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
  embeddingCache?: EmbeddingCache,
  embedFn?: EmbedFn,
): Promise<SearchResult[]> {
  if (!embeddingCache || !embedFn) {
    return [];
  }

  const [queryEmbedding] = await embedFn([query]);
  if (!queryEmbedding) {
    return [];
  }

  const events = applyFilters(store.readAll(), filters);

  const scored: SearchResult[] = [];
  for (const event of events) {
    const emb = embeddingCache.get(event.id);
    if (!emb) {
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score > 0) {
      scored.push({ event, score, matchType: "vector" });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * Combined search: merge FTS and vector results, deduplicate.
 */
export async function combinedSearch(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
  embeddingCache?: EmbeddingCache,
  embedFn?: EmbedFn,
): Promise<SearchResult[]> {
  const ftsResults = ftsSearch(store, query, topN, filters);
  const vecResults = await vectorSearch(store, query, topN, filters, embeddingCache, embedFn);

  // Merge and deduplicate by event ID
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of [...vecResults, ...ftsResults]) {
    if (!seen.has(r.event.id)) {
      seen.add(r.event.id);
      merged.push(r);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, topN);
}
