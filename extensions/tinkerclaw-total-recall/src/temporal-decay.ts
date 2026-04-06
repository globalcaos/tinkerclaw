/**
 * FORK: Temporal decay for retrieval scoring.
 *
 * Older events score lower unless they're evergreen (markers, persona, system).
 * Formula: multiplier = e^(-lambda * age_days) where lambda = ln(2) / halfLifeDays
 *
 * Wired into retrieval-integration.ts — applied BEFORE task-conditioned scoring.
 */

import type { EventKind } from "./event-types.js";

export interface TemporalDecayConfig {
  enabled: boolean;
  halfLifeDays: number; // default: 14
}

export const DEFAULT_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: true,
  halfLifeDays: 14,
};

/** Event kinds that should never decay — they remain relevant indefinitely. */
const EVERGREEN_KINDS: ReadonlySet<string> = new Set<EventKind>([
  "compaction_marker",
  "persona_state",
  "system_event",
]);

/** Episode summaries decay at 2x the normal half-life (they're distilled knowledge). */
const EPISODE_SUMMARY_KIND = "episode_summary";

/**
 * Returns true if the event kind should never decay.
 */
export function isEvergreenKind(kind: string): boolean {
  return EVERGREEN_KINDS.has(kind);
}

/**
 * Compute a decay multiplier for an event based on its age.
 * Returns a value in (0, 1] where 1.0 = no decay (fresh event).
 *
 * For episode summaries, the effective half-life is doubled (slower decay)
 * since they represent distilled knowledge worth preserving longer.
 */
export function computeTemporalDecay(
  eventTimestamp: number, // ms since epoch
  nowMs: number,
  config: TemporalDecayConfig,
  kind?: string,
): number {
  if (!config.enabled) {
    return 1.0;
  }

  const ageDays = (nowMs - eventTimestamp) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) {
    return 1.0;
  }

  // Episode summaries get 2x half-life (slower decay)
  const effectiveHalfLife =
    kind === EPISODE_SUMMARY_KIND ? config.halfLifeDays * 2 : config.halfLifeDays;

  const lambda = Math.LN2 / effectiveHalfLife;
  return Math.exp(-lambda * ageDays);
}
