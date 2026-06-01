/**
 * 7D: Cost-aware debate budget tests.
 *
 * resolveDebateBudget ties the per-debate USD cap to actual subscription/metered
 * headroom: activeBudget = min(depthBudget, FRACTION * remainingHeadroom), never
 * negative, and a no-op (returns depthBudget) when headroom is unknown or billing-
 * gating is disabled.
 */

import { describe, it, expect } from "vitest";
import { resolveDebateBudget, type BillingHeadroom } from "../src/raac-protocol.js";

describe("7D: resolveDebateBudget clamps to a fraction of headroom", () => {
  it("clamps the depth budget down to FRACTION * remainingUsd", async () => {
    const headroom: BillingHeadroom = { remainingUsd: 10, source: "metered" };
    // depthBudget 8, fraction 0.2 -> 0.2 * 10 = 2.0 < 8 -> clamp to 2.0
    expect(await resolveDebateBudget(8, headroom, 0.2)).toBe(2.0);
  });

  it("keeps the depth budget when the fraction of headroom is larger", async () => {
    const headroom: BillingHeadroom = { remainingUsd: 100, source: "subscription" };
    // 0.2 * 100 = 20 > 8 -> min picks 8
    expect(await resolveDebateBudget(8, headroom, 0.2)).toBe(8);
  });

  it("uses the default fraction (0.2) when none supplied", async () => {
    const headroom: BillingHeadroom = { remainingUsd: 5, source: "metered" };
    // 0.2 * 5 = 1.0 < 3 -> 1.0
    expect(await resolveDebateBudget(3, headroom)).toBe(1.0);
  });
});

describe("7D: resolveDebateBudget returns depthBudget unchanged when headroom unknown", () => {
  it("returns depthBudget when no headroom is supplied", async () => {
    expect(await resolveDebateBudget(3)).toBe(3);
    expect(await resolveDebateBudget(8, undefined, 0.2)).toBe(8);
  });

  it("returns depthBudget when headroom.source is 'unknown'", async () => {
    const headroom: BillingHeadroom = { remainingUsd: 0.5, source: "unknown" };
    // unknown source => no clamping even though 0.2*0.5 would be tiny
    expect(await resolveDebateBudget(8, headroom, 0.2)).toBe(8);
  });
});

describe("7D: resolveDebateBudget never returns negative", () => {
  it("clamps a negative remaining headroom to 0, not a negative budget", async () => {
    const headroom: BillingHeadroom = { remainingUsd: -50, source: "metered" };
    expect(await resolveDebateBudget(8, headroom, 0.2)).toBe(0);
  });

  it("returns 0 (never negative) when remaining is exactly 0", async () => {
    const headroom: BillingHeadroom = { remainingUsd: 0, source: "subscription" };
    expect(await resolveDebateBudget(8, headroom, 0.2)).toBe(0);
  });

  it("never returns negative even if depthBudget itself were negative", async () => {
    expect(await resolveDebateBudget(-5)).toBe(0);
  });
});
