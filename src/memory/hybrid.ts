// Intent: clean code refactoring applied (naming, clarity, DRY, magic numbers)
import { applyMMRToHybridResults, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { extractKeywords } from "./query-expansion.js";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

export type HybridSource = string;

export { type MMRConfig, DEFAULT_MMR_CONFIG };
export { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG };

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

/**
 * Builds the FTS5 MATCH expression for a free-text query: its keywords (extractKeywords drops
 * stop words, bare numbers and Latin words under three letters), each quoted as a phrase and
 * joined with OR. When no keyword survives ("what is that"), the raw tokens are ORed instead.
 * Returns null when the query has no word characters (letters, digits, underscore).
 *
 * Until 2026-10-29 this was an AND of every raw token. On an agent-memory eval (100 files,
 * 40 natural-language queries frozen before any run, 30 EN and 10 ES/CA), that AND returned
 * zero rows for 40 of 40 queries, so the configured 0.7/0.3 hybrid was really vector-only.
 * The OR of keywords raised word-search R@5 from 0.475 (one search per keyword, best score
 * kept) to 0.625, and hybrid R@5 by +0.05 to +0.225 for five of the six embedding models run
 * on that corpus (the sixth was unchanged). BM25 adds a score for each matched term, so, other
 * things equal, a row that matches more keywords ranks first. Cost on an 11.5 GB live index:
 * 276 ms p50, 377 ms p95 over 12 read-only OR queries.
 * Revisit if a re-run of that eval shows a stricter query (AND, phrase, NEAR) beating the OR.
 * Known limit: the default unicode61 tokenizer indexes a CJK run without spaces as one token,
 * so the CJK characters and bigrams from extractKeywords match only standalone tokens.
 */
export function buildFtsQuery(raw: string): string | null {
  const rawTokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (rawTokens.length === 0) {
    return null;
  }
  const keywords = extractKeywords(raw);
  const terms = keywords.length > 0 ? keywords : rawTokens;
  const quoted = terms.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<
  Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: HybridSource;
  }>
> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) {
    return applyMMRToHybridResults(sorted, mmrConfig);
  }

  return sorted;
}
