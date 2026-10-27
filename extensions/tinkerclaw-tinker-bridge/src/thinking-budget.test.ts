import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "./defaults.js";
import {
  claudeCodeThinkingProfile,
  claudeEffortForTurn,
  isAdaptiveEffortModel,
  thinkLevelToClaudeEffort,
  thinkLevelToMaxThinkingTokens,
} from "./thinking-budget.js";

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

describe("claudeCodeThinkingProfile", () => {
  it("exposes the full 7-level set including xhigh and max", () => {
    const ids = claudeCodeThinkingProfile().levels.map((l) => l.id);
    expect(ids).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("ranks levels weakest -> strongest so stale values downgrade correctly", () => {
    const ranks = claudeCodeThinkingProfile().levels.map((l) => l.rank);
    const sorted = [...ranks].toSorted((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    expect(ranks[ranks.length - 1]).toBe(70); // max
  });

  it("admits exactly the levels tinker-bridge can budget (+ off)", () => {
    // every non-off level must have a real MAX_THINKING_TOKENS budget
    for (const { id } of claudeCodeThinkingProfile().levels) {
      if (id === "off") continue;
      expect(thinkLevelToMaxThinkingTokens(id, 32000)).toBeGreaterThan(0);
    }
  });

  it("omits a defaultLevel so Auto keeps falling through to core defaults", () => {
    expect(claudeCodeThinkingProfile()).not.toHaveProperty("defaultLevel");
  });
});

// FORK 2026-10-09 (effort per turn): on an adaptive-effort model the level travels as a Claude
// Code effort, applied per turn on the live process; MAX_THINKING_TOKENS stays for older models.
describe("thinkLevelToClaudeEffort", () => {
  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["adaptive", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
    [" MAX ", "max"],
  ])("maps %s to %s", (level, effort) => {
    expect(thinkLevelToClaudeEffort(level)).toBe(effort);
  });

  it("names no effort for off, empty, missing or unknown levels", () => {
    for (const level of ["off", "", undefined, null, "foo", "constructor", "ultracode"]) {
      expect(thinkLevelToClaudeEffort(level)).toBeUndefined();
    }
  });

  it("has an effort for every level the claude-code profile offers, off aside", () => {
    for (const { id } of claudeCodeThinkingProfile().levels) {
      if (id !== "off") {
        expect(thinkLevelToClaudeEffort(id)).toBeDefined();
      }
    }
  });
});

describe("claudeEffortForTurn", () => {
  it("asks for the level alone, ultracode off", () => {
    expect(claudeEffortForTurn("low", undefined)).toEqual({ effortLevel: "low", ultracode: false });
    expect(claudeEffortForTurn("high", false)).toEqual({ effortLevel: "high", ultracode: false });
  });

  it("puts ultracode on top of the level, at max when the turn names none", () => {
    expect(claudeEffortForTurn("xhigh", true)).toEqual({ effortLevel: "xhigh", ultracode: true });
    expect(claudeEffortForTurn(undefined, true)).toEqual({ effortLevel: "max", ultracode: true });
    expect(claudeEffortForTurn("off", true)).toEqual({ effortLevel: "max", ultracode: true });
  });

  it("asks for nothing when the turn names neither", () => {
    expect(claudeEffortForTurn(undefined, undefined)).toBeUndefined();
    expect(claudeEffortForTurn("off", false)).toBeUndefined();
  });
});

describe("isAdaptiveEffortModel", () => {
  it.each([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-code/claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "claude-sonnet-5-5-20261001",
    "us.anthropic.claude-opus-4-7-v1:0",
    "opus",
    "sonnet",
  ])("%s runs adaptive effort", (id) => {
    expect(isAdaptiveEffortModel(id)).toBe(true);
  });

  it.each([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-6",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-code/claude-haiku-4-5",
    "haiku",
    "gpt-5",
    "",
    undefined,
  ])("%s keeps the thinking budget", (id) => {
    expect(isAdaptiveEffortModel(id)).toBe(false);
  });

  // A model added to the bridge's list must be placed here on purpose: the classification decides
  // whether its child gets MAX_THINKING_TOKENS or a per-turn effort.
  it("classifies every model the bridge lists", () => {
    const got = Object.fromEntries(DEFAULT_MODELS.map((m) => [m.id, isAdaptiveEffortModel(m.id)]));
    expect(got).toEqual({
      "claude-opus-5-5": true,
      "claude-sonnet-5-5": true,
      "claude-fable-5-1": true,
      "claude-opus-5": true,
      "claude-opus-4-8": true,
      "claude-opus-4-7": true,
      "claude-opus-4-6": false,
      "claude-sonnet-4-6": false,
      "claude-haiku-4-5": false,
    });
  });
});
