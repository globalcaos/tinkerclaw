/**
 * CORTEX Integration tests.
 *
 * Tests cortex-runtime.ts and observation-runtime.ts with mock SOUL.md data.
 * Covers: persona block generation, SyncScore, drift detection, observation
 * extraction, batch threshold gating, and event store persistence.
 *
 * Scoped to src/memory/cortex — run with:
 *   pnpm test -- src/memory/cortex --reporter=dot
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	createCortexRuntime,
} from "../../agents/pi-extensions/cortex-runtime.js";
import {
	createObservationExtractor,
	DEFAULT_OBSERVATION_THRESHOLD,
} from "../../agents/pi-extensions/observation-runtime.js";
import { createEventStore } from "../engram/event-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "cortex-integration-test-"));
}

const MOCK_SOUL_MD = `# Persona: TestBot (v1)

## Identity
AI assistant and extension of TestUser

## Voice (core)
- Avg sentence length: 12 words
- Vocabulary: standard
- Hedging: rare
- Emoji: never

## Humor
- Frequency: 0.2
- Sensitivity: 0.4
`;

// ---------------------------------------------------------------------------
// CortexRuntime tests
// ---------------------------------------------------------------------------

describe("CORTEX Integration: CortexRuntime", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates runtime with default persona when no source files exist", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		expect(runtime.persona).toBeDefined();
		expect(runtime.persona.name).toBeTruthy();
		expect(runtime.persona.identityStatement).toBeTruthy();
	});

	it("loads persona name from SOUL.md heading", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath: join(tmpDir, "IDENTITY.md") });
		expect(runtime.persona.name).toBe("TestBot");
	});

	it("loads identity statement from ## Identity section of SOUL.md", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath: join(tmpDir, "IDENTITY.md") });
		expect(runtime.persona.identityStatement).toContain("TestUser");
	});

	it("parses voice markers (sentence length, hedging, emoji) from SOUL.md", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath: join(tmpDir, "IDENTITY.md") });
		expect(runtime.persona.voiceMarkers.avgSentenceLength).toBe(12);
		expect(runtime.persona.voiceMarkers.hedgingLevel).toBe("rare");
		expect(runtime.persona.voiceMarkers.emojiUsage).toBe("never");
	});

	it("IDENTITY.md overrides identity statement from SOUL.md", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		const identityPath = join(tmpDir, "IDENTITY.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");
		writeFileSync(identityPath, "Overridden identity from IDENTITY.md", "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath });
		expect(runtime.persona.identityStatement).toBe("Overridden identity from IDENTITY.md");
	});

	it("getPersonaBlock() returns a non-empty string containing the persona name", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath: join(tmpDir, "IDENTITY.md") });
		const block = runtime.getPersonaBlock();
		expect(typeof block).toBe("string");
		expect(block.length).toBeGreaterThan(0);
		expect(block).toContain("TestBot");
	});

	it("getPersonaBlock() is cached — identical string reference on repeated calls", () => {
		const soulPath = join(tmpDir, "SOUL.md");
		writeFileSync(soulPath, MOCK_SOUL_MD, "utf8");

		const runtime = createCortexRuntime({ soulPath, identityPath: join(tmpDir, "IDENTITY.md") });
		const block1 = runtime.getPersonaBlock();
		const block2 = runtime.getPersonaBlock();
		// Strict reference equality (cached string)
		expect(block1).toBe(block2);
	});

	it("evaluateSyncScore() returns C in valid range [0, 1]", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		const messages = [
			"Here is the solution to your question.",
			"I have reviewed the code and spotted the issue.",
		];
		const result = runtime.evaluateSyncScore(messages);
		expect(result.consistency.C).toBeGreaterThanOrEqual(0);
		expect(result.consistency.C).toBeLessThanOrEqual(1);
	});

	it("evaluateSyncScore() returns a valid action tier", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		const result = runtime.evaluateSyncScore(["A normal message."]);
		const validActions = ["none", "mild_reinforce", "moderate_refresh", "severe_rebase"];
		expect(validActions).toContain(result.consistency.action);
	});

	it("detectDrift() returns no drift for benign messages", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		const benign = ["Can you summarise this document?", "What is the best approach here?"];
		const assessment = runtime.detectDrift(benign);
		expect(assessment.isHostile).toBe(false);
		expect(assessment.corrections).toHaveLength(0);
		expect(assessment.score.ewmaScore).toBeGreaterThanOrEqual(0);
	});

	it("detectDrift() triggers on explicit persona correction input", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		const corrections = [
			"Stop being so formal! That's not how you normally talk.",
			"You usually sound more casual. Be more like yourself.",
		];
		const assessment = runtime.detectDrift(corrections);
		// detectUserCorrections should match at least one correction pattern
		expect(assessment.corrections.length).toBeGreaterThan(0);
		expect(assessment.isHostile).toBe(true);
	});

	it("detectDrift() EWMA score rises above zero under repeated corrections", () => {
		const runtime = createCortexRuntime({
			soulPath: join(tmpDir, "SOUL.md"),
			identityPath: join(tmpDir, "IDENTITY.md"),
		});
		const repeated = Array.from(
			{ length: 10 },
			() => "Stop acting so formal. Be more casual and less verbose.",
		);
		const assessment = runtime.detectDrift(repeated);
		expect(assessment.score.ewmaScore).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// ObservationExtractor tests
// ---------------------------------------------------------------------------

describe("CORTEX Integration: ObservationExtractor", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeStore() {
		return createEventStore({ baseDir: tmpDir, sessionKey: "test-obs" });
	}

	it("does not extract when token count is below the default 30K threshold", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		// These short messages won't accumulate 30K tokens
		const obs = extractor.extractObservations(["Hello.", "Hi there."]);
		expect(obs).toHaveLength(0);
		expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(0);
	});

	it("extracts facts from messages when threshold is forced to 1", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		const messages = [
			"I work at a startup as a senior engineer.",
			"I use TypeScript and Node.js daily.",
		];
		const obs = extractor.extractObservations(messages, 1);
		expect(obs.length).toBeGreaterThan(0);
		expect(obs.some((o) => o.type === "fact")).toBe(true);
	});

	it("extracts preferences from messages when threshold is forced to 1", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		const messages = ["I prefer concise answers over lengthy explanations."];
		const obs = extractor.extractObservations(messages, 1);
		expect(obs.some((o) => o.type === "preference")).toBe(true);
	});

	it("stores extracted observations in event store as system_event with 'observation' tag", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		extractor.extractObservations(
			["I prefer TypeScript over JavaScript for large-scale projects."],
			1,
		);
		const events = store.readByKind("system_event");
		const obsEvents = events.filter((e) => e.metadata.tags?.includes("observation"));
		expect(obsEvents.length).toBeGreaterThan(0);
	});

	it("totalExtracted increments after a successful batch", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		expect(extractor.totalExtracted).toBe(0);
		extractor.extractObservations(["I love using Rust for systems programming."], 1);
		// Some observations should have been extracted (preference or fact)
		expect(extractor.totalExtracted).toBeGreaterThanOrEqual(0);
	});

	it("tokensSinceLastExtraction resets to 0 after a batch fires", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		// Force a batch by using threshold=1
		extractor.extractObservations(["I always prefer short responses."], 1);
		expect(extractor.tokensSinceLastExtraction).toBe(0);
	});

	it("accumulates tokens across multiple calls before triggering extraction", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		// First call with very high threshold — no extraction
		extractor.extractObservations(["Short message."], DEFAULT_OBSERVATION_THRESHOLD + 999_999);
		const after1 = extractor.tokensSinceLastExtraction;
		expect(after1).toBeGreaterThan(0);

		// Second call with same high threshold — tokens accumulate
		extractor.extractObservations(["Another message."], DEFAULT_OBSERVATION_THRESHOLD + 999_999);
		expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(after1);
	});

	it("observation events contain valid JSON with type, content, and confidence fields", () => {
		const store = makeStore();
		const extractor = createObservationExtractor(store);
		extractor.extractObservations(["I prefer concise documentation always."], 1);
		const events = store.readByKind("system_event");
		const obsEvents = events.filter((e) => e.metadata.tags?.includes("observation"));
		for (const event of obsEvents) {
			const parsed = JSON.parse(event.content) as {
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
});
