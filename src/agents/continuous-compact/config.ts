/**
 * Continuous compacting configuration.
 *
 * Rolling window + topic-aware embedding retrieval — replaces batch
 * compaction for conversations that opt in via `continuousCompact.enabled`.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { EmbeddingProvider } from "../../memory/embeddings.js";
import { createEmbeddingProvider } from "../../memory/embeddings.js";
import { resolveMemorySearchConfig } from "../memory-search.js";

// ── Turn Indexer Config ─────────────────────────────────────────────

export interface TurnIndexerConfig {
  /** Max recent turns in active window. Default: 20 */
  windowSize: number;
  /** Max tokens for the active window. Default: 40 000 */
  windowTokenBudget: number;
  /** Batch size for embedding calls. Default: 10 */
  batchSize: number;
  /** Skip very short turns (chars). Default: 20 */
  minTurnChars: number;
  /** Max chars per turn to embed (truncate longer). Default: 8 000 */
  maxEmbedChars: number;
}

export const DEFAULT_INDEXER_CONFIG: TurnIndexerConfig = {
  windowSize: 20,
  windowTokenBudget: 40_000,
  batchSize: 10,
  minTurnChars: 20,
  maxEmbedChars: 8_000,
};

// ── Retrieval Config ────────────────────────────────────────────────

export interface RetrievalConfig {
  /** Max turn chunks to retrieve. Default: 8 */
  maxRetrievedChunks: number;
  /** Token budget for all retrieved content. Default: 15 000 */
  maxRetrievedTokens: number;
  /** Min cosine similarity score. Default: 0.35 */
  minScore: number;
  /** Recent active-window messages included in query. Default: 3 */
  recentContextForQuery: number;
  /** Apply recency boost. Default: true */
  recencyBoost: boolean;
  /** Recency boost half-life in turn indices. Default: 50 */
  recencyHalfLife: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxRetrievedChunks: 8,
  maxRetrievedTokens: 15_000,
  minScore: 0.35,
  recentContextForQuery: 3,
  recencyBoost: true,
  recencyHalfLife: 50,
};

// ── Top-Level Config ────────────────────────────────────────────────

export interface ContinuousCompactConfig {
  /** Enable continuous compacting. Default: false */
  enabled: boolean;
  /** Turn indexer settings. */
  indexer: TurnIndexerConfig;
  /** Retrieval settings. */
  retrieval: RetrievalConfig;
  /** Fallback to batch compaction on failure. Default: true */
  fallbackToBatchCompaction: boolean;
}

export const DEFAULT_CONTINUOUS_COMPACT_CONFIG: ContinuousCompactConfig = {
  enabled: false,
  indexer: DEFAULT_INDEXER_CONFIG,
  retrieval: DEFAULT_RETRIEVAL_CONFIG,
  fallbackToBatchCompaction: true,
};

/**
 * Resolve continuous compact config from OpenClaw config.
 */
export function resolveContinuousCompactConfig(
  cfg: OpenClawConfig | undefined,
): ContinuousCompactConfig {
  const raw = (cfg?.agents?.defaults as Record<string, unknown> | undefined)?.continuousCompact as
    | Record<string, unknown>
    | undefined;
  if (!raw?.enabled) {
    return { ...DEFAULT_CONTINUOUS_COMPACT_CONFIG, enabled: false };
  }

  return {
    enabled: true,
    indexer: {
      windowSize: (raw.windowSize as number) ?? DEFAULT_INDEXER_CONFIG.windowSize,
      windowTokenBudget:
        (raw.windowTokenBudget as number) ?? DEFAULT_INDEXER_CONFIG.windowTokenBudget,
      batchSize: (raw.batchSize as number) ?? DEFAULT_INDEXER_CONFIG.batchSize,
      minTurnChars: (raw.minTurnChars as number) ?? DEFAULT_INDEXER_CONFIG.minTurnChars,
      maxEmbedChars: (raw.maxEmbedChars as number) ?? DEFAULT_INDEXER_CONFIG.maxEmbedChars,
    },
    retrieval: {
      maxRetrievedChunks:
        (raw.maxRetrievedTurns as number) ?? DEFAULT_RETRIEVAL_CONFIG.maxRetrievedChunks,
      maxRetrievedTokens:
        (raw.maxRetrievedTokens as number) ?? DEFAULT_RETRIEVAL_CONFIG.maxRetrievedTokens,
      minScore: (raw.minScore as number) ?? DEFAULT_RETRIEVAL_CONFIG.minScore,
      recentContextForQuery: DEFAULT_RETRIEVAL_CONFIG.recentContextForQuery,
      recencyBoost: (raw.recencyBoost as boolean) ?? DEFAULT_RETRIEVAL_CONFIG.recencyBoost,
      recencyHalfLife: DEFAULT_RETRIEVAL_CONFIG.recencyHalfLife,
    },
    fallbackToBatchCompaction: (raw.fallbackToBatchCompaction as boolean) ?? true,
  };
}

/**
 * Get or create an embedding provider from existing memory search config.
 */
export async function getOrCreateEmbeddingProvider(
  cfg: OpenClawConfig | undefined,
  agentDir: string,
): Promise<EmbeddingProvider | null> {
  if (!cfg) {
    return null;
  }
  const memConfig = resolveMemorySearchConfig(cfg, "main");
  if (!memConfig) {
    return null;
  }

  try {
    const result = await createEmbeddingProvider({
      config: cfg,
      agentDir,
      provider: memConfig.provider,
      model: memConfig.model,
      fallback: memConfig.fallback ?? "none",
      local: {
        modelPath: memConfig.local?.modelPath,
        modelCacheDir: memConfig.local?.modelCacheDir,
      },
    });
    return result.provider;
  } catch {
    return null;
  }
}
