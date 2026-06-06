/**
 * SS5b (2026-06-06): derived overseer supervision-loop bound — floor 1, rises as fitness falls, +1 while gap shrinks, decays with prior iterations.
 * Target: overseer-budget.ts (deriveOverseerLoopBudget).
 * Bible anchor: subagents-and-recipes.md (SS5b verify: block); FOUNDATION.md design-principle #19.
 * Bug-history: J16 "no frozen magic number" — a loop count must NOT be a constant MAX_LOOPS;
 *   it derives from the situation and floors at 1 (always ≥1 supervision pass). HARD_LOOP_MAX=25 is only the ceiling.
 * Catches: a hardcoded loop cap; a budget that ignores its inputs (constant-shaped); a 0/neg floor; a non-integer.
 */
import { describe, it, expect } from "vitest";
import { deriveOverseerLoopBudget } from "../overseer-budget.js";

describe("deriveOverseerLoopBudget (overseer supervision-loop bound)", () => {
  it("floors at 1 with no signals (always at least one supervision pass)", () => {
    expect(deriveOverseerLoopBudget({})).toBeGreaterThanOrEqual(1);
    expect(deriveOverseerLoopBudget({ priorIterations: 0 })).toBeGreaterThanOrEqual(1);
  });
  it("is NOT a constant — lower fitness earns MORE passes than higher fitness", () => {
    const shaky = deriveOverseerLoopBudget({ priorIterations: 0, fitnessSuccessRate: 0.05 });
    const solid = deriveOverseerLoopBudget({ priorIterations: 0, fitnessSuccessRate: 0.95 });
    expect(shaky).toBeGreaterThan(solid);
    expect(solid).toBeGreaterThanOrEqual(1); // never below the floor
  });
  it("earns +1 pass while the gap is shrinking", () => {
    const stalled = deriveOverseerLoopBudget({ fitnessSuccessRate: 0.5, gapShrinking: false });
    const closing = deriveOverseerLoopBudget({ fitnessSuccessRate: 0.5, gapShrinking: true });
    expect(closing).toBe(stalled + 1);
  });
  it("decays as prior iterations pile up (diminishing returns), never below 1", () => {
    const fresh = deriveOverseerLoopBudget({ priorIterations: 0, fitnessSuccessRate: 0.1 });
    const tired = deriveOverseerLoopBudget({ priorIterations: 5, fitnessSuccessRate: 0.1 });
    expect(tired).toBeLessThanOrEqual(fresh);
    expect(tired).toBeGreaterThanOrEqual(1);
  });
  it("clamps DOWN to affordable when a dispatch budget is threaded", () => {
    // a generous derivation, but the budget pays for only one more dispatch.
    expect(
      deriveOverseerLoopBudget({
        priorIterations: 0,
        fitnessSuccessRate: 0.05,
        gapShrinking: true,
        remainingDispatchBudget: 1,
        estStepTokens: 1,
      }),
    ).toBe(1);
    // budget more than enough → the derivation (≥1) stands
    expect(
      deriveOverseerLoopBudget({
        priorIterations: 0,
        fitnessSuccessRate: 0.05,
        gapShrinking: true,
        remainingDispatchBudget: 1000,
        estStepTokens: 1,
      }),
    ).toBeGreaterThanOrEqual(1);
  });
  it("returns an integer", () => {
    const out = deriveOverseerLoopBudget({
      priorIterations: 1,
      fitnessSuccessRate: 0.3,
      gapShrinking: true,
    });
    expect(Number.isInteger(out)).toBe(true);
  });
  it("J16: two different signal sets produce two different outputs (non-constant)", () => {
    const a = deriveOverseerLoopBudget({ priorIterations: 4, fitnessSuccessRate: 0.95 });
    const b = deriveOverseerLoopBudget({
      priorIterations: 0,
      fitnessSuccessRate: 0.05,
      gapShrinking: true,
    });
    expect(a).not.toBe(b);
  });
});
