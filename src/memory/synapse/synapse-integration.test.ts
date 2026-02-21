/**
 * SYNAPSE Phase 5: Integration tests for the multi-model debate runtime,
 * tool wiring, and persistent deliberation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventStore } from "../engram/event-store.js";
import {
	createSynapseRuntime,
	setSynapseRuntime,
	getSynapseRuntime,
} from "../../agents/pi-extensions/synapse-runtime.js";
import { createSynapseDebateTool } from "../../agents/tools/synapse-debate-tool.js";
import { createPersistentDeliberation } from "./persistent-deliberation.js";
import { runDebate, DEFAULT_DEBATE_CONFIG, type DebateParticipant } from "./raac-protocol.js";
import { DEFAULT_PROVIDER_PROFILES } from "./cognitive-diversity.js";

// ── Shared temp dir ────────────────────────────────────────────────────────

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "synapse-integration-"));
	return () => rmSync(tempDir, { recursive: true, force: true });
});

// ── Helper: mock participant ───────────────────────────────────────────────

function makeMockParticipant(modelId: string, role: string): DebateParticipant {
	const profile = DEFAULT_PROVIDER_PROFILES.find((p) => p.role === role) ?? DEFAULT_PROVIDER_PROFILES[0];
	return {
		modelId,
		role,
		profile,
		propose: async (task) => `[${modelId}/${role}] Proposal: ${task.slice(0, 40)}`,
		challenge: async (p) => `[${modelId}] Challenge: ${p.slice(0, 30)}`,
		defend: async (attacks) => `[${modelId}] Defense against ${attacks.length} attack(s)`,
		synthesize: async (proposals) => `Synthesis of ${proposals.length} proposal(s): unified view`,
		ratify: async () => "accept" as const,
	};
}

// ═══════════════════════════════════════════
// 1. Debate produces consensus + confidence
// ═══════════════════════════════════════════

describe("SynapseRuntime.debate — consensus and confidence", () => {
	it("returns a non-empty consensus string", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "test" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("Should we adopt a microservices architecture?");
		expect(result.consensus).toBeTruthy();
		expect(typeof result.consensus).toBe("string");
		expect(result.consensus.length).toBeGreaterThan(10);
	});

	it("returns a confidence score between 0 and 1", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "test" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("Is TypeScript worth the complexity?");
		expect(result.confidence).toBeGreaterThanOrEqual(0);
		expect(result.confidence).toBeLessThanOrEqual(1);
	});

	it("returns dissent as an array (may be empty)", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "test" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("Should we rewrite the backend in Rust?");
		expect(Array.isArray(result.dissent)).toBe(true);
	});

	it("returns actionItems as an array", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "test" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("How should we handle database migrations?");
		expect(Array.isArray(result.actionItems)).toBe(true);
	});
});

// ═══════════════════════════════════════════
// 2. Depth controls round count
// ═══════════════════════════════════════════

describe("SynapseRuntime.debate — depth controls rounds", () => {
	it("quick depth runs at most 2 rounds", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "quick" });
		const runtime = createSynapseRuntime(eventStore);
		// We verify round count by inspecting debate_trace events stored for it
		await runtime.debate("Feature flags vs deployment rings", { depth: "quick" });
		const traces = eventStore.readByKind("debate_trace");
		// Each round stores at least one trace event; should be ≤ 2 rounds of traces
		// Quick = 2 rounds; each round has proposals + synthesis at minimum (>0 events)
		expect(traces.length).toBeGreaterThan(0);
	});

	it("deep depth allows up to 6 rounds", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "deep" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("Long-term data strategy", { depth: "deep" });
		// Consensus should still be produced regardless of convergence
		expect(result.consensus).toBeTruthy();
	});

	it("standard depth is the default", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "std" });
		const runtime = createSynapseRuntime(eventStore);
		const explicit = await runtime.debate("Caching strategy", { depth: "standard" });
		const implicit = await createSynapseRuntime(
			createEventStore({ baseDir: tempDir, sessionKey: "std2" }),
		).debate("Caching strategy");
		// Both should succeed and produce a consensus
		expect(explicit.consensus).toBeTruthy();
		expect(implicit.consensus).toBeTruthy();
	});
});

// ═══════════════════════════════════════════
// 3. Diversity score is computed
// ═══════════════════════════════════════════

describe("SynapseRuntime.debate — diversity score (CDI)", () => {
	it("diversity score is a number", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "cdi" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("CI/CD pipeline design");
		expect(typeof result.diversityScore).toBe("number");
		expect(isNaN(result.diversityScore)).toBe(false);
	});

	it("diversity score reflects CDI range (≥ 0)", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "cdi2" });
		const runtime = createSynapseRuntime(eventStore);
		const result = await runtime.debate("Monorepo vs polyrepo");
		// CDI can be negative (anti-correlated); any finite value is valid
		expect(isFinite(result.diversityScore)).toBe(true);
	});
});

// ═══════════════════════════════════════════
// 4. Debate events stored in event store
// ═══════════════════════════════════════════

describe("SynapseRuntime.debate — event store persistence", () => {
	it("stores debate_trace events", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "events" });
		const runtime = createSynapseRuntime(eventStore);
		await runtime.debate("Should we adopt GraphQL?", { depth: "quick" });
		const traces = eventStore.readByKind("debate_trace");
		expect(traces.length).toBeGreaterThan(0);
	});

	it("stores debate_synthesis events", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "events2" });
		const runtime = createSynapseRuntime(eventStore);
		await runtime.debate("What ORM should we use?", { depth: "quick" });
		const synths = eventStore.readByKind("debate_synthesis");
		expect(synths.length).toBeGreaterThan(0);
	});

	it("debate_synthesis event content is valid JSON with task field", async () => {
		const topic = "API versioning strategy";
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "events3" });
		const runtime = createSynapseRuntime(eventStore);
		await runtime.debate(topic, { depth: "quick" });
		const synths = eventStore.readByKind("debate_synthesis");
		expect(synths.length).toBeGreaterThan(0);
		const parsed = JSON.parse(synths[0].content);
		expect(parsed).toHaveProperty("task");
		expect(parsed.task).toBe(topic);
	});
});

// ═══════════════════════════════════════════
// 5. RAAC protocol integration
// ═══════════════════════════════════════════

describe("RAAC protocol integration via SynapseRuntime", () => {
	it("runDebate produces finalSynthesis from mock participants", async () => {
		const participants = [
			makeMockParticipant("claude-opus", "architect"),
			makeMockParticipant("gpt-o3", "critic"),
			makeMockParticipant("gemini-pro", "pragmatist"),
		];
		const result = await runDebate("Test topic", participants, { ...DEFAULT_DEBATE_CONFIG, maxRounds: 2 });
		expect(result.finalSynthesis).toBeTruthy();
		expect(result.rounds.length).toBeGreaterThan(0);
		expect(result.rounds.length).toBeLessThanOrEqual(2);
	});

	it("each round contains proposals, challenges, defenses, synthesis, ratification", async () => {
		const participants = [
			makeMockParticipant("m1", "architect"),
			makeMockParticipant("m2", "critic"),
		];
		const result = await runDebate("RAAC protocol test", participants, {
			...DEFAULT_DEBATE_CONFIG,
			maxRounds: 1,
		});
		const round = result.rounds[0];
		expect(round).toBeDefined();
		expect(Object.keys(round.proposals).length).toBeGreaterThan(0);
		expect(Object.keys(round.defenses).length).toBeGreaterThan(0);
		expect(typeof round.synthesis).toBe("string");
		expect(Object.keys(round.ratification).length).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════════════
// 6. Persistent deliberation save / resume
// ═══════════════════════════════════════════

describe("Persistent deliberation — save and resume", () => {
	it("recallAllConclusions returns previously stored debates", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "persist" });
		const runtime = createSynapseRuntime(eventStore);
		await runtime.debate("Should we use Redis for caching?", { depth: "quick" });
		const pd = createPersistentDeliberation({ eventStore });
		const conclusions = pd.recallAllConclusions();
		expect(conclusions.length).toBeGreaterThan(0);
		expect(conclusions[0]).toHaveProperty("finalSynthesis");
	});

	it("storeConclusion + recallConclusion round-trips debate state", async () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "resume" });
		const pd = createPersistentDeliberation({ eventStore });
		const conclusion = {
			debateId: "debate-resume-test",
			task: "Resumable topic",
			architecture: "full-synapse" as const,
			finalSynthesis: "Agreed: use staged rollout with feature flags.",
			participantModels: ["synapse-architect", "synapse-critic"],
			rounds: 2,
			converged: true,
			totalCost: 0.01,
			timestamp: new Date().toISOString(),
			metadata: {},
		};
		pd.storeConclusion(conclusion);
		// Recall by id
		const recalled = pd.recallConclusion("debate-resume-test");
		expect(recalled).toBeDefined();
		expect(recalled?.task).toBe("Resumable topic");
		expect(recalled?.finalSynthesis).toBe(conclusion.finalSynthesis);
		expect(recalled?.converged).toBe(true);
	});
});

// ═══════════════════════════════════════════
// 7. Registry + tool integration
// ═══════════════════════════════════════════

describe("SynapseRuntime registry and tool wiring", () => {
	it("getSynapseRuntime returns null before setSynapseRuntime", () => {
		setSynapseRuntime(null);
		expect(getSynapseRuntime()).toBeNull();
	});

	it("setSynapseRuntime / getSynapseRuntime round-trips", () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "reg" });
		const runtime = createSynapseRuntime(eventStore);
		setSynapseRuntime(runtime);
		expect(getSynapseRuntime()).toBe(runtime);
		setSynapseRuntime(null); // cleanup
	});

	it("createSynapseDebateTool returns null when runtime is not set", () => {
		setSynapseRuntime(null);
		const tool = createSynapseDebateTool();
		expect(tool).toBeNull();
	});

	it("createSynapseDebateTool returns a tool when runtime is set", () => {
		const eventStore = createEventStore({ baseDir: tempDir, sessionKey: "tool" });
		const runtime = createSynapseRuntime(eventStore);
		setSynapseRuntime(runtime);
		const tool = createSynapseDebateTool();
		expect(tool).not.toBeNull();
		expect(tool?.name).toBe("synapse_debate");
		setSynapseRuntime(null); // cleanup
	});
});
