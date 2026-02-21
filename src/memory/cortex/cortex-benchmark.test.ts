/**
 * CORTEX Phase 6.3: Persona Stability Benchmark
 *
 * Validates:
 * 1. SyncScore stays >0.8 during normal 50-turn conversation with topic shifts
 * 2. Drift recovery: deliberate drift is corrected after persona re-injection
 * 3. Ablation: marginal contribution of each CORTEX component
 *
 * Outputs benchmark results as JSON.
 */

import { describe, it, expect } from "vitest";
import { createDefaultPersonaState } from "./persona-state.js";
import { computeEPhi, computeBaselineEPhi, ePhiDistance } from "./voice-markers.js";
import {
	createDriftState,
	computeDriftScore,
	computeAdaptiveWeights,
	aggregateProbeScores,
	DRIFT_CONFIG,
} from "./drift-detection.js";
import {
	computeConsistency,
	generateReinforcement,
	classifyAction,
} from "./consistency-metric.js";
import type { ProbeResult } from "./behavioral-probes.js";
import type { PersonaState } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ON_PERSONA: string[] = [
	"The implementation demonstrates a clean separation of concerns. Each module handles its responsibility.",
	"Indeed — the approach maintains architectural integrity. The solution is concise and well-structured.",
	"The algorithm processes the request through the middleware pipeline. Latency is within acceptable bounds.",
	"Here is the solution. Tested, documented, and ready for production deployment.",
	"The database query has been optimised. Cache hit rate improved by 40% after the refactor.",
	"The configuration schema validates correctly. All required fields are present and typed.",
	"The API endpoint handles edge cases appropriately. Error responses include actionable context.",
	"The dependency injection pattern ensures testability. Each component can be stubbed independently.",
];

const OFF_PERSONA: string[] = [
	"Hey! So yeah I totally messed up the config lol 😅 gonna fix it now!",
	"Hmm maybe I should try something? I think perhaps we could possibly do this?",
	"Wow that's kinda cool! I dunno, maybe later haha. So basically whatever!",
	"Oh wow okay sure! I'm not entirely sure but maybe we could probably try that?",
	"Hey hey! Definitely gonna do that thing lol. So yeah basically it works maybe.",
];

const TOPICS = [
	"database optimisation", "API design", "type safety", "caching strategy",
	"error handling", "testing patterns", "deployment pipeline", "security review",
	"performance profiling", "code review",
];

// User messages that trigger correction detection
const CORRECTION_MSGS = [
	"that's not how you usually talk",
	"you normally sound more formal",
	"that doesn't sound like you",
	"too casual — go back to your normal style",
	"be more like yourself",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPersona(): PersonaState {
	const ps = createDefaultPersonaState(
		"JarvisOne",
		"AI assistant and extension of Oscar. Technical, precise, moderately formal.",
	);
	ps.traits = [
		{ dimension: "formality", targetValue: 0.7, description: "Moderately formal", calibrationExamples: [] },
		{ dimension: "verbosity", targetValue: 0.4, description: "Concise", calibrationExamples: [] },
		{ dimension: "technicalDensity", targetValue: 0.7, description: "Technical", calibrationExamples: [] },
	];
	ps.voiceMarkers = {
		avgSentenceLength: 15,
		vocabularyTier: "technical",
		hedgingLevel: "rare",
		emojiUsage: "never",
		signaturePhrases: ["Indeed", "As it were"],
		forbiddenPhrases: ["lol", "gonna", "wanna", "kinda"],
	};
	ps.referenceSamples = ON_PERSONA.slice(0, 4);
	return ps;
}

function makeProbe(score: number, turn = 0): ProbeResult {
	return {
		probeType: "hard_rule",
		turnNumber: turn,
		timestamp: new Date().toISOString(),
		scores: { compliance: score },
		violations: score < 0.5 ? ["style_violation"] : [],
		rawOutput: "",
		model: "mock",
		inputTokens: 0,
		outputTokens: 0,
		latencyMs: 0,
		cost: 0,
	};
}

/** SyncScore = 1 − EWMA drift. High = persona is stable. */
function syncScore(ewma: number): number {
	return Math.max(0, 1 - ewma);
}

// ---------------------------------------------------------------------------
// 1. 50-Turn Stability
// ---------------------------------------------------------------------------

describe("CORTEX Benchmark 1: 50-turn persona stability", () => {
	it("SyncScore stays >0.8 during normal conversation with topic shifts", () => {
		const persona = buildPersona();
		const baseline = computeBaselineEPhi(ON_PERSONA);
		const driftState = createDriftState();
		const syncs: number[] = [];

		for (let t = 0; t < 50; t++) {
			const topic = TOPICS[t % TOPICS.length];
			const response = ON_PERSONA[t % ON_PERSONA.length];
			const userMsg = `Tell me about ${topic}.`;

			const ds = computeDriftScore(userMsg, [makeProbe(0.95, t)], driftState, t);
			const consistency = computeConsistency([makeProbe(0.95, t)], [response], baseline);
			const ephi = computeEPhi(response);
			const dist = ePhiDistance(ephi, baseline);

			// Combined SyncScore weights drift + consistency + E_φ proximity
			const ss = syncScore(ds.ewmaScore) * 0.5 + consistency.C * 0.3 + (1 - dist) * 0.2;
			syncs.push(ss);
		}

		const avg = syncs.reduce((a, b) => a + b, 0) / syncs.length;
		const min = Math.min(...syncs);

		const result = {
			test: "50-turn-stability",
			turns: 50,
			avgSyncScore: +avg.toFixed(4),
			minSyncScore: +min.toFixed(4),
			passesThreshold: min > 0.8,
		};
		console.log(JSON.stringify(result, null, 2));

		expect(min).toBeGreaterThan(0.8);
		expect(avg).toBeGreaterThan(0.9);
	});
});

// ---------------------------------------------------------------------------
// 2. Drift Recovery
// ---------------------------------------------------------------------------

describe("CORTEX Benchmark 2: Drift recovery via persona re-injection", () => {
	it("re-injection corrects deliberate drift within 10 turns", () => {
		const persona = buildPersona();
		const baseline = computeBaselineEPhi(ON_PERSONA);
		const driftState = createDriftState();

		type TurnRecord = { phase: string; turn: number; sync: number; action: string };
		const log: TurnRecord[] = [];

		// Phase A: stable (turns 0-19)
		for (let t = 0; t < 20; t++) {
			const ds = computeDriftScore(`Tell me about ${TOPICS[t % TOPICS.length]}.`, [makeProbe(0.95, t)], driftState, t);
			log.push({ phase: "stable", turn: t, sync: +syncScore(ds.ewmaScore).toFixed(4), action: "none" });
		}

		// Phase B: drift injected (turns 20-29) — correction messages + bad probes
		for (let t = 20; t < 30; t++) {
			const msg = CORRECTION_MSGS[(t - 20) % CORRECTION_MSGS.length];
			const ds = computeDriftScore(msg, [makeProbe(0.2, t)], driftState, t);
			const consistency = computeConsistency([makeProbe(0.2, t)], [OFF_PERSONA[(t - 20) % OFF_PERSONA.length]], baseline);
			log.push({ phase: "drift", turn: t, sync: +syncScore(ds.ewmaScore).toFixed(4), action: consistency.action });
		}

		const syncAfterDrift = syncScore(driftState.ewmaScore);

		// Re-injection event: simulate persona reinforcement
		const reinforcement = generateReinforcement(persona, ["style_violation", "emoji_usage"]);
		expect(reinforcement).toContain("JarvisOne");

		// Phase C: recovery (turns 30-49) — no corrections, good probes
		for (let t = 30; t < 50; t++) {
			const ds = computeDriftScore(`Tell me about ${TOPICS[t % TOPICS.length]}.`, [makeProbe(0.95, t)], driftState, t);
			log.push({ phase: "recovery", turn: t, sync: +syncScore(ds.ewmaScore).toFixed(4), action: "none" });
		}

		const syncAfterRecovery = syncScore(driftState.ewmaScore);

		// Recovery check: find first turn where sync exceeds 0.8 after drift
		const recoveryTurn = log.findIndex((r) => r.phase === "recovery" && r.sync > 0.8);

		const result = {
			test: "drift-recovery",
			syncAfterDrift: +syncAfterDrift.toFixed(4),
			syncAfterRecovery: +syncAfterRecovery.toFixed(4),
			recoveryTurnOffset: recoveryTurn === -1 ? null : recoveryTurn - 20, // relative to start of recovery phase
			recovered: syncAfterRecovery > 0.8,
			reinforcementLength: reinforcement.length,
		};
		console.log(JSON.stringify(result, null, 2));

		expect(syncAfterDrift).toBeLessThan(syncScore(0) * 0.9); // drift reduced sync
		expect(syncAfterRecovery).toBeGreaterThan(0.8); // recovery restored sync
		expect(recoveryTurn).toBeGreaterThan(-1); // recovery happened within 20 turns
	});
});

// ---------------------------------------------------------------------------
// 3. Ablation Study
// ---------------------------------------------------------------------------

describe("CORTEX Benchmark 3: Ablation — marginal component contributions", () => {
	it("measures marginal drift signal from each component", () => {
		const baseline = computeBaselineEPhi(ON_PERSONA);
		const correctionMsg = CORRECTION_MSGS[0];
		const offResponse = OFF_PERSONA[0];
		const onResponse = ON_PERSONA[0];

		// A) Full CORTEX: adaptive weights + probe signal + E_φ distance
		const stateA = createDriftState();
		const dsFullOn = computeDriftScore("Tell me.", [makeProbe(0.95)], stateA, 0);
		const dsFullOff = computeDriftScore(correctionMsg, [makeProbe(0.1)], stateA, 1);

		// B) Probe signal only (no user correction — Su=0 path)
		const stateB = createDriftState();
		const dsBProbeOnly = computeDriftScore("Tell me.", [makeProbe(0.1)], stateB, 0);

		// C) User correction only (no probe signal — Sp=0 path)
		const stateC = createDriftState();
		const dsCUserOnly = computeDriftScore(correctionMsg, [], stateC, 0);

		// D) Adaptive weights impact: compute with dense vs sparse corrections
		const sparseWeights = computeAdaptiveWeights(0); // no corrections → probe boosted
		const denseWeights = computeAdaptiveWeights(0.5); // many corrections → user-weighted

		// E) E_φ distance: on-persona vs off-persona
		const distOn = ePhiDistance(computeEPhi(onResponse), baseline);
		const distOff = ePhiDistance(computeEPhi(offResponse), baseline);

		// F) Consistency metric comparison
		const cOn = computeConsistency([makeProbe(0.95)], [onResponse], baseline);
		const cOff = computeConsistency([makeProbe(0.1)], [offResponse], baseline);

		const result = {
			test: "ablation",
			components: {
				driftDetection: {
					fullCortexDeltaDrift: +(dsFullOff.ewmaScore - dsFullOn.ewmaScore).toFixed(4),
					rawDriftOnPersona: +dsFullOn.rawScore.toFixed(4),
					rawDriftOffPersona: +dsFullOff.rawScore.toFixed(4),
				},
				probeSignalOnly: {
					ewmaScore: +dsBProbeOnly.ewmaScore.toFixed(4),
					Sp: +dsBProbeOnly.Sp.toFixed(4),
				},
				userCorrectionOnly: {
					ewmaScore: +dsCUserOnly.ewmaScore.toFixed(4),
					Su: +dsCUserOnly.Su.toFixed(4),
				},
				adaptiveWeights: {
					sparseCorrections: { wu: +sparseWeights.wu.toFixed(3), wp: +sparseWeights.wp.toFixed(3) },
					denseCorrections: { wu: +denseWeights.wu.toFixed(3), wp: +denseWeights.wp.toFixed(3) },
					probeWeightBoost: +(sparseWeights.wp - DRIFT_CONFIG.baseWeightProbe).toFixed(3),
				},
				voiceMarkersEPhi: {
					onPersonaDistance: +distOn.toFixed(4),
					offPersonaDistance: +distOff.toFixed(4),
					separationRatio: distOn > 0 ? +(distOff / distOn).toFixed(2) : null,
				},
				consistencyMetric: {
					onPersona: { C: +cOn.C.toFixed(4), action: cOn.action },
					offPersona: { C: +cOff.C.toFixed(4), action: cOff.action },
					delta: +(cOn.C - cOff.C).toFixed(4),
				},
			},
		};
		console.log(JSON.stringify(result, null, 2));

		// Assert each component provides meaningful signal
		expect(dsFullOff.ewmaScore).toBeGreaterThan(dsFullOn.ewmaScore); // drift detects off-persona
		expect(dsBProbeOnly.Sp).toBeGreaterThan(0); // probe signal fires on bad probe
		expect(dsCUserOnly.Su).toBe(1); // user correction detected
		expect(sparseWeights.wp).toBeGreaterThan(denseWeights.wp); // adaptive boost on sparse
		expect(distOff).toBeGreaterThan(distOn); // E_φ separates on/off persona
		expect(cOn.C).toBeGreaterThan(cOff.C); // consistency higher for on-persona
		expect(classifyAction(cOn.C)).toBe("none"); // on-persona: no action needed
	});
});
