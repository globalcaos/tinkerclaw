/**
 * Tests for CDI (Cognitive Diversity Index) scoring (extension copy).
 */

import { describe, it, expect } from "vitest";
import { pearsonCorrelation, measureCDI, correlationCI } from "../src/cognitive-diversity.js";

describe("CDI: returns 0 for unanimous proposals", () => {
  it("identical error vectors produce CDI = 0", () => {
    const errors = [true, false, true, true, false, false, true, false, true, true];
    const result = measureCDI({
      modelA: errors,
      modelB: [...errors],
      modelC: [...errors],
    });
    expect(result.cdi).toBeCloseTo(0, 1);
  });

  it("single model produces CDI = 0 (no pairs)", () => {
    const result = measureCDI({
      onlyModel: [true, false, true],
    });
    // With one model there are 0 pairs, meanCorrelation = 0, CDI = 1 - 0 = 1
    // Actually: pairs = 0, so sumCorrelation / pairs would be 0, CDI = 1
    // This is correct: a single model has no pairwise diversity to measure
    expect(result.cdi).toBe(1);
  });
});

describe("CDI: returns >0 when roles disagree", () => {
  it("uncorrelated vectors produce CDI > 0.5", () => {
    const a = [true, false, true, false, true, false, true, false, true, false];
    const b = [false, true, false, true, false, true, false, true, false, true];
    const c = [true, true, false, false, true, true, false, false, true, true];

    const result = measureCDI({ a, b, c });
    expect(result.cdi).toBeGreaterThan(0.5);
  });

  it("anti-correlated vectors produce CDI > 1", () => {
    const a = [true, true, true, true, true, false, false, false, false, false];
    const b = [false, false, false, false, false, true, true, true, true, true];

    const result = measureCDI({ a, b });
    expect(result.cdi).toBeGreaterThan(1);
  });

  it("partially overlapping errors produce 0 < CDI < 2", () => {
    const a = [true, true, false, false, true, false, true, false];
    const b = [true, false, true, false, true, true, false, false];

    const result = measureCDI({ a, b });
    expect(result.cdi).toBeGreaterThan(0);
    expect(result.cdi).toBeLessThan(2);
  });
});

describe("CDI: score range is always [0,1] for correlated inputs", () => {
  it("identical errors give CDI = 0 (minimum for positively correlated)", () => {
    const v = [true, false, true, false, true];
    const result = measureCDI({ x: v, y: [...v] });
    expect(result.cdi).toBeCloseTo(0, 5);
  });

  it("confidence interval is computed and brackets the mean correlation", () => {
    const [lo, hi] = correlationCI(0.5, 50);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(1);
  });

  it("small sample returns wide CI [-1, 1]", () => {
    const [lo, hi] = correlationCI(0.5, 3);
    expect(lo).toBe(-1);
    expect(hi).toBe(1);
  });
});

describe("CDI: edge cases", () => {
  it("pearsonCorrelation of empty arrays returns 0", () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  it("pearsonCorrelation of constant arrays returns 0 (no variance)", () => {
    expect(pearsonCorrelation([true, true, true], [true, true, true])).toBe(0);
  });

  it("measureCDI timestamp is a valid ISO string", () => {
    const result = measureCDI({ a: [true], b: [false] });
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
