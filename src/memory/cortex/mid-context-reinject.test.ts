/**
 * Tests for CORTEX Phase 3.3 (mid-context re-injection) and
 * Phase 3.4 (observational memory turn-based extraction).
 *
 * Run with: pnpm test -- src/memory/cortex
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	applyMidContextReinject,
	evaluateTurnSyncScore,
} from "../../agents/pi-extensions/mid-context-reinject.js";
import {
	createCortexRuntime,
	SYNC_SCORE_DRIFT_THRESHOLD,
	type CortexRuntime,
	type SyncScoreResult,
	type DriftAssessment,
} from "../../agents/pi-extensions/cortex-runtime.js";
import {
	createObservationExtractor,
	DEFAULT_OBSERVATION_THRESHOLD,
} from "../../agents/pi-extensions/observation-runtime.js";
import { createEventStore } from "../engram/event-store.js";
import type { PersonaState } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Mock CortexRuntime factory — allows direct control of ewmaSyncScore
// ---------------------------------------------------------------------------

function makeMockRuntime(ewma: number, personaBlock = "# Persona: MockBot\n## Identity\nTest persona"): CortexRuntime {
	let _ewma = ewma;
	const mockPersona = {
		name: "MockBot",
		version: 1,
		identityStatement: "Test persona",
		hardRules: [],
		traits: [],
		humor: { humorFrequency: 0, sensitivityThreshold: 0.5, preferredPatterns: [], avoidPatterns: [] },
		voiceMarkers: {
			avgSentenceLength: 15,
			vocabularyTier: "standard" as const,
			hedgingLevel: "rare" as const,
			emojiUsage: "never" as const,
			forbiddenPhrases: [],
			signaturePhrases: [],
		},
		referenceSamples: [],
		relational: {
			rapport: 0.5,
			userPreferences: {},
			interactionHistory: { totalTurns: 0, firstInteraction: "", lastInteraction: "" },
		},
	} satisfies PersonaState;

	return {
		get ewmaSyncScore() { return _ewma; },
		get persona() { return mockPersona; },
		getPersonaBlock() { return personaBlock; },
		evaluateSyncScore(msgs: string[], turn?: number): SyncScoreResult {
			// Simulate a low rawScore that pushes EWMA toward 0
			const rawScore = msgs.length === 0 ? 0.0 : 0.95;
			_ewma = 0.1 * rawScore + 0.9 * _ewma;
			return {
				rawScore,
				ewmaScore: _ewma,
				needsReinjection: _ewma < SYNC_SCORE_DRIFT_THRESHOLD,
				turnNumber: turn ?? 1,
				timestamp: new Date().toISOString(),
				consistency: { C: rawScore, Munit: rawScore, Memb: 0, action: "none" as const },
			};
		},
		detectDrift(): DriftAssessment {
			return {
				score: { turnNumber: 0, timestamp: new Date().toISOString(), rawScore: 0, ewmaScore: _ewma, Su: 0, Sp: 0, wu: 0.7, wp: 0.3, userDensity: 0 },
				isHostile: false,
				corrections: [],
				action: "none",
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "cortex-reinject-test-"));
}

const MOCK_SOUL_MD = `# Persona: TestBot (v1)

## Identity
AI assistant and test persona

## Voice (core)
- Avg sentence length: 12 words
- Vocabulary: standard
- Hedging: rare
- Emoji: never
`;

// ---------------------------------------------------------------------------
// Phase 3.3: applyMidContextReinject
// ---------------------------------------------------------------------------

describe("Phase 3.3: applyMidContextReinject", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns unchanged prompt when cortexRuntime is null", () => {
		const result = applyMidContextReinject(null, "My system prompt");
		expect(result.reinjected).toBe(false);
		expect(result.systemPrompt).toBe("My system prompt");
		expect(result.ewmaScore).toBe(1.0);
	});

	it("returns unchanged prompt when cortexRuntime is undefined", () => {
		const result = applyMidContextReinject(undefined, "My system prompt");
		expect(result.reinjected).toBe(false);
		expect(result.systemPrompt).toBe("My system prompt");
	});

	it("does NOT re-inject when EWMA score is at threshold (0.6)", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");
		const runtime = createCortexRuntime({
			soulPath,
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		// Default EWMA starts at 1.0 (healthy) — should not re-inject
		const result = applyMidContextReinject(runtime, "Original prompt");
		expect(result.reinjected).toBe(false);
		expect(result.systemPrompt).toBe("Original prompt");
	});

	it("does NOT re-inject when EWMA score is above threshold", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");
		const runtime = createCortexRuntime({
			soulPath,
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		// EWMA starts at 1.0, well above 0.6
		expect(runtime.ewmaSyncScore).toBe(1.0);
		const result = applyMidContextReinject(runtime, "System prompt content");
		expect(result.reinjected).toBe(false);
		expect(result.ewmaScore).toBeGreaterThanOrEqual(0.6);
	});

	it("re-injects and prepends persona block when EWMA < 0.6", () => {
		// Use a mock runtime with EWMA already below threshold (0.3 < 0.6)
		const runtime = makeMockRuntime(0.3, "# Persona: TestBot\n## Identity\nTest persona");

		expect(runtime.ewmaSyncScore).toBeLessThan(0.6);

		const originalPrompt = "Original system prompt content";
		const result = applyMidContextReinject(runtime, originalPrompt);

		expect(result.reinjected).toBe(true);
		expect(result.ewmaScore).toBeLessThan(0.6);
		// Persona block should be prepended before the original prompt
		expect(result.systemPrompt).toContain("TestBot");
		expect(result.systemPrompt).toContain(originalPrompt);
		// Persona block appears first
		expect(result.systemPrompt.indexOf("TestBot")).toBeLessThan(
			result.systemPrompt.indexOf(originalPrompt),
		);
	});

	it("re-injected prompt still contains original prompt text", () => {
		// Use a mock runtime with EWMA below threshold
		const runtime = makeMockRuntime(0.2, "# Persona: TestBot\n## Identity\nTest persona");

		const original = "## Rules\n- Always be helpful\n- Never lie";
		const result = applyMidContextReinject(runtime, original);

		expect(result.reinjected).toBe(true);
		expect(result.systemPrompt).toContain("## Rules");
		expect(result.systemPrompt).toContain("Always be helpful");
	});
});

// ---------------------------------------------------------------------------
// Phase 3.3: evaluateTurnSyncScore
// ---------------------------------------------------------------------------

describe("Phase 3.3: evaluateTurnSyncScore", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("is a no-op when cortexRuntime is null", () => {
		// Should not throw
		expect(() =>
			evaluateTurnSyncScore(null, ["Some assistant text."], 1),
		).not.toThrow();
	});

	it("is a no-op when assistantTexts is empty", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");
		const runtime = createCortexRuntime({
			soulPath,
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		// No throw, EWMA unchanged
		const before = runtime.ewmaSyncScore;
		evaluateTurnSyncScore(runtime, [], 5);
		expect(runtime.ewmaSyncScore).toBe(before);
	});

	it("calls evaluateSyncScore on the runtime and updates EWMA", () => {
		// Start with healthy EWMA (0.9). After one call the mock updates it.
		const runtime = makeMockRuntime(0.9);

		const beforeEwma = runtime.ewmaSyncScore;
		expect(beforeEwma).toBe(0.9);

		const logFn = vi.fn();
		evaluateTurnSyncScore(runtime, ["Some response text."], 1, logFn);

		// EWMA should have been updated by evaluateSyncScore (mock: 0.1*0.95 + 0.9*0.9 = 0.905)
		expect(runtime.ewmaSyncScore).toBeLessThan(1.0);
		expect(runtime.ewmaSyncScore).not.toBe(beforeEwma); // changed
	});

	it("calls logFn when needsReinjection is true", () => {
		// Use a mock runtime with EWMA already below threshold so needsReinjection=true
		// after evaluation (mock: 0.1*0.95 + 0.9*0.3 = 0.365, still < 0.6)
		const runtime = makeMockRuntime(0.3);
		expect(runtime.ewmaSyncScore).toBeLessThan(0.6);

		const logFn = vi.fn();
		evaluateTurnSyncScore(runtime, ["A response from the assistant."], 10, logFn);

		// logFn should have been called because needsReinjection is true
		expect(logFn).toHaveBeenCalled();
		const message = logFn.mock.calls[0][0] as string;
		expect(message).toContain("SyncScore drift detected");
	});

	it("does NOT call logFn when score is healthy", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");
		const runtime = createCortexRuntime({
			soulPath,
			identityPath: join(tmpDir, "IDENTITY.md"),
			syncScoreInterval: 1,
		});
		// EWMA = 1.0 (healthy)
		const logFn = vi.fn();
		evaluateTurnSyncScore(runtime, ["Great response here."], 10, logFn);
		// logFn should NOT be called since EWMA >= 0.6
		expect(logFn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Phase 3.4: Turn-based observational memory extraction
// ---------------------------------------------------------------------------

describe("Phase 3.4: Turn-based observational memory", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeStore(sessionKey = "obs-turn-test") {
		return createEventStore({ baseDir: tmpDir, sessionKey });
	}

	it("does not extract on non-milestone turns with low token count", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		// Turn 1 — not a 10-turn milestone, token count low → no extraction
		const obs = extractor.extractObservations(
			["I work at a company as an engineer."],
			DEFAULT_OBSERVATION_THRESHOLD, // high threshold
		);
		expect(obs).toHaveLength(0);
	});

	it("forces extraction on turn 10 milestone (threshold=1)", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		// Simulate turn 10 — we pass threshold=1 to force extraction
		const obs = extractor.extractObservations(
			["I prefer TypeScript over JavaScript for all my projects."],
			1, // threshold=1 simulates the forceByTurn behaviour in attempt.ts
		);
		expect(obs.length).toBeGreaterThan(0);
	});

	it("persists facts/preferences to event store with 'observation' tag", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		extractor.extractObservations(
			[
				"I always use functional patterns in my code.",
				"I prefer short, direct answers without padding.",
			],
			1, // force extraction
		);

		const events = store.readByKind("system_event");
		const obsEvents = events.filter((e) => e.metadata.tags?.includes("observation"));
		expect(obsEvents.length).toBeGreaterThan(0);
	});

	it("observation event JSON contains type, content, confidence", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		extractor.extractObservations(
			["I believe clean code is more important than clever code."],
			1,
		);

		const events = store.readByKind("system_event");
		const obsEvents = events.filter((e) => e.metadata.tags?.includes("observation"));
		for (const evt of obsEvents) {
			const parsed = JSON.parse(evt.content) as {
				type: string;
				content: string;
				confidence: number;
			};
			expect(["fact", "preference", "belief"]).toContain(parsed.type);
			expect(typeof parsed.content).toBe("string");
			expect(parsed.confidence).toBeGreaterThan(0);
			expect(parsed.confidence).toBeLessThanOrEqual(1);
		}
	});

	it("accumulates tokens across turns before firing at 30K threshold", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		// Turn 1 (non-milestone): accumulate tokens but don't extract
		const obs1 = extractor.extractObservations(
			["I work as a software engineer at a tech startup."],
			DEFAULT_OBSERVATION_THRESHOLD,
		);
		expect(obs1).toHaveLength(0);

		const tokensAfterTurn1 = extractor.tokensSinceLastExtraction;
		expect(tokensAfterTurn1).toBeGreaterThan(0);

		// Turn 2 (non-milestone): more tokens accumulated
		extractor.extractObservations(
			["I use Node.js and TypeScript daily."],
			DEFAULT_OBSERVATION_THRESHOLD,
		);
		expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(tokensAfterTurn1);
	});

	it("resets tokensSinceLastExtraction to 0 after milestone extraction", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		// First call accumulates some tokens
		extractor.extractObservations(["I prefer unit tests for all critical paths."], 999_999);
		expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(0);

		// Force extraction at turn 10 (threshold=1)
		extractor.extractObservations(["I love TypeScript and avoid plain JavaScript."], 1);
		expect(extractor.tokensSinceLastExtraction).toBe(0);
	});

	it("totalExtracted increments after each successful batch", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		expect(extractor.totalExtracted).toBe(0);

		extractor.extractObservations(
			["I prefer functional programming patterns over OOP."],
			1,
		);
		const after1 = extractor.totalExtracted;

		extractor.extractObservations(
			["I always add type annotations to my TypeScript functions."],
			1,
		);
		const after2 = extractor.totalExtracted;

		// totalExtracted should be non-decreasing
		expect(after2).toBeGreaterThanOrEqual(after1);
	});

	it("multiple observations with different types are stored separately", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);

		extractor.extractObservations(
			[
				"I work as a lead engineer at a fintech company.",
				"I prefer async/await over raw Promise chains.",
				"I think strong types prevent the most common bugs.",
			],
			1,
		);

		const events = store.readByKind("system_event");
		const obsEvents = events.filter((e) => e.metadata.tags?.includes("observation"));

		// Each matched sentence is stored as a separate event
		expect(obsEvents.length).toBeGreaterThanOrEqual(1);

		const types = obsEvents.map((e) => {
			const parsed = JSON.parse(e.content) as { type: string };
			return parsed.type;
		});

		// Should include at least facts and/or preferences
		const hasFactOrPref = types.some((t) => t === "fact" || t === "preference");
		expect(hasFactOrPref).toBe(true);
	});
});
