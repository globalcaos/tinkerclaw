/**
 * SS5b (2026-06-06): derive — never freeze — the overseer SUPERVISION-LOOP bound.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): how many supervision iterations the
 * overseer runs before it stops nudging a long task is NOT a constant. It is a
 * function of the live situation:
 *   - confidence    : the recipe's historical success rate (less reliable → loop harder)
 *   - gap trend     : a shrinking gap-to-done earns one more pass (close to finishing)
 *   - effort spent  : prior iterations already burned (diminishing returns)
 *   - affordability : how many more dispatches the remaining budget covers
 *
 * Distinct from recovery-budget.ts (ERROR-RECOVERY retries of a failed step) and
 * spawn-budget.ts (parallel-spawn fan-out width): this derives the OVERSEER LOOP
 * count (how many supervision passes the critic makes). The author's intent is a
 * DOWNWARD CAP applied by the caller (min(N, this)); this function's job is only
 * the situation-derived WORKING bound, floored at 1 (always at least one pass).
 *
 * The WORKING bound is what this returns; HARD_LOOP_MAX=25 (recipe-runner.ts) is the
 * structural CEILING — a safety ceiling, never the working value (FOUNDATION §1,
 * design-principle #19: "a frozen number is at most a safety CEILING, never the
 * working value"). The coefficients are a derivation, not the answer; the *output*
 * responds to the inputs (proven by overseer-budget.test.ts). Do not collapse this
 * to a literal — that would re-introduce a frozen MAX_LOOPS (the exact J16
 * anti-pattern).
 */

export interface OverseerLoopSignals {
  /** Supervision iterations already burned on this task (diminishing returns). */
  priorIterations?: number;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
  /** Whether the observed gap-to-done is shrinking (close to finishing → one more pass). */
  gapShrinking?: boolean;
  /** Remaining dispatch/token allowance for the run, if a caller threads one. */
  remainingDispatchBudget?: number;
  /** Observed/estimated tokens for one dispatch of this step, if known. */
  estStepTokens?: number;
}

/** Clamp a value into the [0,1] interval. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Overseer supervision-loop bound = max(1, derived), clamped DOWN by affordability.
 * Rises as fitness falls (a shaky recipe earns more supervision passes), gains one
 * pass while the gap is still shrinking, decays as prior iterations accumulate, and
 * never drops below 1 (always one pass). This is the WORKING bound; HARD_LOOP_MAX=25
 * is only the safety ceiling, never the frozen value (design-principle #19). With no
 * budget threaded the affordability clamp is inert (POSITIVE_INFINITY) — the same
 * documented "structurally-derived-but-inert until wired" gap as recovery-budget.
 */
export function deriveOverseerLoopBudget(signals: OverseerLoopSignals): number {
  // confidence: a shaky recipe (low success rate) earns more supervision passes.
  const uncertainty = 1 - clamp01(signals.fitnessSuccessRate ?? 0.5); // [0,1]

  // base ambition scales with uncertainty: a perfectly reliable recipe still gets
  // the floor (1); a wholly unreliable one gets up to ~3 supervision passes.
  let ambition = 1 + Math.round(uncertainty * 2); // [1,3]

  // gap trend: while the gap-to-done is still shrinking, earn one more pass
  // (we're close — keep nudging to the finish).
  if (signals.gapShrinking) ambition += 1;

  // effort spent: each prior iteration shaves one off the ambition (diminishing
  // returns), but never below the floor.
  const spent = Math.max(0, Math.floor(signals.priorIterations ?? 0));
  const derived = Math.max(1, ambition - spent);

  // affordability clamp: never plan more dispatches than the budget can pay for.
  const affordable =
    signals.remainingDispatchBudget != null && signals.estStepTokens && signals.estStepTokens > 0
      ? Math.floor(signals.remainingDispatchBudget / signals.estStepTokens)
      : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(derived, affordable));
}
