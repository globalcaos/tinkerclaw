/**
 * FORK: Vector similarity search over the embedding cache.
 * Brute-force cosine similarity -- fast enough for <50K events.
 *
 * Used by the hybrid retrieval pipeline in retrieval-integration.ts to
 * complement FTS with semantic matching. Iterates events from the EventStore
 * and looks up their embeddings in the EmbeddingCache (which has no keys()
 * iterator, so we must drive iteration from the event list).
 */

import type { EmbeddingCache } from "./embedding-cache.js";
import type { EventStore } from "./event-store.js";

export interface VectorSearchResult {
  eventId: string;
  score: number; // cosine similarity [0, 1]
}

/**
 * Cosine similarity between two Float32Arrays.
 * Returns 0 for zero-norm vectors or dimension mismatch.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
 * Search for events similar to the query embedding.
 * Returns top-K results sorted descending by cosine similarity.
 */
export function vectorSearch(
  queryEmbedding: Float32Array,
  store: EventStore,
  cache: EmbeddingCache,
  topK: number = 30,
): VectorSearchResult[] {
  const events = store.readAll();
  if (events.length === 0) {
    return [];
  }

  const scored: VectorSearchResult[] = [];

  for (const event of events) {
    const emb = cache.get(event.id);
    if (!emb) {
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score > 0) {
      scored.push({ eventId: event.id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
