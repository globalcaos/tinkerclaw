export {
  type ContinuousCompactConfig,
  type RetrievalConfig,
  type TurnIndexerConfig,
  DEFAULT_CONTINUOUS_COMPACT_CONFIG,
  DEFAULT_INDEXER_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  getOrCreateEmbeddingProvider,
  resolveContinuousCompactConfig,
} from "./config.js";

export {
  type AssembledContext,
  assembleContextWithContinuousCompact,
} from "./context-assembler.js";

export { buildRetrievalQuery, formatRetrievedTurns, retrieveRelevantTurns } from "./retriever.js";

export {
  type ScoredTurnChunk,
  type SessionVectorStore,
  type Topic,
  cosineSimilarity,
  destroySessionVectorStore,
  openSessionVectorStore,
} from "./session-store.js";

export {
  type TurnChunk,
  buildTurnChunks,
  flattenMessageText,
  flattenPairText,
  groupIntoPairs,
  partitionActiveWindow,
} from "./turn-indexer.js";
