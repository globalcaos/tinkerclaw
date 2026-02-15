import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "./session-store.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });

  it("handles non-unit vectors", () => {
    expect(cosineSimilarity([2, 0], [4, 0])).toBeCloseTo(1);
  });
});
