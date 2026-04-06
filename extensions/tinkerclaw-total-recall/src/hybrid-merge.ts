/**
 * FORK: Hybrid merge of vector and keyword (FTS) search results.
 *
 * Normalizes scores from each source to [0, 1] and combines them with
 * configurable weights (default 0.6 vector / 0.4 keyword). Events appearing
 * in both result sets get the weighted sum; events in only one set get the
 * single-source score scaled by its weight.
 */

import type { VectorSearchResult } from "./vector-search.js";

export interface KeywordSearchResult {
  eventId: string;
  score: number;
}

export interface MergedResult {
  eventId: string;
  score: number; // weighted combined score
  vectorScore: number; // 0 if not in vector results
  keywordScore: number; // 0 if not in FTS results
}

export interface MergeParams {
  vector: VectorSearchResult[];
  keyword: KeywordSearchResult[];
  vectorWeight?: number; // default 0.6
  keywordWeight?: number; // default 0.4
}

/**
 * Merge vector search results with FTS results by event ID.
 *
 * 1. Normalize scores within each set to [0, 1] (divide by max in set).
 * 2. Union by eventId.
 * 3. Combined score = vectorWeight * normVectorScore + keywordWeight * normKeywordScore.
 * 4. Sort descending by combined score.
 */
export function mergeHybridResults(params: MergeParams): MergedResult[] {
  const { vector, keyword, vectorWeight = 0.6, keywordWeight = 0.4 } = params;

  if (vector.length === 0 && keyword.length === 0) {
    return [];
  }

  const maxVec = vector.reduce((m, r) => Math.max(m, r.score), 0);
  const maxKw = keyword.reduce((m, r) => Math.max(m, r.score), 0);

  const vecMap = new Map<string, number>();
  for (const r of vector) {
    vecMap.set(r.eventId, maxVec > 0 ? r.score / maxVec : 0);
  }

  const kwMap = new Map<string, number>();
  for (const r of keyword) {
    kwMap.set(r.eventId, maxKw > 0 ? r.score / maxKw : 0);
  }

  const allIds = new Set<string>([...vecMap.keys(), ...kwMap.keys()]);

  const merged: MergedResult[] = [];
  for (const eventId of allIds) {
    const normVec = vecMap.get(eventId) ?? 0;
    const normKw = kwMap.get(eventId) ?? 0;
    merged.push({
      eventId,
      score: vectorWeight * normVec + keywordWeight * normKw,
      vectorScore: normVec,
      keywordScore: normKw,
    });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}
