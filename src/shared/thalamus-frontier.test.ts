import { describe, expect, it } from "vitest";
import {
  biasPick,
  classifyTaskDomain,
  frontierRungsFor,
  paretoFrontier,
  THALAMUS_BIAS_GAP,
  thalamusRoute,
  type DomainStrength,
  type FrontierRung,
  type TaskDomain,
} from "./thalamus-frontier.js";

// FORK 2026-09-02 (the architect): "They are supposed to be picked as up-left as possible,
// basically defining the top-left outline." These tests pin the three properties the
// envelope and the router now share: the frontier is a monotone top-left outline, the
// BIAS dial walks along it, and a task domain can only move the pick to a model with a
// MEASURED advantage.

const rung = (key: string, effort: string, smart: number, cost: number): FrontierRung => ({
  key,
  effort,
  smart,
  cost,
  basis: "measured",
});

const BOARD: FrontierRung[] = [
  rung("a/best", "max", 65, 1.0),
  rung("a/best", "high", 62, 0.5),
  rung("a/best", "low", 55, 0.3),
  rung("b/mid", "max", 60, 0.2),
  rung("b/mid", "low", 50, 0.05),
  rung("c/cheap", "", 45, 0.02),
  rung("d/dear-and-dumb", "", 58, 2.0), // dominated: dearer than everything, dumber than most
  rung("e/same-price-dumber", "", 40, 0.02), // dominated by c/cheap at equal cost
];

describe("paretoFrontier — the top-left outline", () => {
  it("is cost-ascending with STRICTLY increasing intelligence, and drops every dominated rung", () => {
    const f = paretoFrontier(BOARD);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].cost).toBeGreaterThanOrEqual(f[i - 1].cost);
      expect(f[i].smart).toBeGreaterThan(f[i - 1].smart);
    }
    const keys = f.map((r) => `${r.key}@${r.effort}`);
    expect(keys).not.toContain("d/dear-and-dumb@");
    expect(keys).not.toContain("e/same-price-dumber@");
    // a/best@low (55 at 0.30) is dominated by b/mid@max (60 at 0.20)
    expect(keys).not.toContain("a/best@low");
    expect(keys).toEqual(["c/cheap@", "b/mid@low", "b/mid@max", "a/best@high", "a/best@max"]);
  });

  it("is a function of the SET, not of input order", () => {
    const a = paretoFrontier(BOARD).map((r) => `${r.key}@${r.effort}`);
    const b = paretoFrontier([...BOARD].reverse()).map((r) => `${r.key}@${r.effort}`);
    expect(b).toEqual(a);
  });
});

describe("biasPick — the dial walks the frontier", () => {
  const f = paretoFrontier(BOARD);
  it("at SMART (6) takes the best rung; at FAST (0) the cheapest within 15 points of it", () => {
    expect(biasPick(f, 6)).toMatchObject({ key: "a/best", effort: "max" });
    // best 65 − 15 = 50 → cheapest frontier rung ≥ 50 is b/mid@low (50 at 0.05)
    expect(biasPick(f, 0)).toMatchObject({ key: "b/mid", effort: "low" });
  });
  it("never moves DOWN the frontier as the dial turns right", () => {
    let last = -Infinity;
    for (let i = 0; i < THALAMUS_BIAS_GAP.length; i++) {
      const p = biasPick(f, i)!;
      expect(p.smart).toBeGreaterThanOrEqual(last);
      last = p.smart;
    }
  });
  it("clamps an out-of-range or missing dial to a real stop", () => {
    expect(biasPick(f, 99)).toEqual(biasPick(f, 6));
    expect(biasPick(f, -3)).toEqual(biasPick(f, 0));
    expect(biasPick(f, undefined)).toEqual(biasPick(f, 3));
  });
});

describe("thalamusRoute — the Fugu step: a domain moves the pick only on measured advantage", () => {
  const strengths: Record<string, Partial<Record<TaskDomain, DomainStrength>>> = {
    "a/best": { code: { p: 0.7, n: 5, basis: [] } },
    "b/mid": { code: { p: 0.95, n: 4, basis: [] }, write: { p: 0.72, n: 1, basis: [] } },
  };
  const strengthFor = (key: string, d: TaskDomain) => strengths[key]?.[d];

  it("general = the bias pick, untouched", () => {
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 6, domain: "general", strengthFor })!;
    expect(r.rung).toMatchObject({ key: "a/best", effort: "max" });
    expect(r.rung).toEqual(r.biasRung);
  });

  it("switches to the domain leader inside the band, at its cheapest rung above the floor", () => {
    // bias 3 → floor 60 → bias pick b/mid@max (0.2); band = rungs ≥ 60 within 5x: b/mid@max,
    // a/best@high (0.5), a/best@max (1.0). b/mid leads CODE by 25 points → stays on b/mid@max.
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 3, domain: "code", strengthFor })!;
    expect(r.biasRung).toMatchObject({ key: "b/mid", effort: "max" });
    expect(r.rung).toMatchObject({ key: "b/mid", effort: "max" });
    const r6 = thalamusRoute({ rungs: BOARD, biasIdx: 6, domain: "code", strengthFor })!;
    expect(r6.biasRung).toMatchObject({ key: "a/best", effort: "max" });
    // at SMART the floor is 65: only a/best@max clears it, so no switch is possible
    expect(r6.rung).toMatchObject({ key: "a/best", effort: "max" });
  });

  it("refuses a specialist dearer than DOMAIN_SWITCH_MAX_COST_MULT x the bias pick", () => {
    // bias 0 → floor 50 → bias pick b/mid@low (0.05), cap 0.25. a/best@low (0.3) is 6x and
    // a/best@high (0.5) 10x dearer: even at p0.99 in CODE neither may take a "fast" turn.
    const pricey = (key: string, d: TaskDomain): DomainStrength | undefined =>
      d === "code" && key === "a/best" ? { p: 0.99, n: 5, basis: [] } : undefined;
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 0, domain: "code", strengthFor: pricey })!;
    expect(r.biasRung).toMatchObject({ key: "b/mid", effort: "low" });
    expect(r.rung).toEqual(r.biasRung);
  });

  it("does NOT switch on a gain under the threshold, or to a model with no measurement", () => {
    const close = (key: string, d: TaskDomain): DomainStrength | undefined =>
      d === "code"
        ? key === "a/best"
          ? { p: 0.9, n: 3, basis: [] }
          : key === "b/mid"
            ? { p: 0.95, n: 3, basis: [] }
            : undefined
        : undefined;
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 5, domain: "code", strengthFor: close })!;
    // bias 5 → floor 63.5 → bias pick a/best@max; b/mid does not clear the floor anyway
    expect(r.rung).toMatchObject({ key: "a/best", effort: "max" });
    const r2 = thalamusRoute({ rungs: BOARD, biasIdx: 4, domain: "write", strengthFor })!;
    // floor 62: band = a/best@high, a/best@max; neither has a WRITE measurement → keep
    expect(r2.rung).toEqual(r2.biasRung);
    expect(r2.reason).toContain("no measured strengths");
  });
});

describe("classifyTaskDomain — deterministic, ties go to general", () => {
  it("reads the obvious cues", () => {
    expect(classifyTaskDomain("fix the failing unit test in the typescript build")).toBe("code");
    expect(classifyTaskDomain("prove the theorem and derive the integral")).toBe("reason");
    expect(classifyTaskDomain("draft an email to the landlord, polite tone")).toBe("write");
    expect(
      classifyTaskDomain("my partner is anxious about the argument we had, how do I tell her"),
    ).toBe("psych");
    expect(classifyTaskDomain("what do you see in this screenshot")).toBe("vision");
  });
  it("returns general on silence and on a tie", () => {
    expect(classifyTaskDomain("")).toBe("general");
    expect(classifyTaskDomain("ok")).toBe("general");
    expect(classifyTaskDomain("write code")).toBe("general");
  });
});

describe("frontierRungsFor — one route becomes its rungs on the shared tables", () => {
  it("builds Opus 5's five measured rungs priced in €/TASK on the chart's task axis", () => {
    const rungs = frontierRungsFor("claude-code/claude-opus-5", 63.05, 0.0735);
    expect(rungs.map((r) => r.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(rungs.every((r) => r.basis === "measured")).toBe(true);
    // €/task = €/Mtok(max) x tokens(max)/tokens(reference high) = 0.0735·3 x 3/1.5 — the
    // token multiplier enters twice, once in the price and once in the burn.
    expect(rungs.find((r) => r.effort === "max")!.cost).toBeCloseTo(0.0735 * 3 * 2);
    expect(rungs.find((r) => r.effort === "high")!.cost).toBeCloseTo(0.0735 * 1.5);
  });
  it("gives a ladderless route one headline rung, and refuses a non-positive price", () => {
    expect(frontierRungsFor("openrouter/qwen/qwen3.8-max", 58, 4)).toHaveLength(1);
    expect(frontierRungsFor("claude-code/claude-opus-5", 63, 0)).toEqual([]);
  });
});
