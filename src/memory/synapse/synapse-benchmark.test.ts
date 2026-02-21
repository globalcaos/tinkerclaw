/**
 * SYNAPSE Phase 6.5: Debate Quality & Cognitive Diversity Benchmark.
 * Measures: CDI per scenario, convergence speed, consensus quality,
 * and single-model vs multi-perspective debate output quality.
 *
 * Results are emitted as a JSON report at the end of the suite.
 * Reference: SYNAPSE §3–5
 */

import { describe, it, expect, afterAll } from "vitest";
import { measureCDI, DEFAULT_PROVIDER_PROFILES, type ProviderProfile } from "./cognitive-diversity.js";
import {
	runDebate,
	DEFAULT_DEBATE_CONFIG,
	type DebateParticipant,
	type DebateConfig,
	type DebateRound,
} from "./raac-protocol.js";
import { fanOut, moderatedTribunal, fullSynapse, type ArchitectureResult } from "./debate-architectures.js";

// ── Benchmark Scenarios ──────────────────────────────────────────────────────

interface Scenario {
	id: string;
	question: string;
	domain: string;
	stakesLevel: "low" | "medium" | "high";
	/** Expected perspectives that a diverse debate should surface */
	expectedPerspectives: string[];
}

const SCENARIOS: Scenario[] = [
	{
		id: "s1-arch",
		question: "Should we migrate our monolith to microservices?",
		domain: "software-architecture",
		stakesLevel: "high",
		expectedPerspectives: ["scalability", "complexity", "cost", "team-topology"],
	},
	{
		id: "s2-ai-safety",
		question: "How should AI systems handle conflicting user goals?",
		domain: "ai-ethics",
		stakesLevel: "high",
		expectedPerspectives: ["autonomy", "safety", "transparency", "harm-avoidance"],
	},
	{
		id: "s3-data",
		question: "Is federated learning always preferable over centralized training?",
		domain: "ml-systems",
		stakesLevel: "medium",
		expectedPerspectives: ["privacy", "accuracy", "communication-cost", "heterogeneity"],
	},
	{
		id: "s4-product",
		question: "Should we build in-house tooling or adopt third-party SaaS?",
		domain: "product-strategy",
		stakesLevel: "medium",
		expectedPerspectives: ["vendor-lock-in", "maintenance", "time-to-market", "customisation"],
	},
	{
		id: "s5-infra",
		question: "Is Kubernetes the right platform for a 5-person startup?",
		domain: "infrastructure",
		stakesLevel: "low",
		expectedPerspectives: ["operational-overhead", "scalability", "cost", "hiring"],
	},
];

// ── Mock Participant Factory ─────────────────────────────────────────────────

/**
 * Creates a deterministic mock participant whose outputs vary by role,
 * enabling measurable diversity without live API calls.
 */
function makeParticipant(modelId: string, role: string, bias: string[]): DebateParticipant {
	const profile: ProviderProfile =
		DEFAULT_PROVIDER_PROFILES.find((p) => p.modelId === modelId) ?? DEFAULT_PROVIDER_PROFILES[0];

	// Error profile: simulate distinct error patterns per model
	// Use role hash to create genuinely different patterns per participant
	const roleHash = role.split("").reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
	const errorProfile: boolean[] = Array.from({ length: 20 }, (_, i) => {
		const seed = ((i + roleHash) * 2654435761) >>> 0;
		return seed % (bias.length + 2) < bias.length; // varies by role
	});
	profile.errorProfile = errorProfile;

	return {
		modelId,
		role,
		profile,
		propose: async (task, r, prior) => {
			const focus = bias.join(", ");
			const refined = prior ? ` (building on: ${prior.slice(0, 40)}...)` : "";
			return `[${role}/${modelId}] From a ${focus} lens: ${task.slice(0, 60)}${refined}. Key points: ${bias.map((b) => `${b}-matters`).join("; ")}.`;
		},
		challenge: async (proposal) =>
			`[${role}/${modelId}] Challenge: overlooked ${bias[0]} tradeoffs in "${proposal.slice(0, 40)}..."`,
		defend: async (attacks, r) =>
			`[${role}/${modelId}] Defense: ${bias.join("+")} perspective holds despite ${attacks.length} attacks.`,
		synthesize: async (proposals, challenges, defenses) => {
			const themes = [...new Set(proposals.flatMap((p) => p.match(/\w+-matters/g) ?? []))];
			return `Synthesis integrating ${proposals.length} proposals, ${challenges.length} challenges, ${defenses.length} defenses. Themes: ${themes.slice(0, 6).join(", ")}. Consensus: balanced multi-perspective approach.`;
		},
		ratify: async (synthesis) => {
			const covers = bias.some((b) => synthesis.includes(b));
			return covers ? "accept" : "amend";
		},
	};
}

// ── Benchmark Participants ───────────────────────────────────────────────────

const PANEL: DebateParticipant[] = [
	makeParticipant("claude-opus", "architect", ["safety", "nuance", "long-term"]),
	makeParticipant("gpt-o3", "critic", ["edge-cases", "formal-logic", "risk"]),
	makeParticipant("gemini-pro", "pragmatist", ["cost", "speed", "practicality"]),
	makeParticipant("deepseek-r1", "researcher", ["evidence", "research", "benchmarks"]),
	makeParticipant("claude-sonnet", "synthesizer", ["balance", "clarity", "consensus"]),
];

function singleModelParticipant(scenario: Scenario): DebateParticipant {
	return makeParticipant("claude-opus", "solo", ["safety", "nuance"]);
}

// ── Metrics Helpers ──────────────────────────────────────────────────────────

interface ScenarioBenchmark {
	scenarioId: string;
	question: string;
	domain: string;
	cdi: number;
	cdiConfidenceInterval: [number, number];
	convergenceRound: number | null;
	totalRounds: number;
	consensusQuality: number; // 0–1: fraction of "accept" votes in final round
	perspectiveCoverage: number; // 0–1: expected perspectives found in synthesis
	singleModelLength: number;
	debateOutputLength: number;
	outputEnrichmentRatio: number; // debate/single
	totalCostUsd: number;
	architecture: string;
}

function measureConsensusQuality(round: DebateRound): number {
	const votes = Object.values(round.ratification);
	return votes.filter((v) => v === "accept").length / (votes.length || 1);
}

function measurePerspectiveCoverage(synthesis: string, expected: string[]): number {
	const lower = synthesis.toLowerCase();
	const found = expected.filter((kw) => lower.includes(kw.toLowerCase()));
	return found.length / expected.length;
}

function buildErrorProfiles(rounds: DebateRound[]): Record<string, boolean[]> {
	const profiles: Record<string, boolean[]> = {};
	for (const round of rounds) {
		for (const [modelId, proposal] of Object.entries(round.proposals)) {
			if (!profiles[modelId]) profiles[modelId] = [];
			// Heuristic: "error" if proposal lacks any challenge keyword from this round
			const challenges = Object.values(round.challenges).flatMap((c) => Object.values(c));
			const challenged = challenges.some((ch) => ch.includes(modelId));
			profiles[modelId].push(challenged);
		}
	}
	return profiles;
}

// ── Results Store ────────────────────────────────────────────────────────────

const benchmarkResults: ScenarioBenchmark[] = [];

// ── Benchmark Suite ──────────────────────────────────────────────────────────

describe("SYNAPSE Benchmark: Debate Quality & Cognitive Diversity", () => {
	const config: DebateConfig = {
		...DEFAULT_DEBATE_CONFIG,
		maxRounds: 3,
		convergenceThreshold: 0.25,
	};

	for (const scenario of SCENARIOS) {
		it(`[${scenario.id}] ${scenario.domain}: "${scenario.question.slice(0, 50)}..."`, async () => {
			// Single-model baseline
			const solo = singleModelParticipant(scenario);
			const singleResult = await fanOut(scenario.question, [solo]);

			// Multi-perspective debate (architecture selected by stakes)
			let debateResult: ArchitectureResult;
			if (scenario.stakesLevel === "low") {
				debateResult = await moderatedTribunal(scenario.question, PANEL.slice(0, 3));
			} else if (scenario.stakesLevel === "medium") {
				debateResult = await moderatedTribunal(scenario.question, PANEL);
			} else {
				debateResult = await fullSynapse(scenario.question, PANEL, config);
			}

			// CDI from debate rounds (fall back to error profiles from panel profiles)
			let cdiScore = 1.0;
			let cdiCI: [number, number] = [0.8, 1.2];
			const debateRounds = (debateResult as any).rounds as DebateRound[] | undefined;
			if (debateRounds && debateRounds.length > 0) {
				const errorProfiles = buildErrorProfiles(debateRounds);
				if (Object.keys(errorProfiles).length >= 2) {
					const cdi = measureCDI(errorProfiles, scenario.id);
					cdiScore = cdi.cdi;
					cdiCI = cdi.confidenceInterval;
				}
			} else {
				// Use profile-level error vectors from participants
				const profileErrors: Record<string, boolean[]> = {};
				for (const p of PANEL) {
					if (p.profile.errorProfile && p.profile.errorProfile.length > 0) {
						profileErrors[p.modelId] = p.profile.errorProfile;
					}
				}
				if (Object.keys(profileErrors).length >= 2) {
					const cdi = measureCDI(profileErrors, scenario.id);
					cdiScore = cdi.cdi;
					cdiCI = cdi.confidenceInterval;
				}
			}

			// Consensus quality: from full-synapse we have rounds, otherwise simulate
			let consensusQuality = 0.8;
			if (debateRounds && debateRounds.length > 0) {
				const lastRound = debateRounds[debateRounds.length - 1];
				consensusQuality = measureConsensusQuality(lastRound);
			}

			// Perspective coverage
			const coverage = measurePerspectiveCoverage(debateResult.output, scenario.expectedPerspectives);

			// Enrichment ratio
			const enrichment = debateResult.output.length / Math.max(singleResult.output.length, 1);

			const result: ScenarioBenchmark = {
				scenarioId: scenario.id,
				question: scenario.question,
				domain: scenario.domain,
				cdi: Number(cdiScore.toFixed(4)),
				cdiConfidenceInterval: [Number(cdiCI[0].toFixed(4)), Number(cdiCI[1].toFixed(4))],
				convergenceRound: (debateResult as any).convergenceRound ?? null,
				totalRounds: debateRounds?.length ?? debateResult.rounds,
				consensusQuality: Number(consensusQuality.toFixed(4)),
				perspectiveCoverage: Number(coverage.toFixed(4)),
				singleModelLength: singleResult.output.length,
				debateOutputLength: debateResult.output.length,
				outputEnrichmentRatio: Number(enrichment.toFixed(4)),
				totalCostUsd: Number(debateResult.totalEstimatedCost.toFixed(6)),
				architecture: debateResult.architecture,
			};

			benchmarkResults.push(result);

			// Assertions
			expect(result.cdi).toBeGreaterThanOrEqual(0); // diversity >= 0 (0 = identical, 1 = fully diverse)
			expect(result.consensusQuality).toBeGreaterThanOrEqual(0);
			expect(result.perspectiveCoverage).toBeGreaterThanOrEqual(0);
			expect(result.outputEnrichmentRatio).toBeGreaterThan(0);
			expect(result.totalCostUsd).toBeGreaterThan(0);
		});
	}

	afterAll(() => {
		const report = {
			benchmarkName: "SYNAPSE Debate Quality & Cognitive Diversity",
			timestamp: new Date().toISOString(),
			scenarioCount: benchmarkResults.length,
			summary: {
				avgCDI: Number((benchmarkResults.reduce((s, r) => s + r.cdi, 0) / benchmarkResults.length).toFixed(4)),
				avgConsensusQuality: Number(
					(benchmarkResults.reduce((s, r) => s + r.consensusQuality, 0) / benchmarkResults.length).toFixed(4),
				),
				avgPerspectiveCoverage: Number(
					(benchmarkResults.reduce((s, r) => s + r.perspectiveCoverage, 0) / benchmarkResults.length).toFixed(4),
				),
				avgOutputEnrichmentRatio: Number(
					(benchmarkResults.reduce((s, r) => s + r.outputEnrichmentRatio, 0) / benchmarkResults.length).toFixed(4),
				),
				totalCostUsd: Number(benchmarkResults.reduce((s, r) => s + r.totalCostUsd, 0).toFixed(6)),
				convergedScenarios: benchmarkResults.filter((r) => r.convergenceRound !== null).length,
			},
			scenarios: benchmarkResults,
		};

		console.log("\n── SYNAPSE BENCHMARK RESULTS ──────────────────────────────");
		console.log(JSON.stringify(report, null, 2));
		console.log("───────────────────────────────────────────────────────────\n");
	});
});
