/**
 * LIMBIC Phase 6C: Bridge Discovery Pipeline.
 *
 * Cascading pipeline (LIMBIC §6.7):
 * 1. Midpoint search (embedding arithmetic) — fast
 * 2. Analogy completion — fast
 * 3. Conceptual blending — fast
 * 4. Graph traversal (placeholder) — medium
 * 5. LLM-guided generate-then-score — slow fallback
 *
 * Quality filter: q(β,A,B) = v(β,A,B) · σ(β|A,B) > q_min
 */

import { LIMBIC_CONFIG } from "./config.js";
import { bridgeSurprise, bridgeValidity, type AnnIndex } from "./humor-potential.js";
import { cosineSimilarity, cosineDistance, vectorMean, vectorSub, vectorAdd, normalize } from "./vector-math.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeCandidate {
	id: string;
	vector: number[];
	method: BridgeMethod;
	quality: number; // v × σ
}

export type BridgeMethod = "midpoint" | "analogy" | "blending" | "graph_traversal" | "llm_guided";

export type LlmBridgeGenerator = (conceptA: string, conceptB: string, count: number) => Promise<Array<{ label: string; embedding: number[] }>>;

// ---------------------------------------------------------------------------
// Individual discovery methods
// ---------------------------------------------------------------------------

/**
 * Method 1: Midpoint search — find concepts near the midpoint of A and B.
 */
export function midpointSearch(A: number[], B: number[], index: AnnIndex, topN = 10): BridgeCandidate[] {
	const mid = vectorMean(A, B);
	const neighbors = index.query(mid, topN);
	return neighbors.map((n) => ({
		id: n.id,
		vector: n.vector,
		method: "midpoint" as const,
		quality: 0, // computed later
	}));
}

/**
 * Method 2: Analogy completion — A is to X as B is to ? (vector arithmetic).
 * Finds bridges by computing A - mean(A,B) + B and searching near that.
 */
export function analogySearch(A: number[], B: number[], index: AnnIndex, topN = 10): BridgeCandidate[] {
	// Analogy: find concept that relates to A the way B's context suggests
	const offset = vectorSub(A, B);
	const target = normalize(vectorAdd(B, offset.map((v) => v * 0.5)));
	const neighbors = index.query(target, topN);
	return neighbors.map((n) => ({
		id: n.id,
		vector: n.vector,
		method: "analogy" as const,
		quality: 0,
	}));
}

/**
 * Method 3: Conceptual blending — search orthogonal to the A-B axis.
 * Finds equidistant concepts that are off the direct line between A and B.
 */
export function blendingSearch(A: number[], B: number[], index: AnnIndex, topN = 10): BridgeCandidate[] {
	const mid = vectorMean(A, B);
	// Perturb midpoint slightly to get off-axis results
	const perturbations: BridgeCandidate[] = [];
	const axis = vectorSub(A, B);
	const axisNorm = normalize(axis);

	// Create orthogonal perturbation by zeroing out axis component from mid
	const projection = axisNorm.map((v) => v * axisNorm.reduce((s, x, i) => s + x * mid[i], 0));
	const orthogonal = normalize(vectorSub(mid, projection));

	// Search near the orthogonal direction from midpoint
	const searchPoint = normalize(vectorAdd(mid, orthogonal.map((v) => v * 0.3)));
	const neighbors = index.query(searchPoint, topN);
	for (const n of neighbors) {
		perturbations.push({
			id: n.id,
			vector: n.vector,
			method: "blending" as const,
			quality: 0,
		});
	}
	return perturbations;
}

/**
 * Method 4: Graph traversal (placeholder).
 * In a full implementation, this would walk a concept graph.
 * Currently returns empty — acts as a no-op in the cascade.
 */
export function graphTraversalSearch(
	_A: number[],
	_B: number[],
	_index: AnnIndex,
	_topN = 10,
): BridgeCandidate[] {
	// Placeholder: real implementation would use a concept graph (e.g., ConceptNet)
	return [];
}

/**
 * Method 5: LLM-guided generate-then-score.
 * Asks an LLM to generate bridge candidates, then scores them with h_v2 components.
 */
export async function llmGuidedSearch(
	A: number[],
	B: number[],
	labelA: string,
	labelB: string,
	index: AnnIndex,
	generator: LlmBridgeGenerator,
	count: number = LIMBIC_CONFIG.bridge.candidateCount,
): Promise<BridgeCandidate[]> {
	const candidates = await generator(labelA, labelB, count);
	return candidates.map((c) => ({
		id: c.label,
		vector: c.embedding,
		method: "llm_guided" as const,
		quality: 0,
	}));
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

function scoreCandidates(candidates: BridgeCandidate[], A: number[], B: number[], index: AnnIndex): BridgeCandidate[] {
	return candidates.map((c) => {
		const v = bridgeValidity(c.vector, A, B);
		const s = bridgeSurprise(c.vector, A, B, index);
		return { ...c, quality: v * s };
	});
}

// ---------------------------------------------------------------------------
// Cascading pipeline
// ---------------------------------------------------------------------------

export interface BridgeDiscoveryOptions {
	labelA?: string;
	labelB?: string;
	llmGenerator?: LlmBridgeGenerator;
	minQuality?: number;
	maxResults?: number;
}

/**
 * Run the full bridge discovery cascade.
 * Fast methods first; LLM fallback only if quality threshold not met.
 */
export async function discoverBridges(
	A: number[],
	B: number[],
	index: AnnIndex,
	options: BridgeDiscoveryOptions = {},
): Promise<BridgeCandidate[]> {
	const minQ = options.minQuality ?? LIMBIC_CONFIG.bridge.minBridgeQuality;
	const maxResults = options.maxResults ?? 5;

	// Phase 1-3: Fast methods (embedding arithmetic)
	let candidates: BridgeCandidate[] = [
		...midpointSearch(A, B, index),
		...analogySearch(A, B, index),
		...blendingSearch(A, B, index),
		...graphTraversalSearch(A, B, index),
	];

	// Deduplicate by ID
	const seen = new Set<string>();
	candidates = candidates.filter((c) => {
		if (seen.has(c.id)) return false;
		seen.add(c.id);
		return true;
	});

	// Score
	candidates = scoreCandidates(candidates, A, B, index);

	// Filter by quality
	let qualified = candidates.filter((c) => c.quality >= minQ);

	// Phase 5: LLM fallback if insufficient quality bridges
	if (qualified.length === 0 && options.llmGenerator && options.labelA && options.labelB) {
		const llmCandidates = await llmGuidedSearch(
			A, B, options.labelA, options.labelB, index, options.llmGenerator,
		);
		const scored = scoreCandidates(llmCandidates, A, B, index);
		qualified = scored.filter((c) => c.quality >= minQ);
	}

	// Sort by quality descending, return top N
	return qualified.sort((a, b) => b.quality - a.quality).slice(0, maxResults);
}
