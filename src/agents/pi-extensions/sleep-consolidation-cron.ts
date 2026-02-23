/**
 * ENGRAM Phase 1.4 — Sleep Consolidation Cron
 *
 * Wires `sleep-consolidation.ts` into the nightly cron/heartbeat system.
 * Persists consolidation state to disk for fully incremental operation:
 * successive runs only process events appended since the last run.
 *
 * Storage layout (inside <baseDir>):
 *   events/<sessionKey>.jsonl          — raw event log (read-only here)
 *   artifacts/<id>                     — episode summary blobs
 *   consolidation-state/<sessionKey>.json — persisted cursor & counters
 *
 * Safe to call from a cron job, the heartbeat hook, or as a standalone script.
 *
 * FORK-ISOLATED: unique to our fork (ENGRAM paper §5.3).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifactStore } from "../../memory/engram/artifact-store.js";
import {
	type ConsolidationState,
	createInitialConsolidationState,
} from "../../memory/engram/episode-detection.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import {
	type ConsolidationResult,
	type SleepConsolidationConfig,
	runSleepConsolidation as runCore,
} from "../../memory/engram/sleep-consolidation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SleepConsolidationCronConfig extends SleepConsolidationConfig {
	/**
	 * Root directory for the ENGRAM store.
	 * Defaults to `~/.openclaw/engram` (same as Extensions.ts).
	 */
	baseDir?: string;
	/** Session to consolidate (defaults to "default"). */
	sessionKey?: string;
	/**
	 * Logger — defaults to `console.log`.
	 * Override with a no-op in tests or a structured logger in production.
	 */
	log?: (msg: string) => void;
}

export interface SleepConsolidationCronResult extends ConsolidationResult {
	sessionKey: string;
	baseDir: string;
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

function stateDir(baseDir: string): string {
	return join(baseDir, "consolidation-state");
}

function statePath(baseDir: string, sessionKey: string): string {
	return join(stateDir(baseDir), `${sessionKey}.json`);
}

function loadState(baseDir: string, sessionKey: string): ConsolidationState {
	const path = statePath(baseDir, sessionKey);
	if (existsSync(path)) {
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as ConsolidationState;
		} catch {
			// Corrupted state — restart from scratch (idempotent at worst)
		}
	}
	return createInitialConsolidationState();
}

function saveState(baseDir: string, sessionKey: string, state: ConsolidationState): void {
	mkdirSync(stateDir(baseDir), { recursive: true });
	writeFileSync(statePath(baseDir, sessionKey), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the sleep consolidation pipeline for `sessionKey`.
 *
 * Steps:
 *  1. Open the ENGRAM event store for the session.
 *  2. Load previously persisted consolidation state (cursor + counters).
 *  3. Detect episodes from unconsolidated events.
 *  4. Generate per-episode summaries and store them as artifacts.
 *  5. Persist updated state to disk (so the next run is incremental).
 *  6. Log a summary of what was consolidated.
 */
export async function runSleepConsolidation(
	config: SleepConsolidationCronConfig = {},
): Promise<SleepConsolidationCronResult> {
	const {
		baseDir: rawBaseDir,
		sessionKey = "default",
		log = console.log,
		...coreConfig
	} = config;

	const baseDir = rawBaseDir ?? join(process.env.HOME ?? "~", ".openclaw", "engram");
	mkdirSync(baseDir, { recursive: true });

	const eventStore = createEventStore({ baseDir, sessionKey });
	const artifactStore = createArtifactStore({ baseDir });
	const state = loadState(baseDir, sessionKey);

	log(
		`[sleep-consolidation-cron] Starting — session=${sessionKey} events=${eventStore.count()} cursor=${state.lastConsolidatedEventId ?? "none"}`,
	);

	const result = await runCore(eventStore, artifactStore, state, coreConfig);

	// Persist the updated cursor so the next run is incremental.
	saveState(baseDir, sessionKey, state);

	log(
		`[sleep-consolidation-cron] Done — episodes=${result.newEpisodes.length} eventsProcessed=${result.eventsProcessed} summaries=${result.summariesGenerated} durationMs=${result.durationMs}`,
	);

	if (result.newEpisodes.length > 0) {
		for (const ep of result.newEpisodes) {
			log(
				`[sleep-consolidation-cron]   episode id=${ep.id} topic="${ep.topic}" outcome=${ep.outcome} turns=${ep.turnCount}`,
			);
		}
	}

	return { ...result, sessionKey, baseDir };
}

// ---------------------------------------------------------------------------
// Standalone script entry point
// ---------------------------------------------------------------------------
// Run directly:  bun src/agents/pi-extensions/sleep-consolidation-cron.ts
// Or via CLI:    node dist/agents/pi-extensions/sleep-consolidation-cron.js

if (import.meta.url === `file://${process.argv[1]}`) {
	runSleepConsolidation().catch((err: unknown) => {
		console.error("[sleep-consolidation-cron] Fatal:", err);
		process.exit(1);
	});
}
