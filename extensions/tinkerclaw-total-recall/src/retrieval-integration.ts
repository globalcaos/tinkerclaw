/**
 * ENGRAM Phase 1.2: Retrieval pack assembly.
 *
 * Assembles a token-bounded string of relevant past events for injection
 * into the system prompt. Pipeline:
 *   Hybrid (FTS + vector) search → task-conditioned scoring → MMR dedup → token-bounded format.
 *
 * When an embedding cache and embed function are provided via setEmbeddingContext(),
 * the pipeline runs vector search alongside FTS and merges the results using
 * weighted scoring (0.6 vector / 0.4 keyword). Falls back gracefully to FTS-only
 * when embeddings are unavailable or the provider is down.
 */

import type { EmbeddingCache } from "./embedding-cache.js";
import type { EmbedFn } from "./embedding-worker.js";
import { estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import { mergeHybridResults } from "./hybrid-merge.js";
import { ftsSearch } from "./search-index.js";
import { taskConditionedScore } from "./task-conditioned-scoring.js";
import { createDefaultTaskState } from "./task-state.js";
import { vectorSearch } from "./vector-search.js";

/** Default token budget for a retrieval pack (fits comfortably in system prompt). */
export const DEFAULT_RETRIEVAL_MAX_TOKENS = 4096;

// -- Embedding context (set once at extension init, read by assembleRetrievalPack) --

let sharedEmbeddingCache: EmbeddingCache | null = null;
let sharedEmbedFn: EmbedFn | null = null;

/**
 * Provide embedding cache + embed function for hybrid retrieval.
 * Call once during extension initialisation. If never called, the pipeline
 * falls back to FTS-only (no vector search).
 */
export function setEmbeddingContext(cache: EmbeddingCache, embedFn: EmbedFn): void {
  sharedEmbeddingCache = cache;
  sharedEmbedFn = embedFn;
}

/** MMR diversity weight: higher = more relevance-focused, lower = more diverse. */
const MMR_LAMBDA = 0.7;

/** How many FTS candidates to pull before scoring + MMR. */
const FTS_TOP_N = 50;

/** Section header token cost. */
const HEADER_TEXT = "## Retrieved Context";

export interface AssembleOptions {
  /** Token budget for the assembled pack. Defaults to DEFAULT_RETRIEVAL_MAX_TOKENS. */
  maxTokens?: number;
  /** If set, filters to events from this task and applies task-conditioned scoring. */
  taskId?: string;
}

/**
 * Word-level Jaccard similarity between two strings.
 * Used for MMR redundancy estimation (faster than embedding cosine for this scale).
 */
function wordJaccard(a: string, b: string): number {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface ScoredEvent {
  event: MemoryEvent;
  score: number;
}

/**
 * Maximal Marginal Relevance reranking.
 */
function mmrRerank(
  candidates: ScoredEvent[],
  lambda: number = MMR_LAMBDA,
  maxItems: number = FTS_TOP_N,
): ScoredEvent[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const selected: ScoredEvent[] = [];
  const remaining = [...candidates];

  while (remaining.length > 0 && selected.length < maxItems) {
    let bestScore = -Infinity;
    let bestIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = wordJaccard(c.event.content, s.event.content);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

function formatEvent(event: MemoryEvent): string {
  const ts = event.timestamp.slice(0, 19);
  const preview = event.content.length > 300 ? `${event.content.slice(0, 300)}…` : event.content;
  return `[${ts}] [${event.kind}] ${preview}`;
}

/**
 * Assemble a retrieval pack: a token-bounded, relevance-ranked, deduplicated
 * string of past events ready for system prompt injection.
 *
 * When embedding context is available (via setEmbeddingContext), runs hybrid
 * FTS + vector search. Otherwise falls back to FTS-only. Embedding failures
 * are caught and degraded gracefully.
 */
export async function assembleRetrievalPack(
  query: string,
  eventStore: EventStore,
  options?: AssembleOptions,
): Promise<string> {
  const maxTokens = options?.maxTokens ?? DEFAULT_RETRIEVAL_MAX_TOKENS;
  const taskId = options?.taskId;

  if (eventStore.count() === 0) {
    return "";
  }

  // 1. FTS search
  const ftsResults = ftsSearch(eventStore, query, FTS_TOP_N, taskId ? { taskId } : undefined);

  // 1.5. Hybrid merge — combine FTS with vector search when embeddings available
  let candidateIds: Map<string, number>;

  if (sharedEmbeddingCache && sharedEmbedFn) {
    try {
      const [queryEmbedding] = await sharedEmbedFn([query]);
      if (queryEmbedding) {
        const vecResults = vectorSearch(
          queryEmbedding,
          eventStore,
          sharedEmbeddingCache,
          FTS_TOP_N,
        );
        const merged = mergeHybridResults({
          vector: vecResults,
          keyword: ftsResults.map((r) => ({ eventId: r.event.id, score: r.score })),
        });
        candidateIds = new Map(merged.map((m) => [m.eventId, m.score]));
      } else {
        candidateIds = new Map(ftsResults.map((r) => [r.event.id, r.score]));
      }
    } catch {
      // Embedding provider down — graceful degradation to FTS-only
      candidateIds = new Map(ftsResults.map((r) => [r.event.id, r.score]));
    }
  } else {
    candidateIds = new Map(ftsResults.map((r) => [r.event.id, r.score]));
  }

  if (candidateIds.size === 0) {
    return "";
  }

  // Resolve event objects for candidates (some may come from vector-only matches)
  const allEvents = eventStore.readAll();
  const eventById = new Map(allEvents.map((e) => [e.id, e]));

  // 2. Task-conditioned scoring
  const taskState = createDefaultTaskState(taskId ?? "default");
  const scored: ScoredEvent[] = [];
  for (const [eventId, baseScore] of candidateIds) {
    const event = eventById.get(eventId);
    if (!event) {
      continue;
    }
    scored.push({
      event,
      score: taskConditionedScore(event, baseScore, taskState),
    });
  }

  // 3. Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 4. MMR deduplication
  const reranked = mmrRerank(scored);

  // 5. Token-bounded assembly
  const headerTokens = estimateTokens(`${HEADER_TEXT}\n`);
  if (headerTokens >= maxTokens) {
    return "";
  }

  const lines: string[] = [HEADER_TEXT];
  let tokensUsed = headerTokens;

  for (const { event } of reranked) {
    const line = formatEvent(event);
    const lineTokens = estimateTokens(`${line}\n`);
    if (tokensUsed + lineTokens > maxTokens) {
      break;
    }
    lines.push(line);
    tokensUsed += lineTokens;
  }

  if (lines.length === 1) {
    return "";
  }

  return lines.join("\n");
}
