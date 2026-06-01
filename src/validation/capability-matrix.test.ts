/**
 * FORK 2026-06-01 — tests for the capability-regression gate (J8 §2c, codeable-now).
 *
 * Test target: src/validation/capability-matrix.ts
 *
 * The 2c LoRA TRAINER is EXTERNAL/OUT-OF-SCOPE; only the validation gate is in-scope and
 * tested here. All scores are injected (mocked benchmark scores — NO GPU, NO model API in
 * CI), per the J8 plan test convention ("mocked trainer + mocked benchmark scores").
 */

import { describe, it, expect } from "vitest";
import {
  runCapabilityMatrix,
  isRegression,
  MAX_REGRESSION_THRESHOLD,
  type BenchmarkScores,
} from "./capability-matrix.js";

// A baseline (pre-adapter) score sheet used across the suite.
const BASELINE: BenchmarkScores = {
  mmlu: 0.7,
  humaneval: 0.5,
  gsm8k: 0.6,
  ifeval: 0.8,
};

describe("runCapabilityMatrix — default stub gate", () => {
  it("returns a passing { maxRegression: 0.01 } stub so the apply path is testable without a real benchmark", async () => {
    const report = await runCapabilityMatrix("adapter-xyz");
    expect(report.maxRegression).toBeCloseTo(0.01, 10);
    expect(report.maxRegression).toBeLessThanOrEqual(MAX_REGRESSION_THRESHOLD);
    expect(report.alignmentFail).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.adapter).toBe("adapter-xyz");
  });

  it("the gate threshold is the paper §7.2 ICVR 2% bound", () => {
    expect(MAX_REGRESSION_THRESHOLD).toBeCloseTo(0.02, 10);
  });
});

describe("runCapabilityMatrix — injected benchmark scores (mocked, no GPU)", () => {
  it("computes maxRegression as the largest per-benchmark drop and passes within tolerance", async () => {
    // candidate drops mmlu by 0.01 (within 2%), improves the rest → maxRegression 0.01, pass.
    const candidate: BenchmarkScores = { mmlu: 0.69, humaneval: 0.55, gsm8k: 0.62, ifeval: 0.81 };
    const report = await runCapabilityMatrix("cand", { baseline: BASELINE, candidate });
    expect(report.maxRegression).toBeCloseTo(0.01, 10);
    expect(report.passed).toBe(true);
    expect(report.alignmentFail).toBe(false);
  });

  it("rejects when ANY benchmark regresses more than 2%", async () => {
    // gsm8k drops 0.05 (>2%) → reject even though others improve.
    const candidate: BenchmarkScores = { mmlu: 0.72, humaneval: 0.55, gsm8k: 0.55, ifeval: 0.85 };
    const report = await runCapabilityMatrix("cand", { baseline: BASELINE, candidate });
    expect(report.maxRegression).toBeCloseTo(0.05, 10);
    expect(report.maxRegression).toBeGreaterThan(MAX_REGRESSION_THRESHOLD);
    expect(report.passed).toBe(false);
  });

  it("treats an improvement (no drop) as zero regression and passes", async () => {
    const candidate: BenchmarkScores = { mmlu: 0.75, humaneval: 0.55, gsm8k: 0.65, ifeval: 0.85 };
    const report = await runCapabilityMatrix("cand", { baseline: BASELINE, candidate });
    expect(report.maxRegression).toBe(0);
    expect(report.passed).toBe(true);
  });
});

describe("runCapabilityMatrix — alignment short-circuit", () => {
  it("alignment-fail rejects the merge regardless of benchmark deltas", async () => {
    // benchmarks all improve, but alignment fails → still rejected.
    const candidate: BenchmarkScores = { mmlu: 0.99, humaneval: 0.99, gsm8k: 0.99, ifeval: 0.99 };
    const report = await runCapabilityMatrix("cand", {
      baseline: BASELINE,
      candidate,
      alignmentFail: true,
    });
    expect(report.maxRegression).toBe(0);
    expect(report.alignmentFail).toBe(true);
    expect(report.passed).toBe(false);
  });
});

describe("isRegression — pure threshold predicate", () => {
  it("is true only when maxRegression exceeds the 2% threshold OR alignment failed", () => {
    expect(isRegression({ maxRegression: 0.0, alignmentFail: false })).toBe(false);
    expect(isRegression({ maxRegression: 0.02, alignmentFail: false })).toBe(false); // == threshold, not >
    expect(isRegression({ maxRegression: 0.0201, alignmentFail: false })).toBe(true);
    expect(isRegression({ maxRegression: 0.0, alignmentFail: true })).toBe(true);
  });
});
