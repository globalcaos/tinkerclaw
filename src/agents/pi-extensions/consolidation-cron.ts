/**
 * ENGRAM Phase 1.4 — Consolidation Cron Hook
 *
 * Provides `runNightlyConsolidation` — a stable, idempotent entry point that
 * can be called from a heartbeat, cron job, or CLI with no side effects beyond
 * appending consolidated episode summaries to the named event store.
 *
 * Safe to call repeatedly: the underlying runner tracks its cursor, so
 * successive calls only process events appended since the last run.
 */

import { createEventStore } from "../../memory/engram/event-store.js";
import {
	type ConsolidationRunResult,
	type ConsolidationRunnerOptions,
	createConsolidationRunner,
} from "./consolidation-runtime.js";

export interface NightlyConsolidationOptions extends ConsolidationRunnerOptions {
	/** Optional ISO timestamp — process only events at or after this point. */
	sinceTimestamp?: string;
	/** Logger (defaults to console). Override in tests or structured-log contexts. */
	log?: (msg: string) => void;
}

export interface NightlyConsolidationResult extends ConsolidationRunResult {
	sessionKey: string;
	baseDir: string;
}

/**
 * Create an event store for `sessionKey`, run the consolidation pipeline,
 * and log the outcome. Idempotent — calling repeatedly is safe.
 */
export async function runNightlyConsolidation(
	baseDir: string,
	sessionKey: string,
	options: NightlyConsolidationOptions = {},
): Promise<NightlyConsolidationResult> {
	const { sinceTimestamp, log = console.log, ...runnerOptions } = options;

	const store = createEventStore({ baseDir, sessionKey });
	const runner = createConsolidationRunner(store, runnerOptions);

	log(
		`[consolidation-cron] Starting consolidation — session=${sessionKey} since=${sinceTimestamp ?? "last-cursor"}`,
	);

	const result = await runner.consolidate(sinceTimestamp);

	log(
		`[consolidation-cron] Done — episodes=${result.episodesCreated} events=${result.eventsProcessed} durationMs=${result.durationMs}`,
	);

	if (result.summaryEventIds.length > 0) {
		log(
			`[consolidation-cron] Summary events written: ${result.summaryEventIds.join(", ")}`,
		);
	}

	return { ...result, sessionKey, baseDir };
}
