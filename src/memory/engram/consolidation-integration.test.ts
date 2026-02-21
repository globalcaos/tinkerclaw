/**
 * ENGRAM Phase 1.4 — Consolidation Integration Tests
 *
 * Verifies that createConsolidationRunner correctly:
 *   - Produces episode summaries written as system_event entries
 *   - Embeds provenance pointers (sourceEventIds) in summary content
 *   - Handles empty stores gracefully
 *   - Is idempotent across multiple runs
 *   - Respects sinceTimestamp filtering
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore, type EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
	type EpisodeSummaryPayload,
	createConsolidationRunner,
} from "../../agents/pi-extensions/consolidation-runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-consolidation-"));
	store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function appendMsg(
	kind: MemoryEvent["kind"],
	content: string,
	turnId = 0,
	metadata: MemoryEvent["metadata"] = {},
): MemoryEvent {
	return store.append({ kind, content, tokens: 10, turnId, sessionKey: "test-session", metadata });
}

/** Parse the EpisodeSummaryPayload from a consolidated system_event. */
function parsePayload(event: MemoryEvent): EpisodeSummaryPayload {
	return JSON.parse(event.content) as EpisodeSummaryPayload;
}

/** Return all consolidated summary events in the store. */
function summaryEvents(): MemoryEvent[] {
	return store
		.readAll()
		.filter(
			(e) => e.kind === "system_event" && e.metadata?.tags?.includes("consolidated"),
		);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Consolidation Integration", () => {
	it("empty store produces no summaries", async () => {
		const runner = createConsolidationRunner(store);
		const result = await runner.consolidate();

		expect(result.episodesCreated).toBe(0);
		expect(result.summaryEventIds).toHaveLength(0);
		expect(result.eventsProcessed).toBe(0);
		expect(summaryEvents()).toHaveLength(0);
	});

	it("consolidation produces at least one summary event", async () => {
		appendMsg("user_message", "hello", 0);
		appendMsg("agent_message", "hi there", 1);

		const runner = createConsolidationRunner(store);
		const result = await runner.consolidate();

		expect(result.episodesCreated).toBeGreaterThan(0);
		expect(result.summaryEventIds.length).toBe(result.episodesCreated);
		expect(summaryEvents()).toHaveLength(result.episodesCreated);
	});

	it("summary events carry the 'consolidated' tag", async () => {
		appendMsg("user_message", "test", 0);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();

		for (const ev of summaryEvents()) {
			expect(ev.metadata?.tags).toContain("consolidated");
		}
	});

	it("summary content is valid JSON with type=episode_summary", async () => {
		appendMsg("user_message", "plan a trip", 0);
		appendMsg("agent_message", "sure!", 1);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();

		for (const ev of summaryEvents()) {
			const payload = parsePayload(ev);
			expect(payload.type).toBe("episode_summary");
			expect(typeof payload.episodeId).toBe("string");
			expect(typeof payload.summary).toBe("string");
		}
	});

	it("provenance: sourceEventIds reference original source events", async () => {
		const e1 = appendMsg("user_message", "help me", 0);
		const e2 = appendMsg("agent_message", "of course", 1);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();

		const all = summaryEvents();
		expect(all.length).toBeGreaterThan(0);

		const allSourceIds = all.flatMap((ev) => parsePayload(ev).sourceEventIds);
		// Both source event IDs should appear in provenance
		expect(allSourceIds).toContain(e1.id);
		expect(allSourceIds).toContain(e2.id);
	});

	it("provenance: sourceEventIds do not include summary events themselves", async () => {
		appendMsg("user_message", "foo", 0);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();

		const summaries = summaryEvents();
		const summaryIds = new Set(summaries.map((s) => s.id));

		for (const ev of summaries) {
			const payload = parsePayload(ev);
			for (const id of payload.sourceEventIds) {
				expect(summaryIds.has(id)).toBe(false);
			}
		}
	});

	it("idempotency: running twice produces no duplicate summaries", async () => {
		appendMsg("user_message", "hello", 0);
		appendMsg("agent_message", "world", 1);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();
		const countAfterFirst = summaryEvents().length;

		await runner.consolidate();
		expect(summaryEvents()).toHaveLength(countAfterFirst);
	});

	it("idempotency: second run reports zero events processed", async () => {
		appendMsg("user_message", "msg", 0);

		const runner = createConsolidationRunner(store);
		await runner.consolidate();

		const r2 = await runner.consolidate();
		expect(r2.eventsProcessed).toBe(0);
		expect(r2.episodesCreated).toBe(0);
	});

	it("incremental: second run picks up only new events", async () => {
		appendMsg("user_message", "first batch", 0);

		const runner = createConsolidationRunner(store);
		const r1 = await runner.consolidate();
		expect(r1.eventsProcessed).toBe(1);

		const e3 = appendMsg("user_message", "second batch", 1);
		const e4 = appendMsg("agent_message", "reply", 2);

		const r2 = await runner.consolidate();
		expect(r2.eventsProcessed).toBe(2);

		// Provenance in second run should reference only the new events
		const secondRunSummaryIds = new Set(r2.summaryEventIds);
		const secondRunSummaries = summaryEvents().filter((ev) =>
			secondRunSummaryIds.has(ev.id),
		);
		const allSourceIds = secondRunSummaries.flatMap((ev) => parsePayload(ev).sourceEventIds);
		expect(allSourceIds).toContain(e3.id);
		expect(allSourceIds).toContain(e4.id);
	});

	it("sinceTimestamp: filters events by timestamp", async () => {
		appendMsg("user_message", "old message", 0);

		// Small delay so the second event gets a later timestamp
		await new Promise((r) => setTimeout(r, 5));
		const cutoff = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 5));

		const newEvent = appendMsg("user_message", "new message", 1);

		const runner = createConsolidationRunner(store);
		const result = await runner.consolidate(cutoff);

		expect(result.eventsProcessed).toBe(1);
		const allSourceIds = summaryEvents().flatMap((ev) => parsePayload(ev).sourceEventIds);
		expect(allSourceIds).toContain(newEvent.id);
	});

	it("custom summarizer output appears in the summary field", async () => {
		appendMsg("user_message", "custom test", 0);

		const runner = createConsolidationRunner(store, {
			summarizeEpisode: () => "CUSTOM_SUMMARY_TEXT",
		});
		await runner.consolidate();

		const payloads = summaryEvents().map(parsePayload);
		expect(payloads.some((p) => p.summary === "CUSTOM_SUMMARY_TEXT")).toBe(true);
	});

	it("runner state tracks cursor after consolidation", async () => {
		appendMsg("user_message", "track me", 0);

		const runner = createConsolidationRunner(store);
		expect(runner.state.lastConsolidatedEventId).toBeNull();
		expect(runner.state.episodeCount).toBe(0);

		await runner.consolidate();

		expect(runner.state.lastConsolidatedEventId).not.toBeNull();
		expect(runner.state.lastConsolidatedAt).not.toBeNull();
		expect(runner.state.episodeCount).toBeGreaterThan(0);
	});

	it("result.durationMs is a non-negative number", async () => {
		appendMsg("user_message", "timing test", 0);

		const runner = createConsolidationRunner(store);
		const result = await runner.consolidate();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});
