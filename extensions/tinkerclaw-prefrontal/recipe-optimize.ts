/**
 * SS4 (2026-06-06): the self-sharpening orchestrator.
 *
 * Reads a recipe's LIVE plan archive (PlanStore.close() → archive/<date>/*.md),
 * aggregates per-step struggle (step-struggle.readStepStruggle), proposes a
 * `rewrite_step_text` mutation per struggling step (recipe-evolution.proposeStepRewrites),
 * and — ONLY when RECIPE_AUTOAPPLY_ENABLED is set — applies each via the
 * snapshot-reversible, authorship-guarded, validate-or-skip recipe-apply path
 * (recipe-apply.applyMutationProposal). By DEFAULT it PROPOSES and applies nothing.
 *
 * Re-measure: a later optimizeRecipe pass re-runs readStepStruggle over the NEWER
 * archives; the per-step failureRate delta is the improvement signal (the caller
 * diffs struggleBefore against a subsequent run). NOT the inert fitness store.
 *
 * Pure orchestration: all I/O (archive read, apply, env) is injected for testability.
 */

import type { Plan } from "openclaw/plugin-sdk/fork-prefrontal-schema";
import type { MutationProposal } from "openclaw/plugin-sdk/fork-recipe-engine";
import { proposeStepRewrites } from "openclaw/plugin-sdk/fork-recipe-engine";
import type { ApplyProposalInput, ApplyResult } from "./recipe-apply.js";
import { isApplyEnabled } from "./recipe-apply.js";
import { readStepStruggle, type StruggleReport } from "./step-struggle.js";

export interface OptimizeDeps {
  /** Load + parse this recipe's archived plans (the live struggle signal). */
  readArchivedPlans: (kitRef: string) => Promise<Plan[]>;
  /** The recipe's current version number (for MutationProposal.baseVersion). Default 1. */
  baseVersion?: number;
  /** Apply one proposal via the recipe-apply 5-rail path. Injected for testability. */
  applyProposal: (input: ApplyProposalInput) => Promise<ApplyResult>;
  /** Env for the kill-switch (RECIPE_AUTOAPPLY_ENABLED). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface OptimizeResult {
  kitRef: string;
  /** The struggle report measured BEFORE any rewrite (the re-measure baseline). */
  struggleBefore: StruggleReport;
  /** Every rewrite_step_text proposal emitted (always, even when not applied). */
  proposed: MutationProposal[];
  /** The proposals actually applied (empty unless RECIPE_AUTOAPPLY_ENABLED). */
  applied: ApplyResult[];
  /** Archive paths produced by applied rewrites (the rollback net). */
  snapshots: string[];
}

/** Map a MutationProposal (engram) to the recipe-apply ApplyProposalInput. */
function toApplyInput(p: MutationProposal): ApplyProposalInput {
  const payload = p.payload as {
    stepIndex?: number;
    stepTitle?: string;
    dominantKind?: string;
    failureRate?: number;
  };
  return {
    recipeId: p.recipeId,
    op: p.op,
    intent: p.rationale,
    rationale: p.rationale,
    payload: {
      stepIndex: payload.stepIndex,
      stepTitle: payload.stepTitle,
      dominantKind: payload.dominantKind,
      failureRate: payload.failureRate,
    },
  };
}

/**
 * Orchestrate one optimize pass for a recipe. Idempotent + reversible. Returns the
 * before-report + every proposal + the applied results. Applies nothing unless the
 * kill-switch is on (proposes-only by default).
 */
export async function optimizeRecipe(kitRef: string, deps: OptimizeDeps): Promise<OptimizeResult> {
  const plans = await deps.readArchivedPlans(kitRef);
  const struggleBefore = readStepStruggle(kitRef, plans);

  const proposed = proposeStepRewrites({
    kitRef,
    baseVersion: deps.baseVersion ?? 1,
    struggling: struggleBefore.strugglingStepIndexes.map((idx) => {
      const s = struggleBefore.steps.find((x) => x.stepIndex === idx)!;
      return {
        stepIndex: s.stepIndex,
        title: s.title,
        dominantKind: s.dominantKind,
        failureRate: s.failureRate,
        runs: s.runs,
        failures: s.failures,
      };
    }),
  });

  const applied: ApplyResult[] = [];
  const snapshots: string[] = [];
  if (isApplyEnabled(deps.env ?? process.env)) {
    for (const p of proposed) {
      const r = await deps.applyProposal(toApplyInput(p));
      applied.push(r);
      if (r.archivePath) snapshots.push(r.archivePath);
    }
  }

  return { kitRef, struggleBefore, proposed, applied, snapshots };
}
