/**
 * ENGRAM Phase 1.4 — Sleep Consolidation Cron Tests
 *
 * Verifies that runSleepConsolidation (cron wrapper):
 *   - Produces episode summaries on first run
 *   - Persists state to disk for incremental operation
 *   - Is idempotent — second run without new events does nothing
 *   - Only processes new events after the first run
 *   - Respects custom session keys, log functions, and episode summarizers
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore, type EventStore } from "../../memory/engram/event-store.js";
import type { MemoryEvent } from "../../memory/engram/event-types.js";
import { runSleepConsolidation } from "./sleep-consolidation-cron.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "sleep-cron-"));
	store = createEventStore({ baseDir: tmpDir, sessionKey: "default" });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function appendEvent(overrides: {
	kind?: MemoryEvent["kind"];
	content?: string;
	turnId?: number;
}): MemoryEvent {
	return store.append({
		kind: overrides.kind ?? "user_message",
		content: overrides.content ?? "test message",
		tokens: 10,
		turnId: overrides.turnId ?? 0,
		sessionKey: "default",
		metadata: {},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SleepConsolidationCron", () => {
	it("empty store produces no episodes or summaries", async () => {
		const result = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		expect(result.newEpisodes).toHaveLength(0);
		expect(result.eventsProcessed).toBe(0);
		expect(result.summariesGenerated).toBe(0);
		expect(result.sessionKey).toBe("default");
		expect(result.baseDir).toBe(tmpDir);
	});

	it("consolidates events and returns episode summaries", async () => {
		appendEvent({ content: "hello", turnId: 0 });
		appendEvent({ kind: "agent_message", content: "hi there", turnId: 1 });

		const result = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		expect(result.newEpisodes.length).toBeGreaterThan(0);
		expect(result.summariesGenerated).toBeGreaterThan(0);
		expect(result.eventsProcessed).toBe(2);
	});

	it("result carries durationMs as a non-negative number", async () => {
		appendEvent({ content: "timing test", turnId: 0 });

		const result = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("idempotent: second run with no new events processes nothing", async () => {
		appendEvent({ content: "msg", turnId: 0 });
		appendEvent({ kind: "agent_message", content: "reply", turnId: 1 });

		const r1 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });
		expect(r1.eventsProcessed).toBe(2);
		expect(r1.newEpisodes.length).toBeGreaterThan(0);

		// State was persisted — second run should do nothing.
		const r2 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });
		expect(r2.eventsProcessed).toBe(0);
		expect(r2.newEpisodes).toHaveLength(0);
		expect(r2.summariesGenerated).toBe(0);
	});

	it("incremental: second run processes only events added after the first", async () => {
		appendEvent({ content: "batch 1", turnId: 0 });

		const r1 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });
		expect(r1.eventsProcessed).toBe(1);

		// Add new events.
		appendEvent({ content: "batch 2", turnId: 1 });
		appendEvent({ kind: "agent_message", content: "reply 2", turnId: 2 });

		const r2 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });
		expect(r2.eventsProcessed).toBe(2);
	});

	it("state is persisted across invocations (disk-based cursor)", async () => {
		appendEvent({ content: "persist me", turnId: 0 });
		await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		// One new event added after first run.
		appendEvent({ content: "new event", turnId: 1 });

		// Fresh call — should reload state from disk and process only the new event.
		const r2 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });
		expect(r2.eventsProcessed).toBe(1);
	});

	it("custom log function receives cron log messages", async () => {
		appendEvent({ content: "log test", turnId: 0 });

		const messages: string[] = [];
		await runSleepConsolidation({
			baseDir: tmpDir,
			log: (msg) => messages.push(msg),
		});

		expect(messages.some((m) => m.includes("[sleep-consolidation-cron]"))).toBe(true);
	});

	it("custom session key is respected", async () => {
		// Write an event into the non-default session.
		const altStore = createEventStore({ baseDir: tmpDir, sessionKey: "custom-session" });
		altStore.append({
			kind: "user_message",
			content: "custom session event",
			tokens: 10,
			turnId: 0,
			sessionKey: "custom-session",
			metadata: {},
		});

		const result = await runSleepConsolidation({
			baseDir: tmpDir,
			sessionKey: "custom-session",
			log: () => {},
		});

		expect(result.sessionKey).toBe("custom-session");
		expect(result.eventsProcessed).toBe(1);
	});

	it("custom episode summarizer is invoked", async () => {
		appendEvent({ content: "summarize me", turnId: 0 });

		let summarized = false;
		await runSleepConsolidation({
			baseDir: tmpDir,
			log: () => {},
			summarizeEpisode: (_episode, _events) => {
				summarized = true;
				return "custom summary text";
			},
		});

		expect(summarized).toBe(true);
	});

	it("episode metadata is present in result (topic, outcome, turnCount)", async () => {
		appendEvent({ content: "what time is it?", turnId: 0 });
		appendEvent({ kind: "agent_message", content: "It is 3pm.", turnId: 1 });

		const result = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		expect(result.newEpisodes.length).toBeGreaterThan(0);
		const ep = result.newEpisodes[0];
		expect(typeof ep.topic).toBe("string");
		expect(ep.topic.length).toBeGreaterThan(0);
		expect(["completed", "abandoned", "ongoing"]).toContain(ep.outcome);
		expect(ep.turnCount).toBeGreaterThanOrEqual(0);
	});

	it("multiple runs accumulate episodeCount across persisted state", async () => {
		appendEvent({ content: "run 1 msg", turnId: 0 });
		await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		appendEvent({ content: "run 2 msg", turnId: 1 });
		appendEvent({ kind: "agent_message", content: "run 2 reply", turnId: 2 });
		const r2 = await runSleepConsolidation({ baseDir: tmpDir, log: () => {} });

		// At least some episodes were detected in the second run.
		expect(r2.newEpisodes.length).toBeGreaterThan(0);
	});
});
