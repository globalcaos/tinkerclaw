/**
 * ENGRAM Phase 1D: Search index for event retrieval.
 * Provides full-text search (FTS) and placeholder for vector search.
 */

import type { MemoryEvent, EventKind } from "./event-types.js";
import type { EventStore } from "./event-store.js";

export interface SearchResult {
	event: MemoryEvent;
	score: number;
	matchType: "fts" | "vector";
}

export interface SearchFilters {
	taskId?: string;
	kinds?: EventKind[];
	since?: string;
	until?: string;
}

/**
 * Simple full-text search over event store.
 * Scores by term frequency (TF) with position boost for earlier matches.
 */
export function ftsSearch(
	store: EventStore,
	query: string,
	topN: number = 20,
	filters?: SearchFilters,
): SearchResult[] {
	const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
	if (terms.length === 0) return [];

	let events = store.readAll();

	// Apply filters
	if (filters?.taskId) {
		events = events.filter((e) => e.metadata.taskId === filters.taskId);
	}
	if (filters?.kinds) {
		const kindSet = new Set(filters.kinds);
		events = events.filter((e) => kindSet.has(e.kind));
	}
	if (filters?.since) {
		events = events.filter((e) => e.timestamp >= filters.since!);
	}
	if (filters?.until) {
		events = events.filter((e) => e.timestamp <= filters.until!);
	}

	const scored: SearchResult[] = [];

	for (const event of events) {
		const content = event.content.toLowerCase();
		let score = 0;

		for (const term of terms) {
			const idx = content.indexOf(term);
			if (idx !== -1) {
				// Base score for match
				score += 1.0;
				// Count occurrences
				const matches = content.split(term).length - 1;
				score += Math.log2(matches + 1) * 0.5;
				// Position boost (earlier match = higher score)
				score += (1.0 - idx / Math.max(content.length, 1)) * 0.3;
			}
		}

		if (score > 0) {
			// Normalize by number of terms for partial match penalty
			score = score / terms.length;
			scored.push({ event, score, matchType: "fts" });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topN);
}

/**
 * Placeholder for vector search. Will be implemented in Phase 2A with embeddings.
 * For now, falls back to FTS.
 */
export async function vectorSearch(
	_store: EventStore,
	_query: string,
	_topN: number = 20,
	_filters?: SearchFilters,
): Promise<SearchResult[]> {
	// Phase 2A will implement actual embedding-based search
	return [];
}

/**
 * Combined search: merge FTS and vector results, deduplicate.
 */
export async function combinedSearch(
	store: EventStore,
	query: string,
	topN: number = 20,
	filters?: SearchFilters,
): Promise<SearchResult[]> {
	const ftsResults = ftsSearch(store, query, topN, filters);
	const vecResults = await vectorSearch(store, query, topN, filters);

	// Merge and deduplicate by event ID
	const seen = new Set<string>();
	const merged: SearchResult[] = [];

	for (const r of [...vecResults, ...ftsResults]) {
		if (!seen.has(r.event.id)) {
			seen.add(r.event.id);
			merged.push(r);
		}
	}

	merged.sort((a, b) => b.score - a.score);
	return merged.slice(0, topN);
}
