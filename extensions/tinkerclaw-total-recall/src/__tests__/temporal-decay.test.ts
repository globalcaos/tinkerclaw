/**
 * FORK: Tests for temporal decay scoring.
 */

import { describe, it, expect } from "vitest";
import {
  computeTemporalDecay,
  isEvergreenKind,
  DEFAULT_DECAY_CONFIG,
  type TemporalDecayConfig,
} from "../temporal-decay.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

describe("computeTemporalDecay", () => {
  const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 14 };
  const now = Date.now();

  it("returns ~1.0 for a fresh event (0 days old)", () => {
    const result = computeTemporalDecay(now, now, config);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.5 for an event at the half-life (14 days)", () => {
    const eventTs = now - 14 * MS_PER_DAY;
    const result = computeTemporalDecay(eventTs, now, config);
    expect(result).toBeCloseTo(0.5, 2);
  });

  it("returns ~0.25 for an event at 2x half-life (28 days)", () => {
    const eventTs = now - 28 * MS_PER_DAY;
    const result = computeTemporalDecay(eventTs, now, config);
    expect(result).toBeCloseTo(0.25, 2);
  });

  it("returns 1.0 when decay is disabled", () => {
    const disabledConfig: TemporalDecayConfig = { enabled: false, halfLifeDays: 14 };
    const eventTs = now - 100 * MS_PER_DAY;
    const result = computeTemporalDecay(eventTs, now, disabledConfig);
    expect(result).toBe(1.0);
  });

  it("returns 1.0 for future events (negative age)", () => {
    const futureTs = now + 5 * MS_PER_DAY;
    const result = computeTemporalDecay(futureTs, now, config);
    expect(result).toBe(1.0);
  });

  it("uses 2x half-life for episode_summary kind", () => {
    // At 14 days with 2x half-life (28 days effective), should be ~0.707 not ~0.5
    const eventTs = now - 14 * MS_PER_DAY;
    const result = computeTemporalDecay(eventTs, now, config, "episode_summary");
    expect(result).toBeCloseTo(Math.SQRT1_2, 2); // ~0.707

    // At 28 days with 2x half-life, should be ~0.5
    const eventTs28 = now - 28 * MS_PER_DAY;
    const result28 = computeTemporalDecay(eventTs28, now, config, "episode_summary");
    expect(result28).toBeCloseTo(0.5, 2);
  });
});

describe("isEvergreenKind", () => {
  it("returns true for compaction_marker", () => {
    expect(isEvergreenKind("compaction_marker")).toBe(true);
  });

  it("returns true for persona_state", () => {
    expect(isEvergreenKind("persona_state")).toBe(true);
  });

  it("returns true for system_event", () => {
    expect(isEvergreenKind("system_event")).toBe(true);
  });

  it("returns false for user_message", () => {
    expect(isEvergreenKind("user_message")).toBe(false);
  });

  it("returns false for agent_message", () => {
    expect(isEvergreenKind("agent_message")).toBe(false);
  });

  it("returns false for tool_call", () => {
    expect(isEvergreenKind("tool_call")).toBe(false);
  });

  it("returns false for episode_summary", () => {
    expect(isEvergreenKind("episode_summary")).toBe(false);
  });
});

describe("DEFAULT_DECAY_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_DECAY_CONFIG.enabled).toBe(true);
    expect(DEFAULT_DECAY_CONFIG.halfLifeDays).toBe(14);
  });
});
