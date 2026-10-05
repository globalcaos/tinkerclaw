import { describe, expect, it } from "vitest";
import {
  breakEvenN,
  decideSwitch,
  digestPays,
  singleStepPays,
  switchRatios,
  type SwitchInput,
} from "./thalamus-switch.js";
import { FABLE, HAIKU, OPUS } from "./thalamus-v4.test-support.js";

describe("N*: the paper's break-even run (P§5.1)", () => {
  it("is about 2.9 for a candidate five times cheaper at the usual cache prices", () => {
    expect(breakEvenN({ k: 5, rb: 0.1, rs: 0.1, w: 1.25 })).toBeCloseTo(2.875, 10);
  });

  it("is about 4.8 with the one-hour cache write", () => {
    expect(breakEvenN({ k: 5, rb: 0.1, rs: 0.1, w: 2 })).toBeCloseTo(4.75, 10);
  });

  it("is about 7.7 when the incumbent reads its cache for a twentieth (Opus 5.5)", () => {
    expect(breakEvenN({ k: 5, rb: 0.05, rs: 0.1, w: 1.25 })).toBeCloseTo(7.6667, 3);
  });

  it("is the same 7.7 for a model ten times dearer that reads for a fortieth (Fable 5.1)", () => {
    expect(breakEvenN({ k: 10, rb: 0.025, rs: 0.1, w: 1.25 })).toBeCloseTo(7.6667, 3);
  });

  it("does not depend on the length of the thread", () => {
    // N* has no thread-length argument at all; the ratios are the whole input.
    expect(breakEvenN.length).toBe(1);
  });

  it("never pays when k * r_b <= r_s", () => {
    expect(breakEvenN({ k: 1, rb: 0.1, rs: 0.1, w: 1.25 })).toBe(Infinity);
    expect(breakEvenN({ k: 0.5, rb: 0.1, rs: 0.1, w: 2 })).toBe(Infinity);
    expect(breakEvenN({ k: 1.5, rb: 0.05, rs: 0.1, w: 1.25 })).toBe(Infinity);
  });

  it("pays late, not never, when k * r_b only just clears r_s (Opus 5.5 -> a model four times cheaper)", () => {
    expect(breakEvenN({ k: 4, rb: 0.05, rs: 0.1, w: 1.25 })).toBeCloseTo(11.5, 10);
  });

  it("is never negative", () => {
    expect(breakEvenN({ k: 10, rb: 0.5, rs: 2, w: 1 })).toBeGreaterThanOrEqual(0);
    expect(breakEvenN({ k: 10, rb: 0.5, rs: 0.1, w: 0.05 })).toBe(0);
  });

  it("comes out of the price table: Opus 5 -> Haiku 4.5 is 4.75 (1 h) and 2.875 (5 min)", () => {
    expect(breakEvenN(switchRatios(OPUS, HAIKU, "1h")!)).toBeCloseTo(4.75, 10);
    expect(breakEvenN(switchRatios(OPUS, HAIKU, "5m")!)).toBeCloseTo(2.875, 10);
  });

  it("comes out of the price table: Fable 5.1 -> Haiku 4.5 is about 7.7 at the 5-minute write", () => {
    expect(breakEvenN(switchRatios(FABLE, HAIKU, "5m")!)).toBeCloseTo(7.6667, 3);
  });

  it("has no ratios when a model has no price or cache figure", () => {
    expect(switchRatios(OPUS, "openai-codex/gpt-9-unlisted")).toBeUndefined();
    expect(switchRatios("copilot/copilot-think-deeper", HAIKU)).toBeUndefined();
  });
});

describe("single step: pays only when k * r_b > 1", () => {
  it("has thresholds of 10x, 20x and 40x at cache reads of 0.1, 0.05 and 0.025", () => {
    for (const [rb, threshold] of [
      [0.1, 10],
      [0.05, 20],
      [0.025, 40],
    ] as const) {
      expect(singleStepPays({ k: threshold * 1.001, rb }), `rb ${rb}`).toBe(true);
      expect(singleStepPays({ k: threshold * 0.999, rb }), `rb ${rb}`).toBe(false);
    }
  });
});

describe("digest: (1 - d/S)(w + r_b L) > q (P§5.2)", () => {
  it("pays at L = 0 when the digest is under a fifth of the result, for any reader no dearer than the incumbent", () => {
    for (const w of [1.25, 2]) {
      for (const q of [0.1, 0.5, 1]) {
        expect(digestPays({ dOverS: 0.19, w, rb: 0.1, L: 0, q }), `w ${w} q ${q}`).toBe(true);
      }
    }
    expect(digestPays({ dOverS: 0.21, w: 1.25, rb: 0.1, L: 0, q: 1 })).toBe(false);
  });

  it("gains margin with every step that follows", () => {
    // Half the result is kept: fails with no later step, pays once enough steps re-read it.
    expect(digestPays({ dOverS: 0.5, w: 1.25, rb: 0.1, L: 0, q: 1 })).toBe(false);
    expect(digestPays({ dOverS: 0.5, w: 1.25, rb: 0.1, L: 7, q: 1 })).toBe(false);
    expect(digestPays({ dOverS: 0.5, w: 1.25, rb: 0.1, L: 8, q: 1 })).toBe(true);
    let prev = -Infinity;
    for (let L = 0; L < 30; L++) {
      const v = (1 - 0.5) * (1.25 + 0.1 * L);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("pays on the incumbent's own model (q = 1): the saving is not carrying the raw result", () => {
    expect(digestPays({ dOverS: 0.1, w: 1.25, rb: 0.1, L: 0, q: 1 })).toBe(true);
  });

  it("does not pay when the reader costs more than the saving", () => {
    expect(digestPays({ dOverS: 0.1, w: 1.25, rb: 0.1, L: 2, q: 2 })).toBe(false);
  });
});

describe("decideSwitch: the policy (P§5.4)", () => {
  const ratios = { k: 5, rb: 0.1, rs: 0.1, w: 2 }; // N* = 4.75
  const base: SwitchInput = {
    incumbentKey: OPUS,
    pickKey: HAIKU,
    handPicked: false,
    fresh: false,
    expectedRun: 3,
    incumbentCold: false,
    ratios,
  };

  it("keeps a hand-picked model before anything else is looked at", () => {
    expect(decideSwitch({ ...base, handPicked: true, fresh: true, incumbentCold: true })).toEqual({
      kind: "keep",
      reason: "hand-picked",
    });
  });

  it("does nothing when the pick is the incumbent", () => {
    expect(decideSwitch({ ...base, pickKey: OPUS }).reason).toBe("no-change");
  });

  it("switches freely at a fresh point", () => {
    expect(decideSwitch({ ...base, fresh: true })).toEqual({
      kind: "fresh",
      reason: "fresh-point",
    });
  });

  it("holds a running thread below N* and moves it above N*", () => {
    const below = decideSwitch({ ...base, expectedRun: 4 });
    expect(below).toMatchObject({ kind: "keep", reason: "kept-below-n-star", expectedRun: 4 });
    expect(below.nStar).toBeCloseTo(4.75, 10);
    const above = decideSwitch({ ...base, expectedRun: 5 });
    expect(above).toMatchObject({ kind: "switch", reason: "run-exceeds-n-star", expectedRun: 5 });
  });

  it("moves a single step only when k * r_b > 1", () => {
    expect(decideSwitch({ ...base, expectedRun: 1 }).kind).toBe("keep");
    expect(
      decideSwitch({ ...base, expectedRun: 1, ratios: { k: 12, rb: 0.1, rs: 0.1, w: 2 } }),
    ).toMatchObject({
      kind: "switch",
      reason: "single-step-pays",
    });
  });

  it("escalates a stuck step when a stronger model is cheaper than another failed try", () => {
    expect(
      decideSwitch({ ...base, outcome: "stuck", strongerCheaperThanRetry: true, expectedRun: 0 }),
    ).toEqual({
      kind: "switch",
      reason: "stuck",
    });
    expect(
      decideSwitch({ ...base, outcome: "stuck", strongerCheaperThanRetry: false, expectedRun: 0 })
        .reason,
    ).toBe("kept-below-n-star");
  });

  it("moves when the incumbent's cache is cold anyway", () => {
    expect(decideSwitch({ ...base, incumbentCold: true, expectedRun: 0 })).toEqual({
      kind: "switch",
      reason: "cache-cold",
    });
  });

  it("holds the incumbent when the price table cannot say (the cautious side)", () => {
    expect(decideSwitch({ ...base, ratios: undefined, expectedRun: 30 }).kind).toBe("keep");
  });

  it("never switches when the candidate can never pay", () => {
    expect(
      decideSwitch({ ...base, expectedRun: 1000, ratios: { k: 1.5, rb: 0.05, rs: 0.1, w: 1.25 } }),
    ).toMatchObject({
      kind: "keep",
      nStar: Infinity,
    });
  });
});
