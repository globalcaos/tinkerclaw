import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, estimateTokens } from "../src/event-store.js";
import type { MemoryEvent } from "../src/event-types.js";
import { NON_EVICTABLE_KINDS } from "../src/event-types.js";
import {
  pointerCompact,
  estimateCacheTokens,
  type ContextCache,
  type CompactionBudgets,
} from "../src/pointer-compaction.js";
import type { TimeRangeMarker } from "../src/time-range-marker.js";

function makeEvent(
  overrides: Partial<MemoryEvent> & { turnId: number; kind: MemoryEvent["kind"] },
): MemoryEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    sessionKey: "test",
    content: overrides.content ?? `Content for turn ${overrides.turnId}`,
    tokens:
      overrides.tokens ??
      estimateTokens(overrides.content ?? `Content for turn ${overrides.turnId}`),
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

describe("Pointer compaction", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "engram-compact-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("does not compact when under budget", () => {
    const events: MemoryEvent[] = [
      makeEvent({ turnId: 1, kind: "user_message", tokens: 10 }),
      makeEvent({ turnId: 2, kind: "agent_message", tokens: 10 }),
    ];
    const cache: ContextCache = { events, markers: [] };
    const budgets: CompactionBudgets = {
      ctx: 1000,
      headroom: 100,
      hotTailTurns: 1,
      markerSoftCap: 20,
    };

    const cycles = pointerCompact(cache, budgets);
    expect(cycles).toBe(0);
    expect(cache.events).toHaveLength(2);
    expect(cache.markers).toHaveLength(0);
  });

  it("compacts events when over budget", () => {
    const store = createEventStore({ baseDir, sessionKey: "compact" });
    const events: MemoryEvent[] = [];
    for (let i = 1; i <= 20; i++) {
      const ev = store.append({
        turnId: i,
        sessionKey: "compact",
        kind: "tool_result",
        content: "x".repeat(200),
        tokens: 50,
        metadata: {},
      });
      events.push(ev);
    }

    const cache: ContextCache = { events: [...events], markers: [] };
    const budgets: CompactionBudgets = {
      ctx: 500, // Total budget: 500 tokens
      headroom: 100, // Target: 400 tokens
      hotTailTurns: 2, // Protect last 2 turns
      markerSoftCap: 20,
    };

    const cycles = pointerCompact(cache, budgets, store);
    expect(cycles).toBeGreaterThan(0);
    expect(cache.markers.length).toBeGreaterThan(0);
    // Should have reduced total tokens
    expect(estimateCacheTokens(cache)).toBeLessThanOrEqual(500);
  });

  it("preserves non-evictable kinds", () => {
    const events: MemoryEvent[] = [
      makeEvent({ turnId: 1, kind: "tool_result", tokens: 100 }),
      makeEvent({ turnId: 2, kind: "compaction_marker", tokens: 50 }),
      makeEvent({ turnId: 3, kind: "persona_state", tokens: 50 }),
      makeEvent({ turnId: 4, kind: "system_event", tokens: 50 }),
      makeEvent({ turnId: 5, kind: "tool_result", tokens: 100 }),
    ];

    const cache: ContextCache = { events: [...events], markers: [] };
    const budgets: CompactionBudgets = {
      ctx: 200,
      headroom: 50,
      hotTailTurns: 0,
      markerSoftCap: 20,
    };

    pointerCompact(cache, budgets);

    // Non-evictable kinds should still be present
    const remainingKinds = new Set(cache.events.map((e) => e.kind));
    for (const kind of NON_EVICTABLE_KINDS) {
      // If they were originally present, they should still be
      if (events.some((e) => e.kind === kind)) {
        expect(remainingKinds.has(kind)).toBe(true);
      }
    }
  });

  it("creates time-range markers from evicted events", () => {
    const store = createEventStore({ baseDir, sessionKey: "markers" });
    const events: MemoryEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      const ev = store.append({
        turnId: i,
        sessionKey: "markers",
        kind: "tool_result",
        content: "x".repeat(400),
        tokens: 100,
        metadata: {},
      });
      events.push(ev);
    }

    const cache: ContextCache = { events: [...events], markers: [] };
    const budgets: CompactionBudgets = {
      ctx: 300,
      headroom: 50,
      hotTailTurns: 1,
      markerSoftCap: 20,
    };

    pointerCompact(cache, budgets, store);

    expect(cache.markers.length).toBeGreaterThan(0);
    for (const marker of cache.markers) {
      expect(marker.type).toBe("time_range_marker");
      expect(marker.eventCount).toBeGreaterThan(0);
      expect(marker.tokenCount).toBeGreaterThan(0);
      expect(marker.startTurnId).toBeLessThanOrEqual(marker.endTurnId);
    }
  });

  it("protects hot tail turns from eviction", () => {
    const store = createEventStore({ baseDir, sessionKey: "tail" });
    const events: MemoryEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      const ev = store.append({
        turnId: i,
        sessionKey: "tail",
        kind: "tool_result",
        content: "x".repeat(200),
        tokens: 50,
        metadata: {},
      });
      events.push(ev);
    }

    const cache: ContextCache = { events: [...events], markers: [] };
    const budgets: CompactionBudgets = {
      ctx: 200,
      headroom: 50,
      hotTailTurns: 3,
      markerSoftCap: 20,
    };

    pointerCompact(cache, budgets, store);

    // Last 3 turns (8, 9, 10) should still be in cache
    const remainingTurnIds = new Set(cache.events.map((e) => e.turnId));
    expect(remainingTurnIds.has(10)).toBe(true);
    expect(remainingTurnIds.has(9)).toBe(true);
    expect(remainingTurnIds.has(8)).toBe(true);
  });
});
