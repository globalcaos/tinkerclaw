/**
 * Re-export of the canonical overseer loop-budget derivation.
 *
 * The implementation moved to src/fork/overseer-budget.ts (2026-06-07) so that BOTH
 * the per-turn engine (src/fork/overseer.ts) and the recipe-runner overseer loop
 * (recipe-runner.ts) derive the supervision bound from ONE source of truth — no
 * duplicated arithmetic, no chance of the two paths drifting apart (design-principle
 * #19: derive, never freeze; a single canonical derivation).
 *
 * recipe-runner.ts imports `deriveOverseerLoopBudget` from "./overseer-budget.js"
 * unchanged; it now resolves to the core implementation via this re-export.
 */

export {
  deriveOverseerLoopBudget,
  type OverseerLoopSignals,
} from "../../src/fork/overseer-budget.js";
