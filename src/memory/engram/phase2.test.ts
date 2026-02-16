/**
 * Tests for ENGRAM Phase 2A (Embedding Pipeline) and Phase 2B (Task-Conditioned Scoring).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEmbeddingCache } from "./embedding-cache.js";
import { createEmbeddingWorker, type EmbedFn } from "./embedding-worker.js";
import {
	taskConditionedModifier,
	taskConditionedScore,
	premiseCompatibility,
	phaseSalience,
} from "./task-conditioned-scoring.js";
import { createEventStore } from "./event-store.js";
import { vectorSearch, combinedSearch } from "./search-index.js";
import { recall } from "./recall-tool.js";
import { createDefaultTaskState, updateTaskState } from "./task-state.js";
import type { MemoryEvent } from "./event-types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-p2-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Mock embed function that returns deterministic vectors based on content hash. */
function createMockEmbedFn(dimensions = 768): { embedFn: EmbedFn; callCount: () => number } {
	let calls = 0;
	const embedFn: EmbedFn = async (texts: string[]): Promise<Float32Array[]> => {
		calls++;
		return texts.map((text) => {
			const arr = new Float32Array(dimensions);
			// Simple deterministic embedding based on char codes
			for (let i = 0; i < text.length && i < dimensions; i++) {
				arr[i % dimensions] += text.charCodeAt(i) / 256;
			}
			// Normalize
			let norm = 0;
			for (let i = 0; i < dimensions; i++) norm += arr[i] * arr[i];
			norm = Math.sqrt(norm) || 1;
			for (let i = 0; i < dimensions; i++) arr[i] /= norm;
			return arr;
		});
	};
	return { embedFn, callCount: () => calls };
}

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
	return {
		id: `EVT-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		turnId: 1,
		sessionKey: "test",
		kind: "tool_result",
		content: "test content",
		tokens: 10,
		metadata: {},
		...overrides,
	};
}

// ============================================================
// Phase 2A: Embedding Cache
// ============================================================
describe("EmbeddingCache", () => {
	it("stores and retrieves embeddings", () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		const emb = new Float32Array(768).fill(0.5);
		cache.set("evt-1", emb);
		expect(cache.has("evt-1")).toBe(true);
		const got = cache.get("evt-1");
		expect(got).not.toBeNull();
		expect(got!.length).toBe(768);
		expect(got![0]).toBeCloseTo(0.5);
	});

	it("returns null for missing embeddings", () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		expect(cache.get("nonexistent")).toBeNull();
		expect(cache.has("nonexistent")).toBe(false);
	});

	it("rejects wrong dimensions", () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		expect(() => cache.set("evt-1", new Float32Array(100))).toThrow("dimension mismatch");
	});

	it("persists to disk across instances", () => {
		const cache1 = createEmbeddingCache(tmpDir, 4);
		cache1.set("evt-1", new Float32Array([1, 2, 3, 4]));

		const cache2 = createEmbeddingCache(tmpDir, 4);
		const got = cache2.get("evt-1");
		expect(got).not.toBeNull();
		expect(Array.from(got!)).toEqual([1, 2, 3, 4]);
	});
});

// ============================================================
// Phase 2A: Embedding Worker
// ============================================================
describe("EmbeddingWorker", () => {
	it("embeds events and stores in cache", async () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		const { embedFn } = createMockEmbedFn();
		const worker = createEmbeddingWorker({ embedFn, cache, batchSize: 10, batchTimeoutMs: 50 });

		const event = makeEvent({ id: "e1", content: "hello world" });
		worker.enqueue(event);
		await worker.flush();

		expect(cache.has("e1")).toBe(true);
		expect(cache.get("e1")!.length).toBe(768);
		expect(worker.processedCount()).toBe(1);
	});

	it("skips already-cached events (cache hit)", async () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		cache.set("e1", new Float32Array(768).fill(0.1));

		const { embedFn, callCount } = createMockEmbedFn();
		const worker = createEmbeddingWorker({ embedFn, cache, batchSize: 10, batchTimeoutMs: 50 });

		worker.enqueue(makeEvent({ id: "e1", content: "hello" }));
		await worker.flush();

		expect(callCount()).toBe(0); // No API call needed
	});

	it("batches efficiently — 50 events in ≤2 calls", async () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		const { embedFn, callCount } = createMockEmbedFn();
		const worker = createEmbeddingWorker({ embedFn, cache, batchSize: 32, batchTimeoutMs: 50 });

		for (let i = 0; i < 50; i++) {
			worker.enqueue(makeEvent({ id: `e${i}`, content: `content ${i}` }));
		}
		await worker.flush();

		expect(callCount()).toBeLessThanOrEqual(2);
		expect(worker.processedCount()).toBe(50);
	});

	it("reports errors via onError callback", async () => {
		const cache = createEmbeddingCache(tmpDir, 768);
		const failFn: EmbedFn = async () => { throw new Error("API down"); };
		const errors: Array<{ err: Error; ids: string[] }> = [];

		const worker = createEmbeddingWorker({
			embedFn: failFn,
			cache,
			batchSize: 10,
			batchTimeoutMs: 50,
			onError: (err, ids) => errors.push({ err, ids }),
		});

		worker.enqueue(makeEvent({ id: "e1" }));
		await worker.flush();

		expect(errors.length).toBe(1);
		expect(errors[0].err.message).toBe("API down");
	});
});

// ============================================================
// Phase 2A: Vector Search
// ============================================================
describe("vectorSearch", () => {
	it("finds similar events by embedding", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
		const cache = createEmbeddingCache(tmpDir, 768);
		const { embedFn } = createMockEmbedFn();

		// Add events with embeddings
		const e1 = store.append({ turnId: 1, sessionKey: "test", kind: "tool_result", content: "docker build failed with error", tokens: 10, metadata: {} });
		const e2 = store.append({ turnId: 2, sessionKey: "test", kind: "user_message", content: "the weather is nice today", tokens: 10, metadata: {} });

		// Generate embeddings
		const [emb1] = await embedFn(["docker build failed with error"]);
		const [emb2] = await embedFn(["the weather is nice today"]);
		cache.set(e1.id, emb1);
		cache.set(e2.id, emb2);

		const results = await vectorSearch(store, "docker build error", 5, undefined, cache, embedFn);
		expect(results.length).toBe(2);
		expect(results[0].matchType).toBe("vector");
		// Both events returned with scores
		for (const r of results) {
			expect(r.score).toBeGreaterThan(0);
		}
	});

	it("returns empty when no cache provided", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
		const results = await vectorSearch(store, "test query", 5);
		expect(results).toEqual([]);
	});
});

// ============================================================
// Phase 2B: Task-Conditioned Scoring
// ============================================================
describe("taskConditionedModifier", () => {
	it("task-relevant events score higher than cross-task events", () => {
		const taskState = createDefaultTaskState("task-1");
		const sameTask = makeEvent({ kind: "user_message", metadata: { taskId: "task-1", premiseRef: taskState.premiseVersion } });
		const diffTask = makeEvent({ kind: "user_message", metadata: { taskId: "task-2", premiseRef: taskState.premiseVersion } });

		const scoreSame = taskConditionedModifier(sameTask, taskState);
		const scoreDiff = taskConditionedModifier(diffTask, taskState);
		expect(scoreSame).toBeGreaterThan(scoreDiff);
	});

	it("superseded events are penalized", () => {
		const taskState = createDefaultTaskState("task-1");
		const current = makeEvent({ metadata: {} });
		const superseded = makeEvent({ metadata: { supersededBy: "newer-id" } });

		expect(taskConditionedModifier(current, taskState)).toBeGreaterThan(
			taskConditionedModifier(superseded, taskState),
		);
	});

	it("matching premise scores higher than mismatched", () => {
		const taskState = createDefaultTaskState("task-1");
		const matching = makeEvent({ metadata: { premiseRef: taskState.premiseVersion } });
		const mismatched = makeEvent({ metadata: { premiseRef: "old-premise-hash" } });

		expect(taskConditionedModifier(matching, taskState)).toBeGreaterThan(
			taskConditionedModifier(mismatched, taskState),
		);
	});

	it("phase salience: debugging boosts tool_result", () => {
		const debugState = updateTaskState(createDefaultTaskState(), { phase: "debugging" }, 1);
		const planState = updateTaskState(createDefaultTaskState(), { phase: "planning" }, 1);

		const toolResult = makeEvent({ kind: "tool_result", metadata: {} });
		expect(taskConditionedModifier(toolResult, debugState)).toBeGreaterThan(
			taskConditionedModifier(toolResult, planState),
		);
	});

	it("constraint events have a score floor of 3.0", () => {
		const taskState = createDefaultTaskState();
		const constraint = makeEvent({ metadata: { tags: ["constraint"], supersededBy: "x" } });
		expect(taskConditionedModifier(constraint, taskState)).toBeGreaterThanOrEqual(3.0);
	});

	it("score is capped at M_MAX = 10.0", () => {
		const taskState = createDefaultTaskState();
		// Even with all boosters, capped
		const event = makeEvent({ metadata: { tags: ["constraint"], premiseRef: taskState.premiseVersion } });
		expect(taskConditionedModifier(event, taskState)).toBeLessThanOrEqual(10.0);
	});
});

describe("premiseCompatibility", () => {
	it("returns 1.0 for exact match", () => {
		expect(premiseCompatibility("abc", "abc")).toBe(1.0);
	});
	it("returns 0.5 for undefined", () => {
		expect(premiseCompatibility(undefined, "abc")).toBe(0.5);
	});
	it("returns 0.4 for mismatch", () => {
		expect(premiseCompatibility("old", "new")).toBe(0.4);
	});
});

describe("phaseSalience", () => {
	it("debugging boosts tool_result to 2.0", () => {
		expect(phaseSalience("debugging", "tool_result")).toBe(2.0);
	});
	it("idle returns 1.0 for user_message", () => {
		expect(phaseSalience("idle", "user_message")).toBe(1.0);
	});
	it("returns 1.0 for unknown kind", () => {
		expect(phaseSalience("idle", "debate_synthesis")).toBe(1.0);
	});
});

// ============================================================
// Phase 2B: Integration — recall with task-conditioned scoring
// ============================================================
describe("recall with task-conditioned scoring", () => {
	it("ranks current-task events above cross-task events", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
		const taskState = createDefaultTaskState("task-A");

		// Event from current task
		store.append({
			turnId: 1, sessionKey: "test", kind: "user_message",
			content: "nginx config error port 8080",
			tokens: 10, metadata: { taskId: "task-A", premiseRef: taskState.premiseVersion },
		});
		// Event from different task with identical content
		store.append({
			turnId: 2, sessionKey: "test", kind: "user_message",
			content: "nginx config error port 8080",
			tokens: 10, metadata: { taskId: "task-B", premiseRef: taskState.premiseVersion },
		});

		const result = await recall(
			{ query: "nginx config error" },
			store,
			undefined,
			undefined,
			{ taskState },
		);

		expect(result.events.length).toBeGreaterThan(0);
		// First result should be from task-A (higher score due to task relevance)
		expect(result.events[0].event.metadata.taskId).toBe("task-A");
	});

	it("push-pack contents change when task state changes", async () => {
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });

		store.append({
			turnId: 1, sessionKey: "test", kind: "tool_result",
			content: "build log output success", tokens: 10, metadata: {},
		});
		store.append({
			turnId: 2, sessionKey: "test", kind: "user_message",
			content: "review the architecture decision", tokens: 10, metadata: {},
		});

		const debugState = updateTaskState(createDefaultTaskState(), { phase: "debugging" }, 1);
		const reviewState = updateTaskState(createDefaultTaskState(), { phase: "reviewing" }, 1);

		const debugResult = await recall({ query: "build output review" }, store, undefined, undefined, { taskState: debugState });
		const reviewResult = await recall({ query: "build output review" }, store, undefined, undefined, { taskState: reviewState });

		// Scores should differ based on phase
		if (debugResult.events.length > 0 && reviewResult.events.length > 0) {
			// In debugging, tool_result scores higher; in reviewing, user_message scores higher
			const debugToolScore = debugResult.events.find(e => e.event.kind === "tool_result")?.score ?? 0;
			const reviewToolScore = reviewResult.events.find(e => e.event.kind === "tool_result")?.score ?? 0;
			const debugUserScore = debugResult.events.find(e => e.event.kind === "user_message")?.score ?? 0;
			const reviewUserScore = reviewResult.events.find(e => e.event.kind === "user_message")?.score ?? 0;

			// Tool results boosted in debugging
			expect(debugToolScore).toBeGreaterThan(reviewToolScore);
			// User messages boosted in reviewing
			expect(reviewUserScore).toBeGreaterThan(debugUserScore);
		}
	});
});

// ============================================================
// Phase 2B: Ablation framework
// ============================================================
describe("ablation framework", () => {
	it("each scoring factor can be independently evaluated", () => {
		const taskState = createDefaultTaskState("task-1");
		const event = makeEvent({ 
			kind: "tool_result",
			metadata: { taskId: "task-1", premiseRef: taskState.premiseVersion },
		});

		// Base modifier with all factors
		const full = taskConditionedModifier(event, taskState);

		// Each factor contributes independently
		const premCompat = premiseCompatibility(event.metadata.premiseRef, taskState.premiseVersion);
		const phaseSal = phaseSalience(taskState.phase, event.kind);

		expect(premCompat).toBe(1.0); // matching premise
		expect(phaseSal).toBe(0.5); // idle + tool_result
		expect(full).toBeCloseTo(premCompat * phaseSal); // no supersession, same task
	});
});
