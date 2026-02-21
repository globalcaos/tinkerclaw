/**
 * ENGRAM Phase 1.2: Retrieval pack assembly.
 *
 * Assembles a token-bounded string of relevant past events for injection
 * into the system prompt. Pipeline:
 *   FTS search → task-conditioned scoring → MMR dedup → token-bounded format.
 */

import { estimateTokens } from "./event-store.js";
import { ftsSearch } from "./search-index.js";
import { taskConditionedScore } from "./task-conditioned-scoring.js";
import { createDefaultTaskState } from "./task-state.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";

/** Default token budget for a retrieval pack (fits comfortably in system prompt). */
export const DEFAULT_RETRIEVAL_MAX_TOKENS = 4096;

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
		new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

	const setA = words(a);
	const setB = words(b);
	if (setA.size === 0 || setB.size === 0) return 0;

	let intersection = 0;
	for (const w of setA) {
		if (setB.has(w)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

interface ScoredEvent {
	event: MemoryEvent;
	score: number;
}

/**
 * Maximal Marginal Relevance reranking (λ=0.7 by default).
 * Iteratively selects the candidate that best balances relevance against
 * redundancy with already-selected items.
 *
 * MMR(i) = λ · relevance(i) - (1-λ) · max_j∈S similarity(i, j)
 */
function mmrRerank(
	candidates: ScoredEvent[],
	lambda: number = MMR_LAMBDA,
	maxItems: number = FTS_TOP_N,
): ScoredEvent[] {
	if (candidates.length <= 1) return [...candidates];

	const selected: ScoredEvent[] = [];
	const remaining = [...candidates];

	while (remaining.length > 0 && selected.length < maxItems) {
		let bestScore = -Infinity;
		let bestIdx = 0;

		for (let i = 0; i < remaining.length; i++) {
			const c = remaining[i];
			// Max similarity to any already-selected item
			let maxSim = 0;
			for (const s of selected) {
				const sim = wordJaccard(c.event.content, s.event.content);
				if (sim > maxSim) maxSim = sim;
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

/**
 * Format a single memory event as a compact, readable line.
 * Truncates long content to keep token cost predictable.
 */
function formatEvent(event: MemoryEvent): string {
	const ts = event.timestamp.slice(0, 19); // "2024-01-01T12:00:00" without ms/tz
	const preview =
		event.content.length > 300 ? `${event.content.slice(0, 300)}…` : event.content;
	return `[${ts}] [${event.kind}] ${preview}`;
}

/**
 * Assemble a retrieval pack: a token-bounded, relevance-ranked, deduplicated
 * string of past events ready for system prompt injection.
 *
 * Returns an empty string when the store is empty or no FTS matches exist.
 *
 * @param query   - The current user message or turn query.
 * @param eventStore - The ENGRAM event store for this session.
 * @param options - Optional token budget and task context.
 */
export function assembleRetrievalPack(
	query: string,
	eventStore: EventStore,
	options?: AssembleOptions,
): string {
	const maxTokens = options?.maxTokens ?? DEFAULT_RETRIEVAL_MAX_TOKENS;
	const taskId = options?.taskId;

	// Fast-path: nothing to retrieve
	if (eventStore.count() === 0) return "";

	// 1. FTS search — pull candidate events
	const ftsResults = ftsSearch(
		eventStore,
		query,
		FTS_TOP_N,
		taskId ? { taskId } : undefined,
	);
	if (ftsResults.length === 0) return "";

	// 2. Task-conditioned scoring — amplify / discount by task context
	const taskState = createDefaultTaskState(taskId ?? "default");
	const scored: ScoredEvent[] = ftsResults.map((r) => ({
		event: r.event,
		score: taskConditionedScore(r.event, r.score, taskState),
	}));

	// 3. Sort by score descending before MMR so the greedy first pick is best
	scored.sort((a, b) => b.score - a.score);

	// 4. MMR deduplication — diversity-aware reranking (λ=0.7)
	const reranked = mmrRerank(scored);

	// 5. Token-bounded assembly
	const headerTokens = estimateTokens(`${HEADER_TEXT}\n`);
	if (headerTokens >= maxTokens) return "";

	const lines: string[] = [HEADER_TEXT];
	let tokensUsed = headerTokens;

	for (const { event } of reranked) {
		const line = formatEvent(event);
		const lineTokens = estimateTokens(`${line}\n`);
		if (tokensUsed + lineTokens > maxTokens) break;
		lines.push(line);
		tokensUsed += lineTokens;
	}

	// If only the header was added, return empty (nothing useful to inject)
	if (lines.length === 1) return "";

	return lines.join("\n");
}
