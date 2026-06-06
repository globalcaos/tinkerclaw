/**
 * SS5b (2026-06-06): derived spawn fan-out width — floor 1, rises with surface/skill, widens as fitness falls.
 * Target: spawn-budget.ts (deriveSpawnBudget).
 * Bible anchor: subagents-and-recipes.md (SS5b verify: block).
 * Bug-history: J16 "no frozen magic number" — a spawn count must NOT be a constant MAX_SPAWNS;
 *   it derives from the situation and floors at 1 (always ≥1 unit).
 * Catches: a hardcoded spawn cap; a budget that ignores its inputs (constant-shaped); a 0/neg floor.
 */
import { describe, it, expect } from "vitest";
import { deriveSpawnBudget } from "../spawn-budget.js";

describe("deriveSpawnBudget (spawn fan-out width)", () => {
  it("floors at 1 with no signals (always at least one unit)", () => {
    expect(deriveSpawnBudget({})).toBeGreaterThanOrEqual(1);
    expect(deriveSpawnBudget({ requiredFieldCount: 0 })).toBeGreaterThanOrEqual(1);
  });
  it("rises as the required-field surface widens", () => {
    const narrow = deriveSpawnBudget({ requiredFieldCount: 0 });
    const wide = deriveSpawnBudget({ requiredFieldCount: 6 });
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(1); // never below the floor
  });
  it("rises when a skill is invoked", () => {
    const plain = deriveSpawnBudget({ requiredFieldCount: 2, skillInvoked: false });
    const skilled = deriveSpawnBudget({ requiredFieldCount: 2, skillInvoked: true });
    expect(skilled).toBeGreaterThan(plain);
  });
  it("is NOT a constant — widens as fitness falls (a shaky recipe spawns wider)", () => {
    const solid = deriveSpawnBudget({ requiredFieldCount: 6, fitnessSuccessRate: 0.95 });
    const shaky = deriveSpawnBudget({ requiredFieldCount: 6, fitnessSuccessRate: 0.05 });
    expect(shaky).toBeGreaterThan(solid);
    expect(solid).toBeGreaterThanOrEqual(1); // never below the floor
  });
  it("clamps DOWN to affordable when a token budget is threaded", () => {
    // a generous derivation, but the budget pays for only one more spawn.
    expect(
      deriveSpawnBudget({
        requiredFieldCount: 6,
        skillInvoked: true,
        fitnessSuccessRate: 0.05,
        remainingTokenBudget: 1,
        estStepTokens: 1,
      }),
    ).toBe(1);
    // budget more than enough → the derivation (≥1) stands
    expect(
      deriveSpawnBudget({
        requiredFieldCount: 6,
        skillInvoked: true,
        fitnessSuccessRate: 0.05,
        remainingTokenBudget: 1000,
        estStepTokens: 1,
      }),
    ).toBeGreaterThanOrEqual(1);
  });
  it("returns an integer", () => {
    const out = deriveSpawnBudget({
      requiredFieldCount: 5,
      skillInvoked: true,
      fitnessSuccessRate: 0.3,
    });
    expect(Number.isInteger(out)).toBe(true);
  });
  it("J16: two different signal sets produce two different outputs (non-constant)", () => {
    const a = deriveSpawnBudget({ requiredFieldCount: 0, fitnessSuccessRate: 0.95 });
    const b = deriveSpawnBudget({
      requiredFieldCount: 6,
      skillInvoked: true,
      fitnessSuccessRate: 0.05,
    });
    expect(a).not.toBe(b);
  });
});
