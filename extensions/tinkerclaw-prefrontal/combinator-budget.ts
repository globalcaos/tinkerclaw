/**
 * SS2b (2026-06-06): derive — never freeze — the combinator bounds.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): a combinator has TWO distinct bounds
 * and NEITHER is a constant:
 *   - WIDTH  : how many elements a map/filter fans out over. This is bounded by
 *              the DATA (the array length), not by a frozen cap — clamped down only
 *              when a caller threads a real dispatch budget that can't afford it.
 *   - DEPTH  : how deep combinator-inside-combinator nesting may go via `uses:`.
 *              3 is a FLOOR (preserving the old MAX_USES_DEPTH=3 behavior exactly
 *              when no budget is wired), and it derives UPWARD when a budget affords
 *              deeper nesting — never below the floor.
 *
 * The coefficients are a derivation, not the answer; the *output* responds to the
 * inputs (proven by combinator-budget.test.ts). Do not collapse either function to
 * a literal — that would re-introduce a frozen MAX (the exact J16 anti-pattern).
 */

/** The depth floor (NOT a frozen ceiling) — see deriveUsesDepthBudget. */
export const USES_DEPTH_FLOOR = 3;

export interface CombinatorFanOutSignals {
  /** The resolved iteration-array length (the data bound on width). */
  arrayLength: number;
  /** Remaining dispatch allowance for the run, if a caller threads one. */
  remainingDispatchBudget?: number;
  /** Estimated dispatches per iteration (default 1: one worker spawn per element). */
  estIterationCost?: number;
}

/**
 * Width of a map/filter fan-out = the array length, clamped DOWN only when a
 * threaded dispatch budget cannot afford one worker per element. With no budget
 * signal the data alone bounds it (zero magic numbers). Never negative.
 */
export function deriveCombinatorFanOut(signals: CombinatorFanOutSignals): number {
  const want = Math.max(0, Math.floor(signals.arrayLength));
  const cost =
    signals.estIterationCost && signals.estIterationCost > 0 ? signals.estIterationCost : 1;
  const affordable =
    signals.remainingDispatchBudget != null
      ? Math.max(0, Math.floor(signals.remainingDispatchBudget / cost))
      : Number.POSITIVE_INFINITY;
  return Math.min(want, affordable);
}

export interface UsesDepthSignals {
  /** Remaining dispatch allowance for the run, if a caller threads one. */
  remainingDispatchBudget?: number;
  /** Estimated dispatches per nesting level, if known. */
  estIterationCost?: number;
}

/**
 * Max `uses:` nesting depth = max(FLOOR, derived). With no budget threaded this
 * returns the floor (3) — numerically identical to the old `MAX_USES_DEPTH = 3`,
 * but derivation-shaped per J16 (a budget signal can push it deeper; nothing can
 * push it below the floor). recipe-rpcs does not yet thread a budget here — the
 * same documented gap as `fitnessSuccessRate` (structurally derived, numerically
 * inert until wired). This is a FOLLOW-UP, not a silent no-op.
 */
export function deriveUsesDepthBudget(signals: UsesDepthSignals): number {
  const cost =
    signals.estIterationCost && signals.estIterationCost > 0 ? signals.estIterationCost : 1;
  const affordable =
    signals.remainingDispatchBudget != null
      ? Math.floor(signals.remainingDispatchBudget / cost)
      : USES_DEPTH_FLOOR;
  return Math.max(USES_DEPTH_FLOOR, affordable);
}
