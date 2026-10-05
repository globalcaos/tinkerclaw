import { describe, expect, it } from "vitest";
import {
  clip,
  crosses,
  isCannotTell,
  levelOf,
  massOutside,
  optionProb,
  pick,
} from "../src/families/common.js";
import { enabledFamilies, FAMILY_ORDER } from "../src/families/index.js";
import { QuestionBook } from "../src/question-book.js";
import type { Cutoff, Question, Verdict } from "../src/types.js";

const v = (o: Partial<Verdict>): Verdict => ({
  id: "v",
  situationId: "s",
  questionId: "q",
  questionVersion: 1,
  type: "noul",
  answer: 0,
  prob: 0,
  confidence: 0.9,
  cacheHit: false,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  ts: 1,
  ...o,
});
const choice = (answer: string, probs: Record<string, number>): Verdict =>
  v({ type: "choice", answer, prob: probs[answer] ?? 0, probs });
const q = (cutoff: Cutoff): Question => ({ id: "q", cutoff }) as Question;

describe("crosses", () => {
  it("prob: at or above", () => {
    expect(crosses(q({ kind: "prob", at: 0.5 }), v({ prob: 0.5 }))).toBe(true);
    expect(crosses(q({ kind: "prob", at: 0.5 }), v({ prob: 0.49 }))).toBe(false);
  });
  it("level: above and below variants (the nearest-level rule has its own test below)", () => {
    const score = (n: number) => v({ type: "score", answer: n, prob: n / 3 });
    expect(crosses(q({ kind: "level", atOrAbove: 2 }), score(2.15))).toBe(true);
    expect(crosses(q({ kind: "level", atOrBelow: 0 }), score(0))).toBe(true);
    expect(crosses(q({ kind: "level", atOrBelow: 0 }), score(2))).toBe(false);
    expect(crosses(q({ kind: "level" }), score(3))).toBe(false);
    expect(levelOf(score(2.5))).toBe(2.5);
    expect(levelOf(v({ type: "choice", answer: "x" }))).toBe(0);
  });
  it("choice: the option's probability, even when it is not the top pick", () => {
    const c = q({ kind: "choice", option: "read-content", at: 0.4 });
    expect(crosses(c, choice("user", { user: 0.55, "read-content": 0.45 }))).toBe(true);
    expect(crosses(c, choice("user", { user: 0.7, "read-content": 0.3 }))).toBe(false);
  });
  it("negated choice: the probability mass on everything except the option and cannot-tell", () => {
    const c = q({ kind: "choice", option: "same", at: 0.6, negate: true });
    // the top pick alone is only 0.35, but 0.7 of the mass says "not the same": that crosses
    expect(crosses(c, choice("firmer", { same: 0.3, firmer: 0.35, dropped: 0.35 }))).toBe(true);
    expect(crosses(c, choice("same", { same: 0.8, firmer: 0.2 }))).toBe(false);
    expect(
      massOutside(choice("firmer", { same: 0.2, firmer: 0.7, "cannot-tell": 0.1 }), "same"),
    ).toBeCloseTo(0.7);
  });
  it("a score is compared as its nearest level, in both directions", () => {
    const score = (n: number) => v({ type: "score", answer: n, prob: n / 3 });
    const above = q({ kind: "level", atOrAbove: 2 });
    // rounds UP to the cut-off: 1.98 reads as level 2
    expect(crosses(above, score(1.98))).toBe(true);
    expect(crosses(above, score(1.5))).toBe(true);
    // rounds DOWN under it: 1.49 reads as level 1
    expect(crosses(above, score(1.49))).toBe(false);
    expect(crosses(above, score(1.2))).toBe(false);
    // and the other way for a low cut-off: 0.08 and 0.49 read as level 0, 0.5 as level 1
    const below = q({ kind: "level", atOrBelow: 0 });
    expect(crosses(below, score(0.08))).toBe(true);
    expect(crosses(below, score(0.49))).toBe(true);
    expect(crosses(below, score(0.5))).toBe(false);
    expect(crosses(below, score(0.9))).toBe(false);
    // a high answer never slips under an "above" cut-off by rounding
    expect(crosses(above, score(2.66))).toBe(true);
  });

  it("cannot-tell NEVER crosses, whatever the cut-off says", () => {
    const ct = choice("cannot-tell", { "cannot-tell": 0.99, other: 0.01 });
    expect(isCannotTell(ct)).toBe(true);
    for (const c of [
      { kind: "choice", option: "cannot-tell", at: 0.1 },
      { kind: "choice", option: "x", at: 0.0, negate: true },
      { kind: "choice", option: "other", at: 0 },
    ] as Cutoff[]) {
      expect(crosses(q(c), ct)).toBe(false);
    }
  });
  it("skipped verdicts, missing verdicts and the none cut-off never cross", () => {
    expect(crosses(q({ kind: "prob", at: 0 }), v({ skipped: "timeout", prob: 1 }))).toBe(false);
    expect(crosses(q({ kind: "none" }), v({ prob: 1 }))).toBe(false);
    expect(crosses(q({ kind: "prob", at: 0 }), undefined)).toBe(false);
    expect(crosses(undefined, v({ prob: 1 }))).toBe(false);
  });
  it("without a distribution the chosen answer stands for the option", () => {
    const one = v({ type: "choice", answer: "firmer", prob: 0.9 });
    expect(crosses(q({ kind: "choice", option: "firmer", at: 0.6 }), one)).toBe(true);
    expect(crosses(q({ kind: "choice", option: "same", at: 0.6, negate: true }), one)).toBe(true);
  });
});

describe("helpers", () => {
  it("pick skips skipped verdicts; optionProb reads distributions; clip keeps one short line", () => {
    const vs = [v({ questionId: "a", skipped: "error" }), v({ questionId: "b", id: "keep" })];
    expect(pick(vs, "a")).toBeUndefined();
    expect(pick(vs, "b")?.id).toBe("keep");
    expect(optionProb(choice("a", { a: 0.7, b: 0.3 }), "b")).toBe(0.3);
    expect(optionProb(v({ type: "choice", answer: "a", prob: 0.7 }), "b")).toBe(0);
    expect(clip("one\n  two   three", 80)).toBe("one two three");
    expect(clip("x".repeat(100), 20)).toHaveLength(20);
  });
});

describe("enabledFamilies", () => {
  const all = {
    safety: true,
    "second-opinion": true,
    "double-check": true,
    efficiency: true,
    personality: true,
  };
  const book = new QuestionBook({ seedDir: new URL("../questions", import.meta.url).pathname });
  it("builds only the switched-on families, in decision order", () => {
    expect(enabledFamilies({ families: all }, { book }).map((f) => f.id)).toEqual(FAMILY_ORDER);
    expect(
      enabledFamilies(
        { families: { ...all, efficiency: false, personality: false } },
        { book },
      ).map((f) => f.id),
    ).toEqual(["second-opinion", "safety", "double-check"]);
  });
});
