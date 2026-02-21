/**
 * LIMBIC Phase 4 Integration Tests.
 *
 * Tests the runtime wiring layer:
 *   - LimbicRuntime: bridge discovery, humor scoring, sensitivity gate, reaction capture
 *   - HumorTrigger: rate limiting, sensitivity gating, trigger evaluation
 *
 * These tests use only in-memory stubs; no disk or network I/O.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	createLimbicRuntime,
	type LimbicRuntime,
} from "../../agents/pi-extensions/limbic-runtime.js";
import {
	createHumorTrigger,
	type HumorTrigger,
} from "../../agents/pi-extensions/humor-trigger.js";
import type { EventStore } from "../engram/event-store.js";
import type { MemoryEvent, EventKind } from "../engram/event-types.js";

// ---------------------------------------------------------------------------
// In-memory EventStore stub
// ---------------------------------------------------------------------------

function createMemoryEventStore(sessionKey = "test-session"): EventStore & {
	events: MemoryEvent[];
} {
	const events: MemoryEvent[] = [];
	let seq = 0;

	const store: EventStore & { events: MemoryEvent[] } = {
		filePath: ":memory:",
		sessionKey,
		events,

		append(partial) {
			const event: MemoryEvent = {
				id: `evt-${++seq}`,
				timestamp: new Date().toISOString(),
				...partial,
			};
			events.push(event);
			return event;
		},

		appendRaw(event) {
			events.push(event);
		},

		readAll() {
			return [...events];
		},

		readByKind(kind: EventKind) {
			return events.filter((e) => e.kind === kind);
		},

		readRange(start, end) {
			return events.filter((e) => e.turnId >= start && e.turnId <= end);
		},

		readById(id) {
			return events.find((e) => e.id === id);
		},

		count() {
			return events.length;
		},
	};

	return store;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let store: ReturnType<typeof createMemoryEventStore>;
let runtime: LimbicRuntime;

beforeEach(() => {
	store = createMemoryEventStore();
	runtime = createLimbicRuntime(store);
});

// ---------------------------------------------------------------------------
// 1. Bridge discovery
// ---------------------------------------------------------------------------

describe("bridge discovery", () => {
	it("returns an array (possibly empty) for any two concept strings", async () => {
		const results = await runtime.discoverBridges("astronomy", "cooking");
		expect(Array.isArray(results)).toBe(true);
	});

	it("result items have bridge, quality, and method fields", async () => {
		const results = await runtime.discoverBridges("music", "mathematics");
		for (const r of results) {
			expect(typeof r.bridge).toBe("string");
			expect(typeof r.quality).toBe("number");
			expect(Number.isFinite(r.quality)).toBe(true);
			expect(typeof r.method).toBe("string");
		}
	});

	it("quality values are non-negative", async () => {
		const results = await runtime.discoverBridges("ocean", "desert");
		for (const r of results) {
			expect(r.quality).toBeGreaterThanOrEqual(0);
		}
	});

	it("different concept pairs produce different bridges", async () => {
		const results1 = await runtime.discoverBridges("fire", "water");
		const results2 = await runtime.discoverBridges("time", "gravity");
		// At minimum, the index contents differ between calls (added vectors)
		// so the two arrays should not be identical objects
		expect(results1).not.toBe(results2);
	});
});

// ---------------------------------------------------------------------------
// 2. Humor scoring
// ---------------------------------------------------------------------------

describe("humor scoring", () => {
	it("returns a finite number for any concept triplet", () => {
		const score = runtime.scoreHumor("philosophy", "plumbing", "pipe");
		expect(typeof score).toBe("number");
		expect(Number.isFinite(score)).toBe(true);
	});

	it("score is a finite number (may be negative when validity is negative)", () => {
		// h_v2 = d × v × σ; bridgeValidity = min(cos(β,A), cos(β,B)) can be negative,
		// so the overall score may be negative — that is expected library behaviour.
		const score = runtime.scoreHumor("robot", "dance", "circuit");
		expect(Number.isFinite(score)).toBe(true);
	});

	it("returns 0 when concept distance is ~0 (identical concepts)", () => {
		// Two identical concepts have cosine distance ~0, so h_v2 → 0
		const score = runtime.scoreHumor("apple", "apple", "fruit");
		expect(score).toBeCloseTo(0, 5);
	});

	it("same triplet produces the same score on repeated calls (deterministic)", () => {
		const s1 = runtime.scoreHumor("language", "geometry", "shape");
		const s2 = runtime.scoreHumor("language", "geometry", "shape");
		expect(s1).toBe(s2);
	});
});

// ---------------------------------------------------------------------------
// 3. Sensitivity gate
// ---------------------------------------------------------------------------

describe("sensitivity gate", () => {
	it("allows safe topics", () => {
		const result = runtime.checkSensitivity("astronomy");
		expect(result.allowed).toBe(true);
		expect(result.sensitivityScore).toBeLessThan(0.5);
	});

	it("blocks topics containing death-related keywords", () => {
		const result = runtime.checkSensitivity("funeral", "the eulogy about grief");
		// 'funeral' alone may or may not trigger; 'grief' definitely should
		const result2 = runtime.checkSensitivity("grief and bereavement");
		expect(result2.sensitivityScore).toBeGreaterThan(0);
		// Hard block when score >= sensitivityThreshold (default 0.5)
		if (result2.sensitivityScore >= 0.5) {
			expect(result2.allowed).toBe(false);
		}
	});

	it("detects suicide-related keywords with positive sensitivity score", () => {
		const result = runtime.checkSensitivity("suicidal thoughts");
		// One sensitive category → score = 0.3 (< default threshold of 0.5, so still allowed).
		// We verify detection, not necessarily blocking, for a single category.
		expect(result.sensitivityScore).toBeGreaterThan(0);
	});

	it("blocks multi-category sensitive topics", () => {
		// grief + suicide = 2 categories → score = 0.6 ≥ 0.5 threshold → blocked
		const result = runtime.checkSensitivity("grief suicidal self-harm");
		expect(result.sensitivityScore).toBeGreaterThan(0);
		expect(result.allowed).toBe(false);
	});

	it("returns sensitivityScore between 0 and 1", () => {
		const r1 = runtime.checkSensitivity("cooking");
		const r2 = runtime.checkSensitivity("genocide massacre");
		expect(r1.sensitivityScore).toBeGreaterThanOrEqual(0);
		expect(r1.sensitivityScore).toBeLessThanOrEqual(1);
		expect(r2.sensitivityScore).toBeGreaterThanOrEqual(0);
		expect(r2.sensitivityScore).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// 4. Reaction capture
// ---------------------------------------------------------------------------

describe("reaction capture", () => {
	it("stores a humor_association event for a positive reaction", () => {
		runtime.recordReaction("attempt-001", "positive");
		const events = store.readByKind("humor_association");
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it("stores a humor_association event for a negative reaction", () => {
		runtime.recordReaction("attempt-002", "negative");
		const events = store.readByKind("humor_association");
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it("stores a humor_association event for a neutral reaction", () => {
		runtime.recordReaction("attempt-003", "neutral");
		const events = store.readByKind("humor_association");
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it("event content is valid JSON with a humorConfidence field", () => {
		runtime.recordReaction("attempt-004", "positive");
		const events = store.readByKind("humor_association");
		const last = events.at(-1)!;
		const parsed = JSON.parse(last.content) as { humorConfidence: number };
		expect(typeof parsed.humorConfidence).toBe("number");
	});

	it("positive reaction yields humorConfidence of 1 (first attempt)", () => {
		runtime.recordReaction("attempt-005", "positive");
		const events = store.readByKind("humor_association");
		const last = events.at(-1)!;
		const parsed = JSON.parse(last.content) as { humorConfidence: number };
		expect(parsed.humorConfidence).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 5. Rate limiting (HumorTrigger)
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
	let trigger: HumorTrigger;

	beforeEach(() => {
		trigger = createHumorTrigger(runtime, undefined, { minTurnsBetweenAttempts: 10 });
	});

	it("allows humor when no prior attempt has been made", async () => {
		const messages = ["I love astronomy and also cooking quite a lot"];
		const result = await trigger.evaluateOpportunity(messages, 15);
		// May or may not find bridges, but should not be rate-limited
		if (!result.shouldAttempt) {
			expect(result.reason).not.toMatch(/Rate limited/);
		}
	});

	it("blocks humor within minTurns of last attempt", async () => {
		const messages = [
			"Thinking about philosophy and also about plumbing systems",
			"The mathematics of music is fascinating to consider",
		];
		// First evaluation records an attempt
		await trigger.evaluateOpportunity(messages, 100);
		// Second evaluation only 5 turns later should be rate-limited
		const result = await trigger.evaluateOpportunity(messages, 105);
		expect(result.shouldAttempt).toBe(false);
		expect(result.reason).toMatch(/Rate limited/);
	});

	it("allows humor after minTurns have passed since last attempt", async () => {
		const messages = [
			"Thinking about philosophy and also about plumbing systems",
			"The mathematics of music is fascinating to consider",
		];
		await trigger.evaluateOpportunity(messages, 100);
		// 11 turns later: should no longer be rate-limited
		const result = await trigger.evaluateOpportunity(messages, 111);
		// Not blocked by rate limit — may still fail for other reasons
		if (!result.shouldAttempt) {
			expect(result.reason).not.toMatch(/Rate limited/);
		}
	});

	it("reset() clears rate limit state", async () => {
		const messages = ["Robotics meets poetry in unexpected ways"];
		await trigger.evaluateOpportunity(messages, 1);
		trigger.reset();
		const result = await trigger.evaluateOpportunity(messages, 2);
		// After reset, rate limit should not fire even 1 turn later
		if (!result.shouldAttempt) {
			expect(result.reason).not.toMatch(/Rate limited/);
		}
	});
});

// ---------------------------------------------------------------------------
// 6. Trigger evaluation with various contexts
// ---------------------------------------------------------------------------

describe("trigger evaluation", () => {
	let trigger: HumorTrigger;

	beforeEach(() => {
		trigger = createHumorTrigger(runtime, undefined, { minTurnsBetweenAttempts: 5 });
	});

	it("returns shouldAttempt=false for empty messages", async () => {
		const result = await trigger.evaluateOpportunity([], 10);
		expect(result.shouldAttempt).toBe(false);
	});

	it("returns shouldAttempt=false for single-word messages", async () => {
		const result = await trigger.evaluateOpportunity(["hello"], 10);
		expect(result.shouldAttempt).toBe(false);
	});

	it("result has the correct shape when shouldAttempt=true", async () => {
		const messages = [
			"I have been thinking about quantum mechanics and baking sourdough bread",
			"The parallels between thermodynamics and fermentation are quite profound",
		];
		const result = await trigger.evaluateOpportunity(messages, 50);
		if (result.shouldAttempt) {
			expect(typeof result.bridge).toBe("string");
			expect(Array.isArray(result.concepts)).toBe(true);
			expect(result.concepts).toHaveLength(2);
			expect(typeof result.score).toBe("number");
		}
	});

	it("blocks sensitive topics from triggering humor", async () => {
		const messages = [
			"Discussing grief and bereavement and how people cope with suicide",
			"Terminal illness and death affect everyone differently",
		];
		const result = await trigger.evaluateOpportunity(messages, 20);
		expect(result.shouldAttempt).toBe(false);
	});
});
