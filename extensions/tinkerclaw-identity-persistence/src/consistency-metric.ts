/**
 * FORK: Persona Consistency Metric & Response (self-contained copy for extension).
 *
 * C = alpha_C * M_unit + (1 - alpha_C) * (1 - Var(M_emb))
 *   where alpha_C = 0.6, M_unit = hard rule compliance, Var(M_emb) = embedding variance
 *
 * Response tiers:
 *   C > 0.85  -> healthy (no action)
 *   C in (0.70, 0.85] -> mild_reinforce
 *   C in (0.50, 0.70] -> moderate_refresh
 *   C <= 0.50  -> severe_rebase
 *
 * Adapted from src/memory/cortex/consistency-metric.ts.
 */

import type { ProbeResult } from "./behavioral-probes.js";
import type { PersonaState } from "./persona-state.js";
import { computeEPhi, ePhiDistance, E_PHI_DIMENSIONS } from "./voice-markers.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const CONSISTENCY_CONFIG = {
  alphaC: 0.6, // weight for hard rule compliance
  healthy: 0.85,
  mild: 0.7,
  moderate: 0.5,
  /** Number of recent responses to use for embedding variance. */
  varianceWindow: 10,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftAction = "none" | "mild_reinforce" | "moderate_refresh" | "severe_rebase";

export interface ConsistencyResult {
  C: number; // consistency metric [0, 1]
  Munit: number; // hard rule compliance [0, 1]
  Memb: number; // embedding variance [0, 1] (0 = consistent, 1 = max variance)
  action: DriftAction;
}

// ---------------------------------------------------------------------------
// Hard rule compliance (M_unit)
// ---------------------------------------------------------------------------

/**
 * Compute M_unit: fraction of hard rules passed across recent probes.
 */
export function computeHardRuleCompliance(probes: ProbeResult[]): number {
  const relevant = probes.filter(
    (p) => p.probeType === "hard_rule" || p.probeType === "full_audit",
  );
  if (relevant.length === 0) {
    return 1.0;
  }

  let totalScore = 0;
  let count = 0;

  for (const probe of relevant) {
    const scores = Object.values(probe.scores);
    if (scores.length > 0) {
      totalScore += scores.reduce((a, b) => a + b, 0) / scores.length;
      count++;
    }
    if (probe.violations.length > 0) {
      totalScore -= probe.violations.length * 0.1;
      totalScore = Math.max(0, totalScore);
    }
  }

  return count > 0 ? Math.min(1, totalScore / count) : 1.0;
}

// ---------------------------------------------------------------------------
// Embedding variance (Var(M_emb))
// ---------------------------------------------------------------------------

/**
 * Compute embedding variance across recent responses relative to persona baseline.
 * Returns value in [0, 1] where 0 = perfectly consistent, 1 = maximum variance.
 */
export function computeEmbeddingVariance(
  recentResponses: string[],
  baselineEPhi?: Float64Array,
): number {
  if (recentResponses.length < 2) {
    return 0;
  }

  const vectors = recentResponses.map((r) => computeEPhi(r));

  if (baselineEPhi && baselineEPhi.length === E_PHI_DIMENSIONS) {
    const distances = vectors.map((v) => ePhiDistance(v, baselineEPhi));
    return populationVariance(distances);
  }

  const centroid = new Float64Array(E_PHI_DIMENSIONS);
  for (const v of vectors) {
    for (let i = 0; i < E_PHI_DIMENSIONS; i++) {
      centroid[i] += v[i];
    }
  }
  for (let i = 0; i < E_PHI_DIMENSIONS; i++) {
    centroid[i] /= vectors.length;
  }

  const distances = vectors.map((v) => ePhiDistance(v, centroid));
  return populationVariance(distances);
}

function populationVariance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Consistency metric
// ---------------------------------------------------------------------------

/**
 * Determine the response action tier from the consistency metric.
 */
export function classifyAction(C: number): DriftAction {
  if (C > CONSISTENCY_CONFIG.healthy) {
    return "none";
  }
  if (C > CONSISTENCY_CONFIG.mild) {
    return "mild_reinforce";
  }
  if (C > CONSISTENCY_CONFIG.moderate) {
    return "moderate_refresh";
  }
  return "severe_rebase";
}

/**
 * Compute the persona consistency metric C and determine the response action.
 *
 * C = alpha_C * M_unit + (1 - alpha_C) * (1 - Var(M_emb))
 */
export function computeConsistency(
  probes: ProbeResult[],
  recentResponses: string[],
  baselineEPhi?: Float64Array,
): ConsistencyResult {
  const Munit = computeHardRuleCompliance(probes);
  const Memb = computeEmbeddingVariance(recentResponses, baselineEPhi);

  const C = CONSISTENCY_CONFIG.alphaC * Munit + (1 - CONSISTENCY_CONFIG.alphaC) * (1 - Memb);
  const clamped = Math.max(0, Math.min(1, C));

  return {
    C: clamped,
    Munit,
    Memb,
    action: classifyAction(clamped),
  };
}

// ---------------------------------------------------------------------------
// Drift response actions
// ---------------------------------------------------------------------------

export interface DriftResponseContext {
  injectSystemMessage: (message: string) => void;
  refreshPersonaState: (ps: PersonaState) => void;
  currentTopic?: string;
}

/**
 * Generate a mild reinforcement message based on the most-violated dimensions.
 */
export function generateReinforcement(persona: PersonaState, violations: string[]): string {
  const lines = [
    `[Persona Reminder: ${persona.name}]`,
    `Identity: ${persona.identityStatement.slice(0, 100)}`,
  ];

  if (violations.length > 0) {
    lines.push(`Pay attention to: ${violations.join(", ")}`);
  }

  const vm = persona.voiceMarkers;
  lines.push(`Voice: ${vm.vocabularyTier}, hedging=${vm.hedgingLevel}, emoji=${vm.emojiUsage}`);

  if (vm.forbiddenPhrases.length > 0) {
    lines.push(`AVOID: ${vm.forbiddenPhrases.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Execute the appropriate drift response action.
 */
export function executeDriftResponse(
  action: DriftAction,
  persona: PersonaState,
  context: DriftResponseContext,
  violations: string[] = [],
): void {
  switch (action) {
    case "none":
      break;
    case "mild_reinforce": {
      const reminder = generateReinforcement(persona, violations);
      context.injectSystemMessage(reminder);
      break;
    }
    case "moderate_refresh":
      context.refreshPersonaState(persona);
      break;
    case "severe_rebase":
      context.refreshPersonaState(persona);
      context.injectSystemMessage(
        `[Persona Rebase] Re-orienting to core identity. ${context.currentTopic ? `Current topic: ${context.currentTopic}` : ""}`,
      );
      break;
  }
}
