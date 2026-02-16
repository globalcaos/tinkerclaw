/**
 * Comprehensive tests for ENGRAM Phase 0 (Metrics, Baseline, Harness)
 * and Phase 1A (Event Store, Artifact Store).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMetricsCollector, type MetricEntry } from "./metrics.js";
import { createEventStore, estimateTokens, generateULID } from "./event-store.js";
import {
	createArtifactStore,
	generatePreview,
	tailLines,
	jsonSkeleton,
	headerPlusRows,
} from "./artifact-store.js";
import type { MemoryEvent } from "./event-types.js";
import { replayTrace, generateSyntheticTrace } from "./test-harness.js";
import needlesFixture from "./__fixtures__/needles.json";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// Phase 0A: Metrics Infrastructure
// ============================================================
describe("Phase 0A: Metrics", () => {
	it("records and reads back metrics", () => {
		const m = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });
		m.record("engram", "test_metric", 42, { foo: "bar" });
		m.record("engram", "test_metric", 43);

		const all = m.readAll();
		expect(all).toHaveLength(2);
		expect(all[0].phase).toBe("engram");
		expect(all[0].metric_name).toBe("test_metric");
		expect(all[0].value).toBe(42);
		expect(all[0].metadata).toEqual({ foo: "bar" });
		expect(all[1].value).toBe(43);
	});

	it("filters by phase", () => {
		const m = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });
		m.record("engram", "a", 1);
		m.record("cortex", "b", 2);
		m.record("engram", "c", 3);

		expect(m.readAll({ phase: "engram" })).toHaveLength(2);
		expect(m.readAll({ phase: "cortex" })).toHaveLength(1);
	});

	it("writes 1000 metrics and preserves ordering", () => {
		const m = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });
		for (let i = 0; i < 1000; i++) {
			m.record("engram", "bulk", i);
		}
		const all = m.readAll();
		expect(all).toHaveLength(1000);
		for (let i = 0; i < 1000; i++) {
			expect(all[i].value).toBe(i);
		}
	});

	it("returns empty array for non-existent file", () => {
		const m = createMetricsCollector({ baseDir: join(tmpDir, "nope"), date: "2099-01-01" });
		// readAll on path that has dir but no file
		expect(m.readAll()).toEqual([]);
	});
});

// ============================================================
// Phase 1A: Event Store
// ============================================================
describe("Phase 1A: Event Store", () => {
	it("write-read-roundtrip: 100 events byte-perfect", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
		const events: MemoryEvent[] = [];

		for (let i = 0; i < 100; i++) {
			events.push(
				store.append({
					turnId: i,
					sessionKey: "test-session",
					kind: "user_message",
					content: `Message ${i}`,
					tokens: 10,
					metadata: {},
				}),
			);
		}

		const read = store.readAll();
		expect(read).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(read[i].id).toBe(events[i].id);
			expect(read[i].content).toBe(`Message ${i}`);
			expect(read[i].turnId).toBe(i);
		}
	});

	it("append-only: no mutation after write", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "immutable" });
		const event = store.append({
			turnId: 1,
			sessionKey: "immutable",
			kind: "user_message",
			content: "original",
			tokens: 5,
			metadata: {},
		});

		// Event store has no update method — that's the invariant
		expect(typeof (store as any).update).toBe("undefined");
		expect(typeof (store as any).delete).toBe("undefined");

		// Re-read from disk
		const store2 = createEventStore({ baseDir: tmpDir, sessionKey: "immutable" });
		const read = store2.readAll();
		expect(read).toHaveLength(1);
		expect(read[0].content).toBe("original");
	});

	it("concurrent write safety: 2 async writers", async () => {
		const store1 = createEventStore({ baseDir: tmpDir, sessionKey: "concurrent" });
		const store2 = createEventStore({ baseDir: tmpDir, sessionKey: "concurrent" });

		const promises = [];
		for (let i = 0; i < 50; i++) {
			promises.push(
				Promise.resolve(
					store1.append({
						turnId: i * 2,
						sessionKey: "concurrent",
						kind: "user_message",
						content: `Writer1-${i}`,
						tokens: 5,
						metadata: {},
					}),
				),
			);
			promises.push(
				Promise.resolve(
					store2.append({
						turnId: i * 2 + 1,
						sessionKey: "concurrent",
						kind: "agent_message",
						content: `Writer2-${i}`,
						tokens: 5,
						metadata: {},
					}),
				),
			);
		}
		await Promise.all(promises);

		// Read from fresh store to verify disk state
		const verifier = createEventStore({ baseDir: tmpDir, sessionKey: "concurrent" });
		const all = verifier.readAll();
		expect(all).toHaveLength(100);
	});

	it("event ordering: ULIDs are monotonic", () => {
		const ids: string[] = [];
		for (let i = 0; i < 100; i++) {
			ids.push(generateULID());
		}
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i] > ids[i - 1]).toBe(true);
		}
	});

	it("token counting: rough estimate within range", () => {
		const text = "Hello world, this is a test message for token counting";
		const tokens = estimateTokens(text);
		// ~4 chars per token, so 54 chars → ~14 tokens
		expect(tokens).toBeGreaterThan(5);
		expect(tokens).toBeLessThan(30);
	});

	it("readByKind filters correctly", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "kinds" });
		store.append({ turnId: 1, sessionKey: "kinds", kind: "user_message", content: "hi", tokens: 2, metadata: {} });
		store.append({ turnId: 2, sessionKey: "kinds", kind: "tool_result", content: "data", tokens: 3, metadata: {} });
		store.append({ turnId: 3, sessionKey: "kinds", kind: "user_message", content: "bye", tokens: 2, metadata: {} });

		expect(store.readByKind("user_message")).toHaveLength(2);
		expect(store.readByKind("tool_result")).toHaveLength(1);
		expect(store.readByKind("agent_message")).toHaveLength(0);
	});

	it("readRange returns correct range", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "range" });
		for (let i = 1; i <= 20; i++) {
			store.append({ turnId: i, sessionKey: "range", kind: "user_message", content: `t${i}`, tokens: 2, metadata: {} });
		}
		const range = store.readRange(5, 10);
		expect(range).toHaveLength(6);
		expect(range[0].turnId).toBe(5);
		expect(range[5].turnId).toBe(10);
	});

	it("readById finds the right event", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "byid" });
		const ev = store.append({ turnId: 1, sessionKey: "byid", kind: "user_message", content: "find me", tokens: 5, metadata: {} });
		expect(store.readById(ev.id)?.content).toBe("find me");
		expect(store.readById("nonexistent")).toBeUndefined();
	});

	it("large store performance: 10K events read < 500ms", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "perf" });
		for (let i = 0; i < 10_000; i++) {
			store.append({
				turnId: i,
				sessionKey: "perf",
				kind: "tool_result",
				content: `data-${i}-${"x".repeat(100)}`,
				tokens: 30,
				metadata: { tags: ["perf"] },
			});
		}

		// Read from fresh store (no cache)
		const store2 = createEventStore({ baseDir: tmpDir, sessionKey: "perf" });
		const start = performance.now();
		const all = store2.readAll();
		const elapsed = performance.now() - start;

		expect(all).toHaveLength(10_000);
		expect(elapsed).toBeLessThan(500);
	});
});

// ============================================================
// Phase 1A: Artifact Store
// ============================================================
describe("Phase 1A: Artifact Store", () => {
	it("stores and retrieves content", () => {
		const as = createArtifactStore({ baseDir: tmpDir });
		const content = "Hello world\nLine 2\nLine 3";
		const preview = as.store(content, "text");

		expect(preview.artifactId).toBeTruthy();
		expect(preview.totalSize).toBe(content.length);
		expect(preview.lineCount).toBe(3);

		const read = as.read(preview.artifactId);
		expect(read).toBe(content);
	});

	it("generates correct preview for each content type", () => {
		// Log: tail lines
		const logPreview = generatePreview("line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12", "log");
		expect(logPreview).toContain("line12");
		expect(logPreview).toContain("omitted");

		// JSON: skeleton
		const jsonPreview = generatePreview(JSON.stringify({ a: 1, b: { c: [1, 2, 3] } }), "json");
		expect(jsonPreview).toContain('"a"');

		// CSV: header + rows
		const csvPreview = generatePreview("name,age\nAlice,30\nBob,25\nCharlie,35\nDave,40", "csv");
		expect(csvPreview).toContain("name,age");
		expect(csvPreview).toContain("Alice");
		expect(csvPreview).toContain("more rows");

		// Text: tail lines
		const textPreview = generatePreview("just a simple text", "text");
		expect(textPreview).toBe("just a simple text");
	});

	it("artifact externalization: large content creates artifact", () => {
		const as = createArtifactStore({ baseDir: tmpDir });
		const largeContent = Array.from({ length: 50 }, (_, i) => `log line ${i}: ${"x".repeat(96)}`).join("\n");
		const preview = as.store(largeContent, "log");

		expect(preview.totalSize).toBeGreaterThan(4000);
		expect(preview.preview.length).toBeLessThan(preview.totalSize);

		const full = as.read(preview.artifactId);
		expect(full).toBe(largeContent);
	});

	it("preview metadata roundtrips", () => {
		const as = createArtifactStore({ baseDir: tmpDir });
		const content = "test content";
		const stored = as.store(content, "text");
		const meta = as.preview(stored.artifactId);

		expect(meta).toBeDefined();
		expect(meta!.artifactId).toBe(stored.artifactId);
		expect(meta!.contentType).toBe("text");
		expect(meta!.totalSize).toBe(content.length);
	});

	it("returns undefined for non-existent artifact", () => {
		const as = createArtifactStore({ baseDir: tmpDir });
		expect(as.read("nonexistent")).toBeUndefined();
		expect(as.preview("nonexistent")).toBeUndefined();
	});
});

// ============================================================
// Phase 0B: Synthetic Trace Generation
// ============================================================
describe("Phase 0B: Synthetic Traces", () => {
	it("generates trace with correct turn count", () => {
		const trace = generateSyntheticTrace({
			turnCount: 50,
			needles: [{ turnId: 10, content: "needle-10" }],
		});
		expect(trace).toHaveLength(50);
	});

	it("embeds needles at correct positions", () => {
		const needles = needlesFixture.needles.map((n, i) => ({
			turnId: (i + 1) * 10,
			content: n.content,
		}));
		const trace = generateSyntheticTrace({ turnCount: 50, needles });

		for (const needle of needles) {
			const turn = trace.find((t) => t.turnId === needle.turnId);
			expect(turn).toBeDefined();
			expect(turn!.content).toBe(needle.content);
		}
	});

	it("flood turns generate substantial token volume", () => {
		const trace = generateSyntheticTrace({
			turnCount: 10,
			needles: [],
			floodTokensPerTurn: 500,
		});
		const totalChars = trace.reduce((sum, t) => sum + t.content.length, 0);
		// 500 tokens * 4 chars * 10 turns ≈ 20K chars minimum
		expect(totalChars).toBeGreaterThan(10000);
	});
});

// ============================================================
// Phase 0C: Test Harness
// ============================================================
describe("Phase 0C: Test Harness", () => {
	it("replays a 10-turn trace correctly", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "harness" });
		const metrics = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });

		const trace = generateSyntheticTrace({
			turnCount: 10,
			needles: [{ turnId: 3, content: "important needle data" }],
		});

		const result = replayTrace(trace, store, metrics);

		expect(result.totalTurns).toBe(10);
		expect(result.totalEvents).toBe(10);
		expect(result.perTurnMetrics).toHaveLength(10);
		expect(result.totalTokens).toBeGreaterThan(0);

		// All events appear in store
		const stored = store.readAll();
		expect(stored).toHaveLength(10);

		// Metrics recorded
		const metricEntries = metrics.readAll();
		expect(metricEntries).toHaveLength(10);
	});

	it("needle is retrievable after replay", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "needle-test" });
		const needleContent = "The secret code is ALPHA-BRAVO-42";
		const trace = generateSyntheticTrace({
			turnCount: 20,
			needles: [{ turnId: 5, content: needleContent }],
		});

		replayTrace(trace, store);

		// Needle is in the store
		const all = store.readAll();
		const needle = all.find((e) => e.content === needleContent);
		expect(needle).toBeDefined();
		expect(needle!.turnId).toBe(5);
	});

	it("cumulative metrics are monotonically increasing", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "monotonic" });
		const trace = generateSyntheticTrace({ turnCount: 20, needles: [] });
		const result = replayTrace(trace, store);

		for (let i = 1; i < result.perTurnMetrics.length; i++) {
			expect(result.perTurnMetrics[i].cumulativeTokens).toBeGreaterThanOrEqual(
				result.perTurnMetrics[i - 1].cumulativeTokens,
			);
			expect(result.perTurnMetrics[i].cumulativeEvents).toBe(
				result.perTurnMetrics[i - 1].cumulativeEvents + 1,
			);
		}
	});
});

// ============================================================
// Preview helper unit tests
// ============================================================
describe("Preview helpers", () => {
	it("tailLines truncates long content", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
		const result = tailLines(lines, 5);
		expect(result).toContain("line-19");
		expect(result).toContain("line-15");
		expect(result).toContain("omitted");
		expect(result).not.toContain("line-0");
	});

	it("jsonSkeleton handles valid JSON", () => {
		const json = JSON.stringify({ key: "value", nested: { a: 1 } });
		const result = jsonSkeleton(json, 7);
		expect(result).toContain('"key"');
	});

	it("jsonSkeleton handles invalid JSON gracefully", () => {
		const result = jsonSkeleton("not json {{{", 5);
		expect(result).toContain("not json");
	});

	it("headerPlusRows shows header and N rows", () => {
		const csv = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n10,11,12";
		const result = headerPlusRows(csv, 2);
		expect(result).toContain("a,b,c");
		expect(result).toContain("1,2,3");
		expect(result).toContain("4,5,6");
		expect(result).toContain("more rows");
		expect(result).not.toContain("7,8,9");
	});
});
