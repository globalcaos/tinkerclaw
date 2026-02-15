/**
 * Context assembler: main orchestrator for continuous compacting.
 *
 * Called from runEmbeddedAttempt() in place of limitHistoryTurns().
 * Flow: partition → index (with topic assignment) → retrieve → assemble.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { EmbeddingProvider } from "../../memory/embeddings.js";
import type { ContinuousCompactConfig } from "./config.js";
import type { SessionVectorStore } from "./session-store.js";
import { buildRetrievalQuery, formatRetrievedTurns, retrieveRelevantTurns } from "./retriever.js";
import { buildTurnChunks, partitionActiveWindow } from "./turn-indexer.js";

// ── Types ───────────────────────────────────────────────────────────

export interface AssembledContext {
  /** Messages for the LLM (active window only). */
  messages: AgentMessage[];
  /** Formatted retrieved context string for system prompt injection. */
  retrievedContext: string;
  /** Number of new turns indexed this cycle. */
  newlyIndexedCount: number;
  /** Total turns in the vector store. */
  totalIndexedCount: number;
  /** Token estimate for active window + retrieved context. */
  estimatedTokens: number;
}

// ── Main Entry Point ────────────────────────────────────────────────

/**
 * Assemble context using continuous compacting.
 *
 * 1. Partition messages into active window + aged-out
 * 2. Index new aged-out turns with topic assignment
 * 3. Retrieve relevant past turns via topic-aware embedding search
 * 4. Format and return assembled context
 */
export async function assembleContextWithContinuousCompact(params: {
  messages: AgentMessage[];
  currentPrompt: string;
  sessionId: string;
  store: SessionVectorStore;
  embedder: EmbeddingProvider;
  config: ContinuousCompactConfig;
}): Promise<AssembledContext> {
  const { messages, currentPrompt, store, embedder, config } = params;

  // 1. Partition
  const { activeWindow, agedOut } = partitionActiveWindow(messages, config.indexer);

  // 2. Incremental indexing — only process turns beyond what's already stored
  const lastIndexed = store.getLastIndexedEndIndex();
  const newAgedOut = agedOut.filter((_, i) => i > lastIndexed);
  let newlyIndexedCount = 0;

  if (newAgedOut.length > 0) {
    const startIndex = lastIndexed + 1;
    const chunks = buildTurnChunks(newAgedOut, params.sessionId, startIndex, config.indexer);

    if (chunks.length > 0) {
      // Embed in batches
      const texts = chunks.map((c) => c.text);
      const embeddings = await embedder.embedBatch(texts);
      for (let i = 0; i < chunks.length; i++) {
        chunks[i].embedding = embeddings[i];
        // Assign topic based on embedding similarity to existing centroids
        const topicId = store.assignTopic(embeddings[i], chunks[i].timestamp);
        chunks[i].metadata = { ...chunks[i].metadata, topicId };
      }
      store.insertTurns(chunks);
      newlyIndexedCount = chunks.length;

      // Periodically merge converging topics
      store.autoMergeTopics();
    }
  }

  // 3. Retrieve relevant past turns (topic-aware)
  let retrievedContext = "";
  if (store.getTurnCount() > 0) {
    const query = buildRetrievalQuery(
      currentPrompt,
      activeWindow.slice(-config.retrieval.recentContextForQuery),
      config.retrieval,
    );
    const retrieved = await retrieveRelevantTurns(store, query, embedder, config.retrieval);
    retrievedContext = formatRetrievedTurns(retrieved);
  }

  // 4. Estimate tokens
  const activeTokens = activeWindow.reduce((sum, m) => sum + estimateTokens(m), 0);
  const retrievedTokens = retrievedContext.length > 0 ? Math.ceil(retrievedContext.length / 4) : 0;

  return {
    messages: activeWindow,
    retrievedContext,
    newlyIndexedCount,
    totalIndexedCount: store.getTurnCount(),
    estimatedTokens: activeTokens + retrievedTokens,
  };
}
