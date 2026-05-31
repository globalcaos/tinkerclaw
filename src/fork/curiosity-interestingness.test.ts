import { describe, it, expect, vi } from "vitest";
import {
  blendInterestingness,
  parseJudgeScore,
  buildJudgePrompt,
  scoreGapsWithInterestingness,
  DEFAULT_BLEND_WEIGHT,
  type InterestingnessJudge,
} from "./curiosity-interestingness.js";
import { makeGap, rescore, DEFAULT_WEIGHTS, type Gap } from "./curiosity-store.js";

// A fixed clock so rescore's recency term is deterministic across the suite.
const NOW = 1_700_000_000_000;

function gapAt(input: Parameters<typeof makeGap>[0]): Gap {
  return makeGap({ ts: NOW, ...input });
}

describe("blendInterestingness — pure blend core", () => {
  it("is a weighted average of fixed and judge at the given weight", () => {
    expect(blendInterestingness(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 10);
    expect(blendInterestingness(0.2, 0.8, 0.25)).toBeCloseTo(0.35, 10);
    expect(blendInterestingness(0.2, 0.8, 0.75)).toBeCloseTo(0.65, 10);
  });

  it("weight=0 ignores the judge (pure fixed); weight=1 ignores fixed (pure judge)", () => {
    expect(blendInterestingness(0.2, 0.9, 0)).toBeCloseTo(0.2, 10);
    expect(blendInterestingness(0.2, 0.9, 1)).toBeCloseTo(0.9, 10);
  });

  it("defaults to weight=0.5 when omitted", () => {
    expect(blendInterestingness(0.4, 0.6)).toBeCloseTo(0.5, 10);
    expect(DEFAULT_BLEND_WEIGHT).toBe(0.5);
  });

  it("clamps fixed, judge, and weight into [0,1]", () => {
    // out-of-range judge clamps to 1, fixed clamps to 0, weight clamps to 1 → pure judge=1
    expect(blendInterestingness(-5, 5, 9)).toBeCloseTo(1, 10);
    // weight clamps to 0 → pure fixed=0
    expect(blendInterestingness(0, 1, -9)).toBeCloseTo(0, 10);
  });

  it("falls back to the fixed score when the judge score is non-finite (safety net)", () => {
    expect(blendInterestingness(0.42, Number.NaN, 0.5)).toBeCloseTo(0.42, 10);
    expect(blendInterestingness(0.42, Number.POSITIVE_INFINITY, 0.5)).toBeCloseTo(0.42, 10);
    // a non-finite FIXED falls back to 0 (no priority known)
    expect(blendInterestingness(Number.NaN, 0.8, 0.5)).toBeCloseTo(0.4, 10);
  });
});

describe("parseJudgeScore — judge reply parsing", () => {
  it("parses a bare 0-100 integer onto the 0..1 scale", () => {
    expect(parseJudgeScore("80")).toBeCloseTo(0.8, 10);
    expect(parseJudgeScore("0")).toBe(0);
    expect(parseJudgeScore("100")).toBe(1);
  });

  it("prefers an explicit SCORE: label even amid prose", () => {
    expect(parseJudgeScore("Here is my rating.\nSCORE: 73\nthanks")).toBeCloseTo(0.73, 10);
    expect(parseJudgeScore("score=12")).toBeCloseTo(0.12, 10);
  });

  it("treats a value already in [0,1] as normalized", () => {
    expect(parseJudgeScore("0.65")).toBeCloseTo(0.65, 10);
    expect(parseJudgeScore("SCORE: 1")).toBe(1);
  });

  it("clamps to [0,1] and returns undefined when no number is present", () => {
    expect(parseJudgeScore("250")).toBe(1);
    expect(parseJudgeScore("no number here")).toBeUndefined();
    expect(parseJudgeScore("")).toBeUndefined();
    expect(parseJudgeScore(undefined)).toBeUndefined();
  });
});

describe("buildJudgePrompt — prompt shape", () => {
  it("includes the gap topic, source, and NO-MATCH specifics, and asks for SCORE: 0-100", () => {
    const gap = gapAt({
      topic: "use playwright",
      source: "no-match",
      toolName: "playwright",
      recipeName: "scrape",
      reason: "unknown tool",
      importance: 0.7,
    });
    gap.frequency = 4;
    const prompt = buildJudgePrompt(gap);
    expect(prompt).toContain("use playwright");
    expect(prompt).toContain("no-match");
    expect(prompt).toContain("playwright");
    expect(prompt).toContain("scrape");
    expect(prompt).toContain("seen 4 times");
    expect(prompt).toMatch(/SCORE:\s*<0-100>/);
    expect(prompt.toLowerCase()).toContain("novelty");
    expect(prompt.toLowerCase()).toContain("tractability");
    expect(prompt.toLowerCase()).toContain("usefulness");
  });
});

describe("scoreGapsWithInterestingness — DI scoring + fallback", () => {
  const mkGaps = (): Gap[] => [
    gapAt({ topic: "alpha", source: "manual", importance: 0.1, userRelevance: 0.1 }),
    gapAt({ topic: "beta", source: "manual", importance: 0.9, userRelevance: 0.9 }),
  ];

  it("blends a mock judge with the fixed score and sorts descending by blended score", async () => {
    // Mock judge: reverse the fixed signal — rate the low-fixed gap 1.0, the high one 0.0.
    const judge: InterestingnessJudge = vi.fn(async (gap) => (gap.topic === "alpha" ? 1.0 : 0.0));
    const gaps = mkGaps();
    const out = await scoreGapsWithInterestingness(gaps, {
      judge,
      blendWeight: 0.5,
      nowTs: NOW,
    });

    expect(judge).toHaveBeenCalledTimes(2);
    // Each blended score = 0.5*fixed + 0.5*judge.
    const alpha = out.find((s) => s.gap.topic === "alpha")!;
    const beta = out.find((s) => s.gap.topic === "beta")!;
    expect(alpha.score).toBeCloseTo(
      blendInterestingness(rescore(gaps[0]!, DEFAULT_WEIGHTS, NOW), 1.0, 0.5),
      10,
    );
    expect(beta.score).toBeCloseTo(
      blendInterestingness(rescore(gaps[1]!, DEFAULT_WEIGHTS, NOW), 0.0, 0.5),
      10,
    );
    expect(alpha.judgeScore).toBe(1.0);
    expect(beta.judgeScore).toBe(0.0);
    // Sorted descending — alpha (judge-boosted) should now outrank beta.
    expect(out[0]!.gap.topic).toBe("alpha");
    expect(out.map((s) => s.score)).toEqual([...out.map((s) => s.score)].sort((a, b) => b - a));
  });

  it("falls back to the fixed score when the judge returns undefined", async () => {
    const judge: InterestingnessJudge = vi.fn(async () => undefined);
    const gaps = mkGaps();
    const out = await scoreGapsWithInterestingness(gaps, { judge, nowTs: NOW });
    for (const s of out) {
      expect(s.judgeScore).toBeUndefined();
      // score collapses to the pure fixed rescore (the linear safety net).
      expect(s.score).toBeCloseTo(s.fixedScore, 10);
      expect(s.score).toBeCloseTo(rescore(s.gap, DEFAULT_WEIGHTS, NOW), 10);
    }
  });

  it("falls back per-gap when the judge THROWS (never propagates)", async () => {
    const judge: InterestingnessJudge = vi.fn(async (gap) => {
      if (gap.topic === "beta") throw new Error("judge exploded");
      return 0.9;
    });
    const gaps = mkGaps();
    const out = await scoreGapsWithInterestingness(gaps, {
      judge,
      blendWeight: 0.5,
      nowTs: NOW,
    });
    const beta = out.find((s) => s.gap.topic === "beta")!;
    const alpha = out.find((s) => s.gap.topic === "alpha")!;
    // beta's judge threw → fixed fallback, no judgeScore recorded.
    expect(beta.judgeScore).toBeUndefined();
    expect(beta.score).toBeCloseTo(beta.fixedScore, 10);
    // alpha got a real judge score and was blended.
    expect(alpha.judgeScore).toBe(0.9);
    expect(alpha.score).toBeCloseTo(blendInterestingness(alpha.fixedScore, 0.9, 0.5), 10);
  });

  it("returns [] for no gaps and never throws", async () => {
    const judge: InterestingnessJudge = vi.fn(async () => 0.5);
    await expect(scoreGapsWithInterestingness([], { judge })).resolves.toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("passes the fixed score to the judge so a learning-progress judge can use it", async () => {
    const seen: number[] = [];
    const judge: InterestingnessJudge = vi.fn(async (_gap, fixedScore) => {
      seen.push(fixedScore);
      return fixedScore; // echo → blended == fixed regardless of weight
    });
    const gaps = mkGaps();
    const out = await scoreGapsWithInterestingness(gaps, {
      judge,
      blendWeight: 0.5,
      nowTs: NOW,
    });
    expect(seen).toEqual(gaps.map((g) => rescore(g, DEFAULT_WEIGHTS, NOW)));
    for (const s of out) {
      expect(s.score).toBeCloseTo(s.fixedScore, 10);
    }
  });
});
