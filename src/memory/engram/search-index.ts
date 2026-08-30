/**
 * ENGRAM Phase 1D: Search index for event retrieval.
 * Provides full-text search (FTS) and placeholder for vector search.
 */

import type { EmbeddingCache } from "./embedding-cache.js";
import type { EmbedFn } from "./embedding-worker.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent, EventKind } from "./event-types.js";

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

/**
 * Simple full-text search over event store.
 * Scores by term frequency (TF) with position boost for earlier matches.
 */
export function ftsSearch(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
): SearchResult[] {
  const rawTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (rawTerms.length === 0) {
    return [];
  }

  // FORK 2026-08-22 — SCORE EACH DISTINCT TERM ONCE, WEIGHTED BY HOW OFTEN IT WAS ASKED.
  //
  // The scoring loop below runs once per event PER TERM, so its cost is O(events x terms) and
  // `terms` is the whole user prompt. Measured on the architect's live cc-experience store
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
  // for the normalisation below so the divisor is unchanged too — deduping THAT would have
  // silently rescaled every score.
  const termCounts = new Map<string, number>();
  for (const t of rawTerms) {
    termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  }
  const uniqueTerms = [...termCounts.entries()];

  const events = applyFilters(store.readAll(), filters);

  const scored: SearchResult[] = [];

  for (const event of events) {
    const content = lowerContent(event);
    let score = 0;

    for (const [term, multiplicity] of uniqueTerms) {
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

    if (score > 0) {
      // Partial matches get a natural penalty via dividing by total term count. Deliberately
      // `rawTerms.length`, NOT the deduped count — the divisor is part of the score's meaning
      // and changing it would rescale every result while looking like a tidy-up.
      score = score / rawTerms.length;
      scored.push({ event, score, matchType: "fts" });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
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
