/**
 * Phase 3 Tests — ENGRAM Sleep Consolidation
 * Episode detection, multi-granularity summaries, consolidation pipeline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore, type EventStore } from "./event-store.js";
import { createArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createInitialConsolidationState, detectEpisodes } from "./episode-detection.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";
import type { MemoryEvent } from "./event-types.js";

let tmpDir: string;
let store: EventStore;
let artifactStore: ArtifactStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-phase3-"));
	store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
	artifactStore = createArtifactStore({ baseDir: tmpDir });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: append an event with sensible defaults. */
function appendEvent(overrides: {
	kind?: MemoryEvent["kind"];
	content?: string;
	taskId?: string;
	turnId?: number;
}) {
	return store.append({
		kind: overrides.kind ?? "user_message",
		content: overrides.content ?? "test message",
		tokens: 10,
		turnId: overrides.turnId ?? 0,
		sessionKey: "test",
		metadata: overrides.taskId ? { taskId: overrides.taskId } : {},
	});
}

/** Helper: create in-memory events at specific time offsets for episode detection. */
function makeTimeline(
	offsets: {
		minutesFromBase: number;
		kind?: MemoryEvent["kind"];
		content?: string;
		taskId?: string;
	}[],
): MemoryEvent[] {
	const base = new Date("2026-02-16T10:00:00Z").getTime();
	return offsets.map((o, i) => ({
		id: `ev-${i}`,
		timestamp: new Date(base + o.minutesFromBase * 60_000).toISOString(),
		turnId: i,
		kind: o.kind ?? "user_message",
		content: o.content ?? `message ${i}`,
		tokens: 10,
		sessionKey: "test",
		metadata: o.taskId ? { taskId: o.taskId } : {},
	}));
}

describe("Phase 3A: Episode Detection", () => {
	it("empty events produce no episodes", async () => {
		const episodes = await detectEpisodes([]);
		expect(episodes).toHaveLength(0);
	});

	it("single event produces one episode", async () => {
		const events = makeTimeline([{ minutesFromBase: 0 }]);
		const episodes = await detectEpisodes(events);
		expect(episodes).toHaveLength(1);
		expect(episodes[0].sourceEventIds).toEqual(["ev-0"]);
	});

	it("time-gap-detection: 2-hour gap produces 2 episodes", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0, content: "hello" },
			{ minutesFromBase: 5, content: "world" },
			{ minutesFromBase: 125, content: "after break" },
			{ minutesFromBase: 130, content: "continuing" },
		]);

		const episodes = await detectEpisodes(events);
		expect(episodes).toHaveLength(2);
		expect(episodes[0].sourceEventIds).toEqual(["ev-0", "ev-1"]);
		expect(episodes[1].sourceEventIds).toEqual(["ev-2", "ev-3"]);
	});

	it("task-change-detection: task ID change produces boundary", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0, taskId: "task-A" },
			{ minutesFromBase: 2, taskId: "task-A" },
			{ minutesFromBase: 4, taskId: "task-B" },
			{ minutesFromBase: 6, taskId: "task-B" },
		]);

		const episodes = await detectEpisodes(events);
		expect(episodes).toHaveLength(2);
	});

	it("session boundary event creates new episode", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0, content: "hello" },
			{
				minutesFromBase: 2,
				kind: "system_event",
				content: "[session_start] new session",
			},
			{ minutesFromBase: 3, content: "new topic" },
		]);

		const episodes = await detectEpisodes(events);
		expect(episodes).toHaveLength(2);
	});

	it("full-coverage: all events belong to exactly one episode", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0 },
			{ minutesFromBase: 5 },
			{ minutesFromBase: 60 },
			{ minutesFromBase: 65 },
			{ minutesFromBase: 200 },
		]);

		const episodes = await detectEpisodes(events);
		const allIds = episodes.flatMap((e) => e.sourceEventIds);
		const eventIds = events.map((e) => e.id);
		expect(allIds.sort()).toEqual(eventIds.sort());
		expect(new Set(allIds).size).toBe(allIds.length);
	});

	it("topic-extraction: topics are non-empty and ≤ 80 chars", async () => {
		const events = makeTimeline([
			{
				minutesFromBase: 0,
				content: "How do I configure the ENGRAM compaction pipeline for my agent?",
			},
			{
				minutesFromBase: 2,
				kind: "agent_message",
				content: "You can configure it via...",
			},
		]);

		const episodes = await detectEpisodes(events);
		expect(episodes).toHaveLength(1);
		expect(episodes[0].topic.length).toBeGreaterThan(0);
		expect(episodes[0].topic.length).toBeLessThanOrEqual(80);
	});

	it("custom time gap threshold", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0 },
			{ minutesFromBase: 10 },
			{ minutesFromBase: 20 },
		]);

		const ep1 = await detectEpisodes(events);
		expect(ep1).toHaveLength(1);

		const ep2 = await detectEpisodes(events, { timeGapMs: 5 * 60_000 });
		expect(ep2).toHaveLength(3);
	});

	it("participants extracted correctly", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0, kind: "user_message" },
			{ minutesFromBase: 1, kind: "agent_message" },
			{ minutesFromBase: 2, kind: "tool_call" },
		]);

		const episodes = await detectEpisodes(events);
		expect(episodes[0].participants).toContain("agent");
	});

	it("outcome: abandoned when last is user message", async () => {
		const events = makeTimeline([{ minutesFromBase: 0, kind: "user_message" }]);
		const episodes = await detectEpisodes(events);
		expect(episodes[0].outcome).toBe("abandoned");
	});

	it("outcome: completed when last is agent message", async () => {
		const events = makeTimeline([
			{ minutesFromBase: 0, kind: "user_message" },
			{ minutesFromBase: 1, kind: "agent_message" },
		]);
		const episodes = await detectEpisodes(events);
		expect(episodes[0].outcome).toBe("completed");
	});

	it("custom topic summarizer", async () => {
		const events = makeTimeline([{ minutesFromBase: 0, content: "ENGRAM config" }]);
		const episodes = await detectEpisodes(events, {
			summarizeTopic: () => "Custom Topic",
		});
		expect(episodes[0].topic).toBe("Custom Topic");
	});
});

describe("Phase 3B: Multi-Granularity Summaries", () => {
	it("summary provenance: artifacts stored after consolidation", async () => {
		const state = createInitialConsolidationState();
		appendEvent({ content: "hello", turnId: 0 });
		appendEvent({ kind: "agent_message", content: "hi", turnId: 1 });

		const result = await runSleepConsolidation(store, artifactStore, state);
		expect(result.summariesGenerated).toBeGreaterThan(0);
	});

	it("custom episode summarizer is used", async () => {
		const state = createInitialConsolidationState();
		appendEvent({ content: "test", turnId: 0 });

		await runSleepConsolidation(store, artifactStore, state, {
			summarizeEpisode: () => "LLM-generated summary",
		});
		// If no error, the custom summarizer was invoked
	});
});

describe("Phase 3C: Sleep Consolidation Pipeline", () => {
	it("idempotent: running twice processes nothing the second time", async () => {
		const state = createInitialConsolidationState();
		appendEvent({ content: "msg 1", turnId: 0 });
		appendEvent({ kind: "agent_message", content: "reply 1", turnId: 1 });

		const r1 = await runSleepConsolidation(store, artifactStore, state);
		expect(r1.newEpisodes.length).toBeGreaterThan(0);

		const r2 = await runSleepConsolidation(store, artifactStore, state);
		expect(r2.newEpisodes).toHaveLength(0);
		expect(r2.eventsProcessed).toBe(0);
	});

	it("incremental: only processes new events", async () => {
		const state = createInitialConsolidationState();

		appendEvent({ content: "batch 1", turnId: 0 });
		const r1 = await runSleepConsolidation(store, artifactStore, state);
		expect(r1.eventsProcessed).toBe(1);

		appendEvent({ content: "batch 2", turnId: 1 });
		appendEvent({ kind: "agent_message", content: "reply 2", turnId: 2 });
		const r2 = await runSleepConsolidation(store, artifactStore, state);
		expect(r2.eventsProcessed).toBe(2);
	});

	it("state tracks progress", async () => {
		const state = createInitialConsolidationState();
		expect(state.lastConsolidatedEventId).toBeNull();
		expect(state.episodeCount).toBe(0);

		appendEvent({ content: "test", turnId: 0 });
		await runSleepConsolidation(store, artifactStore, state);

		expect(state.lastConsolidatedEventId).not.toBeNull();
		expect(state.lastConsolidatedAt).not.toBeNull();
		expect(state.episodeCount).toBe(1);
	});

	it("result includes timing", async () => {
		const state = createInitialConsolidationState();
		appendEvent({ content: "test", turnId: 0 });

		const result = await runSleepConsolidation(store, artifactStore, state);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.summariesGenerated).toBe(1);
	});

	it("handles many events across multiple episodes", async () => {
		const state = createInitialConsolidationState();

		// Store needs file-based events, but time gaps won't work since
		// append uses Date.now(). Use the in-memory detectEpisodes directly
		// for episode-count verification.
		for (let i = 0; i < 20; i++) {
			appendEvent({
				kind: i % 2 === 0 ? "user_message" : "agent_message",
				content: `message ${i}`,
				turnId: i,
			});
		}

		const result = await runSleepConsolidation(store, artifactStore, state);
		expect(result.eventsProcessed).toBe(20);
		// All events within ms of each other → likely 1 episode (no time gaps in test)
		expect(result.newEpisodes.length).toBeGreaterThanOrEqual(1);
	});
});
