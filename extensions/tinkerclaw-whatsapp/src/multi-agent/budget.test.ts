import { describe, expect, it } from "vitest";
import { applyBudgetModifiers, getBudgetModifiers, resolveBudgetMode } from "./budget.js";

describe("resolveBudgetMode", () => {
  it("returns burn when low usage and near reset", () => {
    expect(resolveBudgetMode({ usagePercent: 0.1, hoursToReset: 12 })).toBe("burn");
  });

  it("returns conservative when usage is high", () => {
    expect(resolveBudgetMode({ usagePercent: 0.9, hoursToReset: 100 })).toBe("conservative");
  });

  it("returns moderate for mid-range usage", () => {
    expect(resolveBudgetMode({ usagePercent: 0.7, hoursToReset: 100 })).toBe("moderate");
  });

  it("returns aggressive for low usage with time remaining", () => {
    expect(resolveBudgetMode({ usagePercent: 0.3, hoursToReset: 100 })).toBe("aggressive");
  });

  it("conservative overrides burn when usage is high near reset", () => {
    // High usage near reset → conservative, not burn
    expect(resolveBudgetMode({ usagePercent: 0.9, hoursToReset: 12 })).toBe("conservative");
  });

  it("respects custom burn threshold", () => {
    expect(
      resolveBudgetMode({ usagePercent: 0.3, hoursToReset: 12 }, { burnUsageThreshold: 0.4 }),
    ).toBe("burn");
    expect(
      resolveBudgetMode({ usagePercent: 0.3, hoursToReset: 12 }, { burnUsageThreshold: 0.2 }),
    ).toBe("aggressive");
  });

  it("disables burn mode via config", () => {
    expect(
      resolveBudgetMode({ usagePercent: 0.1, hoursToReset: 12 }, { burnModeEnabled: false }),
    ).toBe("aggressive");
  });
});

describe("getBudgetModifiers", () => {
  it("returns expected modifiers for each mode", () => {
    expect(getBudgetModifiers("burn").congestionDelayMultiplier).toBe(0.3);
    expect(getBudgetModifiers("conservative").congestionDelayMultiplier).toBe(2.0);
    expect(getBudgetModifiers("burn").tangentExploration).toBe(true);
    expect(getBudgetModifiers("conservative").tangentExploration).toBe(false);
  });
});

describe("applyBudgetModifiers", () => {
  const base = { congestionDelay: 1000, stalenessThreshold: 0.85, maxTurns: 30 };

  it("burn mode: faster, more tolerant, longer conversations", () => {
    const result = applyBudgetModifiers(base, "burn");
    expect(result.congestionDelay).toBe(300); // 0.3x
    expect(result.stalenessThreshold).toBe(0.95);
    expect(result.maxTurns).toBe(60); // 2x
    expect(result.tangentExploration).toBe(true);
  });

  it("conservative mode: slower, stricter, shorter", () => {
    const result = applyBudgetModifiers(base, "conservative");
    expect(result.congestionDelay).toBe(2000); // 2x
    expect(result.stalenessThreshold).toBe(0.8);
    expect(result.maxTurns).toBe(15); // 0.5x
    expect(result.tangentExploration).toBe(false);
  });
});
