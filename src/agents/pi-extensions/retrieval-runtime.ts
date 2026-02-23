/**
 * ENGRAM Phase 1.2: Retrieval pack runtime registry.
 *
 * Holds per-session retrieval dependencies keyed by SessionManager identity,
 * following the same WeakMap registry pattern as ingestion-runtime.ts.
 * Phase 1.2+ calls getRetrievalRuntime(sessionManager) to inject
 * the assembled retrieval pack into each agent turn.
 */

import type { EventStore } from "../../memory/engram/event-store.js";
import { estimateTokens } from "../../memory/engram/event-store.js";
import type { SearchResult, SearchFilters } from "../../memory/engram/search-index.js";
import { ftsSearch } from "../../memory/engram/search-index.js";
import type { MMRItem } from "../../memory/mmr.js";
import { mmrRerank } from "../../memory/mmr.js";
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
	/**
	 * Per-turn retrieval: assemble a bounded text pack of relevant past events.
	 * Uses FTS search + recency boost + MMR deduplication.
	 * Auto-injected by setRetrievalRuntime when not provided.
	 */
	assemble?: (query: string, budgetTokens: number) => Promise<string | null>;
}

/**
 * Build a default assemble function bound to a RetrievalRuntime.
 *
 * Algorithm:
 *   1. FTS search for up to 40 candidate events matching the query.
 *   2. Apply a recency boost (exponential decay, half-life ~1 day).
 *   3. MMR deduplication (λ=0.7) to balance relevance and diversity.
 *   4. Pack events into text until the token budget is reached.
 */
function buildDefaultAssemble(
	runtime: Pick<RetrievalRuntime, "eventStore" | "searchIndex">,
): (query: string, budgetTokens: number) => Promise<string | null> {
	return async (query: string, budgetTokens: number): Promise<string | null> => {
		const searchFn = runtime.searchIndex ?? ftsSearch;
		const candidates = searchFn(runtime.eventStore, query, 40);

		if (candidates.length === 0) {return null;}

		// Recency boost: exponential decay with ~1 day half-life
		const now = Date.now();
		const boosted = candidates.map((r) => {
			const ageMs = now - new Date(r.event.timestamp).getTime();
			const recencyBoost = Math.exp(-ageMs / (24 * 60 * 60 * 1000)) * 0.5;
			return { ...r, score: r.score + recencyBoost };
		});

		// MMR re-ranking: λ=0.7 balances relevance with content diversity
		const mmrItems: MMRItem[] = boosted.map((r) => ({
			id: r.event.id,
			score: r.score,
			content: r.event.content,
		}));
		const reranked = mmrRerank(mmrItems, { enabled: true, lambda: 0.7 });

		// Fast lookup by event id
		const byId = new Map(boosted.map((r) => [r.event.id, r]));

		// Pack events into the token budget
		const header = "## Retrieved Memory Context\n";
		const lines: string[] = [header];
		let tokensUsed = estimateTokens(header);

		for (const item of reranked) {
			const result = byId.get(item.id);
			if (!result) {continue;}
			const { event } = result;
			const line = `[${event.timestamp}] [${event.kind}] ${event.content}`;
			const lineTokens = estimateTokens(line);
			if (tokensUsed + lineTokens > budgetTokens) {break;}
			lines.push(line);
			tokensUsed += lineTokens;
		}

		// Return null if no events fit beyond the header
		if (lines.length <= 1) {return null;}

		return lines.join("\n");
	};
}

const registry = createSessionManagerRuntimeRegistry<RetrievalRuntime>();

/**
 * Store a retrieval runtime for a given session manager instance.
 * Automatically injects a default `assemble` implementation when none is provided.
 */
export const setRetrievalRuntime = (
	sessionManager: unknown,
	value: Omit<RetrievalRuntime, "assemble"> & Partial<Pick<RetrievalRuntime, "assemble">> | null,
): void => {
	if (value !== null && !value.assemble) {
		registry.set(sessionManager, {
			...value,
			assemble: buildDefaultAssemble(value),
		});
		return;
	}
	registry.set(sessionManager, value);
};

/** Retrieve the retrieval runtime for a given session manager instance, or null. */
export const getRetrievalRuntime = registry.get;
