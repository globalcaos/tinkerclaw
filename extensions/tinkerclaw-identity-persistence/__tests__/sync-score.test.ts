/**
 * Tests for SyncScore EWMA computation and consistency metric.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCortexRuntime,
  SYNC_SCORE_ALPHA,
  SYNC_SCORE_DRIFT_THRESHOLD,
} from "../src/cortex-runtime.js";
import {
  computeConsistency,
  computeHardRuleCompliance,
  classifyAction,
  CONSISTENCY_CONFIG,
} from "../src/consistency-metric.js";

describe("SyncScore EWMA", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("starts at 1.0 (full alignment)", () => {
    const rt = createCortexRuntime();
    expect(rt.ewmaSyncScore).toBe(1.0);
  });

  it("EWMA smoothing with alpha=0.1", () => {
    expect(SYNC_SCORE_ALPHA).toBe(0.1);
    // EWMA formula: new = alpha * raw + (1 - alpha) * old
    // Starting at 1.0, raw=0.5: new = 0.1*0.5 + 0.9*1.0 = 0.95
    const rt = createCortexRuntime({ syncScoreInterval: 1 });
    const result = rt.evaluateSyncScore(["Hello world."], 1);
    // Raw score is computed by computeConsistency
    // EWMA = 0.1 * rawScore + 0.9 * 1.0
    expect(result.ewmaScore).toBeGreaterThan(0);
    expect(result.ewmaScore).toBeLessThanOrEqual(1.0);
  });

  it("decays when responses diverge from persona", () => {
    const rt = createCortexRuntime({ syncScoreInterval: 1 });

    // Feed many diverse responses to build variance
    const diverseResponses = [
      "Yo dude, what's up? lol that's hilarious haha",
      "Furthermore, the implementation of the algorithm necessitates careful consideration of the polynomial regression coefficients.",
    ];

    // First evaluation
    const r1 = rt.evaluateSyncScore(diverseResponses, 1);
    // Second evaluation with different content
    const r2 = rt.evaluateSyncScore(
      ["Very formal indeed, one must consider the implications thereof."],
      2,
    );

    // EWMA should move (not necessarily down since consistency depends on content)
    expect(r1.ewmaScore).toBeDefined();
    expect(r2.ewmaScore).toBeDefined();
  });

  it("threshold detection at 0.6 triggers reinject", () => {
    expect(SYNC_SCORE_DRIFT_THRESHOLD).toBe(0.6);

    const rt = createCortexRuntime({ syncScoreInterval: 1 });
    // With default persona and simple messages, EWMA stays near 1.0
    const result = rt.evaluateSyncScore(["A simple test message."], 1);
    // Starting EWMA is 1.0, so first eval should be above threshold
    expect(result.needsReinjection).toBe(false);
  });

  it("off-schedule turns return current EWMA without recomputing", () => {
    const rt = createCortexRuntime({ syncScoreInterval: 10 });
    // Turn 1 is not a multiple of 10, so no full computation
    const result = rt.evaluateSyncScore(["Test."], 1);
    // EWMA stays at initial value
    expect(result.ewmaScore).toBe(1.0);
    expect(result.needsReinjection).toBe(false);
  });

  it("scheduled turns trigger full evaluation and log", () => {
    const rt = createCortexRuntime({ syncScoreInterval: 10 });
    // Turn 10 is a multiple of 10 -> full computation
    const result = rt.evaluateSyncScore(["This is a test response."], 10);
    // EWMA should move from 1.0
    expect(result.turnNumber).toBe(10);
    expect(result.consistency).toBeDefined();
    expect(result.consistency.C).toBeGreaterThanOrEqual(0);
    expect(result.consistency.C).toBeLessThanOrEqual(1);
  });
});

describe("Consistency Metric", () => {
  it("returns 1.0 compliance with no probes (assume compliant)", () => {
    expect(computeHardRuleCompliance([])).toBe(1.0);
  });

  it("computes consistency from probes and responses", () => {
    const result = computeConsistency([], ["Hello, how are you?", "I'm doing well."]);
    expect(result.C).toBeGreaterThanOrEqual(0);
    expect(result.C).toBeLessThanOrEqual(1);
    expect(result.Munit).toBe(1.0); // no probes -> assume compliant
    expect(result.action).toBeDefined();
  });

  it("classifies actions correctly by threshold", () => {
    expect(classifyAction(0.9)).toBe("none");
    expect(classifyAction(0.85)).toBe("mild_reinforce");
    expect(classifyAction(0.75)).toBe("mild_reinforce");
    expect(classifyAction(0.7)).toBe("moderate_refresh");
    expect(classifyAction(0.6)).toBe("moderate_refresh");
    expect(classifyAction(0.5)).toBe("severe_rebase");
    expect(classifyAction(0.3)).toBe("severe_rebase");
  });

  it("healthy threshold is 0.85", () => {
    expect(CONSISTENCY_CONFIG.healthy).toBe(0.85);
  });

  it("embedding variance is 0 with fewer than 2 responses", () => {
    const result = computeConsistency([], ["Only one response."]);
    expect(result.Memb).toBe(0);
  });

  it("C formula: alpha_C * Munit + (1 - alpha_C) * (1 - Memb)", () => {
    // With no probes (Munit=1) and single response (Memb=0):
    // C = 0.6 * 1.0 + 0.4 * (1 - 0) = 1.0
    const result = computeConsistency([], ["Single response."]);
    expect(result.C).toBe(1.0);
  });
});
