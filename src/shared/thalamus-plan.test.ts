import { describe, expect, it } from "vitest";
import { isReservedKey, type FrontierRung } from "./thalamus-frontier.js";
import { MAX_CHAIN, reorderChain, thalamusPlan, type ThalamusPlanParams } from "./thalamus-plan.js";
import {
  supplyOfKey,
  supplyStateFrom,
  type SupplyId,
  type SupplyState,
  type SupplyWindowInput,
} from "./thalamus-supply.js";

// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md, jarvis-icu.
//
// THALAMUS emits a PLAN, not a model, because `agents.defaults.model.fallbacks` is literally []
// and the failure machinery underneath it has been handed an empty ladder every turn. What is
// pinned here is what §8 says would falsify that plan: the balanced dial resolves to Opus 5 on a
// board where Opus is feasible; the recovery chain is SUPPLY-DIVERSE, because the failure it
// exists to survive is a rate limit and a second rung on the same limited supply survives
// nothing; the reserved model is never reached by drifting, only by a named reason; and
// composition — which costs strictly more tokens — is gated on the dial.

const NOW = 1_757_000_000_000;
const HOUR = 60 * 60 * 1000;

const TINY = "openrouter/qwen3.8-mini"; // openrouter · below the chain floor
const GEMINI = "google/gemini-3-flash"; // google
const GROK = "xai/grok-4.6"; // xai
const GPT = "openai-codex/gpt-5.6"; // openai
const COPILOT = "github-copilot/gpt-5.6-mini"; // copilot · dominated, off the frontier
const OPUS = "claude-code/claude-opus-5"; // anthropic · THE ANCHOR
const FABLE = "claude-code/claude-fable-5-1"; // anthropic · RESERVED (/fable/i)

const rung = (key: string, effort: string, smart: number, cost: number): FrontierRung => ({
  key,
  effort,
  smart,
  cost,
  basis: "measured",
});

/**
 * A board shaped like the live one: five supplies, an Opus anchor at 63, a reserved Fable above
 * it, one rung too dim to be a fallback (TINY at 40), one dominated rung off the frontier
 * (COPILOT), and two xAI rungs so "one rung per supply" has something to choose between.
 */
const BOARD: readonly FrontierRung[] = [
  rung(TINY, "", 40, 0.01),
  rung(GEMINI, "", 52, 0.02),
  rung(GROK, "low", 50, 0.04),
  rung(GROK, "high", 58, 0.1),
  rung(GPT, "", 61, 0.3),
  rung(COPILOT, "", 55, 0.4),
  rung(OPUS, "high", 63, 0.5),
  rung(FABLE, "high", 66, 1.2),
];

const win = (label: string, usedPercent: number, resetInMs?: number): SupplyWindowInput =>
  resetInMs === undefined
    ? { label, usedPercent }
    : { label, usedPercent, resetAtMs: NOW + resetInMs };

/**
 * Every supply healthy and PACE-UNKNOWN — no published reset, so every shadow is 0 and the
 * €/task axis is left at sticker. The routing tests then read as plain arithmetic on the board
 * above; the one test that needs a bent axis arms it explicitly.
 */
const supplies = (): Map<SupplyId, SupplyState> =>
  new Map<SupplyId, SupplyState>([
    ["anthropic", supplyStateFrom("anthropic", [win("5-hour", 39), win("7-day", 71)], NOW)],
    ["xai", supplyStateFrom("xai", [win("Weekly", 28)], NOW)],
    ["openai", supplyStateFrom("openai", [win("5-hour", 40), win("Weekly", 60)], NOW)],
    ["copilot", supplyStateFrom("copilot", [win("monthly", 50)], NOW)],
    ["google", supplyStateFrom("google", [win("daily", 10)], NOW)],
  ]);

const plan = (over: Partial<ThalamusPlanParams> = {}) =>
  thalamusPlan({ rungs: BOARD, supplies: supplies(), biasIdx: 3, nowMs: NOW, ...over });

const keysOf = (rungs: readonly FrontierRung[]): string[] => rungs.map((r) => r.key);

describe("thalamusPlan — the balanced dial resolves to Opus, and the reserved set stays shut", () => {
  it("routes bias 3 to the anchor and reports no reserved reason", () => {
    // §8: "the design is wrong if the balanced dial does not resolve to Opus 5 on a board where
    // Opus 5 is feasible." Fable is smarter and on the frontier, and is still not picked.
    const p = plan()!;
    expect(p.primary.key).toBe(OPUS);
    expect(isReservedKey(p.primary.key)).toBe(false);
    expect(p.reservedReason).toBeUndefined();
    expect(p.vetoes).toEqual([]);
    expect(p.domain).toBe("general");
    expect(p.subject).toBe("none");
  });

  it("opens the reserved set at the top stop, and NAMES the dial as the reason", () => {
    const p = plan({ biasIdx: 6 })!;
    expect(p.primary.key).toBe(FABLE);
    expect(isReservedKey(p.primary.key)).toBe(true);
    expect(p.reservedReason).toBe("dial");
    expect(p.reason).toContain("reserved set opened by dial");
  });

  it("returns undefined when every rung is vetoed — it says so instead of routing anyway", () => {
    const allSpent = new Map<SupplyId, SupplyState>(
      (["anthropic", "xai", "openai", "copilot", "google", "openrouter"] as SupplyId[]).map(
        (id) => [id, supplyStateFrom(id, [win("Weekly", 100)], NOW)],
      ),
    );
    expect(
      thalamusPlan({ rungs: BOARD, supplies: allSpent, biasIdx: 3, nowMs: NOW }),
    ).toBeUndefined();
    expect(
      thalamusPlan({ rungs: [], supplies: supplies(), biasIdx: 3, nowMs: NOW }),
    ).toBeUndefined();
  });
});

describe("the recovery chain — supply diversity is the point", () => {
  it("carries at most one rung per supply, never the primary's own, best-in-supply", () => {
    const p = plan()!;
    expect(supplyOfKey(p.primary.key)).toBe("anthropic");

    const ids = p.chain.map((r) => supplyOfKey(r.key));
    expect(new Set(ids).size).toBe(ids.length); // one rung per supply
    expect(ids).not.toContain("anthropic"); // never the rate-limited supply we just failed on
    expect(keysOf(p.chain)).not.toContain(FABLE);

    // xAI contributes two rungs and the chain takes the BRIGHTER one; the ladder is ordered by
    // effective cost, cheapest first.
    expect(p.chain).toEqual([...p.chain].sort((a, b) => a.cost - b.cost));
    expect(p.chain.find((r) => r.key === GROK)!.effort).toBe("high");
    expect(keysOf(p.chain)).toEqual([GEMINI, GROK, GPT, COPILOT]);
    expect(p.chain.length).toBeLessThanOrEqual(MAX_CHAIN);
  });

  it("never falls below the route's chainFloor — degraded is allowed, arbitrarily degraded is not", () => {
    const p = plan()!;
    for (const r of p.chain) expect(r.smart).toBeGreaterThanOrEqual(p.route.chainFloor);
    // TINY (40) is the cheapest rung on the board and is still refused as a fallback.
    expect(keysOf(p.chain)).not.toContain(TINY);
    expect(p.route.chainFloor).toBeLessThan(p.primary.smart);
    expect(p.reason).toContain("if it fails →");
  });

  it("appends a same-supply tail ONLY when fewer than two other supplies can be reached", () => {
    // The documented exception: with one rival supply on the board, a same-supply rung at the
    // tail beats having no second fallback at all.
    const thin = [
      rung(GPT, "", 61, 0.3),
      rung(OPUS, "high", 63, 0.5),
      rung(FABLE, "high", 66, 1.2),
    ];
    const p = thalamusPlan({ rungs: thin, supplies: supplies(), biasIdx: 3, nowMs: NOW })!;
    expect(p.primary.key).toBe(OPUS);
    expect(keysOf(p.chain)).toEqual([GPT, FABLE]);
    expect(supplyOfKey(p.chain[1].key)).toBe("anthropic");
  });

  it("says plainly when there is no fallback at all", () => {
    const solo = [rung(OPUS, "high", 63, 0.5)];
    const p = thalamusPlan({ rungs: solo, supplies: supplies(), biasIdx: 3, nowMs: NOW })!;
    expect(p.chain).toEqual([]);
    expect(p.reason).toContain("NO fallback available");
  });
});

describe("the reserved set opens for exactly three named reasons", () => {
  /** xAI a hour from a weekly reset with 10% spent: surplus that cannot physically be consumed. */
  const ballisticSupplies = (): Map<SupplyId, SupplyState> => {
    const m = supplies();
    m.set("xai", supplyStateFrom("xai", [win("Weekly", 10, 1 * HOUR)], NOW));
    return m;
  };

  it("does NOT reach Fable at bias 5 on an ordinary board", () => {
    const p = plan({ biasIdx: 5 })!;
    expect(p.ballistic).toBe(false);
    expect(p.primary.key).toBe(OPUS);
    expect(p.reservedReason).toBeUndefined();
  });

  it("reaches it at the same dial when a window is about to destroy surplus — reason 'ballistic'", () => {
    // The only thing that changed is one supply's clock. Tokens that expire unspent were never
    // worth anything, so the turn may spend them on the model the dial otherwise refuses.
    const p = thalamusPlan({
      rungs: BOARD,
      supplies: ballisticSupplies(),
      biasIdx: 5,
      nowMs: NOW,
    })!;
    expect(p.ballistic).toBe(true);
    expect(p.primary.key).toBe(FABLE);
    expect(p.reservedReason).toBe("ballistic");
    expect(p.reason).toContain("reserved set opened by ballistic");
  });
});

describe("composition — a capability mechanism applied to an easy task is pure cost", () => {
  const noStrengths = () => undefined;

  it("is solo at or below balanced, whatever the domain", () => {
    for (const biasIdx of [0, 1, 2, 3]) {
      const p = plan({ biasIdx, domain: "code", strengthFor: noStrengths })!;
      expect(p.mode).toBe("solo");
      expect(p.panel).toEqual([]);
      expect(p.chair).toBeUndefined();
    }
  });

  it("adds a cross-vendor critic above balanced on buildish work with a clear leader", () => {
    // A builder is a poor judge of its own blind spots, so the critic is drawn from ANOTHER
    // supply — two models of one house share the lineage that produced the blind spot.
    const p = plan({ biasIdx: 4, domain: "code", strengthFor: noStrengths })!;
    expect(p.primary.key).toBe(OPUS);
    expect(p.mode).toBe("critic");
    expect(p.panel).toEqual([GPT]);
    expect(p.chair).toBe(OPUS);
    expect(supplyOfKey(p.panel[0])).not.toBe(supplyOfKey(p.primary.key));
  });

  it("debates instead when the leader's cross-supply margin is inside CONTESTED_MARGIN", () => {
    // GPT raised to 62 puts it 1 AA point behind Opus: the two disagree about who is best, so
    // the turn buys independent answers rather than one answer and a reviewer.
    const contested = BOARD.map((r) => (r.key === GPT ? rung(GPT, "", 62, 0.3) : r));
    const p = thalamusPlan({ rungs: contested, supplies: supplies(), biasIdx: 4, nowMs: NOW })!;
    expect(p.mode).toBe("debate");
    expect(p.panel).toEqual([GPT, GROK]);
    expect(p.chair).toBe(OPUS); // the domain leader chairs — chosen per query, never fixed
    expect(new Set(p.panel.map(supplyOfKey)).size).toBe(p.panel.length);
  });

  it("fans out to the widest-clock supply when the caller intends many units", () => {
    // Leaves are O(N) tokens and the chair is O(1), so the leaves go to xAI — which publishes
    // NO short window and therefore cannot have a burst trip a five-hour limiter — while the
    // chair stays the pick whatever it costs.
    const p = plan({ fanOutWidth: 5 })!;
    expect(p.mode).toBe("fan-out");
    expect(p.leafSupply).toBe("xai");
    expect(p.panel).toEqual([GROK]);
    expect(p.chair).toBe(OPUS);
    expect(p.reason).toContain("fan-out leaves on xai");
  });

  it("stays solo at width 1, and treats a nonsense width as one unit", () => {
    expect(plan({ fanOutWidth: 1 })!.mode).toBe("solo");
    expect(plan({ fanOutWidth: 0 })!.mode).toBe("solo");
    expect(plan({ fanOutWidth: -4 })!.mode).toBe("solo");
  });
});

describe("reorderChain — the error tells you the DIRECTION of the reroute", () => {
  const chain = [rung(GROK, "high", 58, 0.1), rung(GPT, "", 61, 0.3), rung(COPILOT, "", 55, 0.4)];
  const windows: Record<string, number> = { [GROK]: 500_000, [GPT]: 400_000, [COPILOT]: 900_000 };

  it("puts the LARGEST context window first after a capacity failure", () => {
    // The runtime form of Grok → Opus: the turn did not fit, so the retry must be strictly
    // roomier, not merely different.
    const out = reorderChain(chain, "capacity", { contextWindowFor: (k) => windows[k] });
    expect(keysOf(out)).toEqual([COPILOT, GROK, GPT]);
    for (let i = 1; i < out.length; i++) {
      expect(windows[out[i].key]).toBeLessThanOrEqual(windows[out[i - 1].key]);
    }
  });

  it("sinks a route with no published window to the back rather than promoting the unknown", () => {
    const out = reorderChain(chain, "capacity", {
      contextWindowFor: (k) => (k === GPT ? 900_000 : undefined),
    });
    expect(out[0].key).toBe(GPT);
  });

  it("goes cheapest-first on a timeout, smartest-first on a refusal, and leaves a rate limit alone", () => {
    expect(keysOf(reorderChain(chain, "timeout"))).toEqual([GROK, GPT, COPILOT]);
    expect(keysOf(reorderChain(chain, "engagement"))).toEqual([GPT, GROK, COPILOT]);
    expect(reorderChain(chain, "rate_limit")).toEqual(chain); // supply diversity already
    expect(reorderChain(chain, "capacity")).not.toBe(chain); // never mutates the caller's ladder
  });
});
