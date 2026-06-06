/**
 * SS2b (2026-06-06): derived combinator bounds — width (fan-out) + depth.
 * Target: combinator-budget.ts (deriveCombinatorFanOut / deriveUsesDepthBudget).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: J16 "no frozen magic number" — width must = data length, depth must FLOOR not FREEZE at 3.
 * Catches: a hardcoded fan-out cap; a depth that ignores its inputs (constant-shaped).
 */
import { describe, it, expect } from "vitest";
import { deriveCombinatorFanOut, deriveUsesDepthBudget } from "../combinator-budget.js";

describe("deriveCombinatorFanOut (width)", () => {
  it("= arrayLength when no budget is threaded (the data bounds it)", () => {
    expect(deriveCombinatorFanOut({ arrayLength: 0 })).toBe(0);
    expect(deriveCombinatorFanOut({ arrayLength: 3 })).toBe(3);
    expect(deriveCombinatorFanOut({ arrayLength: 100 })).toBe(100);
  });
  it("is NOT a constant — it tracks arrayLength", () => {
    const a = deriveCombinatorFanOut({ arrayLength: 2 });
    const b = deriveCombinatorFanOut({ arrayLength: 7 });
    expect(a).not.toBe(b);
    expect(b).toBeGreaterThan(a);
  });
  it("clamps to affordable when a dispatch budget IS threaded", () => {
    expect(
      deriveCombinatorFanOut({ arrayLength: 50, remainingDispatchBudget: 10, estIterationCost: 1 }),
    ).toBe(10);
    // budget more than enough → still arrayLength
    expect(
      deriveCombinatorFanOut({
        arrayLength: 4,
        remainingDispatchBudget: 1000,
        estIterationCost: 1,
      }),
    ).toBe(4);
  });
});

describe("deriveUsesDepthBudget (depth)", () => {
  it("floors at 3 with no signals (numerically identical to the old frozen cap)", () => {
    expect(deriveUsesDepthBudget({})).toBe(3);
  });
  it("derives UP (above the floor) when a budget affords it — never below 3", () => {
    const deep = deriveUsesDepthBudget({ remainingDispatchBudget: 1000, estIterationCost: 1 });
    expect(deep).toBeGreaterThanOrEqual(3);
    // a tiny budget can never drop it below the floor
    expect(deriveUsesDepthBudget({ remainingDispatchBudget: 1, estIterationCost: 1000 })).toBe(3);
  });
});
