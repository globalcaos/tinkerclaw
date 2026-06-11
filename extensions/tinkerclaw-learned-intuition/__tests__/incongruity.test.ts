import { describe, it, expect } from "vitest";
import {
  segmentByPurpose,
  cosine,
  judgeIncongruity,
  DEFAULT_INCONGRUITY_THRESHOLD,
} from "../src/incongruity.js";

describe("incongruity — segmentation", () => {
  it("splits at a purpose connective", () => {
    const s = segmentByPurpose("build me a chess game so I can water my plants");
    expect(s).not.toBeNull();
    expect(s!.head).toBe("build me a chess game");
    expect(s!.tail).toBe("water my plants");
  });

  it("returns null when there is no connective", () => {
    expect(segmentByPurpose("just refactor the login module please")).toBeNull();
  });

  it("returns null when a clause is too short (single-intent safety)", () => {
    expect(segmentByPurpose("go so I can")).toBeNull();
  });

  it("handles 'in order to' and 'because'", () => {
    expect(
      segmentByPurpose("order more printer paper in order to fix the memory leak"),
    ).not.toBeNull();
    expect(segmentByPurpose("write the parser because the logs are unreadable")).not.toBeNull();
  });
});

describe("incongruity — cosine + judgement", () => {
  it("cosine of identical vectors is ~1", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
  });

  it("cosine of orthogonal vectors is ~0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it("flags incongruous (low cosine) and passes coherent (high cosine)", () => {
    const head = new Float32Array([1, 0, 0, 0]);
    const incoherentTail = new Float32Array([0, 1, 0, 0]); // cos 0 < threshold
    const coherentTail = new Float32Array([0.95, 0.31, 0, 0]); // cos ~0.95 > threshold
    expect(judgeIncongruity(head, incoherentTail).incongruous).toBe(true);
    expect(judgeIncongruity(head, coherentTail).incongruous).toBe(false);
  });

  it("default threshold is conservative (low)", () => {
    expect(DEFAULT_INCONGRUITY_THRESHOLD).toBeLessThan(0.2);
    expect(DEFAULT_INCONGRUITY_THRESHOLD).toBeGreaterThan(0);
  });
});
