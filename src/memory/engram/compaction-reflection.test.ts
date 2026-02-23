/**
 * ENGRAM Phase 1.5: Compaction self-reflection tests.
 *
 * Covers: reflection record creation, severity classification, system_event
 * persistence, graceful handling of missing/empty markers, and learning field.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import { createCompactionReflector, type CompactionReflection } from "./compaction-reflection.js";
import type { CompactionManifest } from "../../agents/pi-extensions/pointer-compaction-runtime.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-reflect-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(sessionKey = "test") {
	return createEventStore({ baseDir: tmpDir, sessionKey });
}

function addCompactionMarker(
	store: ReturnType<typeof makeStore>,
	turnId: number,
	manifest: CompactionManifest,
): MemoryEvent {
	return store.append({
		turnId,
		sessionKey: store.sessionKey,
		kind: "compaction_marker",
		content: JSON.stringify(manifest),
		tokens: 40,
		metadata: { tags: ["pointer_compaction"] },
	});
}

function addRecallPair(
	store: ReturnType<typeof makeStore>,
	turnId: number,
	resultContent: string,
): void {
	store.append({
		turnId,
		sessionKey: store.sessionKey,
		kind: "tool_call",
		content: `recall({ query: "recent decisions" })`,
		tokens: 10,
		metadata: {},
	});
	store.append({
		turnId,
		sessionKey: store.sessionKey,
		kind: "tool_result",
		content: resultContent,
		tokens: Math.ceil(resultContent.length / 4),
		metadata: {},
	});
}

const GOOD_RESULT =
	'{"events":[{"id":"abc","content":"We decided to use TypeScript for the project","score":0.9}],"totalTokens":120}';
const EMPTY_RESULT = '{"events":[],"totalTokens":0}';
const NO_RESULTS_TEXT = "no results found";

const SAMPLE_MANIFEST: CompactionManifest = {
	eventIdRange: ["AAA", "ZZZ"],
	artifactRefs: [],
	topicHints: ["typescript", "architecture"],
	eventCount: 20,
	tokenCount: 4000,
};

// ---------------------------------------------------------------------------
// 1. Reflection record creation — all fields present and typed
// ---------------------------------------------------------------------------

describe("reflection record creation", () => {
	it("returns a reflection with all required fields", () => {
		const store = makeStore("fields-test");
		const marker = addCompactionMarker(store, 10, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: ["typescript"] });

		expect(typeof r.timestamp).toBe("string");
		expect(r.compactionId).toBe(marker.id);
		expect(typeof r.contextTokensBefore).toBe("number");
		expect(typeof r.contextTokensAfter).toBe("number");
		expect(typeof r.retrievalHits).toBe("number");
		expect(typeof r.retrievalMisses).toBe("number");
		expect(typeof r.falsePositives).toBe("number");
		expect(typeof r.diagnosis).toBe("string");
		expect(["none", "auto_added_anchor", "weight_adjusted", "flagged_for_review"]).toContain(
			r.actionTaken,
		);
		expect(["low", "medium", "high"]).toContain(r.severity);
		expect(typeof r.needsHumanReview).toBe("boolean");
		expect(typeof r.learning).toBe("string");
	});

	it("contextTokensAfter is reduced by manifest tokenCount", () => {
		const store = makeStore("tokens-after");
		const marker = addCompactionMarker(store, 5, { ...SAMPLE_MANIFEST, tokenCount: 3000 });
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 8000, activeTopics: [] });
		expect(r.contextTokensBefore).toBe(8000);
		expect(r.contextTokensAfter).toBe(5000);
	});

	it("contextTokensAfter does not go below zero", () => {
		const store = makeStore("tokens-floor");
		const marker = addCompactionMarker(store, 5, { ...SAMPLE_MANIFEST, tokenCount: 99_999 });
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 1000, activeTopics: [] });
		expect(r.contextTokensAfter).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Severity classification
// ---------------------------------------------------------------------------

describe("severity classification", () => {
	it("severity is low when no retrieval activity", () => {
		const store = makeStore("sev-low-no-activity");
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r.severity).toBe("low");
		expect(r.needsHumanReview).toBe(false);
	});

	it("severity is low when all recalls hit", () => {
		const store = makeStore("sev-low-all-hits");
		addRecallPair(store, 3, GOOD_RESULT);
		addRecallPair(store, 4, GOOD_RESULT);
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r.severity).toBe("low");
		expect(r.retrievalHits).toBe(2);
		expect(r.retrievalMisses).toBe(0);
	});

	it("severity is medium with moderate miss rate (>30%)", () => {
		const store = makeStore("sev-medium");
		// 2 hits, 2 misses → 50% miss rate
		addRecallPair(store, 1, GOOD_RESULT);
		addRecallPair(store, 2, GOOD_RESULT);
		addRecallPair(store, 3, EMPTY_RESULT);
		addRecallPair(store, 4, NO_RESULTS_TEXT);
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r.severity).toBe("medium");
		expect(r.actionTaken).toBe("weight_adjusted");
	});

	it("severity is high with dominant misses (>60%)", () => {
		const store = makeStore("sev-high");
		// 1 hit, 4 misses → 80% miss rate
		addRecallPair(store, 1, GOOD_RESULT);
		addRecallPair(store, 2, EMPTY_RESULT);
		addRecallPair(store, 3, EMPTY_RESULT);
		addRecallPair(store, 4, EMPTY_RESULT);
		addRecallPair(store, 5, NO_RESULTS_TEXT);
		const marker = addCompactionMarker(store, 6, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		const r = reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r.severity).toBe("high");
		expect(r.needsHumanReview).toBe(true);
		expect(r.actionTaken).toBe("flagged_for_review");
	});
});

// ---------------------------------------------------------------------------
// 3. Reflection stored as system_event with compaction_reflection tag
// ---------------------------------------------------------------------------

describe("reflection persistence", () => {
	it("stores a system_event after reflect()", () => {
		const store = makeStore("persist-kind");
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });

		const systemEvents = store.readByKind("system_event");
		expect(systemEvents.length).toBeGreaterThanOrEqual(1);
	});

	it("stored system_event is tagged compaction_reflection", () => {
		const store = makeStore("persist-tag");
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });

		const systemEvents = store.readByKind("system_event");
		const reflectionEvent = systemEvents.find((e) =>
			e.metadata.tags?.includes("compaction_reflection"),
		);
		expect(reflectionEvent).toBeDefined();
	});

	it("stored system_event content is a valid CompactionReflection JSON", () => {
		const store = makeStore("persist-json");
		const marker = addCompactionMarker(store, 5, SAMPLE_MANIFEST);
		const reflector = createCompactionReflector(store);

		reflector.reflect(marker.id, { contextTokens: 10_000, activeTopics: [] });

		const systemEvents = store.readByKind("system_event");
		const reflectionEvent = systemEvents.find((e) =>
			e.metadata.tags?.includes("compaction_reflection"),
		);
		expect(() => JSON.parse(reflectionEvent!.content)).not.toThrow();
		const stored = JSON.parse(reflectionEvent!.content) as CompactionReflection;
		expect(stored.compactionId).toBe(marker.id);
		expect(stored.severity).toBeDefined();
		expect(stored.learning).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 4. Empty / missing compaction marker — graceful handling
// ---------------------------------------------------------------------------

describe("empty compaction marker handling", () => {
	it("does not throw when compactionId does not exist", () => {
		const store = makeStore("missing-marker");
		const reflector = createCompactionReflector(store);
		expect(() =>
			reflector.reflect("nonexistent-id", { contextTokens: 5000, activeTopics: [] }),
		).not.toThrow();
	});

	it("returns contextTokensAfter equal to contextTokensBefore when marker is missing", () => {
		const store = makeStore("missing-tokens");
		const reflector = createCompactionReflector(store);
		const r = reflector.reflect("nonexistent-id", { contextTokens: 5000, activeTopics: [] });
		expect(r.contextTokensAfter).toBe(5000);
	});

	it("handles malformed marker content gracefully", () => {
		const store = makeStore("malformed-marker");
		const badMarker = store.append({
			turnId: 1,
			sessionKey: store.sessionKey,
			kind: "compaction_marker",
			content: "NOT_JSON{{{",
			tokens: 10,
			metadata: {},
		});
		const reflector = createCompactionReflector(store);
		expect(() =>
			reflector.reflect(badMarker.id, { contextTokens: 8000, activeTopics: [] }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 5. Learning field populated
// ---------------------------------------------------------------------------

describe("learning field", () => {
	it("learning field is non-empty for all severity levels", () => {
		const store1 = makeStore("learn-low");
		const m1 = addCompactionMarker(store1, 5, SAMPLE_MANIFEST);
		const r1 = createCompactionReflector(store1).reflect(m1.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r1.learning.length).toBeGreaterThan(0);

		const store2 = makeStore("learn-medium");
		addRecallPair(store2, 1, GOOD_RESULT);
		addRecallPair(store2, 2, EMPTY_RESULT);
		addRecallPair(store2, 3, EMPTY_RESULT);
		const m2 = addCompactionMarker(store2, 4, SAMPLE_MANIFEST);
		const r2 = createCompactionReflector(store2).reflect(m2.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r2.learning.length).toBeGreaterThan(0);

		const store3 = makeStore("learn-high");
		for (let i = 1; i <= 5; i++) addRecallPair(store3, i, EMPTY_RESULT);
		const m3 = addCompactionMarker(store3, 6, SAMPLE_MANIFEST);
		const r3 = createCompactionReflector(store3).reflect(m3.id, { contextTokens: 10_000, activeTopics: [] });
		expect(r3.learning.length).toBeGreaterThan(0);
	});

	it("high-severity learning mentions hotTailTurns or anchor tags", () => {
		const store = makeStore("learn-high-hint");
		// Ensure miss-dominated scenario
		for (let i = 1; i <= 5; i++) addRecallPair(store, i, EMPTY_RESULT);
		addRecallPair(store, 6, GOOD_RESULT);
		const marker = addCompactionMarker(store, 7, SAMPLE_MANIFEST);
		const r = createCompactionReflector(store).reflect(marker.id, {
			contextTokens: 10_000,
			activeTopics: [],
		});
		// Learning for high-severity miss-dominated should mention tuning options
		expect(r.learning).toMatch(/hotTailTurns|anchor|review/i);
	});
});

// ---------------------------------------------------------------------------
// 6. reflectCompaction() — structured record and severity routing
// ---------------------------------------------------------------------------

import { appendReflectionJsonl, getDailyDigest } from "./compaction-reflection.js";
import { existsSync, readFileSync } from "node:fs";

describe("reflectCompaction()", () => {
	it("returns low severity and autoFixApplied=true for small compactions", async () => {
		const store = makeStore("reflect-compaction-low");
		const reflector = createCompactionReflector(store);
		const record = await reflector.reflectCompaction({
			eventsCompacted: 5,
			summary: "small compaction summary",
			tokensEvicted: 3_000,
		});
		expect(record.severity).toBe("low");
		expect(record.autoFixApplied).toBe(true);
		expect(record.suggestions.length).toBeGreaterThan(0);
		expect(record.eventsCompacted).toBe(5);
		expect(record.tokensEvicted).toBe(3_000);
		expect(typeof record.timestamp).toBe("string");
	});

	it("returns medium severity for moderate eviction (>15 000 tokens)", async () => {
		const store = makeStore("reflect-compaction-medium");
		const reflector = createCompactionReflector(store);
		const record = await reflector.reflectCompaction({
			eventsCompacted: 20,
			summary: "medium compaction",
			tokensEvicted: 20_000,
		});
		expect(record.severity).toBe("medium");
		expect(record.autoFixApplied).toBe(false);
	});

	it("returns high severity for large eviction (>40 000 tokens) with suggestions", async () => {
		const store = makeStore("reflect-compaction-high");
		const reflector = createCompactionReflector(store);
		const record = await reflector.reflectCompaction({
			eventsCompacted: 80,
			summary: "massive compaction",
			tokensEvicted: 50_000,
		});
		expect(record.severity).toBe("high");
		expect(record.autoFixApplied).toBe(false);
		expect(record.suggestions.some((s) => /hotTailTurns|anchor/i.test(s))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 7. JSONL persistence and daily digest
// ---------------------------------------------------------------------------

describe("JSONL persistence + daily digest", () => {
	it("appendReflectionJsonl writes a parseable JSONL line", () => {
		const dir = join(tmpDir, "reflections");
		const record: import("./compaction-reflection.js").CompactionReflectionRecord = {
			timestamp: new Date().toISOString(),
			severity: "low",
			diagnosis: "[LOW] test",
			suggestions: ["all good"],
			autoFixApplied: true,
			eventsCompacted: 3,
			tokensEvicted: 1000,
		};
		appendReflectionJsonl(record, dir);

		const dateStr = record.timestamp.slice(0, 10);
		const filePath = join(dir, `${dateStr}.jsonl`);
		expect(existsSync(filePath)).toBe(true);
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		const parsed = JSON.parse(lines[0]) as typeof record;
		expect(parsed.severity).toBe("low");
		expect(parsed.eventsCompacted).toBe(3);
	});

	it("getDailyDigest aggregates multiple records correctly", () => {
		const dir = join(tmpDir, "reflections-digest");
		const today = new Date();
		const dateStr = today.toISOString().slice(0, 10);
		const records: import("./compaction-reflection.js").CompactionReflectionRecord[] = [
			{ timestamp: `${dateStr}T01:00:00.000Z`, severity: "low",    diagnosis: "d1", suggestions: [], autoFixApplied: true,  eventsCompacted: 2,  tokensEvicted: 1000 },
			{ timestamp: `${dateStr}T02:00:00.000Z`, severity: "medium", diagnosis: "d2", suggestions: [], autoFixApplied: false, eventsCompacted: 20, tokensEvicted: 18000 },
			{ timestamp: `${dateStr}T03:00:00.000Z`, severity: "high",   diagnosis: "d3", suggestions: [], autoFixApplied: false, eventsCompacted: 120, tokensEvicted: 55000 },
		];
		for (const r of records) appendReflectionJsonl(r, dir);

		const digest = getDailyDigest(today, dir);
		expect(digest.totalReflections).toBe(3);
		expect(digest.severityCounts.low).toBe(1);
		expect(digest.severityCounts.medium).toBe(1);
		expect(digest.severityCounts.high).toBe(1);
		expect(digest.autoFixCount).toBe(1);
		expect(digest.topDiagnoses).toContain("d1");
	});
});
