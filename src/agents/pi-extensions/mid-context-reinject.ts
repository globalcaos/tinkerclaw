/**
 * CORTEX Phase 3.3: Mid-context persona re-injection.
 *
 * When SyncScore EWMA drops below the drift threshold (0.6), re-inject the
 * Tier 1A persona block at the start of the system prompt to reinforce persona
 * identity for the current turn.
 *
 * This module is intentionally free of side effects so it can be unit-tested
 * independently of the full agent pipeline.
 */

import { SYNC_SCORE_DRIFT_THRESHOLD, type CortexRuntime } from "./cortex-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReinjectionResult {
	/** Whether re-injection was triggered this turn. */
	reinjected: boolean;
	/** Updated system prompt text (persona block prepended when reinjected). */
	systemPrompt: string;
	/** EWMA SyncScore that triggered (or declined) re-injection. */
	ewmaScore: number;
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Evaluate whether mid-context persona re-injection is needed and apply it.
 *
 * Re-injection fires when the cortex runtime's EWMA SyncScore is below the
 * drift threshold (default 0.6). The persona Tier 1A block is prepended to the
 * system prompt so the model sees it at the highest attention position.
 *
 * @param cortexRuntime - Session-bound CortexRuntime (or null/undefined when
 *   engram mode is inactive — safe no-op in that case).
 * @param systemPrompt  - Current assembled system prompt text for this turn.
 * @returns Updated system prompt and metadata about whether re-injection fired.
 */
export function applyMidContextReinject(
	cortexRuntime: CortexRuntime | null | undefined,
	systemPrompt: string,
): ReinjectionResult {
	if (!cortexRuntime) {
		return { reinjected: false, systemPrompt, ewmaScore: 1.0 };
	}

	const ewmaScore = cortexRuntime.ewmaSyncScore;

	// No re-injection needed — persona consistency is healthy.
	if (ewmaScore >= SYNC_SCORE_DRIFT_THRESHOLD) {
		return { reinjected: false, systemPrompt, ewmaScore };
	}

	const personaBlock = cortexRuntime.getPersonaBlock();
	if (!personaBlock) {
		// Persona block unavailable (edge case: empty persona state).
		return { reinjected: false, systemPrompt, ewmaScore };
	}

	// Prepend persona block so it appears before all other system instructions,
	// maximising the chance the model applies persona constraints on this turn.
	return {
		reinjected: true,
		systemPrompt: `${personaBlock}\n\n${systemPrompt}`,
		ewmaScore,
	};
}

// ---------------------------------------------------------------------------
// Per-turn SyncScore evaluation helper
// ---------------------------------------------------------------------------

/**
 * Evaluate SyncScore for the current turn and log results.
 *
 * Should be called once per agent turn (after the LLM response is collected)
 * with the assistant message texts from the current turn.
 *
 * @param cortexRuntime - Session-bound CortexRuntime.
 * @param assistantTexts - Assistant response strings from the current turn.
 * @param turnNumber - Current turn number (user message count so far).
 * @param logFn - Logger function for re-injection events (accepts a string).
 */
export function evaluateTurnSyncScore(
	cortexRuntime: CortexRuntime | null | undefined,
	assistantTexts: string[],
	turnNumber: number,
	logFn?: (msg: string) => void,
): void {
	if (!cortexRuntime || assistantTexts.length === 0) return;

	const result = cortexRuntime.evaluateSyncScore(assistantTexts, turnNumber);

	if (result.needsReinjection && logFn) {
		logFn(
			`cortex: SyncScore drift detected — ewma=${result.ewmaScore.toFixed(3)} < ${SYNC_SCORE_DRIFT_THRESHOLD} ` +
				`(raw=${result.rawScore.toFixed(3)}, turn=${turnNumber})`,
		);
	}
}
