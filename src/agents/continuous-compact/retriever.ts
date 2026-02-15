/**
 * Retriever: topic-aware query building, vector search, recency boost.
 *
 * Retrieves relevant past turns organized by conversation topics,
 * with cross-topic awareness to avoid losing parallel threads.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddingProvider } from "../../memory/embeddings.js";
import type { RetrievalConfig } from "./config.js";
import type { SessionVectorStore, ScoredTurnChunk } from "./session-store.js";
import { DEFAULT_RETRIEVAL_CONFIG } from "./config.js";
import { cosineSimilarity } from "./session-store.js";
import { flattenMessageText } from "./turn-indexer.js";

// ── Query Building ──────────────────────────────────────────────────

/**
 * Build a search query from the current message + recent active window.
 * Recent context helps disambiguate vague messages ("yes", "continue").
 */
export function buildRetrievalQuery(
  currentMessage: string,
  recentMessages: AgentMessage[],
  config: RetrievalConfig,
): string {
  const recentTexts = recentMessages
    .slice(-config.recentContextForQuery)
    .map((m) => flattenMessageText(m))
    .filter((t) => t.length > 10)
    .map((t) => t.slice(0, 500));

  return [...recentTexts, currentMessage].join("\n\n");
}

// ── Recency Boost ───────────────────────────────────────────────────

function applyRecencyBoost(
  results: ScoredTurnChunk[],
  maxTurnIndex: number,
  halfLife: number,
  boostWeight = 0.1,
): ScoredTurnChunk[] {
  return results.map((r) => {
    const distance = maxTurnIndex - r.turnEndIndex;
    const boost = boostWeight * Math.exp(-distance / halfLife);
    return { ...r, score: r.score + boost };
  });
}

// ── Topic-Aware Retrieval ───────────────────────────────────────────

/**
 * Retrieve relevant past turns using topic-aware strategy.
 *
 * 1. Embed query
 * 2. Identify which topic(s) the query belongs to via centroid similarity
 * 3. Pull coherent sequences from matching topics
 * 4. Pull most recent turn from OTHER active topics (cross-topic awareness)
 * 5. Apply recency boost, filter to budget, return chronologically
 */
export async function retrieveRelevantTurns(
  store: SessionVectorStore,
  query: string,
  embedder: EmbeddingProvider,
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): Promise<ScoredTurnChunk[]> {
  if (store.getTurnCount() === 0) {
    return [];
  }

  // 1. Embed query
  const queryEmbedding = await embedder.embedQuery(query);

  // 2. Identify matching topics via centroid similarity
  const topics = store.getTopics();
  const topicScores = topics
    .map((t) => ({
      id: t.id,
      sim: t.centroid.length > 0 ? cosineSimilarity(queryEmbedding, t.centroid) : 0,
    }))
    .filter((t) => t.sim > config.minScore)
    .toSorted((a, b) => b.sim - a.sim);

  const primaryTopicIds = topicScores.slice(0, 2).map((t) => t.id);

  // 3. Topic-aware search
  let candidates: ScoredTurnChunk[] = [];
  if (primaryTopicIds.length > 0) {
    for (const topicId of primaryTopicIds) {
      const topicResults = store.searchByTopic(
        topicId,
        queryEmbedding,
        config.maxRetrievedChunks,
        config.minScore,
      );
      candidates.push(...topicResults);
    }

    // 4. Cross-topic awareness: most recent turn from other topics
    const crossTopicTurns = store.getRecentTurnPerTopic(primaryTopicIds, 2);
    candidates.push(...crossTopicTurns);
  } else {
    // Fallback: no topic match — use flat vector search
    candidates = store.searchSimilar(
      queryEmbedding,
      config.maxRetrievedChunks * 3,
      config.minScore,
    );
  }

  if (candidates.length === 0) {
    return [];
  }

  // Deduplicate
  const seen = new Set<string>();
  candidates = candidates.filter((c) => {
    if (seen.has(c.id)) {
      return false;
    }
    seen.add(c.id);
    return true;
  });

  // 5. Recency boost
  const maxTurnIndex = Math.max(...candidates.map((c) => c.turnEndIndex));
  const boosted = config.recencyBoost
    ? applyRecencyBoost(candidates, maxTurnIndex, config.recencyHalfLife)
    : candidates;

  // 6. Select by boosted score within token budget
  const byScore = boosted.toSorted((a, b) => b.score - a.score);
  const selectedIds = new Set<string>();
  let tokenBudget = config.maxRetrievedTokens;

  for (const turn of byScore) {
    if (selectedIds.size >= config.maxRetrievedChunks) {
      break;
    }
    if (turn.tokenEstimate > tokenBudget) {
      continue;
    }
    tokenBudget -= turn.tokenEstimate;
    selectedIds.add(turn.id);
  }

  // 7. Return in chronological order
  return boosted
    .filter((t) => selectedIds.has(t.id))
    .toSorted((a, b) => a.turnStartIndex - b.turnStartIndex);
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Format retrieved turns for injection into the system prompt.
 */
export function formatRetrievedTurns(turns: ScoredTurnChunk[]): string {
  if (turns.length === 0) {
    return "";
  }

  const formatted = turns
    .map((t) => {
      const time = new Date(t.timestamp).toISOString().slice(0, 16);
      const tools = t.metadata?.toolNames?.length
        ? ` [tools: ${t.metadata.toolNames.join(", ")}]`
        : "";
      return `[Turn ${t.turnStartIndex}-${t.turnEndIndex}, ${time}${tools}]\n${t.text}`;
    })
    .join("\n\n---\n\n");

  return [
    "<retrieved_conversation_history>",
    "The following are relevant excerpts from earlier in this conversation,",
    "retrieved by semantic similarity to the current topic. They are NOT the",
    "full history — treat them as context for reference, not as the immediate",
    "conversation flow.",
    "",
    formatted,
    "</retrieved_conversation_history>",
  ].join("\n");
}
