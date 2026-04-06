import { describe, it, expect } from "vitest";
import { mergeHybridResults } from "../src/hybrid-merge.js";

describe("mergeHybridResults", () => {
  it("returns empty for empty inputs", () => {
    expect(mergeHybridResults({ vector: [], keyword: [] })).toEqual([]);
  });

  it("handles vector-only results", () => {
    const result = mergeHybridResults({
      vector: [
        { eventId: "a", score: 0.9 },
        { eventId: "b", score: 0.6 },
      ],
      keyword: [],
    });
    expect(result.length).toBe(2);
    expect(result[0].eventId).toBe("a");
    expect(result[0].vectorScore).toBeCloseTo(1.0);
    expect(result[0].keywordScore).toBe(0);
  });

  it("handles keyword-only results", () => {
    const result = mergeHybridResults({
      vector: [],
      keyword: [
        { eventId: "x", score: 2.0 },
        { eventId: "y", score: 1.0 },
      ],
    });
    expect(result.length).toBe(2);
    expect(result[0].eventId).toBe("x");
    expect(result[0].keywordScore).toBeCloseTo(1.0);
    expect(result[0].vectorScore).toBe(0);
  });

  it("merges overlapping results", () => {
    const result = mergeHybridResults({
      vector: [{ eventId: "shared", score: 0.8 }],
      keyword: [{ eventId: "shared", score: 1.5 }],
    });
    expect(result.length).toBe(1);
    expect(result[0].score).toBeCloseTo(1.0); // 0.6*1 + 0.4*1
  });

  it("merges disjoint results", () => {
    const result = mergeHybridResults({
      vector: [{ eventId: "vec-only", score: 0.7 }],
      keyword: [{ eventId: "kw-only", score: 1.2 }],
    });
    expect(result.length).toBe(2);
    const v = result.find((r) => r.eventId === "vec-only")!;
    const k = result.find((r) => r.eventId === "kw-only")!;
    expect(v.score).toBeCloseTo(0.6); // 0.6*1 + 0.4*0
    expect(k.score).toBeCloseTo(0.4); // 0.6*0 + 0.4*1
  });

  it("normalizes scores within each set", () => {
    const result = mergeHybridResults({
      vector: [
        { eventId: "a", score: 1.0 },
        { eventId: "b", score: 0.5 },
      ],
      keyword: [
        { eventId: "a", score: 3.0 },
        { eventId: "c", score: 1.5 },
      ],
    });
    const a = result.find((r) => r.eventId === "a")!;
    expect(a.vectorScore).toBeCloseTo(1.0);
    expect(a.keywordScore).toBeCloseTo(1.0);
    expect(a.score).toBeCloseTo(1.0);
  });

  it("respects custom weights", () => {
    const result = mergeHybridResults({
      vector: [{ eventId: "a", score: 1.0 }],
      keyword: [{ eventId: "b", score: 1.0 }],
      vectorWeight: 0.3,
      keywordWeight: 0.7,
    });
    const a = result.find((r) => r.eventId === "a")!;
    const b = result.find((r) => r.eventId === "b")!;
    expect(a.score).toBeCloseTo(0.3);
    expect(b.score).toBeCloseTo(0.7);
    expect(result[0].eventId).toBe("b");
  });

  it("sorts descending by combined score", () => {
    const result = mergeHybridResults({
      vector: [
        { eventId: "a", score: 0.3 },
        { eventId: "b", score: 0.9 },
        { eventId: "c", score: 0.6 },
      ],
      keyword: [],
    });
    expect(result[0].eventId).toBe("b");
    expect(result[1].eventId).toBe("c");
    expect(result[2].eventId).toBe("a");
  });

  it("handles all-zero scores", () => {
    const result = mergeHybridResults({
      vector: [{ eventId: "a", score: 0 }],
      keyword: [{ eventId: "b", score: 0 }],
    });
    expect(result.length).toBe(2);
    for (const r of result) {
      expect(r.score).toBe(0);
    }
  });
});
