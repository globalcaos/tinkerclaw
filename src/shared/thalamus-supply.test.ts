import { describe, expect, it } from "vitest";
import {
  effectiveCost,
  fanOutSupply,
  SHADOW_LAMBDA,
  supplyKind,
  supplyOfKey,
  supplyStateFrom,
  supplyStates,
  windowBallistic,
  windowLengthMs,
  type SupplyId,
  type SupplyState,
  type SupplyWindow,
  type SupplyWindowInput,
} from "./thalamus-supply.js";

// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md §2 (M2, M3), jarvis-icu.
// The properties pinned here are the ones §8 says would falsify the design: a subscription's
// unspent token is priced at zero and a metered credit never is, ballistic never fires on a
// metered supply, and the supply with the most headroom and the friendliest clock is the one a
// fan-out lands on. The 2026-09-03 board (Claude 71% / ChatGPT 92% / Copilot 100% / xAI 28%) is
// the fixture, because it is the observation the whole module was written against.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_757_000_000_000;

/** A window entry. `resetInMs` omitted ⇒ the provider published no reset instant. */
const win = (label: string, usedPercent: number, resetInMs?: number): SupplyWindowInput =>
  resetInMs === undefined
    ? { label, usedPercent }
    : { label, usedPercent, resetAtMs: NOW + resetInMs };

/** A worked-out window, for the halves of `windowBallistic` in isolation. */
const paced = (elapsed: number, used: number): SupplyWindow => ({
  label: "7-day",
  used,
  lengthMs: 7 * DAY,
  elapsed,
  pace: used - elapsed,
});

describe("windowLengthMs — the provider's own label is the only signal there is", () => {
  it("reads every window name on the live board", () => {
    expect(windowLengthMs("5-hour")).toBe(5 * HOUR);
    expect(windowLengthMs("7-day")).toBe(7 * DAY);
    expect(windowLengthMs("Weekly")).toBe(7 * DAY);
    expect(windowLengthMs("monthly")).toBe(30 * DAY);
  });

  it("returns undefined for a label it does not know, rather than guessing a length", () => {
    // A wrong W silently inverts the sign of the shadow price, so an unknown label has to
    // disable the pace arithmetic for that window instead of approximating it.
    expect(windowLengthMs("fortnightly")).toBeUndefined();
    expect(windowLengthMs("per sprint")).toBeUndefined();
    expect(windowLengthMs("")).toBeUndefined();
  });
});

describe("supplyStateFrom — a supply is priced by its tightest constraint", () => {
  it("marks the supply spent when any window reaches 100%", () => {
    const s = supplyStateFrom("openai", [win("5-hour", 100), win("Weekly", 92)], NOW);
    expect(s.spent).toBe(true);
    expect(s.binding?.label).toBe("5-hour");
  });

  it("is not spent while every window is short of 100%, however close", () => {
    expect(supplyStateFrom("openai", [win("Weekly", 99.9)], NOW).spent).toBe(false);
  });

  it("prices a supply AHEAD of pace as dearer — a positive shadow", () => {
    // 5-hour window, 3h left ⇒ 40% elapsed against 90% spent: 50 points ahead of an even burn.
    const s = supplyStateFrom("anthropic", [win("5-hour", 90, 3 * HOUR)], NOW);
    expect(s.shadow).toBeCloseTo(0.5);
    expect(s.shadow).toBeGreaterThan(0);
  });

  it("prices a supply BEHIND pace as cheaper — a negative shadow", () => {
    // Same window, 1h left ⇒ 80% elapsed against 50% spent, and not yet near enough to be
    // ballistic, so this is the ordinary discount rather than the free-tokens case.
    const s = supplyStateFrom("anthropic", [win("5-hour", 50, 1 * HOUR)], NOW);
    expect(s.shadow).toBeCloseTo(-0.3);
    expect(s.ballistic).toBe(false);
  });

  it("binds on the window that hurts most, not on the first one handed in", () => {
    // The 2026-09-03 Claude row: 5-hour behind pace, 7-day well ahead of it. The 7-day binds.
    const s = supplyStateFrom(
      "anthropic",
      [win("5-hour", 39, 2 * HOUR), win("7-day", 71, 3.5 * DAY)],
      NOW,
    );
    expect(s.binding?.label).toBe("7-day");
    expect(s.shadow).toBeCloseTo(0.21);
  });

  it("never discounts a METERED supply — unspent credit is money, not a deadline", () => {
    // 7-day clock with 1h to run and 10% spent: a subscription would call this free tokens.
    const metered = supplyStateFrom("openrouter", [win("7-day", 10, 1 * HOUR)], NOW);
    expect(supplyKind("openrouter")).toBe("metered");
    expect(metered.shadow).toBe(0);
    expect(metered.shadow).not.toBeLessThan(0);
    expect(metered.ballistic).toBe(false);
  });

  it("never charges a FREE TIER a scarcity premium — its balance is not an obligation", () => {
    // 20h left on a daily window against 90% spent: 73 points ahead of pace, and still not dear.
    const free = supplyStateFrom("google", [win("daily", 90, 20 * HOUR)], NOW);
    expect(supplyKind("google")).toBe("free-tier");
    expect(free.shadow).toBe(0);
    expect(free.shadow).not.toBeGreaterThan(0);
  });

  it("reports a ballistic subscription at the floor price, and the soonest reset", () => {
    const s = supplyStateFrom(
      "xai",
      [win("7-day", 10, 1 * HOUR), win("monthly", 10, 5 * DAY)],
      NOW,
    );
    expect(s.ballistic).toBe(true);
    expect(s.shadow).toBe(-1);
    expect(s.resetAtMs).toBe(NOW + 1 * HOUR);
  });

  it("treats a window with no published reset as pace-unknown rather than as pace-zero", () => {
    const s = supplyStateFrom("anthropic", [win("7-day", 71)], NOW);
    expect(s.windows[0].elapsed).toBeUndefined();
    expect(s.windows[0].pace).toBeUndefined();
    expect(s.shadow).toBe(0);
  });

  it("prices an empty snapshot at sticker instead of assuming headroom", () => {
    const s = supplyStateFrom("anthropic", undefined, NOW);
    expect(s.spent).toBe(false);
    expect(s.shadow).toBe(0);
    expect(s.binding).toBeUndefined();
  });
});

describe("windowBallistic — NEAR and DEFICIT are both required", () => {
  it("arms only when a reset is imminent AND real surplus will expire with it", () => {
    expect(windowBallistic(paced(0.95, 0.2))).toBe(true);
  });

  it("does NOT arm on NEAR alone — an emptied bucket has nothing left to save", () => {
    expect(windowBallistic(paced(0.95, 0.9))).toBe(false);
  });

  it("does NOT arm on DEFICIT alone — Monday morning is not a refresh", () => {
    expect(windowBallistic(paced(0.5, 0.1))).toBe(false);
  });

  it("does not arm on a window whose length could not be inferred", () => {
    expect(windowBallistic({ label: "per sprint", used: 0.1 })).toBe(false);
  });

  it("never arms on a metered supply, whatever its windows look like", () => {
    // §8: "the design is wrong if ballistic ever fires on a metered supply." The identical
    // windows on a subscription DO arm it, so this is the kind rejecting it, not the arithmetic.
    const windows = [win("7-day", 10, 1 * HOUR)];
    expect(supplyStateFrom("anthropic", windows, NOW).ballistic).toBe(true);
    expect(supplyStateFrom("openrouter", windows, NOW).ballistic).toBe(false);
    expect(supplyStateFrom("unknown", windows, NOW).ballistic).toBe(false);
  });
});

describe("effectiveCost — fairness enters as a price, not as a rule", () => {
  it("bends the €/task axis by (1 + lambda x shadow)", () => {
    const dear = supplyStateFrom("anthropic", [win("5-hour", 90, 3 * HOUR)], NOW); // shadow +0.5
    const cheap = supplyStateFrom("anthropic", [win("5-hour", 50, 1 * HOUR)], NOW); // shadow −0.3
    expect(effectiveCost(1, dear)).toBeCloseTo(1 + SHADOW_LAMBDA * 0.5);
    expect(effectiveCost(1, cheap)).toBeCloseTo(1 - SHADOW_LAMBDA * 0.3);
  });

  it("charges sticker for a supply it knows nothing about — unknown is never a discount", () => {
    expect(effectiveCost(0.42, undefined)).toBe(0.42);
  });

  it("leaves a non-finite cost alone rather than propagating arithmetic into it", () => {
    const s = supplyStateFrom("anthropic", [win("5-hour", 90, 3 * HOUR)], NOW);
    expect(effectiveCost(Number.NaN, s)).toBeNaN();
  });
});

describe("fanOutSupply — the leaves land on the friendliest clock", () => {
  const board = (): Map<SupplyId, SupplyState> =>
    new Map<SupplyId, SupplyState>([
      // The 2026-09-03 board: Claude at 71% with a 5-hour window the day's interactive work
      // depends on, xAI at 28% with no short window at all.
      [
        "anthropic",
        supplyStateFrom(
          "anthropic",
          [win("5-hour", 39, 2 * HOUR), win("7-day", 71, 3.5 * DAY)],
          NOW,
        ),
      ],
      ["xai", supplyStateFrom("xai", [win("Weekly", 28, 3.5 * DAY)], NOW)],
      ["openai", supplyStateFrom("openai", [win("5-hour", 100), win("Weekly", 92)], NOW)],
      ["openrouter", supplyStateFrom("openrouter", [win("7-day", 0, 3.5 * DAY)], NOW)],
    ]);

  it("picks the supply with headroom and NO short window over the busier two-clock one", () => {
    expect(fanOutSupply(board())?.id).toBe("xai");
  });

  it("refuses a spent supply and refuses to spend real money on leaves", () => {
    // openrouter is the roomiest bucket on this board (0% used) and still loses: a 20-way burst
    // is O(N) tokens, and metered tokens are the one kind that cost cash whatever the clock says.
    const only = new Map<SupplyId, SupplyState>([
      ["openai", supplyStateFrom("openai", [win("5-hour", 100)], NOW)],
      ["openrouter", supplyStateFrom("openrouter", [win("7-day", 0, 3.5 * DAY)], NOW)],
    ]);
    expect(fanOutSupply(only)).toBeUndefined();
  });

  it("penalises a short window even when the long one looks roomy", () => {
    // Same headroom on both, but one publishes a 5-hour bucket a burst could trip.
    const states = new Map<SupplyId, SupplyState>([
      ["anthropic", supplyStateFrom("anthropic", [win("5-hour", 20), win("7-day", 20)], NOW)],
      ["xai", supplyStateFrom("xai", [win("Weekly", 20)], NOW)],
    ]);
    expect(fanOutSupply(states)?.id).toBe("xai");
  });

  it("has nothing to offer when the snapshot is empty", () => {
    expect(fanOutSupply(new Map())).toBeUndefined();
  });
});

describe("supplyOfKey — several providers, one billing pool", () => {
  it("folds every route that spends one quota onto that quota", () => {
    expect(supplyOfKey("claude-code/claude-opus-5")).toBe("anthropic");
    expect(supplyOfKey("anthropic/claude-opus-5")).toBe("anthropic");
    expect(supplyOfKey("openai-codex/gpt-5.6")).toBe("openai");
    expect(supplyOfKey("xai/grok-4.6")).toBe("xai");
  });

  it("calls an unrecognised route unknown, and prices unknown as metered", () => {
    expect(supplyOfKey("who/knows")).toBe("unknown");
    expect(supplyOfKey("bare-model-id")).toBe("unknown");
    expect(supplyKind("unknown")).toBe("metered");
  });
});

describe("supplyStates — the join from the snapshot's vocabulary to the billing pools", () => {
  it("merges every fetcher that draws on one quota into ONE state", () => {
    // The budget panel keys by fetcher name and the config keys by provider, so `claude-code` and
    // `anthropic` arrive as two rows for one bucket. Pricing them separately would double-count
    // the headroom of a pool that is really one pool.
    const states = supplyStates(
      {
        "claude-code": [win("5-hour", 39, 2 * HOUR)],
        anthropic: [win("7-day", 71, 3.5 * DAY)],
        chatgpt: [win("5-hour", 100)],
      },
      NOW,
    );
    expect([...states.keys()].sort()).toEqual(["anthropic", "openai"]);
    const claude = states.get("anthropic")!;
    expect(claude.windows.map((w) => w.label).sort()).toEqual(["5-hour", "7-day"]);
    expect(claude.binding?.label).toBe("7-day");
    expect(states.get("openai")?.spent).toBe(true);
  });

  it("drops a window key it cannot join instead of inventing a supply for it", () => {
    // A join miss here would delete a whole supply from the board, so absence has to be the
    // outcome rather than a half-populated state: `feasibility` then reads that supply as
    // UNKNOWN, and UNKNOWN is never a discount and never "has headroom".
    expect([...supplyStates({ "some-new-fetcher": [win("Weekly", 50)] }, NOW).keys()]).toEqual([]);
    expect(supplyStates(undefined, NOW).size).toBe(0);
    expect(supplyStates({}, NOW).size).toBe(0);
  });
});
