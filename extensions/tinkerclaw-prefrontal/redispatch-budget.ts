/**
 * SS1 (2026-06-04): derive — never freeze — the schema re-dispatch bound.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): the number of times the runner will
 * re-ask a subagent to fix a schema-mismatched output is NOT a constant. It is a
 * function of the live situation:
 *   - value-of-work  : how much structure is at stake (required-field count)
 *   - confidence     : the recipe's historical success rate (less reliable → try harder)
 *   - affordability  : how many more dispatches the remaining token budget covers
 *
 * The coefficients below are a derivation, not the answer; the *output* responds
 * to the inputs (proven by redispatch-budget.test.ts). Do not collapse this to a
 * literal — that would re-introduce MAX_SCHEMA_RETRIES=2.
 */

export interface RedispatchSignals {
  /** Count of `required` fields in the step's `out:` schema (value-of-work proxy). */
  requiredFieldCount: number;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
  /** Remaining token allowance for the run, if a caller threads one. */
  remainingTokenBudget?: number;
  /** Observed/estimated tokens for one dispatch of this step, if known. */
  estStepTokens?: number;
}

export function deriveRedispatchBudget(signals: RedispatchSignals): number {
  // value-of-work: 0 fields → 1, scaling up; saturates so a huge schema can't run away.
  const worth = 1 + Math.min(3, Math.floor(signals.requiredFieldCount / 2));

  // confidence: a shaky recipe (low success rate) earns more correction attempts.
  const successRate = signals.fitnessSuccessRate ?? 0.5;
  const uncertainty = 1 - Math.max(0, Math.min(1, successRate)); // [0,1]

  // Combine: worth sets the ceiling of ambition, uncertainty modulates it.
  const derived = Math.max(1, Math.round(worth * (0.5 + uncertainty)));

  // affordability clamp: never plan more dispatches than the budget can pay for.
  const affordable =
    signals.remainingTokenBudget != null &&
    signals.estStepTokens != null &&
    signals.estStepTokens > 0
      ? Math.floor(signals.remainingTokenBudget / signals.estStepTokens)
      : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(derived, affordable));
}
