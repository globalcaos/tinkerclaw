/**
 * ENGRAM Phase 1.3: Pointer compaction manifest generation tests.
 *
 * Focused unit tests for buildManifest and renderManifest — the two new
 * exported helpers that power pointer-mode compaction summaries in
 * compaction-engram.ts.
 */

import { describe, it, expect } from "vitest";
import {
	buildManifest,
	renderManifest,
	type CompactionManifest,
} from "../../agents/pi-extensions/pointer-compaction-runtime.js";
import type { MemoryEvent } from "./event-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		turnId: 1,
		sessionKey: "test",
		kind: "tool_result",
		content: "some content",
		tokens: 100,
		metadata: {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. buildManifest — basic shape and ranges
// ---------------------------------------------------------------------------

describe("buildManifest", () => {
	it("returns expected shape from a set of events", () => {
		const events = [
			makeEvent({ id: "evt-aaa", turnId: 1, tokens: 120 }),
			makeEvent({ id: "evt-bbb", turnId: 2, tokens: 80, kind: "agent_message" }),
			makeEvent({ id: "evt-ccc", turnId: 3, tokens: 200, kind: "tool_call" }),
		];

		const manifest = buildManifest(events);

		expect(manifest.eventIdRange).toEqual(["evt-aaa", "evt-ccc"]);
		expect(manifest.eventCount).toBe(3);
		expect(manifest.tokenCount).toBe(400);
		expect(Array.isArray(manifest.artifactRefs)).toBe(true);
		expect(Array.isArray(manifest.topicHints)).toBe(true);
	});

	it("captures artifact IDs from artifact_reference events", () => {
		const events = [
			makeEvent({ id: "evt-001", kind: "artifact_reference", metadata: { artifactId: "art-alpha" }, tokens: 50 }),
			makeEvent({ id: "evt-002", kind: "tool_result", tokens: 60 }),
			makeEvent({ id: "evt-003", kind: "artifact_reference", metadata: { artifactId: "art-beta" }, tokens: 50 }),
		];

		const manifest = buildManifest(events);

		expect(manifest.artifactRefs).toContain("art-alpha");
		expect(manifest.artifactRefs).toContain("art-beta");
		expect(manifest.artifactRefs.length).toBe(2);
	});

	it("caps topic hints at 3 and deduplicates them", () => {
		const events = Array.from({ length: 10 }, (_, i) =>
			makeEvent({
				id: `evt-${i}`,
				turnId: i + 1,
				tokens: 100,
				metadata: { tags: [`topic-${i}`, "shared-tag"] },
			}),
		);

		const manifest = buildManifest(events);

		// At most 3 hints
		expect(manifest.topicHints.length).toBeLessThanOrEqual(3);
		// No duplicates
		expect(new Set(manifest.topicHints).size).toBe(manifest.topicHints.length);
	});

	it("returns an empty manifest for an empty event list", () => {
		const manifest = buildManifest([]);
		expect(manifest.eventIdRange).toEqual(["", ""]);
		expect(manifest.eventCount).toBe(0);
		expect(manifest.tokenCount).toBe(0);
		expect(manifest.artifactRefs).toHaveLength(0);
		expect(manifest.topicHints).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 2. renderManifest — output format
// ---------------------------------------------------------------------------

describe("renderManifest", () => {
	it("renders a non-empty manifest with event range and token count", () => {
		const manifest: CompactionManifest = {
			eventIdRange: ["evt-start", "evt-end"],
			artifactRefs: [],
			topicHints: ["docker", "file-read"],
			eventCount: 12,
			tokenCount: 2400,
		};

		const rendered = renderManifest(manifest);

		expect(rendered).toContain("evt-start");
		expect(rendered).toContain("evt-end");
		expect(rendered).toContain("12 events");
		expect(rendered).toContain("2400 tokens");
		expect(rendered).toContain("docker");
		expect(rendered).toContain("recall(query)");
	});

	it("includes artifact refs in the rendered output", () => {
		const manifest: CompactionManifest = {
			eventIdRange: ["evt-a", "evt-z"],
			artifactRefs: ["art-01", "art-02"],
			topicHints: [],
			eventCount: 5,
			tokenCount: 500,
		};

		const rendered = renderManifest(manifest);

		expect(rendered).toContain("art-01");
		expect(rendered).toContain("art-02");
	});

	it("returns a no-op message for an empty manifest", () => {
		const manifest: CompactionManifest = {
			eventIdRange: ["", ""],
			artifactRefs: [],
			topicHints: [],
			eventCount: 0,
			tokenCount: 0,
		};

		const rendered = renderManifest(manifest);
		expect(rendered).toContain("no events evicted");
	});
});
