/**
 * ENGRAM — Recipe evolution operator (Upgrade 1, Darwin-Gödel).
 *
 * Given a recipe's current fitness + its history, emit MUTATION PROPOSALS.
 *
 * "Darwin" = mutate + select + archive (the archive keeps variants; selection
 * lives in recipe-archive.rank()). "Gödel" = each variant carries self-describing
 * metadata (difficulty) so selection can be task-difficulty-aware.
 *
 * CRITICAL: proposals are HUMAN-GATED. This module never rewrites a recipe and
 * never applies a mutation. Recipe execution + the kit files are owned by the
 * Prefrontal extension; the Cerebellum only proposes, via a daily manifest, for
 * human review (paper §7.1, self-reinforcing-error-spiral risk).
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 1).
 */

import type { RecipeFitness } from "./recipe-fitness.js";

export type MutationOp =
  | "add_step"
  | "remove_step"
  | "reorder"
  | "tighten_criteria"
  | "loosen_criteria";

export interface MutationProposal {
  recipeId: string;
  baseVersion: number;
  op: MutationOp;
  /** Step text / new ordering / criteria delta — opaque to the Cerebellum. */
  payload: Record<string, unknown>;
  /** Which fitness signal triggered this proposal. */
  rationale: string;
  expectedDelta: { successRate?: number; latencyMs?: number };
  /** Always true for J5 — every procedural mutation is human-gated. */
  needsHumanReview: true;
}

export interface RecipeEvolutionConfig {
  /** Success-rate floor below which corrective mutations are proposed. Default 0.5. */
  successFloor: number;
  /** Minimum runs before any proposal is allowed (avoid low-n noise). Default 3. */
  minRuns: number;
  /** Relative latency regression (current vs window mean) to act on. Default 0.25. */
  latencyRegressionRatio: number;
}

export const DEFAULT_RECIPE_EVOLUTION_CONFIG: RecipeEvolutionConfig = {
  successFloor: 0.5,
  minRuns: 3,
  latencyRegressionRatio: 0.25,
};

/**
 * Propose mutations for a recipe from its current fitness + history.
 *
 * Triggers:
 *   - successRate < floor AND runs >= minRuns
 *       → add_step (a verification/guard step) + tighten_criteria.
 *   - latency regressing vs the historical window mean (>ratio)
 *       → remove_step / reorder.
 *   - high success rate → no proposals (selection handles preference).
 */
export function proposeMutations(
  fitness: RecipeFitness,
  history: RecipeFitness[] = [],
  config: Partial<RecipeEvolutionConfig> = {},
): MutationProposal[] {
  const cfg = { ...DEFAULT_RECIPE_EVOLUTION_CONFIG, ...config };
  const proposals: MutationProposal[] = [];

  if (fitness.runs < cfg.minRuns) {
    return proposals;
  }

  // 1. Low success rate → corrective mutations.
  if (fitness.successRate < cfg.successFloor) {
    proposals.push({
      recipeId: fitness.recipeId,
      baseVersion: fitness.version,
      op: "tighten_criteria",
      payload: { note: "tighten success criteria to fail fast on the common failure mode" },
      rationale: `successRate ${fitness.successRate.toFixed(2)} < floor ${cfg.successFloor} over ${fitness.runs} runs`,
      expectedDelta: { successRate: 0.1 },
      needsHumanReview: true,
    });
    proposals.push({
      recipeId: fitness.recipeId,
      baseVersion: fitness.version,
      op: "add_step",
      payload: { note: "add a verification/guard step before the failing action" },
      rationale: `successRate ${fitness.successRate.toFixed(2)} < floor ${cfg.successFloor} over ${fitness.runs} runs`,
      expectedDelta: { successRate: 0.15 },
      needsHumanReview: true,
    });
  }

  // 2. Latency regression vs window mean → trim/reorder.
  if (history.length >= 2) {
    const prior = history.slice(0, -1);
    const windowMean = prior.reduce((s, f) => s + f.avgLatencyMs, 0) / Math.max(1, prior.length);
    if (windowMean > 0 && fitness.avgLatencyMs > windowMean * (1 + cfg.latencyRegressionRatio)) {
      proposals.push({
        recipeId: fitness.recipeId,
        baseVersion: fitness.version,
        op: "remove_step",
        payload: { note: "remove a redundant step to recover latency" },
        rationale: `avgLatencyMs ${Math.round(fitness.avgLatencyMs)} regressed >${Math.round(
          cfg.latencyRegressionRatio * 100,
        )}% over window mean ${Math.round(windowMean)}`,
        expectedDelta: { latencyMs: -(fitness.avgLatencyMs - windowMean) },
        needsHumanReview: true,
      });
    }
  }

  return proposals;
}
