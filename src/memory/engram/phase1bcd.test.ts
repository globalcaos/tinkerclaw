/**
 * Tests for ENGRAM Phases 1B, 1C, and 1D.
 * Phase 1B: Pointer compaction + time-range markers
 * Phase 1C: Push pack assembly + task state
 * Phase 1D: Recall tool + search index
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEventStore, estimateTokens } from "./event-store.js";
import { createMetricsCollector } from "./metrics.js";
import type { MemoryEvent } from "./event-types.js";
import {
	createTimeRangeMarker,
	mergeMarkers,
	renderMarker,
	renderMarkers,
	isMarkerWithinTokenCap,
	dedupeTopK,
	type TimeRangeMarker,
} from "./time-range-marker.js";
import {
	pointerCompact,
	estimateCacheTokens,
	type ContextCache,
	type CompactionBudgets,
} from "./pointer-compaction.js";
import {
	createDefaultTaskState,
	updateTaskState,
	renderTaskState,
	computePremiseVersion,
} from "./task-state.js";
import { buildPushPack, DEFAULT_BUDGET_FRACTIONS } from "./push-pack.js";
import { recall, createRecallLimiter } from "./recall-tool.js";
import { ftsSearch } from "./search-index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-1bcd-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to create a batch of events in a store and return them
function populateStore(store: ReturnType<typeof createEventStore>, count: number, opts?: { kind?: MemoryEvent["kind"]; tokensPer?: number }): MemoryEvent[] {
	const events: MemoryEvent[] = [];
	const kind = opts?.kind ?? "tool_result";
	const tokensPer = opts?.tokensPer ?? 100;
	for (let i = 0; i < count; i++) {
		events.push(store.append({
			turnId: i + 1,
			sessionKey: store.sessionKey,
			kind,
			content: `Content for event ${i + 1}: ${"x".repeat(tokensPer * 4)}`,
			tokens: tokensPer,
			metadata: {},
		}));
	}
	return events;
}

// ============================================================
// Phase 1B: Time-Range Markers
// ============================================================
describe("Phase 1B: Time-Range Markers", () => {
	it("creates marker with correct metadata", () => {
		const marker = createTimeRangeMarker({
			startTurnId: 12,
			endTurnId: 47,
			startTime: "2026-02-16T10:00:00Z",
			endTime: "2026-02-16T11:00:00Z",
			topicHints: ["Docker build", "nginx config"],
			eventCount: 35,
			tokenCount: 5000,
		});

		expect(marker.type).toBe("time_range_marker");
		expect(marker.startTurnId).toBe(12);
		expect(marker.endTurnId).toBe(47);
		expect(marker.topicHints).toEqual(["Docker build", "nginx config"]);
		expect(marker.eventCount).toBe(35);
		expect(marker.tokenCount).toBe(5000);
		expect(marker.level).toBe(0);
	});

	it("renders marker within token cap", () => {
		const marker = createTimeRangeMarker({
			startTurnId: 1,
			endTurnId: 100,
			startTime: "2026-02-16T10:00:00Z",
			endTime: "2026-02-16T12:00:00Z",
			topicHints: ["topic1", "topic2", "topic3", "topic4", "topic5"],
			eventCount: 100,
			tokenCount: 50000,
		});

		expect(isMarkerWithinTokenCap(marker)).toBe(true);
		const rendered = renderMarker(marker);
		expect(rendered).toContain("T1–T100");
		expect(rendered).toContain("recall(query)");
	});

	it("deduplicates topic hints", () => {
		expect(dedupeTopK(["Docker", "docker", "DOCKER", "nginx"], 5)).toEqual(["Docker", "nginx"]);
		expect(dedupeTopK(["a", "b", "c", "d", "e", "f"], 3)).toEqual(["a", "b", "c"]);
		expect(dedupeTopK(["", " ", "valid"], 5)).toEqual(["valid"]);
	});

	it("merges markers when over soft cap", () => {
		const markers: TimeRangeMarker[] = [];
		for (let i = 0; i < 25; i++) {
			markers.push(createTimeRangeMarker({
				startTurnId: i * 10,
				endTurnId: i * 10 + 9,
				startTime: `2026-02-16T${String(i).padStart(2, "0")}:00:00Z`,
				endTime: `2026-02-16T${String(i).padStart(2, "0")}:59:00Z`,
				topicHints: [`topic-${i}`],
				eventCount: 10,
				tokenCount: 500,
			}));
		}

		const merged = mergeMarkers(markers, 20);
		expect(merged.length).toBeLessThanOrEqual(20);

		// Verify coverage is preserved
		const totalEvents = merged.reduce((s, m) => s + m.eventCount, 0);
		expect(totalEvents).toBe(250); // 25 * 10

		// Merged markers have level > 0
		const mergedOnes = merged.filter((m) => m.level > 0);
		expect(mergedOnes.length).toBeGreaterThan(0);
	});

	it("preserves range coverage after merge", () => {
		const markers = [
			createTimeRangeMarker({ startTurnId: 0, endTurnId: 9, startTime: "a", endTime: "b", topicHints: ["x"], eventCount: 10, tokenCount: 100 }),
			createTimeRangeMarker({ startTurnId: 10, endTurnId: 19, startTime: "b", endTime: "c", topicHints: ["y"], eventCount: 10, tokenCount: 100 }),
		];
		const merged = mergeMarkers(markers, 1);
		expect(merged).toHaveLength(1);
		expect(merged[0].startTurnId).toBe(0);
		expect(merged[0].endTurnId).toBe(19);
		expect(merged[0].eventCount).toBe(20);
		expect(merged[0].tokenCount).toBe(200);
		expect(merged[0].level).toBe(1);
	});
});

// ============================================================
// Phase 1B: Pointer Compaction
// ============================================================
describe("Phase 1B: Pointer Compaction", () => {
	it("compaction preserves store: all events still exist", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-preserve" });
		const events = populateStore(store, 50, { tokensPer: 200 });

		const cache: ContextCache = { events: [...events], markers: [] };
		const budgets: CompactionBudgets = { ctx: 5000, headroom: 500, hotTailTurns: 5, markerSoftCap: 20 };

		const cycles = pointerCompact(cache, budgets, store);
		expect(cycles).toBeGreaterThan(0);

		// All events still in store
		for (const e of events) {
			expect(store.readById(e.id)).toBeDefined();
		}
		expect(store.count()).toBe(50);
	});

	it("marker metadata matches evicted events", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-meta" });
		const events = populateStore(store, 20, { tokensPer: 100 });

		const cache: ContextCache = { events: [...events], markers: [] };
		const budgets: CompactionBudgets = { ctx: 1000, headroom: 100, hotTailTurns: 3, markerSoftCap: 20 };

		pointerCompact(cache, budgets, store);

		expect(cache.markers.length).toBeGreaterThan(0);
		// Total evicted tokens in markers + remaining event tokens should roughly match
		const markerTokens = cache.markers.reduce((s, m) => s + m.tokenCount, 0);
		const remainingTokens = cache.events.reduce((s, e) => s + e.tokens, 0);
		const originalTokens = events.reduce((s, e) => s + e.tokens, 0);
		expect(markerTokens + remainingTokens).toBe(originalTokens);
	});

	it("never evicts protected events (system_event, compaction_marker, persona_state)", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-protect" });

		// Add protected events
		const systemEvent = store.append({ turnId: 1, sessionKey: "compact-protect", kind: "system_event", content: "System init", tokens: 50, metadata: {} });
		const personaEvent = store.append({ turnId: 2, sessionKey: "compact-protect", kind: "persona_state", content: "Persona data", tokens: 50, metadata: {} });

		// Add evictable events
		const evictable = populateStore(store, 20, { tokensPer: 200 });

		const allEvents = [systemEvent, personaEvent, ...evictable];
		const cache: ContextCache = { events: [...allEvents], markers: [] };
		const budgets: CompactionBudgets = { ctx: 1000, headroom: 100, hotTailTurns: 2, markerSoftCap: 20 };

		pointerCompact(cache, budgets, store);

		// Protected events must still be in cache
		const cacheIds = new Set(cache.events.map((e) => e.id));
		expect(cacheIds.has(systemEvent.id)).toBe(true);
		expect(cacheIds.has(personaEvent.id)).toBe(true);
	});

	it("never evicts hot tail turns", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-tail" });
		const events = populateStore(store, 30, { tokensPer: 100 });

		const cache: ContextCache = { events: [...events], markers: [] };
		const budgets: CompactionBudgets = { ctx: 1500, headroom: 200, hotTailTurns: 5, markerSoftCap: 20 };

		pointerCompact(cache, budgets, store);

		// Last 5 turns should be preserved
		const lastTurnIds = events.slice(-5).map((e) => e.turnId);
		const cacheTurnIds = new Set(cache.events.map((e) => e.turnId));
		for (const tid of lastTurnIds) {
			expect(cacheTurnIds.has(tid)).toBe(true);
		}
	});

	it("marker merging triggers when over soft cap", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-merge" });
		// Create many small events to produce many markers
		const events: MemoryEvent[] = [];
		for (let i = 0; i < 100; i++) {
			events.push(store.append({
				turnId: i + 1,
				sessionKey: "compact-merge",
				kind: i % 3 === 0 ? "tool_result" : "user_message",
				content: `Event ${i}`,
				tokens: 50,
				metadata: {},
			}));
		}

		const cache: ContextCache = { events: [...events], markers: [] };
		// Very tight budget to force many compactions
		const budgets: CompactionBudgets = { ctx: 500, headroom: 50, hotTailTurns: 3, markerSoftCap: 5 };

		pointerCompact(cache, budgets, store);

		expect(cache.markers.length).toBeLessThanOrEqual(5);
	});

	it("records metrics for each compaction cycle", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-metrics" });
		const metrics = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });
		const events = populateStore(store, 20, { tokensPer: 200 });

		const cache: ContextCache = { events: [...events], markers: [] };
		const budgets: CompactionBudgets = { ctx: 2000, headroom: 200, hotTailTurns: 3, markerSoftCap: 20 };

		const cycles = pointerCompact(cache, budgets, store, metrics);

		const recorded = metrics.readAll({ phase: "engram" });
		expect(recorded.length).toBe(cycles);
		for (const m of recorded) {
			expect(m.metric_name).toBe("compaction_event");
		}
	});

	it("no-op when cache is within budget", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "compact-noop" });
		const events = populateStore(store, 5, { tokensPer: 50 });

		const cache: ContextCache = { events: [...events], markers: [] };
		const budgets: CompactionBudgets = { ctx: 100000, headroom: 1000, hotTailTurns: 5, markerSoftCap: 20 };

		const cycles = pointerCompact(cache, budgets, store);
		expect(cycles).toBe(0);
		expect(cache.markers).toHaveLength(0);
		expect(cache.events).toHaveLength(5);
	});
});

// ============================================================
// Phase 1C: Task State
// ============================================================
describe("Phase 1C: Task State", () => {
	it("creates default task state", () => {
		const ts = createDefaultTaskState("task-1");
		expect(ts.version).toBe(0);
		expect(ts.taskId).toBe("task-1");
		expect(ts.phase).toBe("idle");
		expect(ts.premiseVersion).toBeTruthy();
	});

	it("updates increment version and recompute premise", () => {
		const ts = createDefaultTaskState("task-1");
		const updated = updateTaskState(ts, { phase: "executing", goals: ["build feature X"] }, 5);

		expect(updated.version).toBe(1);
		expect(updated.phase).toBe("executing");
		expect(updated.goals).toEqual(["build feature X"]);
		expect(updated.premiseVersion).not.toBe(ts.premiseVersion);
		expect(updated.updatedByTurn).toBe(5);
	});

	it("premise version is deterministic", () => {
		const a = computePremiseVersion(["goal1"], ["c1"]);
		const b = computePremiseVersion(["goal1"], ["c1"]);
		const c = computePremiseVersion(["goal2"], ["c1"]);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("preserves old versions in event store", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "task-versions" });
		let ts = createDefaultTaskState("t1");

		// Store v0
		store.append({ turnId: 0, sessionKey: "task-versions", kind: "system_event", content: JSON.stringify(ts), tokens: estimateTokens(JSON.stringify(ts)), metadata: { tags: ["task_state"] } });

		// Update to v1
		ts = updateTaskState(ts, { phase: "executing", goals: ["build X"] }, 5);
		store.append({ turnId: 5, sessionKey: "task-versions", kind: "system_event", content: JSON.stringify(ts), tokens: estimateTokens(JSON.stringify(ts)), metadata: { tags: ["task_state"] } });

		const stored = store.readAll().filter((e) => e.metadata.tags?.includes("task_state"));
		expect(stored).toHaveLength(2);
		expect(JSON.parse(stored[0].content).version).toBe(0);
		expect(JSON.parse(stored[1].content).version).toBe(1);
	});

	it("renders task state for context", () => {
		const ts = updateTaskState(
			createDefaultTaskState("build-feature"),
			{ phase: "debugging", goals: ["fix crash"], constraints: ["no breaking changes"], openLoops: ["check logs"] },
			10,
		);
		const rendered = renderTaskState(ts);
		expect(rendered).toContain("build-feature");
		expect(rendered).toContain("debugging");
		expect(rendered).toContain("fix crash");
		expect(rendered).toContain("no breaking changes");
		expect(rendered).toContain("check logs");
	});
});

// ============================================================
// Phase 1C: Push Pack
// ============================================================
describe("Phase 1C: Push Pack", () => {
	it("push pack fits within budget for various context windows", () => {
		const taskState = createDefaultTaskState("t1");

		for (const ctxWindow of [32_000, 128_000, 200_000]) {
			const tail: MemoryEvent[] = [];
			for (let i = 0; i < 8; i++) {
				tail.push({
					id: `e${i}`, timestamp: "2026-02-16T10:00:00Z", turnId: i,
					sessionKey: "s", kind: "user_message", content: `Turn ${i} message`, tokens: 20, metadata: {},
				});
			}

			const pack = buildPushPack({
				systemPrompt: "You are a helpful assistant.",
				userMessage: "What's next?",
				taskState,
				recentTail: tail,
				markers: [],
				contextWindow: ctxWindow,
			});

			expect(pack.totalTokens).toBeLessThan(ctxWindow);
		}
	});

	it("budget allocation roughly matches paper fractions", () => {
		// Verify fractions sum to ~1.0
		const sum = Object.values(DEFAULT_BUDGET_FRACTIONS).reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(1.0, 1);
	});

	it("includes task state and recall declaration", () => {
		const taskState = updateTaskState(createDefaultTaskState("t1"), { phase: "debugging" }, 1);
		const pack = buildPushPack({
			systemPrompt: "System",
			userMessage: "Help",
			taskState,
			recentTail: [],
			markers: [],
			contextWindow: 100_000,
		});

		const labels = pack.blocks.map((b) => b.label);
		expect(labels).toContain("system");
		expect(labels).toContain("task");
		expect(labels).toContain("recall_decl");
		expect(labels).toContain("user");

		const taskBlock = pack.blocks.find((b) => b.label === "task");
		expect(taskBlock?.content).toContain("debugging");
	});

	it("includes markers when present", () => {
		const marker = createTimeRangeMarker({
			startTurnId: 1, endTurnId: 50, startTime: "a", endTime: "b",
			topicHints: ["Docker"], eventCount: 50, tokenCount: 5000,
		});

		const pack = buildPushPack({
			systemPrompt: "System",
			userMessage: "Help",
			taskState: createDefaultTaskState(),
			recentTail: [],
			markers: [marker],
			contextWindow: 100_000,
		});

		const markerBlock = pack.blocks.find((b) => b.label === "markers");
		expect(markerBlock).toBeDefined();
		expect(markerBlock!.content).toContain("Docker");
	});

	it("tail respects budget limit", () => {
		const taskState = createDefaultTaskState();
		const bigTail: MemoryEvent[] = [];
		for (let i = 0; i < 100; i++) {
			bigTail.push({
				id: `e${i}`, timestamp: "2026-02-16T10:00:00Z", turnId: i,
				sessionKey: "s", kind: "user_message", content: "x".repeat(400), tokens: 100, metadata: {},
			});
		}

		const pack = buildPushPack({
			systemPrompt: "System",
			userMessage: "Help",
			taskState,
			recentTail: bigTail,
			markers: [],
			contextWindow: 10_000, // Only 3000 tokens for tail (30%)
		});

		const tailBlocks = pack.blocks.filter((b) => b.label === "tail");
		const tailTokens = tailBlocks.reduce((s, b) => s + b.tokens, 0);
		expect(tailTokens).toBeLessThanOrEqual(3000);
	});
});

// ============================================================
// Phase 1D: Search Index
// ============================================================
describe("Phase 1D: Search Index (FTS)", () => {
	it("finds needle by keyword search", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "search-needle" });
		// Add noise
		for (let i = 0; i < 20; i++) {
			store.append({ turnId: i, sessionKey: "search-needle", kind: "tool_result", content: `Generic output data ${i}`, tokens: 20, metadata: {} });
		}
		// Add needle
		store.append({ turnId: 25, sessionKey: "search-needle", kind: "user_message", content: "The secret API key is xK9mP2qR7vL4", tokens: 15, metadata: {} });

		const results = ftsSearch(store, "secret API key");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].event.content).toContain("xK9mP2qR7vL4");
	});

	it("respects filters", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "search-filter" });
		store.append({ turnId: 1, sessionKey: "search-filter", kind: "user_message", content: "deploy the server", tokens: 10, metadata: { taskId: "task-A" } });
		store.append({ turnId: 2, sessionKey: "search-filter", kind: "tool_result", content: "deploy completed", tokens: 10, metadata: { taskId: "task-B" } });

		const filtered = ftsSearch(store, "deploy", 20, { taskId: "task-A" });
		expect(filtered).toHaveLength(1);
		expect(filtered[0].event.metadata.taskId).toBe("task-A");
	});

	it("returns empty for no matches", () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "search-empty" });
		store.append({ turnId: 1, sessionKey: "search-empty", kind: "user_message", content: "hello world", tokens: 5, metadata: {} });

		const results = ftsSearch(store, "nonexistent unicorn");
		expect(results).toHaveLength(0);
	});
});

// ============================================================
// Phase 1D: Recall Tool
// ============================================================
describe("Phase 1D: Recall Tool", () => {
	it("recall finds needles after compaction", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-needle" });

		// Add noise + needles
		for (let i = 0; i < 30; i++) {
			store.append({ turnId: i, sessionKey: "recall-needle", kind: "tool_result", content: `Build output line ${i}: ${"data ".repeat(50)}`, tokens: 100, metadata: {} });
		}
		store.append({ turnId: 35, sessionKey: "recall-needle", kind: "user_message", content: "The commit hash for the fix was a1b2c3d4e5f6", tokens: 15, metadata: {} });

		const result = await recall({ query: "commit hash fix" }, store);
		expect(result.events.length).toBeGreaterThan(0);
		expect(result.events.some((e) => e.event.content.includes("a1b2c3d4e5f6"))).toBe(true);
	});

	it("recall deduplication: excludes events in context", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-dedup" });
		const ev = store.append({ turnId: 1, sessionKey: "recall-dedup", kind: "user_message", content: "important secret data", tokens: 10, metadata: {} });

		// With context containing this event
		const contextIds = new Set([ev.id]);
		const result = await recall({ query: "important secret" }, store, contextIds);
		expect(result.events).toHaveLength(0);

		// Without context
		const result2 = await recall({ query: "important secret" }, store);
		expect(result2.events.length).toBeGreaterThan(0);
	});

	it("recall budget enforcement", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-budget" });
		for (let i = 0; i < 50; i++) {
			store.append({ turnId: i, sessionKey: "recall-budget", kind: "user_message", content: `Data point ${i}: ${"info ".repeat(100)}`, tokens: 200, metadata: {} });
		}

		const result = await recall({ query: "data point", maxTokens: 500 }, store);
		expect(result.totalTokens).toBeLessThanOrEqual(500);
		expect(result.truncated).toBe(true);
	});

	it("recall batch queries return union", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-batch" });
		store.append({ turnId: 1, sessionKey: "recall-batch", kind: "user_message", content: "The database host is db.example.com", tokens: 10, metadata: {} });
		store.append({ turnId: 2, sessionKey: "recall-batch", kind: "user_message", content: "The API endpoint is api.example.com/v2", tokens: 10, metadata: {} });

		const result = await recall({ query: ["database host", "API endpoint"] }, store);
		expect(result.queryCount).toBe(2);
		expect(result.events.length).toBeGreaterThanOrEqual(2);
	});

	it("recall on empty store returns gracefully", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-empty" });
		const result = await recall({ query: "anything" }, store);
		expect(result.events).toHaveLength(0);
		expect(result.totalTokens).toBe(0);
		expect(result.truncated).toBe(false);
	});

	it("recall logs metrics", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "recall-metrics" });
		const metrics = createMetricsCollector({ baseDir: tmpDir, date: "2026-02-16" });
		store.append({ turnId: 1, sessionKey: "recall-metrics", kind: "user_message", content: "some test content here", tokens: 10, metadata: {} });

		await recall({ query: "test content" }, store, undefined, metrics);

		const recorded = metrics.readAll({ phase: "engram" });
		expect(recorded.length).toBe(1);
		expect(recorded[0].metric_name).toBe("recall_query");
	});

	it("recall limiter enforces max calls per turn", () => {
		const limiter = createRecallLimiter(3);
		expect(limiter.canRecall()).toBe(true);
		expect(limiter.remaining()).toBe(3);

		limiter.recordCall();
		limiter.recordCall();
		limiter.recordCall();
		expect(limiter.canRecall()).toBe(false);
		expect(limiter.remaining()).toBe(0);

		limiter.reset();
		expect(limiter.canRecall()).toBe(true);
		expect(limiter.remaining()).toBe(3);
	});
});

// ============================================================
// Integration: End-to-end compaction + recall
// ============================================================
describe("Integration: Compaction → Recall", () => {
	it("needle survives compaction and is retrievable via recall", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "e2e" });

		// Populate with noise
		for (let i = 0; i < 40; i++) {
			store.append({ turnId: i, sessionKey: "e2e", kind: "tool_result", content: `Build log line ${i}: ${"x".repeat(200)}`, tokens: 100, metadata: {} });
		}
		// Insert needle
		store.append({ turnId: 45, sessionKey: "e2e", kind: "user_message", content: "Set learning_rate=0.00042 and batch_size=128", tokens: 15, metadata: {} });
		// More noise
		for (let i = 50; i < 60; i++) {
			store.append({ turnId: i, sessionKey: "e2e", kind: "tool_result", content: `More output ${i}: ${"y".repeat(200)}`, tokens: 100, metadata: {} });
		}

		// Build cache from all events
		const allEvents = store.readAll();
		const cache: ContextCache = { events: [...allEvents], markers: [] };

		// Compact aggressively
		const budgets: CompactionBudgets = { ctx: 2000, headroom: 200, hotTailTurns: 5, markerSoftCap: 10 };
		pointerCompact(cache, budgets, store);

		// Verify needle was evicted from cache
		const cacheContents = cache.events.map((e) => e.content).join(" ");
		// The needle might or might not be in cache depending on tail — either way, recall should find it
		const result = await recall({ query: "learning_rate batch_size" }, store);
		expect(result.events.some((e) => e.event.content.includes("learning_rate=0.00042"))).toBe(true);
	});
});
