/**
 * ENGRAM — Recipe evolution operator (Upgrade 1, Darwin-Gödel).
 *
 * Given a recipe's current fitness + its history, emit MUTATION PROPOSALS.
 *
 * "Darwin" = mutate + select + archive (the archive keeps variants; selection
 * lives in recipe-archive.rank()). "Gödel" = each variant carries self-describing
 * metadata (difficulty) so selection can be task-difficulty-aware.
 *
 * AUTONOMY-FIRST GATE (2026-05-31): proposals are HUMAN-GATED by default, but a
 * high-confidence + well-evidenced + reversible proposal is flagged
 * `autoPromotable:true` and its `needsHumanReview` drops to false. This is a
 * SAFE, BOUNDED autonomy win because EVERY recipe mutation is reversible — the
 * never-delete archive (recipe-archive.ts) keeps every prior variant, so an
 * auto-promoted mutation can always be rolled back. The conditions are
 * deliberately strict (success rate FAR below the floor, runs well past the
 * proposal minimum) so only the clearest corrective wins auto-promote.
 *
 * This module still never rewrites a recipe and never applies a mutation. The
 * actual recipe WRITE/apply (turning an autoPromotable proposal into an edit of
 * a Prefrontal kit file) lives in the Prefrontal kit layer — a cross-subsystem
 * step that is explicitly out of scope here. The Cerebellum only proposes + flags.
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
  /**
   * True when the proposal is high-confidence + well-evidenced + reversible and
   * may be applied WITHOUT human review (autonomy-first). When true,
   * `needsHumanReview` is false. See {@link isAutoPromotable}.
   */
  autoPromotable: boolean;
  /**
   * Whether this proposal must pass human review before being applied.
   * Default-gated (true); drops to false only when `autoPromotable` is true.
   */
  needsHumanReview: boolean;
}

export interface RecipeEvolutionConfig {
  /** Success-rate floor below which corrective mutations are proposed. Default 0.5. */
  successFloor: number;
  /** Minimum runs before any proposal is allowed (avoid low-n noise). Default 3. */
  minRuns: number;
  /** Relative latency regression (current vs window mean) to act on. Default 0.25. */
  latencyRegressionRatio: number;
  /**
   * Minimum runs before a proposal may be auto-promoted (skip human review).
   * Must be > minRuns so auto-promote requires stronger evidence than a mere
   * proposal. Default 8.
   */
  autoMinRuns: number;
  /**
   * Multiplier on `successFloor` defining "FAR below the floor". A proposal is
   * only auto-promotable when successRate <= successFloor * autoFloorRatio.
   * Default 0.5 (half the floor).
   */
  autoFloorRatio: number;
}

/** Default runs threshold for auto-promotion (stricter than minRuns). */
export const AUTO_MIN_RUNS = 8;

export const DEFAULT_RECIPE_EVOLUTION_CONFIG: RecipeEvolutionConfig = {
  successFloor: 0.5,
  minRuns: 3,
  latencyRegressionRatio: 0.25,
  autoMinRuns: AUTO_MIN_RUNS,
  autoFloorRatio: 0.5,
};

/**
 * Decide whether a corrective proposal for this fitness is auto-promotable
 * (may skip human review). AUTONOMY-FIRST, but bounded:
 *   1. HIGH-CONFIDENCE: successRate is FAR below the floor
 *      (<= successFloor * autoFloorRatio), not merely under it.
 *   2. WELL-EVIDENCED: runs >= autoMinRuns (> the minRuns proposal threshold),
 *      so the low success rate is not low-n noise.
 *   3. REVERSIBLE: always true — the never-delete archive keeps every prior
 *      variant, so any auto-applied mutation can be rolled back.
 *
 * Only corrective (low-success-rate-driven) proposals are eligible; efficiency
 * proposals (latency regression) are not auto-promotable here.
 */
export function isAutoPromotable(fitness: RecipeFitness, cfg: RecipeEvolutionConfig): boolean {
  const reversible = true; // never-delete archive ⇒ every mutation is reversible
  const highConfidence = fitness.successRate <= cfg.successFloor * cfg.autoFloorRatio;
  const wellEvidenced = fitness.runs >= cfg.autoMinRuns;
  return reversible && highConfidence && wellEvidenced;
}

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
  //    These are eligible for auto-promotion when the success rate is FAR below
  //    the floor AND the run count is well past the proposal minimum. Every
  //    mutation is reversible (never-delete archive), so this is bounded autonomy.
  if (fitness.successRate < cfg.successFloor) {
    const autoPromotable = isAutoPromotable(fitness, cfg);
    const needsHumanReview = !autoPromotable;
    const autoNote = autoPromotable
      ? ` [auto-promotable: rate far below floor over ${fitness.runs} >= ${cfg.autoMinRuns} runs; reversible via archive]`
      : "";
    proposals.push({
      recipeId: fitness.recipeId,
      baseVersion: fitness.version,
      op: "tighten_criteria",
      payload: { note: "tighten success criteria to fail fast on the common failure mode" },
      rationale: `successRate ${fitness.successRate.toFixed(2)} < floor ${cfg.successFloor} over ${fitness.runs} runs${autoNote}`,
      expectedDelta: { successRate: 0.1 },
      autoPromotable,
      needsHumanReview,
    });
    proposals.push({
      recipeId: fitness.recipeId,
      baseVersion: fitness.version,
      op: "add_step",
      payload: { note: "add a verification/guard step before the failing action" },
      rationale: `successRate ${fitness.successRate.toFixed(2)} < floor ${cfg.successFloor} over ${fitness.runs} runs${autoNote}`,
      expectedDelta: { successRate: 0.15 },
      autoPromotable,
      needsHumanReview,
    });
  }

  // 2. Latency regression vs window mean → trim/reorder.
  //    Efficiency proposals stay human-gated — they are not the high-confidence
  //    correctness win the autonomy gate targets.
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
        autoPromotable: false,
        needsHumanReview: true,
      });
    }
  }

  return proposals;
}
