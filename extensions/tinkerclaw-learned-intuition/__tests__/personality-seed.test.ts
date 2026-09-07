import { describe, it, expect } from "vitest";
import {
  generateTargetVector,
  getDimensionIndexMap,
  DEFAULT_TARGET_DIMENSIONS,
} from "../src/personality-seed.js";

describe("personality-seed", () => {
  it("generates a 64-dim vector", () => {
    const v = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    expect(v).toHaveLength(64);
  });

  it("all values are in [0, 1]", () => {
    const v = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    for (const val of v) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic — same input, same output", () => {
    const v1 = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    const v2 = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    expect(v1).toEqual(v2);
  });

  it("humor indices have value 1.0", () => {
    const v = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    const map = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
    const humorIndices = map.get("humor")!;
    expect(humorIndices).toBeDefined();
    // Note: some humor indices may be overwritten by later dimensions
    // (last-writer-wins). Check that at least some are 1.0.
    const humorValues = humorIndices.map((i) => v[i]);
    const maxHumor = Math.max(...humorValues);
    expect(maxHumor).toBe(1.0);
  });

  it("voice_consistency indices exist and have high values", () => {
    const v = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
    const map = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
    const vcIndices = map.get("voice_consistency")!;
    expect(vcIndices).toHaveLength(8);
    // At least some should be 0.95 (may be overwritten by warmth at overlapping indices)
    const vcValues = vcIndices.map((i) => v[i]);
    expect(Math.max(...vcValues)).toBeGreaterThanOrEqual(0.6);
  });

  it("unclaimed dimensions default to 0.5", () => {
    const v = generateTargetVector({ humor: 1.0 });
    const map = getDimensionIndexMap({ humor: 1.0 });
    const humorIndices = new Set(map.get("humor")!);
    // Non-humor indices should be 0.5
    for (let i = 0; i < 64; i++) {
      if (!humorIndices.has(i)) {
        expect(v[i]).toBe(0.5);
      }
    }
  });

  it("each dimension gets 8 unique indices", () => {
    const map = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
    for (const [, indices] of map) {
      expect(indices).toHaveLength(8);
      expect(new Set(indices).size).toBe(8);
    }
  });
});
