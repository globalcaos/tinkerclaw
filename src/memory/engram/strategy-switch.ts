/**
 * ENGRAM Phase 3D — Strategy-switch decision logic (Upgrade 4).
 *
 * Given a per-strategy failure state machine (failure-tracking.ts), decide
 * whether a recurring pattern of failures should trip a *strategy switch*
 * rather than another single-instance patch.
 *
 * Canonical case: the B010 cascade (always-merge fork-sync). Three consecutive
 * failures within a recency window should switch from "always-merge" to the
 * registered fallback "ask-before-merge" — not a fourth identical patch.
 *
 * A hand-authored fallback map is the SAFE DEFAULT. When no fallback is
 * registered for a strategy, the decision is flagged for human review with a
 * null target.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 4).
 */

import type { StrategyState } from "./failure-tracking.js";

export interface SwitchDecision {
  shouldSwitch: boolean;
  strategyId: string;
  fromStrategy: string;
  /** Registered fallback, or null when none is known (→ needsHumanReview). */
  toStrategy: string | null;
  confidence: number;
  needsHumanReview: boolean;
  rationale: string;
}

export interface StrategySwitchConfig {
  /** Consecutive failures required before a switch is considered. Default 3. */
  threshold: number;
  /** Recency window: failures spread beyond this don't trip a switch. Default 24h. */
  windowMs: number;
  /** Confidence below which the switch is flagged for human review. Default 0.8. */
  minConfidence: number;
}

export const DEFAULT_STRATEGY_SWITCH_CONFIG: StrategySwitchConfig = {
  threshold: 3,
  windowMs: 24 * 60 * 60 * 1000,
  minConfidence: 0.8,
};

/**
 * A hand-authored fallback map — the safe default. Strategy id → replacement.
 * Includes the canonical B010 fork-sync case so the documented incident is
 * handled out of the box.
 */
export const DEFAULT_FALLBACKS: ReadonlyMap<string, string> = new Map([
  ["fork-sync:always-merge", "fork-sync:ask-before-merge"],
  ["always-merge", "ask-before-merge"],
]);

/**
 * Confidence heuristic. More consecutive failures → higher confidence. A
 * previous switch on this strategy that did NOT recover lowers confidence
 * (avoid thrashing between two strategies).
 */
function scoreConfidence(state: StrategyState, threshold: number): number {
  const overshoot = state.consecutiveErrors - threshold;
  let confidence = Math.min(1, 0.7 + 0.1 * (overshoot + 1));
  // Penalise if the last switch failed to recover (recoveredAfter > 0 means it
  // kept failing after switching; undefined means recovery never observed).
  const lastSwitch = state.switchHistory[state.switchHistory.length - 1];
  if (lastSwitch) {
    if (lastSwitch.recoveredAfter === undefined || lastSwitch.recoveredAfter > 0) {
      confidence -= 0.25;
    }
  }
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Decide whether to switch strategy.
 *
 * Switch is proposed when:
 *   consecutiveErrors >= threshold AND the most recent failure is within windowMs.
 *
 * The decision is flagged for human review when confidence < minConfidence OR
 * no fallback is registered.
 */
export function decideSwitch(
  state: StrategyState,
  fallbacks: ReadonlyMap<string, string> = DEFAULT_FALLBACKS,
  config: Partial<StrategySwitchConfig> = {},
  now: Date = new Date(),
): SwitchDecision {
  const cfg = { ...DEFAULT_STRATEGY_SWITCH_CONFIG, ...config };
  const base: SwitchDecision = {
    shouldSwitch: false,
    strategyId: state.strategyId,
    fromStrategy: state.currentStrategy,
    toStrategy: null,
    confidence: 0,
    needsHumanReview: false,
    rationale: "",
  };

  if (state.consecutiveErrors < cfg.threshold) {
    return {
      ...base,
      rationale: `Only ${state.consecutiveErrors} consecutive failure(s); threshold is ${cfg.threshold}.`,
    };
  }

  // Recency guard — failures spread beyond the window don't count as a pattern.
  if (state.lastFailureTime) {
    const age = now.getTime() - new Date(state.lastFailureTime).getTime();
    if (age >= cfg.windowMs) {
      return {
        ...base,
        rationale: `${state.consecutiveErrors} failures but most recent is stale (>${Math.round(
          cfg.windowMs / 3_600_000,
        )}h old); recency guard suppresses the switch.`,
      };
    }
  }

  const to = fallbacks.get(state.currentStrategy) ?? null;
  const confidence = scoreConfidence(state, cfg.threshold);
  const needsHumanReview = to === null || confidence < cfg.minConfidence;

  let rationale: string;
  if (to === null) {
    rationale = `${state.consecutiveErrors} consecutive failures of "${state.currentStrategy}" within window, but no registered fallback — flagged for human review.`;
  } else {
    rationale = `${state.consecutiveErrors} consecutive failures of "${state.currentStrategy}" within window → switch to "${to}" (confidence ${confidence.toFixed(
      2,
    )}).`;
  }

  return {
    shouldSwitch: true,
    strategyId: state.strategyId,
    fromStrategy: state.currentStrategy,
    toStrategy: to,
    confidence,
    needsHumanReview,
    rationale,
  };
}
