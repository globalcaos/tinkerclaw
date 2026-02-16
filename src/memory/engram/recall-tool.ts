/**
 * ENGRAM Phase 1D: Recall tool — pull retrieval from the event store.
 * The model calls recall(query) to retrieve compacted events.
 */

import type { MemoryEvent, EventKind } from "./event-types.js";
import type { EventStore } from "./event-store.js";
import { estimateTokens } from "./event-store.js";
import type { MetricsCollector } from "./metrics.js";
import { ftsSearch, combinedSearch, type SearchResult, type SearchFilters } from "./search-index.js";

/** Default retrieval budget per recall invocation (tokens). */
const PULL_MAX_TOKENS = 4000;
/** Max recall calls per turn. */
const PULL_MAX_PER_TURN = 3;
/** MMR lambda for diversity/relevance tradeoff. */
const MMR_LAMBDA = 0.7;

export interface RecallOptions {
	query: string | string[];
	maxTokens?: number;
	filters?: SearchFilters;
}

export interface RecallResult {
	events: ScoredRecallEvent[];
	totalTokens: number;
	queryCount: number;
	truncated: boolean;
}

export interface ScoredRecallEvent {
	event: MemoryEvent;
	score: number;
}

/**
 * Simple cosine-like similarity between two strings based on shared terms.
 * Used for MMR diversity computation.
 */
function textSimilarity(a: string, b: string): number {
	const termsA = new Set(a.toLowerCase().split(/\s+/));
	const termsB = new Set(b.toLowerCase().split(/\s+/));
	if (termsA.size === 0 || termsB.size === 0) return 0;
	let intersection = 0;
	for (const t of termsA) {
		if (termsB.has(t)) intersection++;
	}
	return intersection / Math.sqrt(termsA.size * termsB.size);
}

/**
 * Maximal Marginal Relevance selection.
 * Balances relevance (score) with diversity (low similarity to already-selected).
 */
function mmrSelect(
	candidates: ScoredRecallEvent[],
	k: number,
	lambda: number = MMR_LAMBDA,
): ScoredRecallEvent[] {
	if (candidates.length <= k) return candidates;

	const selected: ScoredRecallEvent[] = [];
	const remaining = [...candidates];

	// Select first by pure relevance
	remaining.sort((a, b) => b.score - a.score);
	selected.push(remaining.shift()!);

	while (selected.length < k && remaining.length > 0) {
		let bestIdx = 0;
		let bestMMR = -Infinity;

		for (let i = 0; i < remaining.length; i++) {
			const relevance = remaining[i].score;
			const maxSim = Math.max(
				...selected.map((s) => textSimilarity(remaining[i].event.content, s.event.content)),
			);
			const mmr = lambda * relevance - (1 - lambda) * maxSim;
			if (mmr > bestMMR) {
				bestMMR = mmr;
				bestIdx = i;
			}
		}

		selected.push(remaining.splice(bestIdx, 1)[0]);
	}

	return selected;
}

/**
 * Pack selected events under a token budget.
 */
function packUnderBudget(events: ScoredRecallEvent[], maxTokens: number): { packed: ScoredRecallEvent[]; truncated: boolean } {
	const packed: ScoredRecallEvent[] = [];
	let tokens = 0;
	let truncated = false;

	for (const e of events) {
		const eventTokens = e.event.tokens || estimateTokens(e.event.content);
		if (tokens + eventTokens > maxTokens) {
			truncated = true;
			break;
		}
		packed.push(e);
		tokens += eventTokens;
	}

	return { packed, truncated };
}

/**
 * Main recall function. Searches event store and returns relevant events
 * within the token budget, deduplicated against current context.
 */
export async function recall(
	options: RecallOptions,
	store: EventStore,
	contextEventIds?: Set<string>,
	metrics?: MetricsCollector,
): Promise<RecallResult> {
	const queries = Array.isArray(options.query) ? options.query : [options.query];
	const maxTokens = options.maxTokens ?? PULL_MAX_TOKENS;

	const candidateMap = new Map<string, ScoredRecallEvent>();

	for (const q of queries) {
		const results = await combinedSearch(store, q, 20, options.filters);
		for (const r of results) {
			const existing = candidateMap.get(r.event.id);
			if (!existing || r.score > existing.score) {
				candidateMap.set(r.event.id, { event: r.event, score: r.score });
			}
		}
	}

	// Deduplicate against current context
	let candidates = [...candidateMap.values()];
	if (contextEventIds && contextEventIds.size > 0) {
		candidates = candidates.filter((c) => !contextEventIds.has(c.event.id));
	}

	// MMR selection
	const selected = mmrSelect(candidates, 20, MMR_LAMBDA);

	// Pack under budget
	const { packed, truncated } = packUnderBudget(selected, maxTokens);

	metrics?.record("engram", "recall_query", 1, {
		queryCount: queries.length,
		candidateCount: candidateMap.size,
		resultCount: packed.length,
		truncated,
	});

	return {
		events: packed,
		totalTokens: packed.reduce((sum, e) => sum + (e.event.tokens || estimateTokens(e.event.content)), 0),
		queryCount: queries.length,
		truncated,
	};
}

/**
 * Rate limiter for recall calls per turn.
 */
export function createRecallLimiter(maxPerTurn: number = PULL_MAX_PER_TURN) {
	let count = 0;
	return {
		canRecall(): boolean {
			return count < maxPerTurn;
		},
		recordCall(): void {
			count++;
		},
		reset(): void {
			count = 0;
		},
		remaining(): number {
			return maxPerTurn - count;
		},
	};
}
