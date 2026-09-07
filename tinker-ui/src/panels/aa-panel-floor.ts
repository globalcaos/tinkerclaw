// tinker-ui/src/panels/aa-panel-floor.ts
//
// The SMART MODELS intelligence floor, expressed as a POSITION in the catalog rather
// than as a score.
//
// FORK 2026-09-05 (the user: "in the model picker panel I only have 2 models available
// now"). Artificial Analysis rebased its Intelligence Index overnight — every scored
// model fell ~15-25% in one scrape (Fable 5.1 65.65 -> 56.76). The nightly refresh
// wrote the new scores into agents.defaults.models correctly; nothing was deleted and
// no model got dumber. But the gate reading those scores was the literal number 53, so
// the panel dropped from 23 models to 2, and the model SELECTOR, which shares the
// predicate, dropped with it.
//
// A threshold denominated in someone else's units is a hostage to their rescaling. An
// ordinal cut is not: "the smartest N" means the same thing on any scale, in any year.
//
// N = 23 reproduces exactly what the 53 cut admitted the day before the rescale. Move N
// when the list stops being scannable at a glance — that, not any number, is the
// criterion the user has stated twice (2026-08-22, 2026-09-05).
export const AA_PANEL_TOP_N = 23;

/**
 * The live floor: the score of the Nth-smartest model in `scores`.
 *
 * A catalog shorter than N is admitted whole (the floor is its weakest member) rather
 * than emptied, and an unscored catalog returns -Infinity so a caller filtering on
 * `score >= floor` degrades to "show everything" instead of "show nothing". Failing
 * OPEN is deliberate here: an empty model picker is the outage this module exists to
 * prevent.
 */
export function aaPanelFloor(scores: readonly number[]): number {
  const sorted = scores.filter((s) => Number.isFinite(s)).sort((a, b) => b - a);
  if (sorted.length === 0) return Number.NEGATIVE_INFINITY;
  return sorted[Math.min(AA_PANEL_TOP_N, sorted.length) - 1] as number;
}
