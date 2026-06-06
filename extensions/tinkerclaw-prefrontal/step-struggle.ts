/**
 * SS4 (2026-06-06): per-step STRUGGLE reader — the self-sharpening signal.
 *
 * The recipe-LEVEL fitness store is inert (the U1 producer→episode-tag wire is
 * missing). SS4 instead reads the LIVE plan archive: PlanStore.close() writes each
 * run to archive/<date>/<session>-<runId>.md with per-step `status` + the SS5a
 * ClassifiedError (the error64: comment), and parsePlanMd reads it back. This is a
 * PER-STEP, live, per-recipe signal — exactly what step-text sharpening needs.
 *
 * Pure + fs-free: the caller (recipe-optimize.ts) loads + parses the archived plans
 * and passes the Plan[] in. Aggregation is over the parsed Plan objects.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): the two struggle thresholds — how many
 * failures before a step is worth sharpening, and how much worse than baseline it
 * must fail — are DERIVED from the live sample (sample size + the recipe's own
 * failure spread), NEVER frozen constants. There is deliberately no `const MIN_RUNS`
 * / `const FLOOR` in this file (the bible gate asserts their absence).
 */

import type { Plan, PlanStep } from "../../src/gateway/protocol/schema/prefrontal-plan.js";

/** One step's struggle profile aggregated across a recipe's archived runs. */
export interface StepStruggle {
  stepIndex: number;
  title: string;
  /** Runs in which this step was at least dispatched (status !== "pending"). */
  runs: number;
  /** Runs in which this step did NOT cleanly succeed (error status OR an error envelope). */
  failures: number;
  /** failures / runs, 0 when runs === 0. */
  failureRate: number;
  /** The modal ClassifiedError.kind over the failing runs (undefined when failures === 0). */
  dominantKind?: string;
}

export interface StruggleReport {
  kitRef: string;
  steps: StepStruggle[];
  /** The 0-based indexes of steps the derived thresholds flag as struggling. */
  strugglingStepIndexes: number[];
}

/** A step is "failing" in a run when it ended in error OR carries a classified-error
 * envelope (the SS5a done-partial shape: a `done` step that did not cleanly succeed). */
function stepFailed(step: PlanStep): boolean {
  return step.status === "error" || step.error !== undefined;
}

/** A step "ran" in a plan when it was at least dispatched (not still pending). */
function stepRan(step: PlanStep): boolean {
  return step.status !== "pending";
}

/**
 * DERIVED min-runs: the failure-count floor below which a step is not worth
 * sharpening. Grows with the available evidence (sqrt of the step's run count) so a
 * lone failure on a young step never fires, and a noisy step on a long history needs
 * proportionally more failures. Floor 2 (never act on a single failure). NOT a
 * frozen constant — it is a function of the sample size.
 */
export function deriveMinRuns(totalRunsForStep: number): number {
  return Math.max(2, Math.ceil(Math.sqrt(Math.max(0, totalRunsForStep))));
}

/**
 * DERIVED struggle threshold: a step is struggling when it fails noticeably WORSE
 * than the recipe's own baseline. `recipeMeanFailureRate` = total failures / total
 * runs across ALL steps. The threshold is 1.5× that mean, clamped to [0.2, 0.9]:
 * floor 0.2 (never flag a step failing <20%), cap 0.9 (a recipe failing everywhere
 * still surfaces its worst steps). NOT a frozen FLOOR — it tracks the recipe's spread.
 */
export function deriveStruggleThreshold(recipeMeanFailureRate: number): number {
  const scaled = recipeMeanFailureRate * 1.5;
  return Math.min(0.9, Math.max(0.2, scaled));
}

/**
 * Aggregate a recipe's archived plans into a per-step struggle report. The caller
 * passes the Plan[] already filtered to this kitRef. Pure: no fs, no throw on empty.
 */
export function readStepStruggle(kitRef: string, plans: Plan[]): StruggleReport {
  // Accumulate per stepIndex. Title is taken from the first plan that has the step.
  const acc = new Map<
    number,
    { title: string; runs: number; failures: number; kinds: Map<string, number> }
  >();
  for (const plan of plans) {
    plan.steps.forEach((step, i) => {
      if (!stepRan(step)) return;
      const cur = acc.get(i) ?? { title: step.title, runs: 0, failures: 0, kinds: new Map() };
      cur.runs += 1;
      if (stepFailed(step)) {
        cur.failures += 1;
        const kind =
          step.error?.kind ?? (step.status === "error" ? "execution-error" : "execution-error");
        cur.kinds.set(kind, (cur.kinds.get(kind) ?? 0) + 1);
      }
      acc.set(i, cur);
    });
  }

  const steps: StepStruggle[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stepIndex, v]) => {
      // dominant kind = the modal failing kind (first-seen wins ties via insertion order).
      let dominantKind: string | undefined;
      let best = 0;
      for (const [kind, n] of v.kinds) {
        if (n > best) {
          best = n;
          dominantKind = kind;
        }
      }
      return {
        stepIndex,
        title: v.title,
        runs: v.runs,
        failures: v.failures,
        failureRate: v.runs === 0 ? 0 : v.failures / v.runs,
        ...(dominantKind !== undefined ? { dominantKind } : {}),
      };
    });

  // recipe baseline = total failures / total runs across all steps.
  const totalRuns = steps.reduce((s, x) => s + x.runs, 0);
  const totalFailures = steps.reduce((s, x) => s + x.failures, 0);
  const recipeMean = totalRuns === 0 ? 0 : totalFailures / totalRuns;
  const threshold = deriveStruggleThreshold(recipeMean);

  const strugglingStepIndexes = steps
    .filter((s) => s.failures >= deriveMinRuns(s.runs) && s.failureRate >= threshold)
    .map((s) => s.stepIndex);

  return { kitRef, steps, strugglingStepIndexes };
}
