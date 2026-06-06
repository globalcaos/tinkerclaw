/**
 * SS5a (2026-06-06): derive — never freeze — the recovery-RETRY bound.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): how many times the runner re-runs a
 * FAILED step (the `onError: retry N` policy) is NOT a constant. It is a function
 * of the live situation:
 *   - confidence    : the recipe's historical success rate (less reliable → try harder)
 *   - effort spent  : prior attempts already burned (diminishing returns)
 *   - affordability : how many more dispatches the remaining budget covers
 *
 * Distinct from redispatch-budget.ts: that derives SCHEMA-redispatch retries (a
 * typed step's bad JSON); this derives ERROR-RECOVERY retries (the step itself
 * failed). The author's `onError: retry N` is a DOWNWARD CAP applied by the caller
 * (min(N, this)); this function's job is only the situation-derived bound, floored
 * at 1 (always at least one recovery attempt). The coefficients are a derivation,
 * not the answer; the *output* responds to the inputs (proven by
 * recovery-budget.test.ts). Do not collapse this to a literal — that would
 * re-introduce a frozen MAX_RETRIES (the exact J16 anti-pattern).
 */

export interface RecoveryRetrySignals {
  /** Recovery attempts already burned on this step (diminishing returns). */
  priorAttempts?: number;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
  /** Remaining dispatch/token allowance for the run, if a caller threads one. */
  remainingDispatchBudget?: number;
  /** Observed/estimated tokens for one dispatch of this step, if known. */
  estStepTokens?: number;
}

/**
 * Recovery-retry bound = max(1, derived), clamped DOWN by affordability. Rises as
 * fitness falls (a shaky recipe earns more attempts), decays as prior attempts
 * accumulate, and never drops below 1 (always one recovery attempt). With no budget
 * threaded the affordability clamp is inert (POSITIVE_INFINITY) — the same
 * documented "structurally-derived-but-inert until wired" gap as redispatch-budget.
 */
export function deriveRecoveryRetryBudget(signals: RecoveryRetrySignals): number {
  // confidence: a shaky recipe (low success rate) earns more recovery attempts.
  const successRate = signals.fitnessSuccessRate ?? 0.5;
  const uncertainty = 1 - Math.max(0, Math.min(1, successRate)); // [0,1]

  // base ambition scales with uncertainty: a perfectly reliable recipe still gets
  // the floor (1); a wholly unreliable one gets up to ~3 fresh attempts.
  const ambition = 1 + Math.round(uncertainty * 2); // [1,3]

  // effort spent: each prior attempt shaves one off the ambition (diminishing
  // returns), but never below the floor.
  const spent = Math.max(0, Math.floor(signals.priorAttempts ?? 0));
  const derived = Math.max(1, ambition - spent);

  // affordability clamp: never plan more dispatches than the budget can pay for.
  const affordable =
    signals.remainingDispatchBudget != null &&
    signals.estStepTokens != null &&
    signals.estStepTokens > 0
      ? Math.floor(signals.remainingDispatchBudget / signals.estStepTokens)
      : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(derived, affordable));
}
