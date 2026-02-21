/**
 * ENGRAM Phase 1.4 — Consolidation Runtime
 *
 * Wires sleep-consolidation.ts and episode-detection.ts into an event-store-
 * backed runner that persists episode summaries as `system_event` entries
 * (tagged "consolidated") with full provenance pointers to source event IDs.
 *
 * Incremental & idempotent — tracks lastConsolidatedEventId across calls.
 */

import type { EventStore } from "../../memory/engram/event-store.js";
import {
	type ConsolidationState,
	type Episode,
	type EpisodeDetectionConfig,
	createInitialConsolidationState,
	detectEpisodes,
} from "../../memory/engram/episode-detection.js";
import type { MemoryEvent } from "../../memory/engram/event-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConsolidationRunnerOptions {
	episodeDetection?: Partial<EpisodeDetectionConfig>;
	/** Override the default summarizer (e.g. LLM-backed in production). */
	summarizeEpisode?: (episode: Episode, events: MemoryEvent[]) => string | Promise<string>;
}

/** Payload embedded in the `content` field of every consolidated system_event. */
export interface EpisodeSummaryPayload {
	type: "episode_summary";
	episodeId: string;
	topic: string;
	outcome: Episode["outcome"];
	/** Provenance: IDs of every source event that fed this summary. */
	sourceEventIds: string[];
	/** Human-readable summary text. */
	summary: string;
}

export interface ConsolidationRunResult {
	episodesCreated: number;
	/** IDs of the newly written summary system_events. */
	summaryEventIds: string[];
	eventsProcessed: number;
	durationMs: number;
}

export interface ConsolidationRunner {
	/**
	 * Process unconsolidated events and write episode summaries.
	 *
	 * @param sinceTimestamp ISO timestamp — when provided, overrides the
	 *   internal state cursor and processes only events at or after this time.
	 */
	consolidate(sinceTimestamp?: string): Promise<ConsolidationRunResult>;
	/** Expose internal state for inspection / persistence. */
	readonly state: Readonly<ConsolidationState>;
}

// ---------------------------------------------------------------------------
// Default summarizer
// ---------------------------------------------------------------------------

function defaultSummarizer(episode: Episode, events: MemoryEvent[]): string {
	const userMsgs = events
		.filter((e) => e.kind === "user_message")
		.map((e) => e.content.slice(0, 100));
	const agentMsgs = events
		.filter((e) => e.kind === "agent_message")
		.map((e) => e.content.slice(0, 100));

	return [
		`Episode: ${episode.topic}`,
		`Turns: ${episode.turnCount}, Outcome: ${episode.outcome}`,
		userMsgs.length > 0 ? `User: ${userMsgs.slice(0, 3).join(" | ")}` : "",
		agentMsgs.length > 0 ? `Agent: ${agentMsgs.slice(0, 3).join(" | ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConsolidationRunner(
	eventStore: EventStore,
	options: ConsolidationRunnerOptions = {},
): ConsolidationRunner {
	const state: ConsolidationState = createInitialConsolidationState();

	return {
		get state(): Readonly<ConsolidationState> {
			return state;
		},

		async consolidate(sinceTimestamp?: string): Promise<ConsolidationRunResult> {
			const start = Date.now();
			const allEvents = eventStore.readAll();

			// Determine candidate window -------------------------------------------
			let candidates: MemoryEvent[];

			if (sinceTimestamp !== undefined) {
				// Caller-supplied timestamp takes precedence over internal cursor
				candidates = allEvents.filter((e) => e.timestamp >= sinceTimestamp);
			} else if (state.lastConsolidatedEventId) {
				const lastIdx = allEvents.findIndex(
					(e) => e.id === state.lastConsolidatedEventId,
				);
				candidates = lastIdx >= 0 ? allEvents.slice(lastIdx + 1) : allEvents;
			} else {
				candidates = allEvents;
			}

			// Exclude previously generated summaries so consolidation is idempotent
			const unconsolidated = candidates.filter(
				(e) =>
					!(e.kind === "system_event" && e.metadata?.tags?.includes("consolidated")),
			);

			if (unconsolidated.length === 0) {
				return {
					episodesCreated: 0,
					summaryEventIds: [],
					eventsProcessed: 0,
					durationMs: Date.now() - start,
				};
			}

			// Episode detection ----------------------------------------------------
			const episodes = await detectEpisodes(unconsolidated, options.episodeDetection);

			// Generate & persist summaries ----------------------------------------
			const summaryEventIds: string[] = [];

			for (const episode of episodes) {
				const episodeEvents = unconsolidated.filter((e) =>
					episode.sourceEventIds.includes(e.id),
				);

				const summaryText = options.summarizeEpisode
					? await options.summarizeEpisode(episode, episodeEvents)
					: defaultSummarizer(episode, episodeEvents);

				const payload: EpisodeSummaryPayload = {
					type: "episode_summary",
					episodeId: episode.id,
					topic: episode.topic,
					outcome: episode.outcome,
					sourceEventIds: episode.sourceEventIds,
					summary: summaryText,
				};

				const summaryEvent = eventStore.append({
					kind: "system_event",
					content: JSON.stringify(payload),
					tokens: Math.ceil(JSON.stringify(payload).length / 4),
					turnId: 0,
					sessionKey: eventStore.sessionKey,
					metadata: {
						tags: ["consolidated"],
					},
				});

				summaryEventIds.push(summaryEvent.id);
			}

			// Advance internal state cursor ----------------------------------------
			const lastEvent = unconsolidated[unconsolidated.length - 1];
			state.lastConsolidatedEventId = lastEvent.id;
			state.lastConsolidatedAt = new Date().toISOString();
			state.episodeCount += episodes.length;

			return {
				episodesCreated: episodes.length,
				summaryEventIds,
				eventsProcessed: unconsolidated.length,
				durationMs: Date.now() - start,
			};
		},
	};
}
