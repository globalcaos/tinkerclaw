/**
 * ENGRAM Phase 3C — Sleep Consolidation Pipeline
 *
 * Runs during idle time (or via cron/CLI) to:
 * 1. Detect new episodes from unprocessed events
 * 2. Generate per-episode summaries
 * 3. Store summaries as artifacts
 *
 * Incremental & idempotent — tracks lastConsolidatedEventId.
 *
 * FORK-ISOLATED: unique to our fork (ENGRAM paper §5.3).
 */

import type { EventStore } from "./event-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
	type ConsolidationState,
	type Episode,
	type EpisodeDetectionConfig,
	createInitialConsolidationState,
	detectEpisodes,
} from "./episode-detection.js";
import type { MemoryEvent } from "./event-types.js";

export interface SleepConsolidationConfig {
	episodeDetection?: Partial<EpisodeDetectionConfig>;
	/** Generate a summary for an episode. LLM-backed in production, simple in tests. */
	summarizeEpisode?: (episode: Episode, events: MemoryEvent[]) => string | Promise<string>;
}

export interface ConsolidationResult {
	newEpisodes: Episode[];
	summariesGenerated: number;
	eventsProcessed: number;
	durationMs: number;
}

/** Default episode summarizer — concatenates key content. */
function defaultEpisodeSummarizer(episode: Episode, events: MemoryEvent[]): string {
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

/**
 * Run sleep consolidation pipeline.
 */
export async function runSleepConsolidation(
	store: EventStore,
	artifactStore: ArtifactStore,
	state: ConsolidationState,
	config: SleepConsolidationConfig = {},
): Promise<ConsolidationResult> {
	const start = Date.now();
	const summarize = config.summarizeEpisode ?? defaultEpisodeSummarizer;

	// 1. Get unprocessed events
	const allEvents = store.readAll();
	let unprocessed: MemoryEvent[];

	if (state.lastConsolidatedEventId) {
		const lastIdx = allEvents.findIndex((e) => e.id === state.lastConsolidatedEventId);
		unprocessed = lastIdx >= 0 ? allEvents.slice(lastIdx + 1) : allEvents;
	} else {
		unprocessed = allEvents;
	}

	if (unprocessed.length === 0) {
		return {
			newEpisodes: [],
			summariesGenerated: 0,
			eventsProcessed: 0,
			durationMs: Date.now() - start,
		};
	}

	// 2. Detect episodes
	const episodes = await detectEpisodes(unprocessed, config.episodeDetection);

	// 3. Generate & store summaries
	let summariesGenerated = 0;
	for (const episode of episodes) {
		const episodeEvents = unprocessed.filter((e) => episode.sourceEventIds.includes(e.id));
		const summary = await summarize(episode, episodeEvents);

		artifactStore.store(summary, "text");
		summariesGenerated++;
	}

	// 4. Update state
	const lastEvent = unprocessed[unprocessed.length - 1];
	state.lastConsolidatedEventId = lastEvent.id;
	state.lastConsolidatedAt = new Date().toISOString();
	state.episodeCount += episodes.length;

	return {
		newEpisodes: episodes,
		summariesGenerated,
		eventsProcessed: unprocessed.length,
		durationMs: Date.now() - start,
	};
}

export { createInitialConsolidationState };
