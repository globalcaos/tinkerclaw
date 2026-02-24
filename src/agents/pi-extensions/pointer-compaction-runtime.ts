/**
 * ENGRAM Phase 1.3: Pointer compaction runtime wrapper.
 *
 * Wraps pointer-compaction.ts for use in the compaction pipeline as a
 * feature-flagged alternative to narrative compaction. Registered alongside
 * compaction-engram.ts when compaction.mode === "engram".
 *
 * FORK-ISOLATED: This file is unique to our fork.
 */

import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";
import {
	pointerCompact,
	type ContextCache,
	type CompactionBudgets,
} from "../../memory/engram/pointer-compaction.js";
import { renderMarkers } from "../../memory/engram/time-range-marker.js";
import type { EventStore } from "../../memory/engram/event-store.js";
import type { MemoryEvent } from "../../memory/engram/event-types.js";

export interface PointerCompactionOptions {
	/** Number of most-recent turns to preserve verbatim. Default: 10. */
	hotTailTurns?: number;
	/** Total context window size in tokens. Default: 100_000. */
	ctxTokens?: number;
	/** Headroom kept free after compaction, in tokens. Default: 4_000. */
	headroom?: number;
	/** Soft cap on marker count before merging adjacent markers. Default: 20. */
	markerSoftCap?: number;
}

/** Manifest stored as a compaction_marker event in the event store. */
export interface CompactionManifest {
	/** First and last event IDs in the evicted range. */
	eventIdRange: [string, string];
	/** IDs of any artifact_reference events that were evicted. */
	artifactRefs: string[];
	/** Top-3 topic hints extracted from evicted events. */
	topicHints: string[];
	/** Total number of evicted events. */
	eventCount: number;
	/** Estimated token count of evicted events. */
	tokenCount: number;
}

export interface CompactionResult {
	/** Rendered time-range markers suitable for context injection. */
	summary: string;
	/** Number of events removed from the context cache. */
	evictedCount: number;
	/** Number of time-range markers created. */
	markersCreated: number;
	/** ID of the compaction_marker event stored in the event store. */
	markerEventId: string;
}

export interface PointerCompactionHandler {
	/**
	 * Run pointer compaction on the given events.
	 * Evicts oldest evictable turns, stores a compaction_marker in the event
	 * store, and returns rendered markers as the summary.
	 */
	compact(events: MemoryEvent[]): CompactionResult;
	/** The event store used by this handler. */
	readonly eventStore: EventStore;
	/** Resolved options (with defaults applied). */
	readonly options: Required<PointerCompactionOptions>;
}

/**
 * Render a CompactionManifest to a human-readable summary string.
 * Suitable for use as the compaction "summary" passed back to Pi.
 */
export function renderManifest(manifest: CompactionManifest): string {
	if (manifest.eventCount === 0) return "[Pointer manifest: no events evicted]";
	const range = `${manifest.eventIdRange[0]}..${manifest.eventIdRange[1]}`;
	const topics =
		manifest.topicHints.length > 0 ? ` Topics: ${manifest.topicHints.join(", ")}.` : "";
	const artifacts =
		manifest.artifactRefs.length > 0 ? ` Artifacts: ${manifest.artifactRefs.join(", ")}.` : "";
	return (
		`[Pointer manifest: events ${range} (${manifest.eventCount} events, ~${manifest.tokenCount} tokens).` +
		`${topics}${artifacts} Use recall(query) to retrieve.]`
	);
}

/**
 * Build a CompactionManifest from a set of evicted events.
 * Includes event ID range, artifact refs, and top-3 topic hints.
 */
export function buildManifest(evictedEvents: MemoryEvent[]): CompactionManifest {
	if (evictedEvents.length === 0) {
		return { eventIdRange: ["", ""], artifactRefs: [], topicHints: [], eventCount: 0, tokenCount: 0 };
	}

	const artifactRefs = evictedEvents
		.filter((e) => e.kind === "artifact_reference" && e.metadata.artifactId)
		.map((e) => e.metadata.artifactId as string);

	const hints: string[] = [];
	for (const e of evictedEvents) {
		if (hints.length >= 3) break;
		if (e.metadata.tags) {
			for (const tag of e.metadata.tags) {
				if (tag !== "constraint" && hints.length < 3) hints.push(tag);
			}
		}
		if (e.kind === "tool_call" && hints.length < 3 && e.content.length < 120) {
			hints.push(e.content.slice(0, 60));
		}
	}

	return {
		eventIdRange: [evictedEvents[0].id, evictedEvents[evictedEvents.length - 1].id],
		artifactRefs: [...new Set(artifactRefs)],
		topicHints: [...new Set(hints)].slice(0, 3),
		eventCount: evictedEvents.length,
		tokenCount: evictedEvents.reduce((s, e) => s + e.tokens, 0),
	};
}

/**
 * Create a pointer compaction handler bound to the given event store.
 *
 * @example
 * ```ts
 * const handler = createPointerCompactionHandler(eventStore, { hotTailTurns: 10 });
 * const result = handler.compact(eventsInContext);
 * // result.summary — rendered markers for context
 * ```
 */
export function createPointerCompactionHandler(
	eventStore: EventStore,
	options?: PointerCompactionOptions,
): PointerCompactionHandler {
	const resolved: Required<PointerCompactionOptions> = {
		hotTailTurns: options?.hotTailTurns ?? 10,
		ctxTokens: options?.ctxTokens ?? 100_000,
		headroom: options?.headroom ?? 4_000,
		markerSoftCap: options?.markerSoftCap ?? 20,
	};

	return {
		eventStore,
		options: resolved,

		compact(events: MemoryEvent[]): CompactionResult {
			const cache: ContextCache = { events: [...events], markers: [] };
			const budgets: CompactionBudgets = {
				ctx: resolved.ctxTokens,
				headroom: resolved.headroom,
				hotTailTurns: resolved.hotTailTurns,
				markerSoftCap: resolved.markerSoftCap,
			};

			// Determine which events will be evicted (before vs after)
			const beforeIds = new Set(events.map((e) => e.id));
			pointerCompact(cache, budgets, eventStore);
			const afterIds = new Set(cache.events.map((e) => e.id));
			const evicted = events.filter((e) => !afterIds.has(e.id));

			// Build manifest and persist as compaction_marker
			const manifest = buildManifest(evicted);
			const stored = eventStore.append({
				turnId: events[events.length - 1]?.turnId ?? 0,
				sessionKey: eventStore.sessionKey,
				kind: "compaction_marker",
				content: JSON.stringify(manifest),
				tokens: Math.ceil(JSON.stringify(manifest).length / 4),
				metadata: { tags: ["pointer_compaction"] },
			});

			const summary = renderMarkers(cache.markers) || "[No events compacted]";

			return {
				summary,
				evictedCount: beforeIds.size - afterIds.size,
				markersCreated: cache.markers.length,
				markerEventId: stored.id,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Session-manager-scoped runtime registry
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<PointerCompactionHandler>();

/** Register a pointer compaction handler for a given session manager instance. */
export const setPointerCompactionRuntime = registry.set;

/** Retrieve the pointer compaction handler for a given session manager instance, or null. */
export const getPointerCompactionRuntime = registry.get;
