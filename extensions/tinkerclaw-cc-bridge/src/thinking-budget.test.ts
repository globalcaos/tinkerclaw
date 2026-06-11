import { describe, expect, it } from "vitest";
import { thinkLevelToMaxThinkingTokens } from "./thinking-budget.js";

// thinkLevelToMaxThinkingTokens maps a coarse think-level string to a concrete
// max_thinking_tokens budget, clamped so it never exceeds the model's output
// budget (and never returns 0). off/unknown/empty -> undefined (no thinking).
// `adaptive` is an alias of `medium`; matching is case-insensitive.

const MODEL_MAX = 32000;

describe("thinkLevelToMaxThinkingTokens", () => {
  it("returns undefined for off / undefined / empty / unknown levels", () => {
    expect(thinkLevelToMaxThinkingTokens("off", MODEL_MAX)).toBeUndefined();
    expect(thinkLevelToMaxThinkingTokens(undefined, MODEL_MAX)).toBeUndefined();
    expect(thinkLevelToMaxThinkingTokens("", MODEL_MAX)).toBeUndefined();
    expect(thinkLevelToMaxThinkingTokens("foo", MODEL_MAX)).toBeUndefined();
  });

  it("maps each named level to its budget", () => {
    expect(thinkLevelToMaxThinkingTokens("minimal", MODEL_MAX)).toBe(2000);
    expect(thinkLevelToMaxThinkingTokens("low", MODEL_MAX)).toBe(4000);
    expect(thinkLevelToMaxThinkingTokens("medium", MODEL_MAX)).toBe(8000);
    expect(thinkLevelToMaxThinkingTokens("high", MODEL_MAX)).toBe(16000);
    expect(thinkLevelToMaxThinkingTokens("xhigh", MODEL_MAX)).toBe(22000);
    expect(thinkLevelToMaxThinkingTokens("max", MODEL_MAX)).toBe(28000);
  });

  it("treats adaptive as an alias of medium", () => {
    expect(thinkLevelToMaxThinkingTokens("adaptive", MODEL_MAX)).toBe(
      thinkLevelToMaxThinkingTokens("medium", MODEL_MAX),
    );
    expect(thinkLevelToMaxThinkingTokens("adaptive", MODEL_MAX)).toBe(8000);
  });

  it("matches level names case-insensitively", () => {
    expect(thinkLevelToMaxThinkingTokens("MAX", MODEL_MAX)).toBe(28000);
  });

  it("clamps the budget to the model output budget (never exceeds it)", () => {
    expect(thinkLevelToMaxThinkingTokens("high", 10000)).toBe(6000);
    expect(thinkLevelToMaxThinkingTokens("max", 10000)).toBe(6000);
  });

  it("never returns 0", () => {
    const levels = ["minimal", "low", "medium", "adaptive", "high", "xhigh", "max"];
    for (const lvl of levels) {
      const v = thinkLevelToMaxThinkingTokens(lvl, MODEL_MAX);
      expect(v).not.toBe(0);
    }
    // even with a tiny model budget the clamp result stays > 0
    expect(thinkLevelToMaxThinkingTokens("high", 10000)).toBeGreaterThan(0);
  });
});
