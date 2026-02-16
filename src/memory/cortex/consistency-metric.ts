/**
 * CORTEX Phase 5C: Persona Consistency Metric & Response
 *
 * C = α_C * M_unit + (1 - α_C) * (1 - Var(M_emb))
 *   where α_C = 0.6, M_unit = hard rule compliance, Var(M_emb) = embedding variance
 *
 * Response tiers:
 *   C > 0.85  → healthy (no action)
 *   C ∈ (0.70, 0.85] → mild_reinforce
 *   C ∈ (0.50, 0.70] → moderate_refresh
 *   C ≤ 0.50  → severe_rebase
 *
 * Implements CORTEX §5.3.
 */

import type { ProbeResult } from "./behavioral-probes.js";
import { computeEPhi, ePhiDistance, E_PHI_DIMENSIONS } from "./voice-markers.js";
import type { PersonaState } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const CONSISTENCY_CONFIG = {
	alphaC: 0.6, // weight for hard rule compliance
	healthy: 0.85,
	mild: 0.70,
	moderate: 0.50,
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
 * Uses hard_rule and full_audit probe results.
 */
export function computeHardRuleCompliance(probes: ProbeResult[]): number {
	const relevant = probes.filter(
		(p) => p.probeType === "hard_rule" || p.probeType === "full_audit",
	);
	if (relevant.length === 0) return 1.0; // no data → assume compliant

	let totalScore = 0;
	let count = 0;

	for (const probe of relevant) {
		// Use hard_rule_compliance or per-rule scores
		const scores = Object.values(probe.scores);
		if (scores.length > 0) {
			totalScore += scores.reduce((a, b) => a + b, 0) / scores.length;
			count++;
		}
		// Penalize violations
		if (probe.violations.length > 0) {
			totalScore -= probe.violations.length * 0.1;
			// Don't let it go negative
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
 *
 * Uses E_φ vectors (136-dim) and computes variance of distances to the baseline.
 */
export function computeEmbeddingVariance(
	recentResponses: string[],
	baselineEPhi?: Float64Array,
): number {
	if (recentResponses.length < 2) return 0; // insufficient data

	const vectors = recentResponses.map((r) => computeEPhi(r));

	// If we have a baseline, compute distances to it
	if (baselineEPhi && baselineEPhi.length === E_PHI_DIMENSIONS) {
		const distances = vectors.map((v) => ePhiDistance(v, baselineEPhi));
		return variance(distances);
	}

	// Without baseline, compute pairwise variance of distances to mean
	const mean = new Float64Array(E_PHI_DIMENSIONS);
	for (const v of vectors) {
		for (let i = 0; i < E_PHI_DIMENSIONS; i++) mean[i] += v[i];
	}
	for (let i = 0; i < E_PHI_DIMENSIONS; i++) mean[i] /= vectors.length;

	const distances = vectors.map((v) => ePhiDistance(v, mean));
	return variance(distances);
}

function variance(values: number[]): number {
	if (values.length === 0) return 0;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Consistency metric
// ---------------------------------------------------------------------------

/**
 * Determine the response action tier from the consistency metric.
 */
export function classifyAction(C: number): DriftAction {
	if (C > CONSISTENCY_CONFIG.healthy) return "none";
	if (C > CONSISTENCY_CONFIG.mild) return "mild_reinforce";
	if (C > CONSISTENCY_CONFIG.moderate) return "moderate_refresh";
	return "severe_rebase";
}

/**
 * Compute the persona consistency metric C and determine the response action.
 *
 * C = α_C * M_unit + (1 - α_C) * (1 - Var(M_emb))
 *
 * @param probes - Recent probe results
 * @param recentResponses - Recent agent responses (for embedding variance)
 * @param baselineEPhi - Optional baseline E_φ fingerprint
 */
export function computeConsistency(
	probes: ProbeResult[],
	recentResponses: string[],
	baselineEPhi?: Float64Array,
): ConsistencyResult {
	const Munit = computeHardRuleCompliance(probes);
	const Memb = computeEmbeddingVariance(recentResponses, baselineEPhi);

	// C = α_C * M_unit + (1 - α_C) * (1 - Var(M_emb))
	const C =
		CONSISTENCY_CONFIG.alphaC * Munit +
		(1 - CONSISTENCY_CONFIG.alphaC) * (1 - Memb);

	// Clamp to [0, 1]
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
	/** Inject a system message into the next turn's context. */
	injectSystemMessage: (message: string) => void;
	/** Refresh the full PersonaState prefix. */
	refreshPersonaState: (ps: PersonaState) => void;
	/** Current topic for bridging messages. */
	currentTopic?: string;
}

/**
 * Generate a mild reinforcement message based on the most-violated dimensions.
 */
export function generateReinforcement(
	persona: PersonaState,
	violations: string[],
): string {
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
