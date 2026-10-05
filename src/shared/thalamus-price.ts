// THALAMUS v4 — one price per option (design doc section 11.1; paper J19 v4.0 P§3).
//
//   price = money x pace + lambda x t_crit + p_fail x c_rec          [EUR-equivalent]
//
// WHAT THIS IS FOR. Money, quota pace, cache state, time on the critical path and the risk of
// failure become one number, so the router can compare a cheap slow model with a dear fast one
// at the setting of one dial. These are ROUTING prices: they decide which option wins, not what
// anyone pays. That is why every price carries `moneyBasis`: with the plan factor at its default
// a subscription is priced at list price, a fair yardstick inside one vendor and a wrong one
// across vendors, and the learning job must not read it as money spent.
//
// HOW EACH TERM IS COMPUTED
//   money   uncached, cached and written input from the CACHE LEDGER (counts, never guesses),
//           at the price table's rates, plus expected output. A model with no price row leaves
//           `moneyKnown` false and falls back to v2's per-task figure.
//   pace    v2's shadow price: 1 + SHADOW_LAMBDA x shadow(supply), floored. Positive shadow makes
//           a scarce supply dearer, negative makes an expiring one cheaper. Unknown supply: 1.
//   t_crit  seconds the option adds to the critical path: its own time beyond the unit's slack.
//   lambda  what a second is worth for this task, from the urgency read. STARTING GUESSES
//           (0.004 EUR/s waiting is about 0.24 EUR a minute, one mid-sized Opus call); P§9 test 2
//           is what tunes them (design doc section 16, O9).
//   p_fail  the chance the call fails or is refused; c_rec what recovering would cost.
//
// PURE. No clock, no I/O; `nowMs` is an argument.

import { applyCallUsage, predictCall, type CacheLedger } from "./thalamus-cache-ledger.js";
import { cachePolicyFor, ratesFor } from "./thalamus-price-table.js";
import { effectiveCost, supplyOfKey, type SupplyId, type SupplyState } from "./thalamus-supply.js";
import type {
  CallPrediction,
  Depth,
  MoneyBasis,
  Option,
  PricedOption,
  Rung,
  Urgency,
} from "./thalamus-v4-types.js";

/** EUR per second a task is worth speeding up. STARTING GUESSES, see the header. */
export const LAMBDA_EUR_PER_SEC: Readonly<Record<Urgency, number>> = {
  waiting: 0.004,
  today: 0.0005,
  whenever: 0,
};

/** A supply can get at most this much cheaper for being behind pace. */
export const PACE_FLOOR = 0.4;

/** Ceiling on the chance of failure the model may charge for. */
export const P_FAIL_CEILING = 0.9;

export const DEFAULT_EUR_PER_USD = 0.92;

/**
 * AA points the dial's bar relaxes by, per how much thought the step needs. STARTING GUESSES:
 * a mechanical step (copy a value, apply a known edit) does not need the smartest model the dial
 * would pick for the task; a deep one does. P§9 test 2 tunes them.
 */
export const DEPTH_RELIEF: Readonly<Record<Depth, number>> = {
  mechanical: 12,
  routine: 5,
  deep: 0,
};

/** AA points per full 0..1 of domain strength above the anchor's. A STARTING GUESS (section 16, O9). */
export const STRENGTH_AA_PER_UNIT = 20;

/** Time knowledge for one rung (paper P§3 "Time"). Phase F fills these from recorded calls. */
export type RungTime = {
  ttftColdSec: number;
  ttftWarmSec: number;
  tokensPerSec: number;
  thinkSec: Readonly<Record<Depth, number>>;
};

/** Class default until the ledger has evidence for a rung. */
export const DEFAULT_RUNG_TIME: RungTime = {
  ttftColdSec: 2.5,
  ttftWarmSec: 1,
  tokensPerSec: 60,
  thinkSec: { mechanical: 0, routine: 3, deep: 20 },
};

export type PriceContext = {
  cache: CacheLedger;
  conversationKey: string;
  nowMs: number;
  supplies: ReadonlyMap<SupplyId, SupplyState>;
  urgency: Urgency;
  depth: Depth;
  /** Seconds this unit could finish later without delaying the task. 0 on the critical path. */
  slackSec: number;
  /** Quality estimate of a rung for this task, in AA points. */
  qualityFor: (rungKey: string, effort: string, smart: number) => number;
  timeFor?: (rungKey: string, effort: string) => RungTime;
  pFailFor?: (rungKey: string) => number;
  /** Fraction of list price a subscription counts as; setting it makes the basis "plan". */
  planFactor?: Partial<Record<SupplyId, number>>;
  eurPerUsd?: number;
  /**
   * The rung a model with no price row is measured against (v2's anchor). Such a rung is priced as
   * this one would be for the same tokens, scaled by the ratio of v2's per-task costs, so every
   * option is in euros for THIS call. Absent, or without a price row itself, the option is
   * `unanchored` and sorts after every option that has a price.
   */
  anchorRung?: Rung;
  /** Cache write tier assumed for new tokens. Claude Code writes the one-hour tier (measured). */
  writeTier?: "5m" | "1h";
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Quality of a rung: general height, moved by measured domain strength relative to the anchor. */
export function qualityOf(
  smart: number,
  strength: number | undefined,
  anchorStrength: number | undefined,
): number {
  if (strength === undefined || anchorStrength === undefined) return smart;
  return smart + STRENGTH_AA_PER_UNIT * (strength - anchorStrength);
}

/** The bar an option must clear for a step of this depth. */
export function barFor(dialBar: number, depth: Depth): number {
  return dialBar - DEPTH_RELIEF[depth];
}

/** Fresh feeds (a brief, a digest) are one-shot input: no cache hit, no write premium. */
function predictionFor(o: Option, ctx: PriceContext): CallPrediction {
  if (o.feed !== "thread") return { cachedIn: 0, uncachedIn: o.inputTokens, writeIn: 0 };
  return predictCall(
    ctx.cache,
    ctx.conversationKey,
    o.rung.key,
    o.inputTokens,
    ctx.nowMs,
    cachePolicyFor(o.rung.key),
  );
}

type Money = { money: number; known: boolean; anchored: boolean; basis: MoneyBasis };

/** Euros for one call of this option from the price table, or undefined when the model has no price row. */
function listMoney(o: Option, ctx: PriceContext): { money: number; basis: MoneyBasis } | undefined {
  const key = o.rung.key;
  const rates = ratesFor(key, o.inputTokens);
  if (!rates) return undefined;
  const prediction = predictionFor(o, ctx);
  const policy = cachePolicyFor(key);
  const factor = ctx.planFactor?.[supplyOfKey(key)];
  const tier = ctx.writeTier ?? "1h";
  const writeMult = policy ? (tier === "1h" ? policy.write1hMult : policy.write5mMult) : 1;
  const cachedRate = rates.cacheReadPerMTok ?? rates.inputPerMTok;
  const usd =
    (prediction.uncachedIn * rates.inputPerMTok +
      prediction.cachedIn * cachedRate +
      prediction.writeIn * rates.inputPerMTok * writeMult +
      o.expectedOutputTokens * rates.outputPerMTok) /
    1e6;
  return {
    money: usd * (ctx.eurPerUsd ?? DEFAULT_EUR_PER_USD) * (factor ?? 1),
    basis: factor === undefined ? "list" : "plan",
  };
}

/**
 * The money term. A priced model is computed from the table. A model with no price row is put on
 * the same unit by pricing the ANCHOR for the same tokens and scaling by the ratio of v2's
 * per-task costs (B-review correction 1): v2's cost is euros per task, the rest are euros per call,
 * and comparing the two would decide picks on a unit mismatch. With no priced anchor the option is
 * left `anchored: false` and carries v2's figure only as a last resort.
 */
function moneyFor(o: Option, ctx: PriceContext): Money {
  const own = listMoney(o, ctx);
  if (own) return { ...own, known: true, anchored: true };
  const anchor = ctx.anchorRung;
  if (anchor && anchor.cost > 0 && Number.isFinite(anchor.cost) && Number.isFinite(o.rung.cost)) {
    const a = listMoney({ ...o, rung: anchor }, ctx);
    if (a) {
      return {
        money: (a.money * o.rung.cost) / anchor.cost,
        known: false,
        anchored: true,
        basis: a.basis,
      };
    }
  }
  return { money: o.rung.cost, known: false, anchored: false, basis: "list" };
}

export function priceOption(o: Option, ctx: PriceContext): PricedOption {
  const key = o.rung.key;
  const prediction = predictionFor(o, ctx);
  const supplyId = supplyOfKey(key);
  const { money, known: moneyKnown, anchored, basis: moneyBasis } = moneyFor(o, ctx);

  const pace = ctx.supplies.has(supplyId)
    ? Math.max(PACE_FLOOR, effectiveCost(1, ctx.supplies.get(supplyId)))
    : 1;

  const time = (ctx.timeFor ?? (() => DEFAULT_RUNG_TIME))(key, o.rung.effort);
  const warm = prediction.cachedIn > 0 && prediction.cachedIn >= o.inputTokens / 2;
  const timeSec =
    (warm ? time.ttftWarmSec : time.ttftColdSec) +
    time.thinkSec[ctx.depth] +
    o.expectedOutputTokens / Math.max(1, time.tokensPerSec);
  const critSec = Math.max(0, timeSec - Math.max(0, ctx.slackSec));

  const lambda = LAMBDA_EUR_PER_SEC[ctx.urgency];
  const pFail = clamp(ctx.pFailFor?.(key) ?? 0, 0, P_FAIL_CEILING);
  const recovery = money + lambda * timeSec;

  const price = money * pace + lambda * critSec + pFail * recovery;
  return {
    ...o,
    parts: { money, moneyKnown, unanchored: !anchored, pace, timeSec, critSec, pFail, recovery },
    price,
    runPrice: price,
    moneyBasis,
    quality: ctx.qualityFor(key, o.rung.effort, o.rung.smart),
    prediction,
  };
}

/**
 * Average the price of a thread option over the next `steps` steps (paper P§5.1). The first step
 * pays what the ledger predicts; every later step finds the whole thread warm on that model, so
 * a cold candidate pays its cache write once and reads cheaply afterwards, while a warm incumbent
 * reads cheaply throughout. One-shot feeds (a brief, a digest) and a single step are unchanged.
 */
export function amortize(o: PricedOption, steps: number, ctx: PriceContext): PricedOption {
  if (o.feed !== "thread" || !(steps > 1)) return o;
  const warmLedger = applyCallUsage(
    ctx.cache,
    {
      conversationKey: ctx.conversationKey,
      modelKey: o.rung.key,
      nowMs: ctx.nowMs,
      input: 0,
      cacheRead: o.inputTokens,
      cacheWrite: 0,
    },
    cachePolicyFor(o.rung.key),
  );
  const steady = priceOption(o, { ...ctx, cache: warmLedger });
  return { ...o, runPrice: (o.price + (steps - 1) * steady.price) / steps };
}
