// src/shared/effort-cost-mult.ts
// Output-token burn per thinking effort, relative to `medium` = 1. Documented EEG
// ladder (2026-06), moved here 2026-09-02 so the THALAMUS router and the chart price a
// rung from ONE table: cost(rung) = relCost x EFFORT_COST_MULT[effort].
// "" is the unset/auto effort the EEG trace paints when no stop is pinned.
export const EFFORT_COST_MULT: Record<string, number> = {
  "": 1.2,
  minimal: 0.5,
  low: 0.75,
  medium: 1,
  high: 1.5,
  xhigh: 2,
  max: 3,
};
