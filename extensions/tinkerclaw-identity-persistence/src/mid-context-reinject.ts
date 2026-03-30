/**
 * FORK: Mid-context persona re-injection (self-contained copy for extension).
 *
 * When SyncScore EWMA drops below the drift threshold (0.6), re-inject the
 * Tier 1A persona block at the start of the system prompt to reinforce persona
 * identity for the current turn.
 *
 * Adapted from src/agents/pi-extensions/mid-context-reinject.ts.
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
 */
export function applyMidContextReinject(
  cortexRuntime: CortexRuntime | null | undefined,
  systemPrompt: string,
): ReinjectionResult {
  if (!cortexRuntime) {
    return { reinjected: false, systemPrompt, ewmaScore: 1.0 };
  }

  const ewmaScore = cortexRuntime.ewmaSyncScore;

  if (ewmaScore >= SYNC_SCORE_DRIFT_THRESHOLD) {
    return { reinjected: false, systemPrompt, ewmaScore };
  }

  const personaBlock = cortexRuntime.getPersonaBlock();
  if (!personaBlock) {
    return { reinjected: false, systemPrompt, ewmaScore };
  }

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
 */
export function evaluateTurnSyncScore(
  cortexRuntime: CortexRuntime | null | undefined,
  assistantTexts: string[],
  turnNumber: number,
  logFn?: (msg: string) => void,
): void {
  if (!cortexRuntime || assistantTexts.length === 0) {
    return;
  }

  const result = cortexRuntime.evaluateSyncScore(assistantTexts, turnNumber);

  if (result.needsReinjection && logFn) {
    logFn(
      `cortex: SyncScore drift detected -- ewma=${result.ewmaScore.toFixed(3)} < ${SYNC_SCORE_DRIFT_THRESHOLD} ` +
        `(raw=${result.rawScore.toFixed(3)}, turn=${turnNumber})`,
    );
  }
}
