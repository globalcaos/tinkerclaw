/**
 * LIMBIC Phase 6E: Humor Associations in Memory.
 *
 * - HumorAssociation schema stored as ENGRAM events (kind: "humor_association")
 * - Callback bonus for successfully landed humor
 * - Running gag detection
 * - Staleness model
 */

import { LIMBIC_CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Schema (LIMBIC §8.3)
// ---------------------------------------------------------------------------

export interface HumorAssociation {
	conceptA: string;
	conceptB: string;
	bridge: string;
	patternType: number; // 1-12
	surpriseScore: number;
	humorConfidence: number; // landed / attempts
	audience: string; // user ID or "general"
	contextTags: string[];
	timesUsed: number;
	lastUsed: string; // ISO 8601
	discoveredVia: "conversation" | "generated" | "observed";
	/** Tracks individual attempts: true = positive reaction, false = negative/neutral */
	outcomes: boolean[];
}

// ---------------------------------------------------------------------------
// Staleness model
// ---------------------------------------------------------------------------

/**
 * Compute staleness factor for a humor association.
 *
 * Staleness increases with use (λ per use) and decreases with time (μ per hour).
 * s(n, Δt) = max(0, λ·n - μ·Δt)
 *
 * Returns 0 (fresh) to 1 (stale). Values > 1 are clamped.
 */
export function computeStaleness(timesUsed: number, hoursSinceLastUse: number): number {
	const { lambda, mu } = LIMBIC_CONFIG.staleness;
	const raw = lambda * timesUsed - mu * hoursSinceLastUse;
	return Math.max(0, Math.min(1, raw));
}

// ---------------------------------------------------------------------------
// Callback bonus
// ---------------------------------------------------------------------------

/**
 * Compute callback bonus for a humor association.
 * Successful humor gets a retrieval boost that decays over time.
 *
 * bonus = confidence × (1 - staleness) × timeDecay
 */
export function computeCallbackBonus(association: HumorAssociation, nowMs: number): number {
	const lastUsedMs = new Date(association.lastUsed).getTime();
	const hoursSinceUse = (nowMs - lastUsedMs) / (1000 * 60 * 60);

	const staleness = computeStaleness(association.timesUsed, hoursSinceUse);

	// Time decay with floor
	const { decayOnsetHours, floorHours, floorValue } = LIMBIC_CONFIG.callback;
	let timeDecay = 1.0;
	if (hoursSinceUse > decayOnsetHours) {
		const decayProgress = Math.min((hoursSinceUse - decayOnsetHours) / (floorHours - decayOnsetHours), 1.0);
		timeDecay = 1.0 - decayProgress * (1.0 - floorValue);
	}

	return association.humorConfidence * (1 - staleness) * timeDecay;
}

// ---------------------------------------------------------------------------
// Running gag detection
// ---------------------------------------------------------------------------

/**
 * Detect running gags: associations used ≥ threshold times with high confidence.
 */
export function detectRunningGags(
	associations: HumorAssociation[],
	minUses = 3,
	minConfidence = 0.6,
): HumorAssociation[] {
	return associations.filter(
		(a) => a.timesUsed >= minUses && a.humorConfidence >= minConfidence,
	);
}

/**
 * Check if a concept pair matches any existing running gag.
 */
export function matchRunningGag(
	conceptA: string,
	conceptB: string,
	gags: HumorAssociation[],
): HumorAssociation | undefined {
	const aLower = conceptA.toLowerCase();
	const bLower = conceptB.toLowerCase();
	return gags.find(
		(g) =>
			(g.conceptA.toLowerCase() === aLower && g.conceptB.toLowerCase() === bLower) ||
			(g.conceptA.toLowerCase() === bLower && g.conceptB.toLowerCase() === aLower),
	);
}

// ---------------------------------------------------------------------------
// Association management
// ---------------------------------------------------------------------------

/**
 * Create a new humor association.
 */
export function createAssociation(params: {
	conceptA: string;
	conceptB: string;
	bridge: string;
	patternType: number;
	surpriseScore: number;
	audience: string;
	contextTags?: string[];
	discoveredVia: HumorAssociation["discoveredVia"];
}): HumorAssociation {
	return {
		...params,
		contextTags: params.contextTags ?? [],
		humorConfidence: 0,
		timesUsed: 0,
		lastUsed: new Date().toISOString(),
		outcomes: [],
	};
}

/**
 * Record the outcome of a humor attempt using this association.
 */
export function recordOutcome(association: HumorAssociation, positive: boolean): HumorAssociation {
	const outcomes = [...association.outcomes, positive];
	const landed = outcomes.filter(Boolean).length;
	return {
		...association,
		outcomes,
		timesUsed: association.timesUsed + 1,
		humorConfidence: landed / outcomes.length,
		lastUsed: new Date().toISOString(),
	};
}

/**
 * Serialize a HumorAssociation for storage as an ENGRAM event content string.
 */
export function serializeAssociation(association: HumorAssociation): string {
	return JSON.stringify(association);
}

/**
 * Deserialize a HumorAssociation from an ENGRAM event content string.
 */
export function deserializeAssociation(content: string): HumorAssociation {
	return JSON.parse(content) as HumorAssociation;
}
