/**
 * LIMBIC Benchmark: Humor Quality & Bridge Validity (Phase 6.4).
 *
 * Measures across 20 humor attempts:
 *   - h_v2 score distribution: scored bridges vs random vs midpoint baseline
 *   - Bridge validity rate (validity > τ_v threshold)
 *   - Humor zone hit rate
 *   - Sensitivity gate trigger rate
 *
 * Outputs a JSON report via console.log for CI artifact capture.
 */

import { describe, it, expect } from "vitest";
import { cosineSimilarity, cosineDistance, vectorMean, normalize } from "./vector-math.js";
import { humorPotentialV2, bridgeValidity, isInHumorZone, type AnnIndex } from "./humor-potential.js";
import { discoverBridges } from "./bridge-discovery.js";
import { sensitivityGate } from "./sensitivity-gate.js";
import { LIMBIC_CONFIG } from "./config.js";
import type { HumorCalibration } from "../cortex/persona-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEmbedding(seed: number, dim = 128): number[] {
	const v: number[] = new Array(dim);
	let s = seed;
	for (let i = 0; i < dim; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		v[i] = (s / 0x7fffffff) * 2 - 1;
	}
	return normalize(v);
}

function blendEmbeddings(a: number[], b: number[], ratio: number): number[] {
	return normalize(a.map((x, i) => x * ratio + b[i] * (1 - ratio)));
}

function createMockIndex(entries: Array<{ id: string; vector: number[] }>): AnnIndex {
	return {
		query(vector: number[], k: number) {
			return entries
				.map((e) => ({ ...e, sim: cosineSimilarity(vector, e.vector) }))
				.sort((a, b) => b.sim - a.sim)
				.slice(0, k);
		},
		getId(vector: number[]) {
			return entries.find((e) => cosineSimilarity(vector, e.vector) > 0.9999)?.id;
		},
	};
}

function mockCalibration(): HumorCalibration {
	// Threshold 0.2 so single-category matches (score=0.3) get blocked
	return { humorFrequency: 0.3, preferredPatterns: [1, 4, 7], sensitivityThreshold: 0.2, audienceModel: {} };
}

// ---------------------------------------------------------------------------
// Fixtures: 20 concept pairs with varied semantic distance profiles
// ---------------------------------------------------------------------------

const CONCEPT_PAIRS = [
	{ labelA: "meeting",     labelB: "hostage",      seedA: 1,  seedB: 2  },
	{ labelA: "coffee",      labelB: "philosophy",   seedA: 3,  seedB: 4  },
	{ labelA: "cat",         labelB: "quantum",      seedA: 5,  seedB: 6  },
	{ labelA: "tax",         labelB: "vacation",     seedA: 7,  seedB: 8  },
	{ labelA: "algorithm",   labelB: "romance",      seedA: 9,  seedB: 10 },
	{ labelA: "dentist",     labelB: "joy",          seedA: 11, seedB: 12 },
	{ labelA: "regex",       labelB: "cooking",      seedA: 13, seedB: 14 },
	{ labelA: "deadline",    labelB: "meditation",   seedA: 15, seedB: 16 },
	{ labelA: "spreadsheet", labelB: "poetry",       seedA: 17, seedB: 18 },
	{ labelA: "firewall",    labelB: "friendship",   seedA: 19, seedB: 20 },
	{ labelA: "budget",      labelB: "dreams",       seedA: 21, seedB: 22 },
	{ labelA: "standup",     labelB: "therapy",      seedA: 23, seedB: 24 },
	{ labelA: "database",    labelB: "memories",     seedA: 25, seedB: 26 },
	{ labelA: "compiler",    labelB: "philosophy",   seedA: 27, seedB: 28 },
	{ labelA: "keyboard",    labelB: "symphony",     seedA: 29, seedB: 30 },
	{ labelA: "ticket",      labelB: "existential",  seedA: 31, seedB: 32 },
	{ labelA: "cache",       labelB: "forgiveness",  seedA: 33, seedB: 34 },
	{ labelA: "semaphore",   labelB: "dance",        seedA: 35, seedB: 36 },
	{ labelA: "loop",        labelB: "ritual",       seedA: 37, seedB: 38 },
	{ labelA: "exception",   labelB: "surprise",     seedA: 39, seedB: 40 },
] as const;

// Shared 200-concept vocabulary for the ANN index
const VOCAB = Array.from({ length: 200 }, (_, i) => ({ id: `concept-${i}`, vector: mockEmbedding(500 + i) }));

function buildIndex(pairIdx: number): AnnIndex {
	const { seedA, seedB } = CONCEPT_PAIRS[pairIdx];
	const A = mockEmbedding(seedA);
	const B = mockEmbedding(seedB);
	return createMockIndex([
		...VOCAB,
		{ id: `mid-${pairIdx}`,     vector: blendEmbeddings(A, B, 0.5) },
		{ id: `near-a-${pairIdx}`,  vector: blendEmbeddings(A, mockEmbedding(seedA + 200), 0.75) },
		{ id: `near-b-${pairIdx}`,  vector: blendEmbeddings(B, mockEmbedding(seedB + 200), 0.75) },
	]);
}

// Sensitivity test cases: mix of blocked and safe
const SENSITIVITY_CASES = [
	{ a: "death",    b: "comedy",      bridge: "funeral",    expectBlocked: true  },
	{ a: "grief",    b: "laughter",    bridge: "eulogy",     expectBlocked: true  },
	{ a: "suicide",  b: "joke",        bridge: "laugh",      expectBlocked: true  },
	{ a: "massacre", b: "timing",      bridge: "war crime",  expectBlocked: true  },
	{ a: "cat",      b: "keyboard",    bridge: "paws",       expectBlocked: false },
	{ a: "coffee",   b: "productivity",bridge: "caffeine",   expectBlocked: false },
	{ a: "pizza",    b: "algorithm",   bridge: "slices",     expectBlocked: false },
];

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

describe("LIMBIC Benchmark: Humor Quality & Bridge Validity", () => {

	it("scores 20 humor attempts and emits JSON report", async () => {
		interface AttemptResult {
			id: number; pair: string; dist: number; bridgesFound: number;
			scored: { h: number; validity: number; inZone: boolean };
			random: { h: number; validity: number };
			midpoint: { h: number };
		}

		const cal = mockCalibration();
		const attempts: AttemptResult[] = [];

		for (let i = 0; i < 20; i++) {
			const pair = CONCEPT_PAIRS[i];
			const A = mockEmbedding(pair.seedA);
			const B = mockEmbedding(pair.seedB);
			const index = buildIndex(i);
			const dist = cosineDistance(A, B);

			const bridges = await discoverBridges(A, B, index, { minQuality: 0.0, maxResults: 5 });
			const best = bridges[0];

			let scoredH = 0, scoredValidity = 0, inZone = false;
			if (best) {
				scoredH = humorPotentialV2(A, B, best.vector, index);
				scoredValidity = bridgeValidity(best.vector, A, B);
				const approxSurprise = dist > 0 && scoredValidity > 0 ? scoredH / (dist * scoredValidity + 1e-9) : 0;
				inZone = isInHumorZone(dist, scoredValidity, approxSurprise);
			}

			const randomVec = mockEmbedding(9000 + i);
			const randomH = humorPotentialV2(A, B, randomVec, index);
			const randomValidity = bridgeValidity(randomVec, A, B);

			const midVec = vectorMean(A, B);
			const midH = humorPotentialV2(A, B, midVec, index);

			attempts.push({
				id: i,
				pair: `${pair.labelA}↔${pair.labelB}`,
				dist: +dist.toFixed(4),
				bridgesFound: bridges.length,
				scored:   { h: +scoredH.toFixed(4),   validity: +scoredValidity.toFixed(4), inZone },
				random:   { h: +randomH.toFixed(4),   validity: +randomValidity.toFixed(4) },
				midpoint: { h: +midH.toFixed(4) },
			});
		}

		const sensitivityResults = SENSITIVITY_CASES.map(({ a, b, bridge, expectBlocked }) => {
			const r = sensitivityGate(a, b, bridge, cal);
			return { pair: `${a}+${b}`, allowed: r.allowed, score: +r.sensitivityScore.toFixed(4), expectBlocked };
		});

		const scoredHValues = attempts.map((a) => a.scored.h);
		const randomHValues = attempts.map((a) => a.random.h);
		const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
		const validityThreshold = LIMBIC_CONFIG.humorZone.validityThreshold;

		const summary = {
			avgHumorPotential: {
				scored:   +avg(scoredHValues).toFixed(4),
				random:   +avg(randomHValues).toFixed(4),
				midpoint: +avg(attempts.map((a) => a.midpoint.h)).toFixed(4),
			},
			bridgeValidityRate:        +(attempts.filter((a) => a.scored.validity > validityThreshold).length / 20).toFixed(4),
			humorZoneHitRate:          +(attempts.filter((a) => a.scored.inZone).length / 20).toFixed(4),
			sensitivityGateTriggerRate:+(sensitivityResults.filter((r) => !r.allowed).length / sensitivityResults.length).toFixed(4),
			scoredBetterThanRandom:    attempts.filter((a) => a.scored.h > a.random.h).length,
		};

		const report = {
			meta: { timestamp: new Date().toISOString(), attempts: 20, vocabSize: VOCAB.length },
			summary,
			sensitivityResults,
			attempts,
		};

		console.log("\n--- LIMBIC Benchmark Report ---\n" + JSON.stringify(report, null, 2));

		// Structural invariants
		expect(attempts).toHaveLength(20);
		expect(summary.avgHumorPotential.scored).toBeGreaterThanOrEqual(0);
		// Random bridges can produce negative scores — that's expected (validates scoring discriminates)
		expect(summary.avgHumorPotential.scored).toBeGreaterThanOrEqual(summary.avgHumorPotential.random);
		expect(summary.bridgeValidityRate).toBeGreaterThanOrEqual(0);
		expect(summary.bridgeValidityRate).toBeLessThanOrEqual(1);
		expect(summary.humorZoneHitRate).toBeGreaterThanOrEqual(0);
		expect(summary.sensitivityGateTriggerRate).toBeGreaterThan(0);   // some blocked
		expect(summary.sensitivityGateTriggerRate).toBeLessThan(1);      // some allowed
		expect(summary.scoredBetterThanRandom).toBeGreaterThan(0);
	}, 30_000);

	it("scored bridges have equal or better validity than random bridges", async () => {
		let scoredValid = 0, randomValid = 0;
		const threshold = LIMBIC_CONFIG.humorZone.validityThreshold;

		for (let i = 0; i < 20; i++) {
			const { seedA, seedB } = CONCEPT_PAIRS[i];
			const A = mockEmbedding(seedA), B = mockEmbedding(seedB);
			const index = buildIndex(i);

			const bridges = await discoverBridges(A, B, index, { minQuality: 0.0, maxResults: 3 });
			if (bridges[0] && bridgeValidity(bridges[0].vector, A, B) > threshold) scoredValid++;
			if (bridgeValidity(mockEmbedding(8000 + i), A, B) > threshold) randomValid++;
		}

		expect(scoredValid).toBeGreaterThanOrEqual(randomValid);
	}, 30_000);

	it("sensitivity gate blocks known-harmful pairs and allows safe pairs", () => {
		const cal = mockCalibration();
		for (const { a, b, bridge, expectBlocked } of SENSITIVITY_CASES) {
			const result = sensitivityGate(a, b, bridge, cal);
			expect(result.allowed).toBe(!expectBlocked);
		}
	});
});
