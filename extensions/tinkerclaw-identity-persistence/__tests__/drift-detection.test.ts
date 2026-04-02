/**
 * Tests for drift detection, user correction patterns, and EWMA smoothing.
 */
import { describe, it, expect } from "vitest";
import type { ProbeResult } from "../src/behavioral-probes.js";
import {
  detectUserCorrections,
  aggregateProbeScores,
  computeAdaptiveWeights,
  createDriftState,
  computeDriftScore,
  DRIFT_CONFIG,
} from "../src/drift-detection.js";

describe("Drift Detection", () => {
  it("detects drift in off-persona responses (user corrections)", () => {
    const corrections = detectUserCorrections("don't be so formal please");
    expect(corrections.length).toBeGreaterThan(0);
  });

  it("detects multiple correction patterns", () => {
    expect(detectUserCorrections("be more natural").length).toBeGreaterThan(0);
    expect(detectUserCorrections("you usually talk differently").length).toBeGreaterThan(0);
    expect(detectUserCorrections("that's not like you").length).toBeGreaterThan(0);
    expect(detectUserCorrections("stop being so verbose").length).toBeGreaterThan(0);
    expect(detectUserCorrections("too formal for this context").length).toBeGreaterThan(0);
    expect(detectUserCorrections("can you tone down the formality").length).toBeGreaterThan(0);
    expect(detectUserCorrections("that doesn't sound like you").length).toBeGreaterThan(0);
    expect(detectUserCorrections("go back to your normal style").length).toBeGreaterThan(0);
  });

  it("no false positives on consistent persona", () => {
    const corrections = detectUserCorrections("That sounds great, thanks!");
    expect(corrections).toHaveLength(0);
  });

  it("no false positives on normal conversation", () => {
    expect(detectUserCorrections("What is the weather today?")).toHaveLength(0);
    expect(detectUserCorrections("Please help me with this code.")).toHaveLength(0);
    expect(detectUserCorrections("Can you explain how DNS works?")).toHaveLength(0);
  });

  it("drift score range [0,1]", () => {
    const state = createDriftState();
    // With a correction
    const score1 = computeDriftScore("don't be so formal", [], state, 1);
    expect(score1.rawScore).toBeGreaterThanOrEqual(0);
    expect(score1.rawScore).toBeLessThanOrEqual(1);
    expect(score1.ewmaScore).toBeGreaterThanOrEqual(0);
    expect(score1.ewmaScore).toBeLessThanOrEqual(1);

    // Without a correction
    const score2 = computeDriftScore("Hello, how are you?", [], state, 2);
    expect(score2.rawScore).toBeGreaterThanOrEqual(0);
    expect(score2.rawScore).toBeLessThanOrEqual(1);
  });

  it("EWMA smoothing with alpha=0.3", () => {
    expect(DRIFT_CONFIG.ewmaAlpha).toBe(0.3);
    const state = createDriftState();
    expect(state.ewmaScore).toBe(0);

    // First correction: raw=0.4 (wu*1.0), ewma = 0.3*0.4 + 0.7*0 = 0.12
    // (wu depends on adaptive weights, but with no prior density it's at max probe boost)
    const score = computeDriftScore("don't be so formal", [], state, 1);
    expect(score.ewmaScore).toBeGreaterThan(0);
    expect(state.ewmaScore).toBe(score.ewmaScore);
  });

  it("accumulates corrections in sliding window", () => {
    const state = createDriftState();
    // Fill window with corrections
    for (let i = 1; i <= 5; i++) {
      computeDriftScore("be more natural", [], state, i);
    }
    expect(state.userCorrectionWindow.length).toBe(5);
    expect(state.userCorrectionWindow.every(Boolean)).toBe(true);

    // Add non-corrections
    for (let i = 6; i <= 10; i++) {
      computeDriftScore("Hello, thanks!", [], state, i);
    }
    expect(state.userCorrectionWindow.length).toBe(10);
  });

  it("window size is bounded at correctionWindowSize", () => {
    const state = createDriftState();
    for (let i = 1; i <= DRIFT_CONFIG.correctionWindowSize + 5; i++) {
      computeDriftScore("just a message", [], state, i);
    }
    expect(state.userCorrectionWindow.length).toBe(DRIFT_CONFIG.correctionWindowSize);
  });
});

describe("Probe Score Aggregation", () => {
  it("returns 0 with no probes", () => {
    expect(aggregateProbeScores([])).toBe(0);
  });

  it("aggregates probe scores as drift signal", () => {
    const probes: ProbeResult[] = [
      {
        probeType: "hard_rule",
        turnNumber: 1,
        timestamp: new Date().toISOString(),
        scores: { rule1: 0.9, rule2: 0.8 },
        violations: [],
        rawOutput: "",
        model: "test",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        cost: 0,
      },
    ];

    const drift = aggregateProbeScores(probes);
    // (1-0.9 + 1-0.8) / 2 = 0.15
    expect(drift).toBeCloseTo(0.15, 2);
  });

  it("violations add extra drift", () => {
    const withViolations: ProbeResult[] = [
      {
        probeType: "hard_rule",
        turnNumber: 1,
        timestamp: new Date().toISOString(),
        scores: { rule1: 1.0 },
        violations: ["rule2"],
        rawOutput: "",
        model: "test",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        cost: 0,
      },
    ];

    const drift = aggregateProbeScores(withViolations);
    // (1-1.0 + 0.2) / 1 = 0.2
    expect(drift).toBeCloseTo(0.2, 2);
  });
});

describe("Adaptive Weights", () => {
  it("uses base weights when user density is above sparsity threshold", () => {
    const { wu, wp } = computeAdaptiveWeights(0.1);
    expect(wu).toBe(DRIFT_CONFIG.baseWeightUser);
    expect(wp).toBe(DRIFT_CONFIG.baseWeightProbe);
  });

  it("boosts probe weight when user corrections are sparse", () => {
    const { wu, wp } = computeAdaptiveWeights(0);
    expect(wp).toBeGreaterThan(DRIFT_CONFIG.baseWeightProbe);
    expect(wu).toBeLessThan(DRIFT_CONFIG.baseWeightUser);
    expect(wu + wp).toBeCloseTo(1.0, 10);
  });

  it("weights always sum to 1.0", () => {
    for (const density of [0, 0.01, 0.03, 0.05, 0.1, 0.5, 1.0]) {
      const { wu, wp } = computeAdaptiveWeights(density);
      expect(wu + wp).toBeCloseTo(1.0, 10);
    }
  });
});
