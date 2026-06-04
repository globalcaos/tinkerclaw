import { describe, it, expect } from "vitest";
import { deriveRedispatchBudget } from "../redispatch-budget.js";

describe("deriveRedispatchBudget", () => {
  it("always allows at least one corrective re-dispatch", () => {
    expect(deriveRedispatchBudget({ requiredFieldCount: 0 })).toBeGreaterThanOrEqual(1);
  });

  it("rises with value-of-work (more required fields → more worth getting right)", () => {
    const few = deriveRedispatchBudget({ requiredFieldCount: 1 });
    const many = deriveRedispatchBudget({ requiredFieldCount: 8 });
    expect(many).toBeGreaterThan(few);
  });

  it("falls as historical confidence rises (high success rate needs fewer fixes)", () => {
    const shaky = deriveRedispatchBudget({ requiredFieldCount: 4, fitnessSuccessRate: 0.1 });
    const solid = deriveRedispatchBudget({ requiredFieldCount: 4, fitnessSuccessRate: 0.95 });
    expect(shaky).toBeGreaterThan(solid);
  });

  it("is clamped by affordability when a token budget is supplied", () => {
    const unbounded = deriveRedispatchBudget({ requiredFieldCount: 8, fitnessSuccessRate: 0.1 });
    const broke = deriveRedispatchBudget({
      requiredFieldCount: 8,
      fitnessSuccessRate: 0.1,
      remainingTokenBudget: 1500,
      estStepTokens: 1000, // affords 1 more dispatch
    });
    expect(broke).toBe(1);
    expect(broke).toBeLessThan(unbounded);
  });

  it("returns an integer", () => {
    const n = deriveRedispatchBudget({ requiredFieldCount: 3, fitnessSuccessRate: 0.4 });
    expect(Number.isInteger(n)).toBe(true);
  });

  it("J16: is NOT constant across situations (no frozen bound)", () => {
    const samples = new Set([
      deriveRedispatchBudget({ requiredFieldCount: 0, fitnessSuccessRate: 0.9 }),
      deriveRedispatchBudget({ requiredFieldCount: 3, fitnessSuccessRate: 0.5 }),
      deriveRedispatchBudget({ requiredFieldCount: 8, fitnessSuccessRate: 0.1 }),
    ]);
    expect(samples.size).toBeGreaterThan(1);
  });
});
