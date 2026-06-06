/**
 * SS5a (2026-06-06): derived recovery-retry bound — floor 1, rises as fitness falls.
 * Target: recovery-budget.ts (deriveRecoveryRetryBudget).
 * Bible anchor: subagents-and-recipes.md (SS5a verify: block).
 * Bug-history: J16 "no frozen magic number" — a retry count must NOT be a constant MAX_RETRIES;
 *   it derives from the situation and floors at 1 (always ≥1 recovery attempt).
 * Catches: a hardcoded retry cap; a budget that ignores its inputs (constant-shaped); a 0/neg floor.
 */
import { describe, it, expect } from "vitest";
import { deriveRecoveryRetryBudget } from "../recovery-budget.js";

describe("deriveRecoveryRetryBudget (recovery retry bound)", () => {
  it("floors at 1 with no signals (always at least one recovery attempt)", () => {
    expect(deriveRecoveryRetryBudget({ priorAttempts: 0 })).toBeGreaterThanOrEqual(1);
    expect(deriveRecoveryRetryBudget({})).toBeGreaterThanOrEqual(1);
  });
  it("is NOT a constant — a shaky recipe (low fitness) earns MORE attempts than a reliable one", () => {
    const shaky = deriveRecoveryRetryBudget({ priorAttempts: 0, fitnessSuccessRate: 0.1 });
    const solid = deriveRecoveryRetryBudget({ priorAttempts: 0, fitnessSuccessRate: 0.95 });
    expect(shaky).toBeGreaterThan(solid);
    expect(solid).toBeGreaterThanOrEqual(1); // never below the floor
  });
  it("decays as prior attempts pile up (diminishing returns), never below 1", () => {
    const fresh = deriveRecoveryRetryBudget({ priorAttempts: 0, fitnessSuccessRate: 0.2 });
    const tired = deriveRecoveryRetryBudget({ priorAttempts: 5, fitnessSuccessRate: 0.2 });
    expect(tired).toBeLessThanOrEqual(fresh);
    expect(tired).toBeGreaterThanOrEqual(1);
  });
  it("clamps DOWN to affordable when a dispatch budget is threaded", () => {
    // a generous derivation, but the budget pays for only one more dispatch.
    expect(
      deriveRecoveryRetryBudget({
        priorAttempts: 0,
        fitnessSuccessRate: 0.05,
        remainingDispatchBudget: 1,
        estStepTokens: 1,
      }),
    ).toBe(1);
    // budget more than enough → the derivation (≥1) stands
    expect(
      deriveRecoveryRetryBudget({
        priorAttempts: 0,
        fitnessSuccessRate: 0.05,
        remainingDispatchBudget: 1000,
        estStepTokens: 1,
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});
