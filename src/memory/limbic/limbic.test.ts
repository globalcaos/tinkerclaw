/**
 * LIMBIC Phase 6 — Comprehensive tests.
 *
 * Covers: 6A (humor potential), 6B (pattern taxonomy), 6C (bridge discovery),
 *         6D (sensitivity gate + calibration), 6E (humor associations).
 */

import { describe, it, expect, vi } from "vitest";
import {
	cosineSimilarity,
	cosineDistance,
	vectorMean,
	dotProduct,
	magnitude,
	normalize,
} from "./vector-math.js";
import {
	humorPotentialV2,
	bridgeSurprise,
	bridgeValidity,
	isInHumorZone,
	type AnnIndex,
} from "./humor-potential.js";
import {
	getAllPatterns,
	getPattern,
	getPatternsByCategory,
	MetaCategory,
	type ConversationContext,
} from "./pattern-taxonomy.js";
import {
	midpointSearch,
	analogySearch,
	blendingSearch,
	graphTraversalSearch,
	llmGuidedSearch,
	discoverBridges,
} from "./bridge-discovery.js";
import {
	sensitivityGate,
	shouldAttemptHumor,
	detectSensitiveCategories,
	computeSensitivityScore,
	weightPatternSelection,
	type AudienceModel,
} from "./sensitivity-gate.js";
import {
	computeStaleness,
	computeCallbackBonus,
	detectRunningGags,
	matchRunningGag,
	createAssociation,
	recordOutcome,
	serializeAssociation,
	deserializeAssociation,
	type HumorAssociation,
} from "./humor-associations.js";
import type { HumorCalibration } from "../cortex/persona-state.js";

// ---------------------------------------------------------------------------
// Test helpers: mock embeddings & ANN index
// ---------------------------------------------------------------------------

/** Create a random unit vector of given dimension. Seeded for reproducibility. */
function mockEmbedding(seed: number, dim = 768): number[] {
	const v: number[] = new Array(dim);
	let s = seed;
	for (let i = 0; i < dim; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		v[i] = (s / 0x7fffffff) * 2 - 1;
	}
	return normalize(v);
}

/** Create an embedding that is a blend of two embeddings (for controlled similarity). */
function blendEmbeddings(a: number[], b: number[], ratio: number): number[] {
	return normalize(a.map((v, i) => v * ratio + b[i] * (1 - ratio)));
}

/** Simple in-memory ANN index for testing. */
function createMockIndex(entries: Array<{ id: string; vector: number[] }>): AnnIndex {
	return {
		query(vector: number[], k: number) {
			const scored = entries.map((e) => ({
				...e,
				sim: cosineSimilarity(vector, e.vector),
			}));
			scored.sort((a, b) => b.sim - a.sim);
			return scored.slice(0, k);
		},
		getId(vector: number[]) {
			for (const e of entries) {
				if (cosineSimilarity(vector, e.vector) > 0.9999) return e.id;
			}
			return undefined;
		},
	};
}

function mockCalibration(overrides?: Partial<HumorCalibration>): HumorCalibration {
	return {
		humorFrequency: 0.15,
		preferredPatterns: [1, 4, 7],
		sensitivityThreshold: 0.5,
		audienceModel: {},
		...overrides,
	};
}

// =========================================================================
// 6A: HUMOR POTENTIAL
// =========================================================================

describe("Phase 6A: Humor Potential h_v2", () => {
	const A = mockEmbedding(1);
	const B = mockEmbedding(2);
	const bridgeClose = blendEmbeddings(A, B, 0.5); // close to midpoint
	const bridgeFar = mockEmbedding(999); // unrelated

	// Build index with some entries including the bridge
	const entries = [
		{ id: "bridge-close", vector: bridgeClose },
		{ id: "bridge-far", vector: bridgeFar },
		...Array.from({ length: 50 }, (_, i) => ({
			id: `filler-${i}`,
			vector: mockEmbedding(100 + i),
		})),
	];
	const index = createMockIndex(entries);

	it("computes h_v2 = d × v × σ", () => {
		// Use a bridge that is NOT the midpoint (so surprise > 0)
		const surprisingBridge = blendEmbeddings(A, mockEmbedding(555), 0.6);
		const h = humorPotentialV2(A, B, surprisingBridge, index);
		expect(h).toBeGreaterThan(0);
		expect(typeof h).toBe("number");
		expect(Number.isFinite(h)).toBe(true);
	});

	it("obvious bridge scores low (low surprise)", () => {
		const hObvious = humorPotentialV2(A, B, bridgeClose, index);
		// Bridge that IS the midpoint has surprise ≈ 0 (rank 0/k), so h ≈ 0
		expect(hObvious).toBeLessThan(0.5);
	});

	it("unrelated bridge has low validity", () => {
		const v = bridgeValidity(bridgeFar, A, B);
		expect(v).toBeLessThan(0.3);
	});

	it("symmetry: h(A,B,β) ≈ h(B,A,β)", () => {
		const h1 = humorPotentialV2(A, B, bridgeClose, index);
		const h2 = humorPotentialV2(B, A, bridgeClose, index);
		expect(Math.abs(h1 - h2)).toBeLessThan(0.01);
	});

	it("h = 0 when A = B (distance is 0)", () => {
		const h = humorPotentialV2(A, A, bridgeClose, index);
		expect(h).toBeCloseTo(0, 2);
	});

	it("humor zone boundaries work", () => {
		expect(isInHumorZone(0.7, 0.3, 0.5)).toBe(true);
		expect(isInHumorZone(0.3, 0.3, 0.5)).toBe(false); // dist too low
		expect(isInHumorZone(0.98, 0.3, 0.5)).toBe(false); // dist too high
		expect(isInHumorZone(0.7, 0.1, 0.5)).toBe(false); // validity too low
		expect(isInHumorZone(0.7, 0.3, 0.1)).toBe(false); // surprise too low
	});

	it("bridgeSurprise returns 1.0 for unknown bridge", () => {
		const unknown = mockEmbedding(77777);
		const s = bridgeSurprise(unknown, A, B, index);
		expect(s).toBe(1.0);
	});

	it("bridgeSurprise returns rank/k for known bridge", () => {
		const s = bridgeSurprise(bridgeClose, A, B, index);
		expect(s).toBeGreaterThanOrEqual(0);
		expect(s).toBeLessThan(1);
	});
});

// =========================================================================
// 6B: PATTERN TAXONOMY
// =========================================================================

describe("Phase 6B: Pattern Taxonomy", () => {
	it("has 12 registered patterns", () => {
		expect(getAllPatterns()).toHaveLength(12);
	});

	it("each meta-category has 3 patterns", () => {
		for (const cat of Object.values(MetaCategory)) {
			expect(getPatternsByCategory(cat)).toHaveLength(3);
		}
	});

	it("core patterns exist: 1, 4, 7, 8", () => {
		for (const id of [1, 4, 7, 8]) {
			const p = getPattern(id);
			expect(p).toBeDefined();
			expect(p!.id).toBe(id);
		}
	});

	it("pattern IDs are 1-12", () => {
		const ids = getAllPatterns().map((p) => p.id).sort((a, b) => a - b);
		expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	it("core patterns produce candidates from context", () => {
		const A = mockEmbedding(10);
		const B = mockEmbedding(20);
		const entries = Array.from({ length: 30 }, (_, i) => ({
			id: `concept-${i}`,
			vector: mockEmbedding(200 + i),
		}));
		const index = createMockIndex(entries);

		const ctx: ConversationContext = {
			recentConcepts: [
				{ label: "meeting", embedding: A },
				{ label: "hostage", embedding: B },
			],
			topicEmbedding: vectorMean(A, B),
		};

		for (const id of [1, 4, 7, 8]) {
			const pattern = getPattern(id)!;
			const candidates = pattern.fn(ctx, index);
			expect(Array.isArray(candidates)).toBe(true);
			// Pattern functions should return something (may be empty depending on thresholds)
			for (const c of candidates) {
				expect(c.patternId).toBe(id);
				expect(c.score).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("callback pattern (10) requires previousHumor", () => {
		const A = mockEmbedding(10);
		const index = createMockIndex([]);
		const ctx: ConversationContext = { recentConcepts: [{ label: "test", embedding: A }] };
		const p10 = getPattern(10)!;
		expect(p10.fn(ctx, index)).toHaveLength(0);

		const ctxWithHistory: ConversationContext = {
			recentConcepts: [{ label: "test", embedding: A }],
			previousHumor: [{ conceptA: "cat", conceptB: "dog", bridge: "pet", timestamp: new Date().toISOString() }],
		};
		expect(p10.fn(ctxWithHistory, index).length).toBeGreaterThan(0);
	});
});

// =========================================================================
// 6C: BRIDGE DISCOVERY
// =========================================================================

describe("Phase 6C: Bridge Discovery", () => {
	const A = mockEmbedding(30);
	const B = mockEmbedding(40);
	const entries = Array.from({ length: 50 }, (_, i) => ({
		id: `bridge-${i}`,
		vector: mockEmbedding(300 + i),
	}));
	const index = createMockIndex(entries);

	it("midpointSearch returns bridges", () => {
		const results = midpointSearch(A, B, index);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].method).toBe("midpoint");
	});

	it("analogySearch returns bridges", () => {
		const results = analogySearch(A, B, index);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].method).toBe("analogy");
	});

	it("blendingSearch returns bridges", () => {
		const results = blendingSearch(A, B, index);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].method).toBe("blending");
	});

	it("graphTraversalSearch returns empty (placeholder)", () => {
		expect(graphTraversalSearch(A, B, index)).toHaveLength(0);
	});

	it("llmGuidedSearch calls generator", async () => {
		const generator = vi.fn().mockResolvedValue([
			{ label: "llm-bridge-1", embedding: mockEmbedding(500) },
			{ label: "llm-bridge-2", embedding: mockEmbedding(501) },
		]);
		const results = await llmGuidedSearch(A, B, "conceptA", "conceptB", index, generator, 2);
		expect(generator).toHaveBeenCalledWith("conceptA", "conceptB", 2);
		expect(results).toHaveLength(2);
		expect(results[0].method).toBe("llm_guided");
	});

	it("discoverBridges runs cascade", async () => {
		const results = await discoverBridges(A, B, index);
		expect(Array.isArray(results)).toBe(true);
		// All results should have quality scores
		for (const r of results) {
			expect(typeof r.quality).toBe("number");
		}
	});

	it("discoverBridges deduplicates by ID", async () => {
		const results = await discoverBridges(A, B, index);
		const ids = results.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("LLM fallback activates when quality is low", async () => {
		// Create an index where nothing passes quality threshold
		const emptyIndex = createMockIndex([]);
		const generator = vi.fn().mockResolvedValue([
			{ label: "fallback", embedding: blendEmbeddings(A, B, 0.5) },
		]);

		await discoverBridges(A, B, emptyIndex, {
			labelA: "a",
			labelB: "b",
			llmGenerator: generator,
			minQuality: 0.001, // very low threshold so fallback results pass
		});
		expect(generator).toHaveBeenCalled();
	});
});

// =========================================================================
// 6D: SENSITIVITY GATE & CALIBRATION
// =========================================================================

describe("Phase 6D: Sensitivity Gate", () => {
	it("detects sensitive categories", () => {
		expect(detectSensitiveCategories("death and funeral")).toContain("death");
		expect(detectSensitiveCategories("hello world")).toHaveLength(0);
		expect(detectSensitiveCategories("suicide prevention")).toContain("suicide");
	});

	it("blocks humor on sensitive topics", () => {
		const cal = mockCalibration({ sensitivityThreshold: 0.2 });
		const result = sensitivityGate("death", "dying", "funeral mourning", cal);
		expect(result.allowed).toBe(false);
		expect(result.sensitivityScore).toBeGreaterThan(0);
	});

	it("allows humor on safe topics", () => {
		const cal = mockCalibration({ sensitivityThreshold: 0.5 });
		const result = sensitivityGate("cat", "keyboard", "typing", cal);
		expect(result.allowed).toBe(true);
		expect(result.sensitivityScore).toBe(0);
	});

	it("hard blocks on audience recent trauma", () => {
		const cal = mockCalibration({ sensitivityThreshold: 0.9 }); // high threshold
		const audience: AudienceModel = {
			userId: "user-1",
			recentTrauma: ["grief"],
			humorReceptivity: 0.8,
			reactions: { positive: 10, negative: 0, neutral: 0 },
		};
		// Even with high threshold, trauma topics are hard-blocked
		const result = sensitivityGate("loss", "comedy", "grieving process", cal, audience);
		expect(result.allowed).toBe(false);
	});

	it("computeSensitivityScore returns 0 for safe text", () => {
		expect(computeSensitivityScore("hello world")).toBe(0);
	});

	it("computeSensitivityScore returns > 0 for sensitive text", () => {
		expect(computeSensitivityScore("death and grief")).toBeGreaterThan(0);
	});
});

describe("Phase 6D: Humor Calibration", () => {
	it("shouldAttemptHumor respects frequency", () => {
		const cal = mockCalibration({ humorFrequency: 0.15 });
		let attempts = 0;
		for (let turn = 0; turn < 1000; turn++) {
			if (shouldAttemptHumor(cal, turn)) attempts++;
		}
		// With 15% frequency, expect ~150 attempts (±50 for hash distribution)
		expect(attempts).toBeGreaterThan(50);
		expect(attempts).toBeLessThan(350);
	});

	it("shouldAttemptHumor with frequency=0 never attempts", () => {
		const cal = mockCalibration({ humorFrequency: 0 });
		for (let turn = 0; turn < 100; turn++) {
			expect(shouldAttemptHumor(cal, turn)).toBe(false);
		}
	});

	it("shouldAttemptHumor modulated by audience receptivity", () => {
		const cal = mockCalibration({ humorFrequency: 1.0 }); // always
		const coldAudience: AudienceModel = {
			userId: "cold",
			humorReceptivity: 0.0, // never receptive
			reactions: { positive: 0, negative: 10, neutral: 0 },
		};
		let attempts = 0;
		for (let turn = 0; turn < 100; turn++) {
			if (shouldAttemptHumor(cal, turn, coldAudience)) attempts++;
		}
		expect(attempts).toBe(0);
	});

	it("weightPatternSelection boosts preferred patterns", () => {
		const weights = weightPatternSelection([1, 2, 3, 4], [1, 4]);
		expect(weights.get(1)).toBe(3.0);
		expect(weights.get(4)).toBe(3.0);
		expect(weights.get(2)).toBe(1.0);
		expect(weights.get(3)).toBe(1.0);
	});
});

// =========================================================================
// 6E: HUMOR ASSOCIATIONS
// =========================================================================

describe("Phase 6E: Humor Associations", () => {
	it("creates association with correct defaults", () => {
		const assoc = createAssociation({
			conceptA: "meeting",
			conceptB: "hostage",
			bridge: "held against your will",
			patternType: 8,
			surpriseScore: 0.7,
			audience: "user-1",
			discoveredVia: "conversation",
		});
		expect(assoc.timesUsed).toBe(0);
		expect(assoc.humorConfidence).toBe(0);
		expect(assoc.outcomes).toHaveLength(0);
	});

	it("recordOutcome updates confidence", () => {
		let assoc = createAssociation({
			conceptA: "a", conceptB: "b", bridge: "c",
			patternType: 1, surpriseScore: 0.5, audience: "u1", discoveredVia: "generated",
		});
		assoc = recordOutcome(assoc, true);
		expect(assoc.timesUsed).toBe(1);
		expect(assoc.humorConfidence).toBe(1.0);

		assoc = recordOutcome(assoc, false);
		expect(assoc.timesUsed).toBe(2);
		expect(assoc.humorConfidence).toBe(0.5);
	});

	it("serialization roundtrip", () => {
		const assoc = createAssociation({
			conceptA: "x", conceptB: "y", bridge: "z",
			patternType: 4, surpriseScore: 0.8, audience: "u1", discoveredVia: "observed",
		});
		const serialized = serializeAssociation(assoc);
		const deserialized = deserializeAssociation(serialized);
		expect(deserialized).toEqual(assoc);
	});

	it("staleness increases with use, decreases with time", () => {
		expect(computeStaleness(0, 0)).toBe(0); // fresh
		expect(computeStaleness(5, 0)).toBeGreaterThan(0); // used a lot
		expect(computeStaleness(5, 5000)).toBeLessThan(computeStaleness(5, 0)); // time heals
	});

	it("callback bonus decays over time", () => {
		// Use an association with 0 uses so staleness is 0 at both time points
		const assoc: HumorAssociation = {
			...createAssociation({
				conceptA: "a", conceptB: "b", bridge: "c",
				patternType: 1, surpriseScore: 0.5, audience: "u1", discoveredVia: "conversation",
			}),
			humorConfidence: 0.9, // set directly to avoid staleness from recordOutcome
		};

		const now = new Date(assoc.lastUsed).getTime();
		const bonusNow = computeCallbackBonus(assoc, now);
		const bonusLater = computeCallbackBonus(assoc, now + 5000 * 60 * 60 * 1000); // 5000 hours later (well past decay onset)
		expect(bonusNow).toBeGreaterThan(bonusLater);
	});

	it("detectRunningGags filters correctly", () => {
		const gag: HumorAssociation = {
			...createAssociation({
				conceptA: "a", conceptB: "b", bridge: "c",
				patternType: 1, surpriseScore: 0.5, audience: "u1", discoveredVia: "conversation",
			}),
			timesUsed: 5,
			humorConfidence: 0.8,
		};
		const nonGag = createAssociation({
			conceptA: "x", conceptB: "y", bridge: "z",
			patternType: 2, surpriseScore: 0.3, audience: "u1", discoveredVia: "generated",
		});

		const gags = detectRunningGags([gag, nonGag]);
		expect(gags).toHaveLength(1);
		expect(gags[0].conceptA).toBe("a");
	});

	it("matchRunningGag finds by concept pair (case-insensitive, symmetric)", () => {
		const gag: HumorAssociation = {
			...createAssociation({
				conceptA: "Meeting", conceptB: "Hostage",
				bridge: "held", patternType: 8, surpriseScore: 0.5, audience: "u1", discoveredVia: "conversation",
			}),
			timesUsed: 3, humorConfidence: 0.7,
		};
		expect(matchRunningGag("meeting", "hostage", [gag])).toBeDefined();
		expect(matchRunningGag("hostage", "meeting", [gag])).toBeDefined(); // symmetric
		expect(matchRunningGag("cat", "dog", [gag])).toBeUndefined();
	});
});

// =========================================================================
// Vector math basics
// =========================================================================

describe("Vector Math", () => {
	it("cosineSimilarity of identical vectors is 1", () => {
		const v = mockEmbedding(1);
		expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
	});

	it("cosineDistance of identical vectors is 0", () => {
		const v = mockEmbedding(1);
		expect(cosineDistance(v, v)).toBeCloseTo(0, 5);
	});

	it("cosineSimilarity of orthogonal vectors is ~0", () => {
		// With high-dimensional random vectors, they tend to be nearly orthogonal
		const a = mockEmbedding(1);
		const b = mockEmbedding(2);
		expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.2);
	});

	it("vectorMean is equidistant", () => {
		const a = mockEmbedding(1);
		const b = mockEmbedding(2);
		const mid = vectorMean(a, b);
		const distA = cosineDistance(mid, a);
		const distB = cosineDistance(mid, b);
		expect(Math.abs(distA - distB)).toBeLessThan(0.1);
	});

	it("normalize produces unit vector", () => {
		const v = [3, 4, 0];
		const n = normalize(v);
		expect(magnitude(n)).toBeCloseTo(1, 5);
	});

	it("handles zero vector gracefully", () => {
		expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
	});
});
