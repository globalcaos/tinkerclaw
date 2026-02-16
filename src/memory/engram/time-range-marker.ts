/**
 * ENGRAM Phase 1B: Time-range marker type and merging.
 * Markers are lightweight pointers that replace evicted events in context.
 */

import { estimateTokens } from "./event-store.js";

const MARKER_SOFT_CAP = 20;
const MARKER_TOKEN_CAP = 60;

export interface TimeRangeMarker {
	type: "time_range_marker";
	startTurnId: number;
	endTurnId: number;
	startTime: string;
	endTime: string;
	topicHints: string[];
	eventCount: number;
	tokenCount: number;
	level: number;
}

/**
 * Render a marker to a human-readable string for context injection.
 * Invariant: rendered form ≤ MARKER_TOKEN_CAP tokens.
 */
export function renderMarker(marker: TimeRangeMarker): string {
	const topics = marker.topicHints.length > 0 ? ` Key topics: ${marker.topicHints.join(", ")}.` : "";
	return `[Events T${marker.startTurnId}–T${marker.endTurnId} evicted (${marker.eventCount} events, ~${marker.tokenCount} tokens).${topics} Use recall(query) to retrieve.]`;
}

/**
 * Deduplicate and keep top-K topic hints.
 */
export function dedupeTopK(hints: string[], k: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const h of hints) {
		const normalized = h.toLowerCase().trim();
		if (!seen.has(normalized) && normalized.length > 0) {
			seen.add(normalized);
			result.push(h.trim());
			if (result.length >= k) break;
		}
	}
	return result;
}

/**
 * Create a time-range marker from evicted event data.
 */
export function createTimeRangeMarker(opts: {
	startTurnId: number;
	endTurnId: number;
	startTime: string;
	endTime: string;
	topicHints: string[];
	eventCount: number;
	tokenCount: number;
}): TimeRangeMarker {
	return {
		type: "time_range_marker",
		startTurnId: opts.startTurnId,
		endTurnId: opts.endTurnId,
		startTime: opts.startTime,
		endTime: opts.endTime,
		topicHints: dedupeTopK(opts.topicHints, 5),
		eventCount: opts.eventCount,
		tokenCount: opts.tokenCount,
		level: 0,
	};
}

/**
 * Merge oldest adjacent markers when count exceeds soft cap.
 * Recursive until count ≤ markerSoftCap.
 */
export function mergeMarkers(markers: TimeRangeMarker[], softCap: number = MARKER_SOFT_CAP): TimeRangeMarker[] {
	if (markers.length <= softCap) return markers;

	const [a, b, ...rest] = markers;
	const merged: TimeRangeMarker = {
		type: "time_range_marker",
		startTurnId: a.startTurnId,
		endTurnId: b.endTurnId,
		startTime: a.startTime,
		endTime: b.endTime,
		topicHints: dedupeTopK([...a.topicHints, ...b.topicHints], 5),
		eventCount: a.eventCount + b.eventCount,
		tokenCount: a.tokenCount + b.tokenCount,
		level: Math.max(a.level, b.level) + 1,
	};

	const result = [merged, ...rest];
	// Recurse if still over cap
	return result.length > softCap ? mergeMarkers(result, softCap) : result;
}

/**
 * Check that a rendered marker is within the token cap.
 */
export function isMarkerWithinTokenCap(marker: TimeRangeMarker, cap: number = MARKER_TOKEN_CAP): boolean {
	return estimateTokens(renderMarker(marker)) <= cap;
}

/**
 * Render all markers as a single block for context injection.
 */
export function renderMarkers(markers: TimeRangeMarker[]): string {
	if (markers.length === 0) return "";
	return markers.map(renderMarker).join("\n");
}
