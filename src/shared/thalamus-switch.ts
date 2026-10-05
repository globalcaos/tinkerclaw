// THALAMUS v4 — when a switch pays (design doc section 11.1; paper J19 v4.0 P§5.1, P§5.2, P§5.4).
//
// WHAT THIS IS FOR. Handing the next step of a running conversation to another model hands over
// the whole thread. The incumbent re-reads it from its cache for a fraction of the price; the
// candidate has to read it at full price and write it into its own cache first. This file holds
// the arithmetic of that trade and the switch policy that applies it.
//
// HOW IT WAS DERIVED. The formulas are the paper's, symbol for symbol:
//   k    how many times dearer the incumbent's input is than the candidate's
//   r_b  the incumbent's cached read, as a fraction of the incumbent's input price
//   r_s  the candidate's cached read, as a fraction of the candidate's input price
//   w    the candidate's cache write, as a multiple of its input price
//   N* = (w - r_s) / (k r_b - r_s)      switching pays when the run of steps N > N*
//   a single step pays only when k r_b > 1
//   a digest of d tokens for a result of S tokens, read L more times, by a reader priced q,
//   pays when (1 - d/S)(w + r_b L) > q
// The thread length cancels out of N*: it sets what is at stake, not when a switch starts to pay.
//
// PURE. No clock, no I/O.

import { cachePolicyFor, priceFor } from "./thalamus-price-table.js";
import type { OutcomeState, SwitchDecision } from "./thalamus-v4-types.js";

export type SwitchRatios = { k: number; rb: number; rs: number; w: number };

/**
 * The paper's break-even run length. Infinity when the incumbent's cached read is no dearer than
 * the candidate's: the switch never pays on input alone. Never below 0.
 */
export function breakEvenN(r: SwitchRatios): number {
  const denominator = r.k * r.rb - r.rs;
  if (!(denominator > 0)) return Infinity;
  return Math.max(0, (r.w - r.rs) / denominator);
}

/** One step on its own needs no cache write on the candidate, so it pays only when k r_b > 1. */
export function singleStepPays(r: Pick<SwitchRatios, "k" | "rb">): boolean {
  return r.k * r.rb > 1;
}

/**
 * Does condensing a result pay? `dOverS` is the digest's share of the result, `L` the number of
 * later steps that would re-read it, `q` the reader's price in units of the incumbent's input
 * price (1 when the reader is the incumbent's own model: the saving is not carrying the raw result).
 */
export function digestPays(p: {
  dOverS: number;
  w: number;
  rb: number;
  L: number;
  q: number;
}): boolean {
  return (1 - p.dOverS) * (p.w + p.rb * p.L) > p.q;
}

/**
 * The ratios for switching from `incumbentKey` to `candidateKey`, from the price table. Undefined
 * when either model has no input price or no cache figure: then nothing is priced and the caller
 * keeps the incumbent (the cautious side).
 */
export function switchRatios(
  incumbentKey: string,
  candidateKey: string,
  tier: "5m" | "1h" = "1h",
): SwitchRatios | undefined {
  const inc = priceFor(incumbentKey);
  const cand = priceFor(candidateKey);
  const incPolicy = cachePolicyFor(incumbentKey);
  const candPolicy = cachePolicyFor(candidateKey);
  if (!inc || !cand || !incPolicy || !candPolicy) return undefined;
  if (inc.inputPerMTok === null || cand.inputPerMTok === null || cand.inputPerMTok <= 0) {
    return undefined;
  }
  return {
    k: inc.inputPerMTok / cand.inputPerMTok,
    rb: incPolicy.readMult,
    rs: candPolicy.readMult,
    w: tier === "1h" ? candPolicy.write1hMult : candPolicy.write5mMult,
  };
}

export type SwitchInput = {
  incumbentKey: string;
  pickKey: string;
  /** A model the user picked by hand: never replaced (paper P§7, step 6). */
  handPicked: boolean;
  /** A fresh point: a new unit, a check, a finish, a digest. Nothing warm to lose. */
  fresh: boolean;
  /** Expected run of mechanical steps on the pick, from the step read. 1 means a single step. */
  expectedRun: number;
  /** The incumbent's cache is cold in the ledger (or the incumbent has none). */
  incumbentCold: boolean;
  outcome?: OutcomeState;
  /** A stronger rung is cheaper than another failed try (`p_fail x c_rec` compared by the caller). */
  strongerCheaperThanRetry?: boolean;
  /** Undefined when the price table cannot say; the switch is then held. */
  ratios?: SwitchRatios;
};

/**
 * The switch policy (paper P§5.4, rules 1 and 3). Rules 2, 4 and 5 (digest, check, one writer)
 * are choices of feed and step kind made before this, and arrive here as `fresh`.
 */
export function decideSwitch(i: SwitchInput): SwitchDecision {
  if (i.handPicked) return { kind: "keep", reason: "hand-picked" };
  if (i.pickKey === i.incumbentKey) return { kind: "keep", reason: "no-change" };
  if (i.fresh) return { kind: "fresh", reason: "fresh-point" };
  if (i.outcome === "stuck" && i.strongerCheaperThanRetry) {
    return { kind: "switch", reason: "stuck" };
  }
  if (i.incumbentCold) return { kind: "switch", reason: "cache-cold" };
  if (!i.ratios) {
    return { kind: "keep", reason: "kept-below-n-star", expectedRun: i.expectedRun };
  }
  if (i.expectedRun <= 1) {
    return singleStepPays(i.ratios)
      ? { kind: "switch", reason: "single-step-pays", expectedRun: i.expectedRun }
      : { kind: "keep", reason: "kept-below-n-star", expectedRun: i.expectedRun };
  }
  const nStar = breakEvenN(i.ratios);
  return i.expectedRun > nStar
    ? { kind: "switch", reason: "run-exceeds-n-star", nStar, expectedRun: i.expectedRun }
    : { kind: "keep", reason: "kept-below-n-star", nStar, expectedRun: i.expectedRun };
}
