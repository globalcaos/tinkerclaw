import { describe, expect, it } from "vitest";
import { cachePolicyFor, ratesFor } from "./thalamus-price-table.js";
import { creditSharedStart } from "./thalamus-shared-start.js";

const HAIKU = "claude-code/claude-haiku-4-5";
const GROK = "xai/grok-4.7";

// What a sibling really pays, written out from the table's own rates (not through the function under test).
function expectedUsd(
  key: string,
  total: number,
  shared: number,
  out: number,
  warm: boolean,
): number {
  const rates = ratesFor(key, total)!;
  const policy = cachePolicyFor(key)!;
  const read = rates.cacheReadPerMTok ?? rates.inputPerMTok;
  const start = warm ? shared * read : shared * rates.inputPerMTok * policy.write1hMult;
  return (start + (total - shared) * rates.inputPerMTok + out * rates.outputPerMTok) / 1e6;
}

const brief = (total: number) => ({ cachedIn: 0, uncachedIn: total, writeIn: 0 });

describe("creditSharedStart", () => {
  const base = {
    routeKey: HAIKU,
    money: 0.25,
    moneyKnown: true,
    prediction: brief(59_000),
    expectedOutputTokens: 800,
    inputTokens: 59_000,
    sharedTokens: 9_000,
  };

  it("scales the option's money to the sibling's real bill: the first writes the start, a later one reads it", () => {
    const oldUsd =
      (59_000 * ratesFor(HAIKU, 59_000)!.inputPerMTok +
        800 * ratesFor(HAIKU, 59_000)!.outputPerMTok) /
      1e6;
    const cold = creditSharedStart({ ...base, warm: false });
    const warm = creditSharedStart({ ...base, warm: true });
    expect(cold.credited && warm.credited).toBe(true);
    expect(cold.money).toBeCloseTo(
      (0.25 * expectedUsd(HAIKU, 59_000, 9_000, 800, false)) / oldUsd,
      12,
    );
    expect(warm.money).toBeCloseTo(
      (0.25 * expectedUsd(HAIKU, 59_000, 9_000, 800, true)) / oldUsd,
      12,
    );
    expect(warm.money).toBeLessThan(cold.money);
    // A read of the start is cheaper than plain input for it; the write costs more than plain input.
    expect(warm.money).toBeLessThan(0.25);
    expect(cold.money).toBeGreaterThan(0.25);
  });

  it("gives the same answer whether the router priced the option as a thread or a brief", () => {
    const thread = { cachedIn: 9_000, uncachedIn: 0, writeIn: 50_000 };
    const a = creditSharedStart({ ...base, warm: true });
    const oldThread =
      (9_000 * ratesFor(HAIKU, 59_000)!.cacheReadPerMTok! +
        50_000 * ratesFor(HAIKU, 59_000)!.inputPerMTok * cachePolicyFor(HAIKU)!.write1hMult +
        800 * ratesFor(HAIKU, 59_000)!.outputPerMTok) /
      1e6;
    const money = 0.3;
    const b = creditSharedStart({ ...base, prediction: thread, money, warm: true });
    // The bill is the same; only the money the option started from differs, so the credited bills agree.
    expect(b.money / money).toBeCloseTo(
      expectedUsd(HAIKU, 59_000, 9_000, 800, true) / oldThread,
      12,
    );
    expect(a.credited && b.credited).toBe(true);
  });

  it("leaves a model with no price row, borrowed money, no shared start, and a free option as they are", () => {
    expect(creditSharedStart({ ...base, routeKey: "nobody/unknown-model", warm: true })).toEqual({
      money: 0.25,
      credited: false,
    });
    expect(creditSharedStart({ ...base, moneyKnown: false, warm: true })).toEqual({
      money: 0.25,
      credited: false,
    });
    expect(creditSharedStart({ ...base, sharedTokens: 0, warm: true })).toEqual({
      money: 0.25,
      credited: false,
    });
    expect(creditSharedStart({ ...base, money: 0, warm: true })).toEqual({
      money: 0,
      credited: false,
    });
  });

  it("works on another vendor's cache too, and never charges for more start than the input holds", () => {
    const g = creditSharedStart({ ...base, routeKey: GROK, warm: true });
    expect(g.credited).toBe(true);
    const all = creditSharedStart({ ...base, sharedTokens: 999_999, warm: true });
    const exact = creditSharedStart({ ...base, sharedTokens: 59_000, warm: true });
    expect(all.money).toBeCloseTo(exact.money, 12);
  });
});
