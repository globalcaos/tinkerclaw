/**
 * ENGRAM Phase 1.2: Retrieval pack runtime registry.
 *
 * Holds per-session retrieval dependencies keyed by SessionManager identity,
 * following the same WeakMap registry pattern as ingestion-runtime.ts.
 * Phase 1.2+ will call getRetrievalRuntime(sessionManager) to inject
 * the assembled retrieval pack into each agent turn.
 */

import type { EventStore } from "../../memory/engram/event-store.js";
import type { SearchResult, SearchFilters } from "../../memory/engram/search-index.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

/**
 * Optional FTS search override — defaults to ftsSearch from search-index.
 * Provided as a field to enable clean injection in tests.
 */
export type SearchIndexFn = (
	store: EventStore,
	query: string,
	topN?: number,
	filters?: SearchFilters,
) => SearchResult[];

/**
 * Optional pack assembly override — defaults to assembleRetrievalPack
 * from retrieval-integration. Provided to enable clean test injection.
 */
export type PushPackFn = (
	query: string,
	store: EventStore,
	opts?: { maxTokens?: number; taskId?: string },
) => string;

export interface RetrievalRuntime {
	/** Live event store for this session. */
	eventStore: EventStore;
	/** Optional FTS search override; falls back to module-level ftsSearch. */
	searchIndex?: SearchIndexFn;
	/** Optional pack assembly override; falls back to assembleRetrievalPack. */
	pushPack?: PushPackFn;
}

const registry = createSessionManagerRuntimeRegistry<RetrievalRuntime>();

/** Store a retrieval runtime for a given session manager instance. */
export const setRetrievalRuntime = registry.set;

/** Retrieve the retrieval runtime for a given session manager instance, or null. */
export const getRetrievalRuntime = registry.get;
