// THALAMUS v4 — what a shared start is worth in a sibling's price (paper J19 v4.1 section 6.3; design doc section 12).
//
// WHAT THIS IS FOR. Siblings of a fan-out share a long start (a contract's definitions and the instructions). The first
// sibling on a model writes that start into the cache; every later one reads it at the cache price. The router's option
// for a fresh unit is either a thread (warm tokens at the cache price, everything else as a WRITE) or a brief (everything
// at the plain input price), and neither is this sibling's real bill: the start is cached, the sibling's own body is read
// once and never again, so it pays plain input, not a write premium. Without this, a plan's cost overstates exactly the
// fan-outs the design prefers, and the ledger would learn from the wrong number.
//
// HOW IT IS COMPUTED. The same terms as `priceOption`'s money, from the same table rows and the same write tier:
//   first sibling on the model  shared x write multiple x input + body x input + output x output price
//   a later sibling             shared x cache-read price  + body x input + output x output price
// The option's own money is scaled by the ratio of the new bill to the one the option's prediction implies, so whatever
// converts dollars to euros and applies a plan factor stays the router's. An option with no price row, or with money that
// was borrowed from an anchor, is left as it is: nothing honest can be said about it.
//
// PURE. No clock, no I/O.

import { cachePolicyFor, priceFor, ratesFor } from "./thalamus-price-table.js";
import type { CallPrediction } from "./thalamus-v4-types.js";

export type SharedStartInput = {
  routeKey: string;
  /** The option's money in EUR and whether it came from the model's own price row. */
  money: number;
  moneyKnown: boolean;
  /** What the router's prediction says the input side was. */
  prediction: CallPrediction;
  expectedOutputTokens: number;
  /** The unit's whole input, and how much of it is the shared start. */
  inputTokens: number;
  sharedTokens: number;
  /** Another sibling already wrote this start into this model's cache. */
  warm: boolean;
  writeTier?: "5m" | "1h";
};

export type SharedStartCredit = {
  /** EUR, for this sibling. Equal to `money` when nothing could be credited. */
  money: number;
  credited: boolean;
};

export function creditSharedStart(p: SharedStartInput): SharedStartCredit {
  const same = { money: p.money, credited: false };
  if (!p.moneyKnown || p.sharedTokens <= 0 || !(p.money > 0)) return same;
  const row = priceFor(p.routeKey);
  const rates = ratesFor(p.routeKey, p.inputTokens);
  const policy = cachePolicyFor(p.routeKey);
  if (!row || !rates || !policy) return same;
  const shared = Math.min(p.sharedTokens, p.inputTokens);
  const body = Math.max(0, p.inputTokens - shared);
  const tier = p.writeTier ?? "1h";
  const writeMult = tier === "1h" ? policy.write1hMult : policy.write5mMult;
  const readRate = rates.cacheReadPerMTok ?? rates.inputPerMTok;
  const out = p.expectedOutputTokens * rates.outputPerMTok;
  const newUsd =
    ((p.warm ? shared * readRate : shared * rates.inputPerMTok * writeMult) +
      body * rates.inputPerMTok +
      out) /
    1e6;
  const was = p.prediction;
  const oldUsd =
    (was.uncachedIn * rates.inputPerMTok +
      was.cachedIn * readRate +
      was.writeIn * rates.inputPerMTok * writeMult +
      out) /
    1e6;
  if (!(oldUsd > 0)) return same;
  return { money: (p.money * newUsd) / oldUsd, credited: true };
}
