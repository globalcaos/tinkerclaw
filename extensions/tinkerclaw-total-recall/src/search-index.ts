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
 * Simple full-text search over event store.
 * Scores by term frequency (TF) with position boost for earlier matches.
 */
export function ftsSearch(
  store: EventStore,
  query: string,
  topN: number = 20,
  filters?: SearchFilters,
): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) {
    return [];
  }

  const events = applyFilters(store.readAll(), filters);

  const scored: SearchResult[] = [];

  for (const event of events) {
    const content = event.content.toLowerCase();
    let score = 0;

    for (const term of terms) {
      const firstMatchIdx = content.indexOf(term);
      if (firstMatchIdx !== -1) {
        score += 1.0;
        // Frequency bonus: more occurrences = higher confidence.
        const occurrences = content.split(term).length - 1;
        score += Math.log2(occurrences + 1) * 0.5;
        // Earlier match position indicates higher relevance.
        score += (1.0 - firstMatchIdx / Math.max(content.length, 1)) * 0.3;
      }
    }

    if (score > 0) {
      // Partial matches get a natural penalty via dividing by total term count.
      score = score / terms.length;
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
