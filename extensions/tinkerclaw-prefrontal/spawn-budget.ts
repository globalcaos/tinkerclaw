/**
 * SS5b (2026-06-06): derive — never freeze — the parallel-spawn unit count.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): how many independent units a step
 * fans out into is NOT a constant. It is a function of the live situation:
 *   - required fields : a wider typed surface earns more parallel coverage
 *   - skill invoked   : a skill-backed step warrants one extra unit
 *   - confidence      : the recipe's historical success rate (less reliable → spawn wider)
 *   - affordability   : how many more spawns the remaining token budget covers
 *
 * Distinct from recovery-budget.ts: that derives ERROR-RECOVERY retries (a failed
 * step re-run); this derives the SPAWN fan-out width (how many units run in
 * parallel). The author's intent is a DOWNWARD CAP applied by the caller
 * (min(N, this)); this function's job is only the situation-derived bound, floored
 * at 1 (always at least one unit). The coefficients are a derivation, not the
 * answer; the *output* responds to the inputs (proven by spawn-budget.test.ts).
 * Do not collapse this to a literal — that would re-introduce a frozen MAX_SPAWNS
 * (the exact J16 anti-pattern).
 */

export interface SpawnBudgetSignals {
  /** Count of required typed fields this step must populate (wider → more units). */
  requiredFieldCount?: number;
  /** Whether a skill backs this step (a skill-backed step earns one extra unit). */
  skillInvoked?: boolean;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
  /** Remaining dispatch/token allowance for the run, if a caller threads one. */
  remainingTokenBudget?: number;
  /** Observed/estimated tokens for one spawn of this step, if known. */
  estStepTokens?: number;
}

/** Clamp a value into the [0,1] interval. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Spawn-fan-out width = max(1, derived), clamped DOWN by affordability. Rises with
 * the required-field surface, gains one unit when a skill is invoked, widens as
 * fitness falls (a shaky recipe spawns wider), and never drops below 1 (always one
 * unit). With no budget threaded the affordability clamp is inert
 * (POSITIVE_INFINITY) — the same documented "structurally-derived-but-inert until
 * wired" gap as recovery-budget.
 */
export function deriveSpawnBudget(signals: SpawnBudgetSignals): number {
  // base ambition scales with the typed surface (capped) and a skill bonus.
  const base =
    1 +
    Math.min(3, Math.floor((signals.requiredFieldCount ?? 0) / 2)) +
    (signals.skillInvoked ? 1 : 0);

  // confidence: a shaky recipe (low success rate) spawns wider coverage.
  const uncertainty = 1 - clamp01(signals.fitnessSuccessRate ?? 0.5); // [0,1]
  const derivedUnits = base * (0.5 + uncertainty);

  // affordability clamp: never plan more spawns than the budget can pay for.
  const affordable =
    signals.remainingTokenBudget != null && signals.estStepTokens && signals.estStepTokens > 0
      ? Math.floor(signals.remainingTokenBudget / signals.estStepTokens)
      : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(Math.round(derivedUnits), affordable));
}
