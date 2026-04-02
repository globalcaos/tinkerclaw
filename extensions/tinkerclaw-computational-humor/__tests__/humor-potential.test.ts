import { describe, it, expect } from "vitest";
import {
  humorPotentialV2,
  bridgeValidity,
  isInHumorZone,
  type AnnIndex,
} from "../src/humor-potential.js";
import { cosineDistance } from "../src/vector-math.js";

/**
 * Create a simple in-memory ANN index from entries.
 */
function mockIndex(entries: Array<{ id: string; vector: number[] }>): AnnIndex {
  return {
    query(vector: number[], k: number) {
      const scored = entries.map((e) => ({
        ...e,
        sim: e.vector.reduce((s, x, i) => s + x * vector[i], 0),
      }));
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, k);
    },
    getId(vector: number[]) {
      for (const e of entries) {
        const sim = e.vector.reduce((s, x, i) => s + x * vector[i], 0);
        if (sim > 0.9999) {
          return e.id;
        }
      }
      return undefined;
    },
  };
}

describe("humorPotentialV2", () => {
  it("returns a score in [0, 1] range", () => {
    // Orthogonal unit vectors in 4D
    const A = [1, 0, 0, 0];
    const B = [0, 1, 0, 0];
    const bridge = [0.5, 0.5, 0.5, 0.5]; // normalized: [0.5,0.5,0.5,0.5]
    const norm = Math.sqrt(0.5 * 0.5 * 4);
    const bridgeNorm = bridge.map((v) => v / norm);

    const index = mockIndex([
      { id: "A", vector: A },
      { id: "B", vector: B },
      { id: "bridge", vector: bridgeNorm },
    ]);

    const score = humorPotentialV2(A, B, bridgeNorm, index);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns higher score for more distant concepts (distance component)", () => {
    // h_v2 = distance * validity * surprise
    // We test the distance component directly: distant pair has larger cosine distance
    const A_close = [0.95, 0.05, 0, 0];
    const B_close = [0.9, 0.1, 0, 0];
    const A_far = [1, 0, 0, 0];
    const B_far = [0, 1, 0, 0];

    const distClose = cosineDistance(A_close, B_close);
    const distFar = cosineDistance(A_far, B_far);

    expect(distFar).toBeGreaterThan(distClose);
    expect(distFar).toBeGreaterThan(0);
    expect(distFar).toBeLessThanOrEqual(1);
  });

  it("returns 0 for identical concepts", () => {
    const A = [1, 0, 0, 0];
    const index = mockIndex([{ id: "A", vector: A }]);
    const score = humorPotentialV2(A, A, A, index);
    expect(score).toBe(0);
  });
});

describe("bridgeValidity", () => {
  it("returns value in [0, 1]", () => {
    const bridge = [0.5, 0.5, 0, 0];
    const bMag = Math.sqrt(0.5);
    const bridgeNorm = bridge.map((v) => v / bMag);
    const A = [1, 0, 0, 0];
    const B = [0, 1, 0, 0];

    const v = bridgeValidity(bridgeNorm, A, B);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("isInHumorZone", () => {
  it("accepts values within the humor zone", () => {
    expect(isInHumorZone(0.7, 0.3, 0.5)).toBe(true);
  });

  it("rejects distance below minimum", () => {
    expect(isInHumorZone(0.3, 0.5, 0.5)).toBe(false);
  });

  it("rejects distance above maximum", () => {
    expect(isInHumorZone(0.99, 0.5, 0.5)).toBe(false);
  });

  it("rejects low validity", () => {
    expect(isInHumorZone(0.7, 0.05, 0.5)).toBe(false);
  });

  it("rejects low surprise", () => {
    expect(isInHumorZone(0.7, 0.5, 0.1)).toBe(false);
  });
});
