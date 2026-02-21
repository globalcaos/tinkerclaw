/**
 * ENGRAM Phase 1.3: Pointer compaction runtime integration tests.
 *
 * Tests for createPointerCompactionHandler — manifest generation,
 * hot tail preservation, compaction_marker persistence, topic hint
 * extraction, and empty store handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
	createPointerCompactionHandler,
	type CompactionManifest,
} from "../../agents/pi-extensions/pointer-compaction-runtime.js";
import {
	pointerCompact,
} from "./pointer-compaction.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-ptr-compact-"));
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

function addEvents(
	store: ReturnType<typeof makeStore>,
	count: number,
	opts?: { kind?: MemoryEvent["kind"]; tokensPer?: number; startTurn?: number; tags?: string[] },
): MemoryEvent[] {
	const kind = opts?.kind ?? "tool_result";
	const tokensPer = opts?.tokensPer ?? 200;
	const startTurn = opts?.startTurn ?? 1;
	const result: MemoryEvent[] = [];
	for (let i = 0; i < count; i++) {
		result.push(
			store.append({
				turnId: startTurn + i,
				sessionKey: store.sessionKey,
				kind,
				content: `Content ${startTurn + i}: ${"x".repeat(tokensPer * 4)}`,
				tokens: tokensPer,
				metadata: { tags: opts?.tags },
			}),
		);
	}
	return result;
}

// ---------------------------------------------------------------------------
// 1. Manifest generation — event ID range
// ---------------------------------------------------------------------------

describe("manifest: event ID range", () => {
	it("manifest captures first and last evicted event IDs", () => {
		const store = makeStore("range-test");
		const events = addEvents(store, 20, { tokensPer: 200 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 2000,
			headroom: 200,
			hotTailTurns: 3,
		});

		const result = handler.compact(events);
		expect(result.evictedCount).toBeGreaterThan(0);

		// Retrieve the stored compaction_marker and verify range
		const markerEvents = store.readByKind("compaction_marker");
		expect(markerEvents.length).toBeGreaterThan(0);
		const manifest = JSON.parse(markerEvents[0].content) as CompactionManifest;

		expect(manifest.eventIdRange).toHaveLength(2);
		expect(typeof manifest.eventIdRange[0]).toBe("string");
		expect(typeof manifest.eventIdRange[1]).toBe("string");
		expect(manifest.eventIdRange[0].length).toBeGreaterThan(0);

		// Range must correspond to actual evicted event IDs
		const eventIds = new Set(events.map((e) => e.id));
		expect(eventIds.has(manifest.eventIdRange[0])).toBe(true);
		expect(eventIds.has(manifest.eventIdRange[1])).toBe(true);
	});

	it("manifest event count matches evicted events", () => {
		const store = makeStore("count-test");
		const events = addEvents(store, 15, { tokensPer: 300 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 1500,
			headroom: 200,
			hotTailTurns: 2,
		});

		const result = handler.compact(events);
		const markerEvents = store.readByKind("compaction_marker");
		const manifest = JSON.parse(markerEvents[0].content) as CompactionManifest;

		expect(manifest.eventCount).toBe(result.evictedCount);
	});
});

// ---------------------------------------------------------------------------
// 2. Hot tail preservation
// ---------------------------------------------------------------------------

describe("hot tail preservation", () => {
	it("preserves last N turns verbatim", () => {
		const store = makeStore("tail-preserve");
		const events = addEvents(store, 20, { tokensPer: 200 });

		// Use pointerCompact directly to verify the hot-tail invariant
		const cache = { events: [...events], markers: [] };
		pointerCompact(cache, { ctx: 2000, headroom: 200, hotTailTurns: 5, markerSoftCap: 20 }, store);

		const lastFiveTurnIds = events.slice(-5).map((e) => e.turnId);
		const cacheTurnIds = new Set(cache.events.map((e) => e.turnId));
		for (const tid of lastFiveTurnIds) {
			expect(cacheTurnIds.has(tid)).toBe(true);
		}
	});

	it("default hotTailTurns is 10", () => {
		const store = makeStore("tail-default");
		const handler = createPointerCompactionHandler(store);
		expect(handler.options.hotTailTurns).toBe(10);
	});

	it("configurable hotTailTurns is respected in options", () => {
		const store = makeStore("tail-config");
		const handler = createPointerCompactionHandler(store, { hotTailTurns: 15 });
		expect(handler.options.hotTailTurns).toBe(15);
	});
});

// ---------------------------------------------------------------------------
// 3. Compaction marker event is stored
// ---------------------------------------------------------------------------

describe("compaction_marker persistence", () => {
	it("stores a compaction_marker event after compact()", () => {
		const store = makeStore("marker-stored");
		const events = addEvents(store, 20, { tokensPer: 200 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 2000,
			headroom: 200,
			hotTailTurns: 3,
		});

		const result = handler.compact(events);

		const markers = store.readByKind("compaction_marker");
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].id).toBe(result.markerEventId);
	});

	it("compaction_marker is tagged with pointer_compaction", () => {
		const store = makeStore("marker-tag");
		const events = addEvents(store, 15, { tokensPer: 250 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 1500,
			headroom: 200,
			hotTailTurns: 2,
		});

		handler.compact(events);

		const marker = store.readByKind("compaction_marker")[0];
		expect(marker?.metadata?.tags).toContain("pointer_compaction");
	});

	it("compaction_marker content is valid JSON manifest", () => {
		const store = makeStore("marker-json");
		const events = addEvents(store, 12, { tokensPer: 300 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 1000,
			headroom: 100,
			hotTailTurns: 2,
		});

		handler.compact(events);

		const marker = store.readByKind("compaction_marker")[0];
		expect(() => JSON.parse(marker.content)).not.toThrow();
		const manifest = JSON.parse(marker.content) as CompactionManifest;
		expect(manifest).toHaveProperty("eventIdRange");
		expect(manifest).toHaveProperty("artifactRefs");
		expect(manifest).toHaveProperty("topicHints");
		expect(manifest).toHaveProperty("eventCount");
		expect(manifest).toHaveProperty("tokenCount");
	});

	it("manifest tokenCount matches evicted token sum", () => {
		const store = makeStore("marker-tokens");
		const events = addEvents(store, 15, { tokensPer: 100 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 800,
			headroom: 100,
			hotTailTurns: 2,
		});

		const result = handler.compact(events);
		const manifest = JSON.parse(
			store.readByKind("compaction_marker")[0].content,
		) as CompactionManifest;

		// Token count in manifest should equal evictedCount * 100 (each event had 100 tokens)
		expect(manifest.tokenCount).toBe(result.evictedCount * 100);
	});
});

// ---------------------------------------------------------------------------
// 4. Topic hint extraction
// ---------------------------------------------------------------------------

describe("topic hint extraction", () => {
	it("extracts hints from event tags", () => {
		const store = makeStore("hints-tags");
		const events: MemoryEvent[] = [];
		// Add evictable events with non-constraint tags
		// (events tagged "constraint" are non-evictable by design, so we use plain topic tags)
		for (let i = 1; i <= 10; i++) {
			events.push(
				store.append({
					turnId: i,
					sessionKey: store.sessionKey,
					kind: "tool_result",
					content: "x".repeat(800),
					tokens: 200,
					metadata: { tags: [`topic-${i}`, "docker"] },
				}),
			);
		}

		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 1000,
			headroom: 100,
			hotTailTurns: 2,
		});
		handler.compact(events);

		const manifest = JSON.parse(
			store.readByKind("compaction_marker")[0].content,
		) as CompactionManifest;

		// Topic tags should appear in hints; "constraint" would be excluded but is not present here
		expect(manifest.topicHints.length).toBeGreaterThan(0);
		// Verify no obviously invalid values
		expect(manifest.topicHints.every((h) => typeof h === "string" && h.length > 0)).toBe(true);
	});

	it("topic hints are capped at 3", () => {
		const store = makeStore("hints-cap");
		const events: MemoryEvent[] = [];
		for (let i = 1; i <= 12; i++) {
			events.push(
				store.append({
					turnId: i,
					sessionKey: store.sessionKey,
					kind: "agent_message",
					content: "y".repeat(400),
					tokens: 100,
					metadata: { tags: [`hint-${i}`] },
				}),
			);
		}

		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 500,
			headroom: 100,
			hotTailTurns: 2,
		});
		handler.compact(events);

		const manifest = JSON.parse(
			store.readByKind("compaction_marker")[0].content,
		) as CompactionManifest;
		expect(manifest.topicHints.length).toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// 5. Artifact refs
// ---------------------------------------------------------------------------

describe("artifact refs in manifest", () => {
	it("includes artifactIds from artifact_reference events", () => {
		const store = makeStore("artifacts");
		const events: MemoryEvent[] = [];
		// Add artifact_reference events
		for (let i = 1; i <= 8; i++) {
			events.push(
				store.append({
					turnId: i,
					sessionKey: store.sessionKey,
					kind: "artifact_reference",
					content: JSON.stringify({ tool: "read_file", artifactId: `art-${i}` }),
					tokens: 150,
					metadata: { artifactId: `art-${i}` },
				}),
			);
		}

		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 500,
			headroom: 100,
			hotTailTurns: 2,
		});
		handler.compact(events);

		const manifest = JSON.parse(
			store.readByKind("compaction_marker")[0].content,
		) as CompactionManifest;
		expect(manifest.artifactRefs.length).toBeGreaterThan(0);
		expect(manifest.artifactRefs[0]).toMatch(/^art-/);
	});
});

// ---------------------------------------------------------------------------
// 6. Empty / no-op cases
// ---------------------------------------------------------------------------

describe("empty event store handling", () => {
	it("compact([]) on empty store does not throw", () => {
		const store = makeStore("empty-store");
		const handler = createPointerCompactionHandler(store);
		expect(() => handler.compact([])).not.toThrow();
	});

	it("compact([]) returns summary with no-eviction message", () => {
		const store = makeStore("empty-summary");
		const handler = createPointerCompactionHandler(store);
		const result = handler.compact([]);
		expect(result.evictedCount).toBe(0);
		expect(result.markersCreated).toBe(0);
		expect(typeof result.summary).toBe("string");
	});

	it("no compaction when events fit within budget", () => {
		const store = makeStore("no-compact");
		const events = addEvents(store, 5, { tokensPer: 50 });
		const handler = createPointerCompactionHandler(store, {
			ctxTokens: 100_000,
			headroom: 1_000,
			hotTailTurns: 10,
		});

		const result = handler.compact(events);
		expect(result.evictedCount).toBe(0);
		expect(result.markersCreated).toBe(0);
	});
});
