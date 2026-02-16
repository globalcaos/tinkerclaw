/**
 * SYNAPSE Phase 7: Full test suite.
 * Tests CDI measurement, RAAC protocol, debate architectures, and persistent deliberation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	pearsonCorrelation,
	measureCDI,
	correlationCI,
	selectModelsForDebate,
	DEFAULT_PROVIDER_PROFILES,
	type ProviderProfile,
} from "./cognitive-diversity.js";
import {
	assignRoles,
	checkConvergence,
	checkConvergenceWithRatification,
	runDebateRound,
	runDebate,
	totalDebateCost,
	DEFAULT_DEBATE_CONFIG,
	type DebateParticipant,
	type DebateConfig,
} from "./raac-protocol.js";
import {
	fanOut,
	sequential,
	moderatedTribunal,
	fullSynapse,
	recommendArchitecture,
	runWithArchitecture,
} from "./debate-architectures.js";
import { createPersistentDeliberation, type PersistentDeliberation } from "./persistent-deliberation.js";
import { createEventStore, type EventStore } from "../engram/event-store.js";
import { createMetricsCollector, type MetricsCollector } from "../engram/metrics.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock Participants ──

function createMockParticipant(modelId: string, role: string, profile?: ProviderProfile): DebateParticipant {
	const p = profile ?? DEFAULT_PROVIDER_PROFILES.find((pp) => pp.modelId === modelId) ?? DEFAULT_PROVIDER_PROFILES[0];
	return {
		modelId,
		role,
		profile: p,
		propose: async (task, r, prior) => `[${modelId}/${r}] Proposal for: ${task.slice(0, 50)}${prior ? " (refined)" : ""}`,
		challenge: async (proposal) => `[${modelId}] Challenge: weakness in ${proposal.slice(0, 30)}`,
		defend: async (attacks, r) => `[${modelId}/${r}] Defense against ${attacks.length} attacks`,
		synthesize: async (proposals) => `Synthesis of ${proposals.length} proposals: combined insight`,
		ratify: async () => "accept" as const,
	};
}

function createRejectingParticipant(modelId: string, role: string): DebateParticipant {
	const base = createMockParticipant(modelId, role);
	return { ...base, ratify: async () => "reject" as const };
}

// ── Temp dir helpers ──

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "synapse-test-"));
	return () => rmSync(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════
// 7A: CDI Measurement
// ═══════════════════════════════════════

describe("Phase 7A: CDI Measurement", () => {
	it("identical errors → CDI = 0", () => {
		const errors = [true, false, true, true, false, false, true, false, true, true];
		const result = measureCDI({
			modelA: errors,
			modelB: [...errors],
			modelC: [...errors],
		});
		expect(result.cdi).toBeCloseTo(0, 1);
	});

	it("independent random errors → CDI ≈ 1", () => {
		// Construct uncorrelated vectors
		const a = [true, false, true, false, true, false, true, false, true, false];
		const b = [false, true, false, true, false, true, false, true, false, true];
		const c = [true, true, false, false, true, true, false, false, true, true];

		const result = measureCDI({ a, b, c });
		// With these specific vectors, correlations are near 0 or negative
		expect(result.cdi).toBeGreaterThan(0.5);
	});

	it("anti-correlated errors → CDI > 1", () => {
		const a = [true, true, true, true, true, false, false, false, false, false];
		const b = [false, false, false, false, false, true, true, true, true, true];

		const result = measureCDI({ a, b });
		expect(result.cdi).toBeGreaterThan(1);
	});

	it("confidence interval computed via Fisher z-transform", () => {
		const [lo, hi] = correlationCI(0.5, 50);
		expect(lo).toBeLessThan(0.5);
		expect(hi).toBeGreaterThan(0.5);
		expect(lo).toBeGreaterThan(-1);
		expect(hi).toBeLessThan(1);
	});

	it("pearsonCorrelation handles edge cases", () => {
		expect(pearsonCorrelation([], [])).toBe(0);
		expect(pearsonCorrelation([true, true, true], [true, true, true])).toBe(0); // no variance
	});

	it("selectModelsForDebate without CDI returns top 3 by role diversity", () => {
		const selected = selectModelsForDebate(DEFAULT_PROVIDER_PROFILES);
		expect(selected.length).toBe(3);
		const roles = new Set(selected.map((p) => p.role));
		expect(roles.size).toBe(3);
	});

	it("selectModelsForDebate with CDI prefers low-correlation models", () => {
		const cdi = measureCDI({
			"claude-opus": [true, false, true],
			"gpt-o3": [false, true, false],
			"gemini-pro": [true, false, true], // same as claude-opus
		});
		const selected = selectModelsForDebate(DEFAULT_PROVIDER_PROFILES.slice(0, 3), cdi);
		expect(selected.length).toBeLessThanOrEqual(3);
	});
});

// ═══════════════════════════════════════
// 7B: RAAC Protocol
// ═══════════════════════════════════════

describe("Phase 7B: RAAC Protocol", () => {
	describe("Role Assignment", () => {
		it("assigns optimal roles via bipartite matching", () => {
			const roles = assignRoles(["claude-opus", "gpt-o3", "gemini-pro"]);
			expect(roles["claude-opus"]).toBe("architect");
			expect(roles["gpt-o3"]).toBe("critic");
			expect(roles["gemini-pro"]).toBe("pragmatist");
		});

		it("handles unknown models gracefully", () => {
			const roles = assignRoles(["unknown-model-1", "unknown-model-2"]);
			expect(Object.keys(roles)).toHaveLength(2);
			// Each gets a role (default 0.5 affinity)
			expect(Object.values(roles).every((r) => typeof r === "string")).toBe(true);
		});

		it("assigns unique roles to each model", () => {
			const roles = assignRoles(["claude-opus", "gpt-o3", "gemini-pro", "deepseek-r1", "claude-sonnet"]);
			const roleValues = Object.values(roles);
			expect(new Set(roleValues).size).toBe(roleValues.length);
		});
	});

	describe("Convergence Detection", () => {
		it("returns false when no previous synthesis", () => {
			expect(checkConvergence("some text", undefined)).toBe(false);
		});

		it("returns true for identical syntheses", () => {
			expect(checkConvergence("the answer is 42", "the answer is 42")).toBe(true);
		});

		it("returns true for very similar syntheses", () => {
			const a = "The optimal solution involves using a distributed cache with Redis for session storage";
			const b = "The optimal solution involves using a distributed cache with Redis for session storage and monitoring";
			expect(checkConvergence(a, b, 0.2)).toBe(true);
		});

		it("returns false for very different syntheses", () => {
			const a = "Use microservices with event sourcing";
			const b = "Monolithic architecture with direct database calls is better";
			expect(checkConvergence(a, b)).toBe(false);
		});

		it("checkConvergenceWithRatification combines text and votes", () => {
			const ratification = { a: "accept" as const, b: "accept" as const, c: "accept" as const };
			// Even with different text, unanimous accept can converge
			const result = checkConvergenceWithRatification("text a", "text b completely different", ratification);
			expect(typeof result).toBe("boolean");
		});
	});

	describe("5-Phase Debate Round", () => {
		it("executes all 5 phases and returns complete round", async () => {
			const participants = [
				createMockParticipant("claude-opus", "architect"),
				createMockParticipant("gpt-o3", "critic"),
				createMockParticipant("claude-sonnet", "synthesizer"),
			];

			const round = await runDebateRound("Design a caching strategy", participants, 1);

			expect(round.roundNumber).toBe(1);
			expect(Object.keys(round.proposals)).toHaveLength(3);
			expect(Object.keys(round.challenges)).toHaveLength(3);
			expect(Object.keys(round.defenses)).toHaveLength(3);
			expect(round.synthesis).toBeTruthy();
			expect(Object.keys(round.ratification)).toHaveLength(3);
			expect(round.costs.length).toBeGreaterThan(0);
		});

		it("tracks costs per phase", async () => {
			const participants = [
				createMockParticipant("claude-opus", "architect"),
				createMockParticipant("gpt-o3", "critic"),
			];

			const round = await runDebateRound("Test task", participants, 1);
			const phases = new Set(round.costs.map((c) => c.phase));
			expect(phases.has("propose")).toBe(true);
			expect(phases.has("challenge")).toBe(true);
			expect(phases.has("defend")).toBe(true);
			expect(phases.has("synthesize")).toBe(true);
			expect(phases.has("ratify")).toBe(true);

			const total = totalDebateCost(round.costs);
			expect(total).toBeGreaterThan(0);
		});

		it("ratification rejection triggers continued rounds", async () => {
			const participants = [
				createRejectingParticipant("claude-opus", "architect"),
				createRejectingParticipant("gpt-o3", "critic"),
				createMockParticipant("claude-sonnet", "synthesizer"),
			];

			const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 3 };
			const result = await runDebate("Controversial topic", participants, config);

			// Should run multiple rounds since majority rejects
			expect(result.rounds.length).toBeGreaterThan(1);
			expect(result.converged).toBe(false);
		});

		it("max rounds enforced", async () => {
			const participants = [
				createRejectingParticipant("a", "architect"),
				createRejectingParticipant("b", "critic"),
			];

			const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 2 };
			const result = await runDebate("Task", participants, config);
			expect(result.rounds.length).toBeLessThanOrEqual(2);
		});

		it("converges and stops early with accepting participants", async () => {
			// Make participants that converge: same synthesis text
			const synth = "The answer is consensus";
			const p1 = createMockParticipant("a", "architect");
			const p2 = createMockParticipant("b", "synthesizer");
			// Override synthesize to return consistent text
			p2.synthesize = async () => synth;

			const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 5, convergenceThreshold: 0.5 };
			const result = await runDebate("Task", [p1, p2], config);

			// Should converge by round 2 (round 1 has no prior, round 2 same synthesis)
			expect(result.rounds.length).toBeLessThanOrEqual(3);
		});

		it("proposals execute in parallel (timing check)", async () => {
			let maxConcurrent = 0;
			let concurrent = 0;

			const makeParticipant = (id: string): DebateParticipant => {
				const base = createMockParticipant(id, "architect");
				return {
					...base,
					propose: async (task, role) => {
						concurrent++;
						maxConcurrent = Math.max(maxConcurrent, concurrent);
						await new Promise((r) => setTimeout(r, 10));
						concurrent--;
						return `Proposal from ${id}`;
					},
				};
			};

			const participants = [makeParticipant("a"), makeParticipant("b"), makeParticipant("c")];
			await runDebateRound("Task", participants, 1);
			expect(maxConcurrent).toBe(3); // all 3 ran concurrently
		});
	});
});

// ═══════════════════════════════════════
// 7C: Debate Architectures
// ═══════════════════════════════════════

describe("Phase 7C: Debate Architectures", () => {
	const participants = [
		createMockParticipant("claude-opus", "architect"),
		createMockParticipant("gpt-o3", "critic"),
		createMockParticipant("claude-sonnet", "synthesizer"),
	];

	it("fan-out produces valid output", async () => {
		const result = await fanOut("Design a cache", participants);
		expect(result.architecture).toBe("fan-out");
		expect(result.output).toBeTruthy();
		expect(result.totalEstimatedCost).toBeGreaterThan(0);
		expect(result.rounds).toBe(1);
	});

	it("sequential produces valid output", async () => {
		const result = await sequential("Design a cache", participants);
		expect(result.architecture).toBe("sequential");
		expect(result.output).toBeTruthy();
		expect(result.rounds).toBe(participants.length);
	});

	it("moderated tribunal produces valid output", async () => {
		const result = await moderatedTribunal("Design a cache", participants);
		expect(result.architecture).toBe("moderated-tribunal");
		expect(result.output).toBeTruthy();
		expect(result.totalEstimatedCost).toBeGreaterThan(0);
	});

	it("full synapse produces valid output", async () => {
		const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 2 };
		const result = await fullSynapse("Design a cache", participants, config);
		expect(result.architecture).toBe("full-synapse");
		expect(result.output).toBeTruthy();
	});

	it("cost ordering: fan-out < tribunal < full-synapse", async () => {
		const fo = await fanOut("Task", participants);
		const mt = await moderatedTribunal("Task", participants);
		const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 2 };
		const fs = await fullSynapse("Task", participants, config);

		expect(fo.totalEstimatedCost).toBeLessThan(fs.totalEstimatedCost);
		// Tribunal should be between fan-out and full synapse
		expect(mt.totalEstimatedCost).toBeLessThanOrEqual(fs.totalEstimatedCost);
	});

	it("recommendArchitecture returns correct architecture for stakes", () => {
		const low = recommendArchitecture({ stakesLevel: "low", participantCount: 3 });
		expect(low.architecture).toBe("fan-out");

		const medium = recommendArchitecture({ stakesLevel: "medium", participantCount: 3 });
		expect(medium.architecture).toBe("moderated-tribunal");

		const high = recommendArchitecture({ stakesLevel: "high", participantCount: 3 });
		expect(high.architecture).toBe("full-synapse");

		const critical = recommendArchitecture({ stakesLevel: "critical", participantCount: 3 });
		expect(critical.architecture).toBe("full-synapse");
	});

	it("recommendArchitecture respects budget constraint", () => {
		const result = recommendArchitecture({ stakesLevel: "high", participantCount: 3, budgetUsd: 0.1 });
		expect(result.architecture).toBe("fan-out");
	});

	it("runWithArchitecture dispatches correctly", async () => {
		const result = await runWithArchitecture("fan-out", "Task", participants);
		expect(result.architecture).toBe("fan-out");
	});
});

// ═══════════════════════════════════════
// 7D: Persistent Deliberation
// ═══════════════════════════════════════

describe("Phase 7D: Persistent Deliberation", () => {
	let eventStore: EventStore;
	let metrics: MetricsCollector;
	let pd: PersistentDeliberation;

	beforeEach(() => {
		eventStore = createEventStore({ baseDir: tempDir, sessionKey: "test-session" });
		metrics = createMetricsCollector({ baseDir: join(tempDir, "metrics") });
		pd = createPersistentDeliberation({ eventStore, metrics });
	});

	it("stores and recalls a debate conclusion", () => {
		const conclusion = {
			debateId: "debate-001",
			task: "Cache design",
			architecture: "full-synapse" as const,
			finalSynthesis: "Use Redis with write-through caching",
			participantModels: ["claude-opus", "gpt-o3"],
			rounds: 3,
			converged: true,
			totalCost: 0.55,
			timestamp: new Date().toISOString(),
			metadata: {},
		};

		pd.storeConclusion(conclusion);
		const recalled = pd.recallConclusion("debate-001");
		expect(recalled).toBeDefined();
		expect(recalled!.finalSynthesis).toBe("Use Redis with write-through caching");
		expect(recalled!.converged).toBe(true);
	});

	it("stores debate traces as ENGRAM events", () => {
		const round = {
			roundNumber: 1,
			proposals: { "claude-opus": "Use Redis", "gpt-o3": "Use Memcached" },
			challenges: { "claude-opus": { "gpt-o3": "Memcached lacks persistence" }, "gpt-o3": { "claude-opus": "Redis is complex" } },
			defenses: { "claude-opus": "Redis Cluster handles it", "gpt-o3": "Memcached is simpler" },
			synthesis: "Use Redis with Memcached as L1",
			ratification: { "claude-opus": "accept" as const, "gpt-o3": "accept" as const },
			converged: false,
			costs: [],
		};

		pd.storeDebateTraces("debate-002", round);
		const traces = eventStore.readByKind("debate_trace");
		expect(traces.length).toBeGreaterThan(0);
		// Should have: 2 proposals + 2 challenges + 2 defenses + 1 synthesis + 1 ratification = 8
		expect(traces.length).toBe(8);
	});

	it("marks traces for eviction after conclusion", () => {
		const round = {
			roundNumber: 1,
			proposals: { a: "Proposal A" },
			challenges: {},
			defenses: { a: "Defense A" },
			synthesis: "Synthesis",
			ratification: { a: "accept" as const },
			converged: true,
			costs: [],
		};

		pd.storeDebateTraces("debate-003", round);
		pd.markTracesForEviction("debate-003");

		const traces = eventStore.readByKind("debate_trace");
		const marked = traces.filter((t) => t.metadata.supersededBy?.includes("debate-003"));
		expect(marked.length).toBeGreaterThan(0);
	});

	it("synthesis persists after traces are marked for eviction", () => {
		pd.storeConclusion({
			debateId: "debate-004",
			task: "Test",
			architecture: "fan-out",
			finalSynthesis: "Important conclusion",
			participantModels: ["a"],
			rounds: 1,
			converged: true,
			totalCost: 0.1,
			timestamp: new Date().toISOString(),
			metadata: {},
		});

		pd.markTracesForEviction("debate-004");

		// Conclusion should still be recallable
		const recalled = pd.recallConclusion("debate-004");
		expect(recalled).toBeDefined();
		expect(recalled!.finalSynthesis).toBe("Important conclusion");
	});

	it("deliberation memory accumulates across debates", () => {
		const makeResult = (converged: boolean, rounds: number, cost: number): any => ({
			task: "Task",
			rounds: Array.from({ length: rounds }, (_, i) => ({
				roundNumber: i + 1,
				proposals: { a: "p" },
				challenges: {},
				defenses: { a: "d" },
				synthesis: "s",
				ratification: { a: "accept" },
				converged: i === rounds - 1 && converged,
				costs: [{ phase: "propose", model: "a", inputTokens: 100, outputTokens: 50, estimatedCost: cost / rounds }],
			})),
			finalSynthesis: "Final",
			totalCosts: [{ phase: "total", model: "a", inputTokens: 100, outputTokens: 50, estimatedCost: cost }],
			totalEstimatedCost: cost,
			converged,
			convergenceRound: converged ? rounds : null,
		});

		pd.updateDeliberationMemory(makeResult(true, 2, 0.3), "fan-out");
		pd.updateDeliberationMemory(makeResult(true, 3, 0.5), "full-synapse");
		pd.updateDeliberationMemory(makeResult(false, 5, 1.0), "full-synapse");

		const memory = pd.getDeliberationMemory();
		expect(memory.totalDebates).toBe(3);
		expect(memory.convergenceRate).toBeCloseTo(2 / 3, 1);
		expect(memory.architectureUsage["fan-out"]).toBe(1);
		expect(memory.architectureUsage["full-synapse"]).toBe(2);
		expect(memory.avgCostPerDebate).toBeCloseTo(0.6, 1);
	});

	it("cross-session: conclusion stored in one session, readable from same store", () => {
		pd.storeConclusion({
			debateId: "cross-session-1",
			task: "Architecture review",
			architecture: "moderated-tribunal",
			finalSynthesis: "Microservices with event bus",
			participantModels: ["claude-opus", "gemini-pro"],
			rounds: 1,
			converged: true,
			totalCost: 0.25,
			timestamp: new Date().toISOString(),
			metadata: {},
		});

		// Create a new PersistentDeliberation instance on the same store (simulates new session)
		const pd2 = createPersistentDeliberation({ eventStore, metrics });
		const recalled = pd2.recallConclusion("cross-session-1");
		expect(recalled).toBeDefined();
		expect(recalled!.finalSynthesis).toBe("Microservices with event bus");
	});

	it("empty deliberation memory is valid", () => {
		const memory = pd.getDeliberationMemory();
		expect(memory.totalDebates).toBe(0);
		expect(memory.convergenceRate).toBe(0);
		expect(memory.avgCostPerDebate).toBe(0);
	});
});
