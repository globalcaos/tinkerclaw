/**
 * LIMBIC Phase 6B: 12-pattern humor taxonomy.
 *
 * 4 meta-categories × 3 patterns each:
 *   Semantic (1-3): Antonymic Inversion, Hyperbolic Extension, Reductio
 *   Pragmatic (4-6): Expectation Subversion, Register Shift, Pragmatic Overload
 *   Structural (7-9): Domain Transfer, Similarity in Dissimilarity, Frame Collision
 *   Temporal (10-12): Callback, Escalation, Bathos
 *
 * Core patterns (1 per meta-category): 1, 4, 7, 8.
 */

import type { AnnIndex } from "./humor-potential.js";
import { cosineDistance, cosineSimilarity, vectorMean, vectorSub, vectorAdd, normalize } from "./vector-math.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationContext {
	/** Recent concept embeddings mentioned in conversation. */
	recentConcepts: Array<{ label: string; embedding: number[] }>;
	/** Current topic embedding. */
	topicEmbedding?: number[];
	/** Register/tone of conversation: casual, formal, technical, etc. */
	register?: string;
	/** Previous humor attempts (for callback detection). */
	previousHumor?: Array<{ conceptA: string; conceptB: string; bridge: string; timestamp: string }>;
}

export interface CandidateBridge {
	conceptA: string;
	conceptB: string;
	bridge: string;
	bridgeEmbedding: number[];
	patternId: number;
	patternName: string;
	score: number; // h_v2 or heuristic quality score
}

export type PatternFn = (context: ConversationContext, index: AnnIndex) => CandidateBridge[];

// ---------------------------------------------------------------------------
// Meta-category enum
// ---------------------------------------------------------------------------

export const MetaCategory = {
	SEMANTIC: "semantic",
	PRAGMATIC: "pragmatic",
	STRUCTURAL: "structural",
	TEMPORAL: "temporal",
} as const;

export type MetaCategoryType = (typeof MetaCategory)[keyof typeof MetaCategory];

// ---------------------------------------------------------------------------
// Pattern registry
// ---------------------------------------------------------------------------

export interface PatternDef {
	id: number;
	name: string;
	metaCategory: MetaCategoryType;
	description: string;
	fn: PatternFn;
}

const patterns: PatternDef[] = [];

function registerPattern(def: PatternDef): void {
	patterns.push(def);
}

export function getPattern(id: number): PatternDef | undefined {
	return patterns.find((p) => p.id === id);
}

export function getAllPatterns(): PatternDef[] {
	return [...patterns];
}

export function getPatternsByCategory(cat: MetaCategoryType): PatternDef[] {
	return patterns.filter((p) => p.metaCategory === cat);
}

// ---------------------------------------------------------------------------
// Helper: find concept pairs from context
// ---------------------------------------------------------------------------

function conceptPairs(ctx: ConversationContext): Array<{ a: ConversationContext["recentConcepts"][0]; b: ConversationContext["recentConcepts"][0] }> {
	const pairs: Array<{ a: (typeof ctx.recentConcepts)[0]; b: (typeof ctx.recentConcepts)[0] }> = [];
	for (let i = 0; i < ctx.recentConcepts.length; i++) {
		for (let j = i + 1; j < ctx.recentConcepts.length; j++) {
			pairs.push({ a: ctx.recentConcepts[i], b: ctx.recentConcepts[j] });
		}
	}
	return pairs;
}

// ---------------------------------------------------------------------------
// CORE PATTERNS (4)
// ---------------------------------------------------------------------------

// Pattern 1: Antonymic Inversion (Semantic)
// Find near-antonyms, collapse the opposition into a bridge.
registerPattern({
	id: 1,
	name: "Antonymic Inversion",
	metaCategory: MetaCategory.SEMANTIC,
	description: "Find near-antonyms and collapse the opposition via a bridge concept.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const { a, b } of conceptPairs(ctx)) {
			const dist = cosineDistance(a.embedding, b.embedding);
			// Antonyms tend to be moderately distant but in same semantic field
			if (dist < 0.5 || dist > 0.95) continue;

			// Search for concepts that invert the relationship
			const antiMidpoint = vectorMean(a.embedding, b.embedding);
			const neighbors = index.query(antiMidpoint, 10);
			for (const n of neighbors) {
				const simA = cosineSimilarity(n.vector, a.embedding);
				const simB = cosineSimilarity(n.vector, b.embedding);
				// Bridge should connect to both but be somewhat surprising
				if (Math.min(simA, simB) > 0.15) {
					results.push({
						conceptA: a.label,
						conceptB: b.label,
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 1,
						patternName: "Antonymic Inversion",
						score: dist * Math.min(simA, simB),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 4: Expectation Subversion (Pragmatic)
// Setup a prediction, deliver a distant-but-valid completion.
registerPattern({
	id: 4,
	name: "Expectation Subversion",
	metaCategory: MetaCategory.PRAGMATIC,
	description: "Set up an expected completion, then deliver a distant-but-valid alternative.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		if (!ctx.topicEmbedding) return results;

		for (const concept of ctx.recentConcepts) {
			// Find what's "expected" near the topic
			const expected = index.query(ctx.topicEmbedding, 5);
			// Find what's "unexpected" — far from topic but still valid
			const farNeighbors = index.query(concept.embedding, 20);
			const unexpected = farNeighbors.filter(
				(n) => cosineDistance(n.vector, ctx.topicEmbedding!) > 0.6,
			);

			for (const u of unexpected.slice(0, 5)) {
				const validity = Math.min(
					cosineSimilarity(u.vector, concept.embedding),
					cosineSimilarity(u.vector, ctx.topicEmbedding),
				);
				if (validity > 0.1) {
					results.push({
						conceptA: concept.label,
						conceptB: "topic",
						bridge: u.id,
						bridgeEmbedding: u.vector,
						patternId: 4,
						patternName: "Expectation Subversion",
						score: cosineDistance(u.vector, ctx.topicEmbedding) * validity,
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 7: Domain Transfer (Structural)
// Import vocabulary/framing from domain A into domain B.
registerPattern({
	id: 7,
	name: "Domain Transfer",
	metaCategory: MetaCategory.STRUCTURAL,
	description: "Import vocabulary or framing from one domain into another.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const { a, b } of conceptPairs(ctx)) {
			const dist = cosineDistance(a.embedding, b.embedding);
			if (dist < 0.6) continue; // need sufficient domain separation

			// Find concepts near A that have some (small) relevance to B
			const domainA = index.query(a.embedding, 15);
			for (const candidate of domainA) {
				const simToA = cosineSimilarity(candidate.vector, a.embedding);
				const simToB = cosineSimilarity(candidate.vector, b.embedding);
				// Good transfer: close to A's domain, weak but nonzero link to B
				if (simToA > 0.4 && simToB > 0.1 && simToB < 0.4) {
					results.push({
						conceptA: a.label,
						conceptB: b.label,
						bridge: candidate.id,
						bridgeEmbedding: candidate.vector,
						patternId: 7,
						patternName: "Domain Transfer",
						score: dist * simToB * (1 - simToB), // peaks at moderate cross-domain relevance
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 8: Similarity in Dissimilarity (Structural)
// Find shared attributes between distant concepts.
registerPattern({
	id: 8,
	name: "Similarity in Dissimilarity",
	metaCategory: MetaCategory.STRUCTURAL,
	description: "Find shared attributes between distant concepts.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const { a, b } of conceptPairs(ctx)) {
			const dist = cosineDistance(a.embedding, b.embedding);
			if (dist < 0.6) continue; // need distant concepts

			// Midpoint captures shared semantic space
			const mid = vectorMean(a.embedding, b.embedding);
			const neighbors = index.query(mid, 10);
			for (const n of neighbors) {
				const simA = cosineSimilarity(n.vector, a.embedding);
				const simB = cosineSimilarity(n.vector, b.embedding);
				// Bridge should be equidistant-ish from both
				const balance = 1 - Math.abs(simA - simB);
				if (balance > 0.7 && Math.min(simA, simB) > 0.15) {
					results.push({
						conceptA: a.label,
						conceptB: b.label,
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 8,
						patternName: "Similarity in Dissimilarity",
						score: dist * balance * Math.min(simA, simB),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// ---------------------------------------------------------------------------
// REMAINING 8 PATTERNS
// ---------------------------------------------------------------------------

// Pattern 2: Hyperbolic Extension (Semantic)
registerPattern({
	id: 2,
	name: "Hyperbolic Extension",
	metaCategory: MetaCategory.SEMANTIC,
	description: "Take a property to its absurd logical extreme.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const concept of ctx.recentConcepts) {
			// "Extend" the concept vector away from the origin/topic
			const direction = ctx.topicEmbedding
				? vectorSub(concept.embedding, ctx.topicEmbedding)
				: concept.embedding;
			const extended = normalize(vectorAdd(concept.embedding, direction));
			const neighbors = index.query(extended, 10);
			for (const n of neighbors) {
				const dist = cosineDistance(n.vector, concept.embedding);
				if (dist > 0.4 && dist < 0.9) {
					results.push({
						conceptA: concept.label,
						conceptB: "extreme",
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 2,
						patternName: "Hyperbolic Extension",
						score: dist * cosineSimilarity(n.vector, concept.embedding),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 3: Reductio (Semantic)
registerPattern({
	id: 3,
	name: "Reductio",
	metaCategory: MetaCategory.SEMANTIC,
	description: "Reduce a concept to its most trivial interpretation.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const concept of ctx.recentConcepts) {
			// Search for trivial/mundane neighbors
			const neighbors = index.query(concept.embedding, 20);
			for (const n of neighbors) {
				const sim = cosineSimilarity(n.vector, concept.embedding);
				// Moderately similar but not identical — trivial reframing
				if (sim > 0.3 && sim < 0.7) {
					results.push({
						conceptA: concept.label,
						conceptB: "trivial",
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 3,
						patternName: "Reductio",
						score: (1 - sim) * sim, // peaks at moderate similarity
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 5: Register Shift (Pragmatic)
registerPattern({
	id: 5,
	name: "Register Shift",
	metaCategory: MetaCategory.PRAGMATIC,
	description: "Shift linguistic register unexpectedly (formal↔casual, technical↔colloquial).",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const concept of ctx.recentConcepts) {
			// Find concepts in a different "register zone"
			const neighbors = index.query(concept.embedding, 20);
			for (const n of neighbors) {
				const dist = cosineDistance(n.vector, concept.embedding);
				if (dist > 0.3 && dist < 0.7) {
					results.push({
						conceptA: concept.label,
						conceptB: ctx.register ?? "neutral",
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 5,
						patternName: "Register Shift",
						score: dist * cosineSimilarity(n.vector, concept.embedding),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 3);
	},
});

// Pattern 6: Pragmatic Overload (Pragmatic)
registerPattern({
	id: 6,
	name: "Pragmatic Overload",
	metaCategory: MetaCategory.PRAGMATIC,
	description: "Overload a concept with multiple pragmatic interpretations simultaneously.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const { a, b } of conceptPairs(ctx)) {
			const mid = vectorMean(a.embedding, b.embedding);
			const neighbors = index.query(mid, 10);
			for (const n of neighbors) {
				const simA = cosineSimilarity(n.vector, a.embedding);
				const simB = cosineSimilarity(n.vector, b.embedding);
				// Overload: bridge is meaningfully connected to BOTH
				if (simA > 0.3 && simB > 0.3) {
					results.push({
						conceptA: a.label,
						conceptB: b.label,
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 6,
						patternName: "Pragmatic Overload",
						score: simA * simB * cosineDistance(a.embedding, b.embedding),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 9: Frame Collision (Structural)
registerPattern({
	id: 9,
	name: "Frame Collision",
	metaCategory: MetaCategory.STRUCTURAL,
	description: "Collide two incompatible conceptual frames.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const { a, b } of conceptPairs(ctx)) {
			const dist = cosineDistance(a.embedding, b.embedding);
			if (dist < 0.7) continue; // need truly incompatible frames

			const mid = vectorMean(a.embedding, b.embedding);
			const neighbors = index.query(mid, 10);
			for (const n of neighbors) {
				const simA = cosineSimilarity(n.vector, a.embedding);
				const simB = cosineSimilarity(n.vector, b.embedding);
				if (Math.min(simA, simB) > 0.1) {
					results.push({
						conceptA: a.label,
						conceptB: b.label,
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 9,
						patternName: "Frame Collision",
						score: dist * Math.min(simA, simB),
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});

// Pattern 10: Callback (Temporal)
registerPattern({
	id: 10,
	name: "Callback",
	metaCategory: MetaCategory.TEMPORAL,
	description: "Reference a previous humor attempt to create a running gag.",
	fn(ctx, _index) {
		const results: CandidateBridge[] = [];
		if (!ctx.previousHumor?.length) return results;

		for (const prev of ctx.previousHumor) {
			for (const concept of ctx.recentConcepts) {
				// Check if current concept is related to a previous humor bridge
				// (simplified: label matching since we may not have embeddings for old bridges)
				results.push({
					conceptA: concept.label,
					conceptB: prev.conceptA,
					bridge: prev.bridge,
					bridgeEmbedding: concept.embedding, // placeholder; real impl uses stored embedding
					patternId: 10,
					patternName: "Callback",
					score: 0.5, // baseline callback score; actual scoring in humor-associations
				});
			}
		}
		return results.slice(0, 3);
	},
});

// Pattern 11: Escalation (Temporal)
registerPattern({
	id: 11,
	name: "Escalation",
	metaCategory: MetaCategory.TEMPORAL,
	description: "Progressively escalate the absurdity of a running theme.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		if (!ctx.previousHumor?.length) return results;

		for (const concept of ctx.recentConcepts) {
			// Escalate: push concept further from center
			const extended = normalize(concept.embedding.map((v) => v * 1.5));
			const neighbors = index.query(extended, 5);
			for (const n of neighbors) {
				const dist = cosineDistance(n.vector, concept.embedding);
				if (dist > 0.3) {
					results.push({
						conceptA: concept.label,
						conceptB: "escalated",
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 11,
						patternName: "Escalation",
						score: dist * 0.8,
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 3);
	},
});

// Pattern 12: Bathos (Temporal)
registerPattern({
	id: 12,
	name: "Bathos",
	metaCategory: MetaCategory.TEMPORAL,
	description: "Sudden shift from elevated to mundane/trivial.",
	fn(ctx, index) {
		const results: CandidateBridge[] = [];
		for (const concept of ctx.recentConcepts) {
			// Find mundane/trivial neighbors of an elevated concept
			const neighbors = index.query(concept.embedding, 20);
			for (const n of neighbors) {
				const dist = cosineDistance(n.vector, concept.embedding);
				// Bathos: moderate distance, suggesting deflation
				if (dist > 0.4 && dist < 0.8) {
					results.push({
						conceptA: concept.label,
						conceptB: "mundane",
						bridge: n.id,
						bridgeEmbedding: n.vector,
						patternId: 12,
						patternName: "Bathos",
						score: dist * 0.7,
					});
				}
			}
		}
		return results.sort((x, y) => y.score - x.score).slice(0, 5);
	},
});
