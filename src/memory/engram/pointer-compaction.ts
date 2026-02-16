/**
 * ENGRAM Phase 1B: Pointer-based compaction engine.
 * Replaces narrative compaction with lossless event-pointer markers.
 * Matches ENGRAM Annex A.4.
 */

import type { MemoryEvent, EventKind } from "./event-types.js";
import { NON_EVICTABLE_KINDS } from "./event-types.js";
import type { EventStore } from "./event-store.js";
import type { MetricsCollector } from "./metrics.js";
import { createTimeRangeMarker, mergeMarkers, type TimeRangeMarker } from "./time-range-marker.js";

/**
 * Eviction priority by event kind. Higher = evicted first.
 * Kinds not listed default to 0.5.
 */
const EVICTION_PRIORITY: Partial<Record<EventKind, number>> = {
	tool_result: 1.0,
	tool_call: 0.8,
	agent_message: 0.5,
	user_message: 0.5,
	artifact_reference: 0.3,
	// These are never evicted (handled by NON_EVICTABLE_KINDS guard)
	compaction_marker: 0.0,
	persona_state: 0.0,
	system_event: 0.0,
};

export interface ContextCache {
	/** All events currently in context, in order. */
	events: MemoryEvent[];
	/** Current markers in context. */
	markers: TimeRangeMarker[];
}

export interface CompactionBudgets {
	/** Total context window in tokens. */
	ctx: number;
	/** Headroom to keep free (tokens). */
	headroom: number;
	/** Number of recent tail turns to keep verbatim. */
	hotTailTurns: number;
	/** Max markers before merging. */
	markerSoftCap: number;
}

/**
 * Estimate total tokens in the context cache (events + markers).
 */
export function estimateCacheTokens(cache: ContextCache): number {
	const eventTokens = cache.events.reduce((sum, e) => sum + e.tokens, 0);
	// Each marker is roughly 40 tokens
	const markerTokens = cache.markers.length * 40;
	return eventTokens + markerTokens;
}

/**
 * Check if an event is evictable.
 */
function isEvictable(event: MemoryEvent, hotTailTurnIds: Set<number>): boolean {
	if (NON_EVICTABLE_KINDS.has(event.kind)) return false;
	if (hotTailTurnIds.has(event.turnId)) return false;
	if (event.metadata.tags?.includes("constraint")) return false;
	return true;
}

/**
 * Choose a contiguous block of events to evict (LRU from oldest, weighted by priority).
 * Returns indices into cache.events.
 */
function chooseVictimBlock(
	cache: ContextCache,
	hotTailTurnIds: Set<number>,
): { startIdx: number; endIdx: number; events: MemoryEvent[] } | null {
	// Find the oldest contiguous run of evictable events
	let bestStart = -1;
	let bestEnd = -1;
	let bestScore = -1;

	let runStart = -1;
	for (let i = 0; i < cache.events.length; i++) {
		if (isEvictable(cache.events[i], hotTailTurnIds)) {
			if (runStart === -1) runStart = i;
		} else {
			if (runStart !== -1) {
				const score = cache.events
					.slice(runStart, i)
					.reduce((s, e) => s + (EVICTION_PRIORITY[e.kind] ?? 0.5) * e.tokens, 0);
				if (score > bestScore) {
					bestScore = score;
					bestStart = runStart;
					bestEnd = i;
				}
			}
			runStart = -1;
		}
	}
	// Check trailing run
	if (runStart !== -1) {
		const score = cache.events
			.slice(runStart)
			.reduce((s, e) => s + (EVICTION_PRIORITY[e.kind] ?? 0.5) * e.tokens, 0);
		if (score > bestScore) {
			bestStart = runStart;
			bestEnd = cache.events.length;
		}
	}

	if (bestStart === -1) return null;

	return {
		startIdx: bestStart,
		endIdx: bestEnd,
		events: cache.events.slice(bestStart, bestEnd),
	};
}

/**
 * Extract topic hints from a set of events.
 */
function extractTopicHints(events: MemoryEvent[]): string[] {
	const hints: string[] = [];
	for (const e of events) {
		if (e.metadata.tags) {
			for (const tag of e.metadata.tags) {
				if (tag !== "constraint" && hints.length < 5) {
					hints.push(tag);
				}
			}
		}
		// Extract brief hints from content for tool calls
		if (e.kind === "tool_call" && e.content.length < 100 && hints.length < 5) {
			hints.push(e.content.slice(0, 50));
		}
	}
	return hints.slice(0, 5);
}

/**
 * Main pointer-compaction loop. Evicts events from context and replaces
 * them with time-range markers. Events remain in the event store (lossless).
 *
 * @param cache - Mutable context cache (modified in place)
 * @param budgets - Token budgets
 * @param store - Event store (for persistence verification)
 * @param metrics - Optional metrics collector
 * @returns Number of compaction cycles performed
 */
export function pointerCompact(
	cache: ContextCache,
	budgets: CompactionBudgets,
	store?: EventStore,
	metrics?: MetricsCollector,
): number {
	const targetTokens = budgets.ctx - budgets.headroom;
	let cycles = 0;

	while (estimateCacheTokens(cache) > targetTokens) {
		// Determine hot tail turn IDs
		const allTurnIds = [...new Set(cache.events.map((e) => e.turnId))].sort((a, b) => b - a);
		const hotTailTurnIds = new Set(allTurnIds.slice(0, budgets.hotTailTurns));

		const victim = chooseVictimBlock(cache, hotTailTurnIds);
		if (!victim || victim.events.length === 0) break; // nothing left to evict

		// Verify events are persisted in store (if provided)
		if (store) {
			for (const e of victim.events) {
				const persisted = store.readById(e.id);
				if (!persisted) {
					throw new Error(`Compaction invariant violated: event ${e.id} not found in store`);
				}
			}
		}

		const marker = createTimeRangeMarker({
			startTurnId: victim.events[0].turnId,
			endTurnId: victim.events[victim.events.length - 1].turnId,
			startTime: victim.events[0].timestamp,
			endTime: victim.events[victim.events.length - 1].timestamp,
			topicHints: extractTopicHints(victim.events),
			eventCount: victim.events.length,
			tokenCount: victim.events.reduce((s, e) => s + e.tokens, 0),
		});

		// Replace victim events with marker
		cache.events.splice(victim.startIdx, victim.events.length);
		cache.markers.push(marker);

		// Merge markers if over soft cap
		cache.markers = mergeMarkers(cache.markers, budgets.markerSoftCap);

		cycles++;
		metrics?.record("engram", "compaction_event", 1, {
			evictedTokens: marker.tokenCount,
			evictedEvents: marker.eventCount,
			markerLevel: marker.level,
		});
	}

	return cycles;
}
