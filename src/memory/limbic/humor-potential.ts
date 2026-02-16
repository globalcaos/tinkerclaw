/**
 * LIMBIC Phase 6A: Humor Potential Function h_v2.
 *
 * h_v2(A, B, β) = d(A,B) · v(β,A,B) · σ(β|A,B)
 *
 * Where:
 *   d(A,B) = cosine distance between concept embeddings A, B
 *   v(β,A,B) = min(cos(β,A), cos(β,B)) — bridge validity
 *   σ(β|A,B) = reciprocal-rank surprise of β in k-NN around midpoint(A,B)
 *
 * Implements LIMBIC §3, §7.1.1.
 */

import { LIMBIC_CONFIG } from "./config.js";
import { cosineDistance, cosineSimilarity, vectorMean } from "./vector-math.js";

// ---------------------------------------------------------------------------
// ANN Index interface — consumers provide their own implementation
// ---------------------------------------------------------------------------

export interface AnnIndex {
	/** Return the k nearest neighbor IDs for a query vector. */
	query(vector: number[], k: number): Array<{ id: string; vector: number[] }>;
	/** Get the stored ID for a given vector (exact match). */
	getId(vector: number[]): string | undefined;
}

// ---------------------------------------------------------------------------
// Surprise function
// ---------------------------------------------------------------------------

/**
 * Compute bridge surprise: how unexpected is β as a bridge between A and B?
 * Uses reciprocal rank in the k-NN neighborhood of midpoint(A,B).
 * If β is not found in top-k, returns 1.0 (maximally surprising).
 */
export function bridgeSurprise(
	bridge: number[],
	A: number[],
	B: number[],
	index: AnnIndex,
	k: number = LIMBIC_CONFIG.bridge.surpriseK,
): number {
	const midpoint = vectorMean(A, B);
	const neighbors = index.query(midpoint, k);
	const bridgeId = index.getId(bridge);

	for (let rank = 0; rank < neighbors.length; rank++) {
		if (neighbors[rank].id === bridgeId) {
			return rank / k;
		}
	}
	return 1.0; // not in top-k → maximally surprising
}

// ---------------------------------------------------------------------------
// Humor potential h_v2
// ---------------------------------------------------------------------------

/**
 * Compute the humor potential score h_v2 for a triplet (A, B, bridge).
 *
 * h_v2 = d(A,B) × v(β,A,B) × σ(β|A,B)
 */
export function humorPotentialV2(
	A: number[],
	B: number[],
	bridge: number[],
	index: AnnIndex,
): number {
	const dist = cosineDistance(A, B);
	const validity = bridgeValidity(bridge, A, B);
	const surprise = bridgeSurprise(bridge, A, B, index);
	return dist * validity * surprise;
}

/**
 * Bridge validity: min(cos(β,A), cos(β,B)).
 * Measures how well the bridge connects to both concepts.
 */
export function bridgeValidity(bridge: number[], A: number[], B: number[]): number {
	return Math.min(cosineSimilarity(bridge, A), cosineSimilarity(bridge, B));
}

/**
 * Check whether a triplet falls within the humor zone.
 */
export function isInHumorZone(dist: number, validity: number, surprise: number): boolean {
	const { distanceMin, distanceMax, validityThreshold, surpriseThreshold } = LIMBIC_CONFIG.humorZone;
	return (
		dist >= distanceMin && dist <= distanceMax && validity >= validityThreshold && surprise >= surpriseThreshold
	);
}
