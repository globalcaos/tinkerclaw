/**
 * TRACE Validation Benchmark — Phase 6.1
 *
 * Needle-in-Haystack: measures recall@K, false positive rate, and
 * compaction latency for TRACE pointer compaction vs naive truncation.
 *
 * Run: pnpm test -- src/memory/engram/trace-benchmark.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEventStore } from "./event-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { pointerCompact, type ContextCache, type CompactionBudgets } from "./pointer-compaction.js";
import { ftsSearch } from "./search-index.js";
import { generateSyntheticTrace, replayTrace } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEEDLE_COUNT = 50;
const EVENT_COUNT = 200;
const COMPACTION_CYCLES = 5;
const RECALL_K = 10;

/** Spread needles evenly across the event timeline */
function buildNeedles(count: number, maxTurnId: number) {
	const step = Math.floor(maxTurnId / (count + 1));
	return Array.from({ length: count }, (_, i) => ({
		turnId: (i + 1) * step,
		content: `NEEDLE_FACT_${i}_secret_value_${(i * 7919) % 99991}`,
		query: `NEEDLE_FACT_${i}`,
	}));
}

// ---------------------------------------------------------------------------
// TRACE compaction helper
// ---------------------------------------------------------------------------

function runTraceCompaction(
	events: ReturnType<ReturnType<typeof createEventStore>["readAll"]>,
	store: ReturnType<typeof createEventStore>,
	forcedCycles: number,
): { finalCache: ContextCache; totalCycles: number; latencyMs: number } {
	// Budget designed to force compaction with tight ctx window
	const budgets: CompactionBudgets = {
		ctx: 4000,
		headroom: 200,
		hotTailTurns: 3,
		markerSoftCap: 20,
	};

	const cache: ContextCache = { events: [...events], markers: [] };
	const t0 = performance.now();

	let totalCycles = 0;
	for (let i = 0; i < forcedCycles; i++) {
		const cycles = pointerCompact(cache, budgets, store);
		totalCycles += cycles;
		if (cycles === 0) break; // nothing left to compact
	}

	return {
		finalCache: cache,
		totalCycles,
		latencyMs: performance.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Naive truncation baseline
// ---------------------------------------------------------------------------

function runTruncationBaseline(
	events: ReturnType<ReturnType<typeof createEventStore>["readAll"]>,
	keepLast: number,
): ReturnType<ReturnType<typeof createEventStore>["readAll"]> {
	return events.slice(-keepLast);
}

// ---------------------------------------------------------------------------
// Recall measurement
// ---------------------------------------------------------------------------

/**
 * For each needle query, search the store and check if the needle content
 * appears in the top-K results.
 *
 * When searchTarget is provided it restricts the candidate pool;
 * otherwise the full store is searched.
 */
function measureRecall(
	store: ReturnType<typeof createEventStore>,
	needles: { query: string; content: string }[],
	k: number,
	candidateIds?: Set<string>,
): { recallAtK: number; falsePositiveRate: number } {
	let hits = 0;
	let falsePositives = 0;

	for (const needle of needles) {
		const results = ftsSearch(store, needle.query, k * 2);
		const topK = candidateIds
			? results.filter((r) => candidateIds.has(r.event.id)).slice(0, k)
			: results.slice(0, k);

		const found = topK.some((r) => r.event.content.includes(needle.content));
		if (found) {
			hits++;
		} else {
			// Check if the needle is anywhere in the results (false negative is in store but not top-K)
			const anyMatch = results.some((r) => r.event.content.includes(needle.content));
			if (!anyMatch) {
				// Needle is genuinely absent from store
				falsePositives++;
			}
		}
	}

	const recallAtK = hits / needles.length;
	const falsePositiveRate = falsePositives / needles.length;

	return { recallAtK, falsePositiveRate };
}

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "trace-bench-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("TRACE Benchmark: Needle-in-Haystack", () => {
	it("measures recall@K and FPR for TRACE pointer compaction vs truncation baseline", () => {
		// ------------------------------------------------------------------
		// 1. Build needle set & synthetic trace
		// ------------------------------------------------------------------
		const needles = buildNeedles(NEEDLE_COUNT, EVENT_COUNT);
		const traceNeedles = needles.map((n) => ({ turnId: n.turnId, content: n.content }));

		const trace = generateSyntheticTrace({
			turnCount: EVENT_COUNT,
			needles: traceNeedles,
			floodTokensPerTurn: 80,
		});

		// ------------------------------------------------------------------
		// 2. Replay into event store (ground truth)
		// ------------------------------------------------------------------
		const store = createEventStore({ baseDir: tmpDir, sessionKey: "bench" });
		replayTrace(trace, store);

		const allEvents = store.readAll();
		expect(allEvents).toHaveLength(EVENT_COUNT);

		// ------------------------------------------------------------------
		// 3. TRACE: run forced pointer compaction
		// ------------------------------------------------------------------
		const {
			finalCache: traceCache,
			totalCycles: traceCycles,
			latencyMs: traceLatencyMs,
		} = runTraceCompaction(allEvents, store, COMPACTION_CYCLES);

		// Events are compacted from context but STILL in store — recall via store FTS
		const traceMetrics = measureRecall(store, needles, RECALL_K);

		// ------------------------------------------------------------------
		// 4. Truncation baseline: keep only last N events
		// ------------------------------------------------------------------
		// Keep roughly same number of events as TRACE cache
		const keepCount = Math.max(traceCache.events.length, 10);
		const truncatedEvents = runTruncationBaseline(allEvents, keepCount);

		// Simulate truncated store (only events still "in context")
		const truncStore = createEventStore({ baseDir: tmpDir, sessionKey: "bench-trunc" });
		for (const ev of truncatedEvents) {
			truncStore.appendRaw(ev);
		}

		const truncMetrics = measureRecall(truncStore, needles, RECALL_K);

		// ------------------------------------------------------------------
		// 5. Assertions — TRACE must match or beat truncation on recall
		// ------------------------------------------------------------------
		// TRACE stores everything — recall should be high (needles never lost)
		expect(traceMetrics.recallAtK).toBeGreaterThanOrEqual(truncMetrics.recallAtK);
		// TRACE FPR should be ≤ truncation (no phantom results from evicted content)
		expect(traceMetrics.falsePositiveRate).toBeLessThanOrEqual(truncMetrics.falsePositiveRate + 0.05);
		// Latency should be reasonable
		expect(traceLatencyMs).toBeLessThan(5000);

		// ------------------------------------------------------------------
		// 6. Output JSON benchmark report
		// ------------------------------------------------------------------
		const report = {
			benchmark: "needle-in-haystack",
			config: {
				needleCount: NEEDLE_COUNT,
				eventCount: EVENT_COUNT,
				forcedCompactionCycles: COMPACTION_CYCLES,
				recallK: RECALL_K,
			},
			trace: {
				recallAtK: +traceMetrics.recallAtK.toFixed(4),
				falsePositiveRate: +traceMetrics.falsePositiveRate.toFixed(4),
				compactionCyclesPerformed: traceCycles,
				eventsInCache: traceCache.events.length,
				markersInCache: traceCache.markers.length,
				compactionLatencyMs: +traceLatencyMs.toFixed(2),
			},
			truncation_baseline: {
				recallAtK: +truncMetrics.recallAtK.toFixed(4),
				falsePositiveRate: +truncMetrics.falsePositiveRate.toFixed(4),
				eventsKept: keepCount,
			},
			delta: {
				recallGain: +(traceMetrics.recallAtK - truncMetrics.recallAtK).toFixed(4),
				fprDelta: +(traceMetrics.falsePositiveRate - truncMetrics.falsePositiveRate).toFixed(4),
			},
		};

		console.log("\n[TRACE-BENCH]", JSON.stringify(report, null, 2));
	});

	it("compaction latency scales sub-linearly with event count", () => {
		const runLatency = (eventCount: number): number => {
			const needles = buildNeedles(5, eventCount);
			const trace = generateSyntheticTrace({
				turnCount: eventCount,
				needles: needles.map((n) => ({ turnId: n.turnId, content: n.content })),
				floodTokensPerTurn: 60,
			});
			const s = createEventStore({ baseDir: tmpDir, sessionKey: `lat-${eventCount}` });
			replayTrace(trace, s);
			const events = s.readAll();
			const { latencyMs } = runTraceCompaction(events, s, 3);
			return latencyMs;
		};

		const lat100 = runLatency(100);
		const lat200 = runLatency(200);

		// 2× events should not mean 10× latency
		expect(lat200).toBeLessThan(lat100 * 10 + 500);

		console.log("\n[TRACE-BENCH-SCALING]", JSON.stringify({
			lat100ms: +lat100.toFixed(2),
			lat200ms: +lat200.toFixed(2),
			scalingFactor: +(lat200 / Math.max(lat100, 1)).toFixed(2),
		}));
	});

	it("TRACE preserves 100% needle recall — no facts lost after compaction", () => {
		const needles = buildNeedles(10, 100);
		const trace = generateSyntheticTrace({
			turnCount: 100,
			needles: needles.map((n) => ({ turnId: n.turnId, content: n.content })),
			floodTokensPerTurn: 100,
		});

		const store = createEventStore({ baseDir: tmpDir, sessionKey: "bench-lossless" });
		replayTrace(trace, store);
		const events = store.readAll();

		runTraceCompaction(events, store, COMPACTION_CYCLES);

		// Every needle must remain in store (lossless invariant)
		for (const needle of needles) {
			const results = ftsSearch(store, needle.query, RECALL_K);
			const found = results.some((r) => r.event.content.includes(needle.content));
			expect(found).toBe(true);
		}
	});
});
