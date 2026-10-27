// THALAMUS v4 — the ladder by reason (design doc section 11; paper J19 v4.1 P§8 step 6).
//
// WHAT THIS IS FOR. When a call fails, the REASON picks the next option, not "the next cheapest":
//   rate limit  -> another provider          (this one has nothing left for now)
//   overloaded  -> the same provider first, then another   (a busy server usually clears)
//   too long    -> a strictly larger window
//   refusal     -> another provider's family (the same lineage will refuse the same way)
//   timeout     -> a faster rung
// A model the user picked by hand gets NO ladder: an explicit choice is never answered by a different model.
//
// HOW IT WAS DERIVED. v2 already names the failure classes and orders a chain by them (`reorderChain`,
// `FailureClass`, `MAX_CHAIN`). This builds the per-call ladder from the options `routeCall` already priced and
// vetoed, so a ladder entry has passed every veto the pick passed (privacy, policy, capacity, quota). Shadow mode
// records the ladder it would use; nothing here changes a call.
//
// PURE. No clock, no I/O.

import { fitsContext } from "./thalamus-feasibility.js";
import { MAX_CHAIN, type FailureClass } from "./thalamus-plan.js";
import { supplyOfKey } from "./thalamus-supply.js";
import type { PricedOption } from "./thalamus-v4-types.js";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "rate_limit",
  "overloaded",
  "capacity",
  "engagement",
  "timeout",
];

/** A recovery option may be this many AA points below the pick: a degraded answer beats none. */
export const LADDER_QUALITY_SLACK = 15;

export type LadderEntry = { key: string; effort: string; quality: number; runPrice: number };

export type Ladder = {
  /** true: a model picked by hand has no ladder, and every list below is empty. */
  handPicked: boolean;
  byReason: Record<FailureClass, LadderEntry[]>;
};

export type LadderParams = {
  /** The options `routeCall` priced, already past every veto. */
  options: readonly PricedOption[];
  chosen: PricedOption;
  handPicked: boolean;
  contextWindowFor?: (key: string) => number | undefined;
  /** Tokens the thread carries, for the "too long" rung. */
  threadTokens?: number;
  /** Lowest quality a recovery option may have. Default: the pick's, less `LADDER_QUALITY_SLACK`. */
  minQuality?: number;
};

const empty = (): Record<FailureClass, LadderEntry[]> => ({
  rate_limit: [],
  overloaded: [],
  capacity: [],
  engagement: [],
  timeout: [],
});

const entry = (o: PricedOption): LadderEntry => ({
  key: o.rung.key,
  effort: o.rung.effort,
  quality: o.quality,
  runPrice: o.runPrice,
});

const same = (a: PricedOption, b: PricedOption): boolean =>
  a.rung.key === b.rung.key && a.rung.effort === b.rung.effort;

const byPrice = (a: PricedOption, b: PricedOption): number =>
  a.runPrice - b.runPrice || b.quality - a.quality || (a.rung.key < b.rung.key ? -1 : 1);

/** Distinct by route and effort, capped at MAX_CHAIN. */
function finish(list: readonly PricedOption[]): LadderEntry[] {
  const seen = new Set<string>();
  const out: LadderEntry[] = [];
  for (const o of list) {
    const k = `${o.rung.key}@${o.rung.effort}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry(o));
    if (out.length >= MAX_CHAIN) break;
  }
  return out;
}

export function ladderFor(p: LadderParams): Ladder {
  if (p.handPicked) return { handPicked: true, byReason: empty() };
  const floor = p.minQuality ?? p.chosen.quality - LADDER_QUALITY_SLACK;
  // Same way of being fed as the pick, so the recovery costs what the pick would have.
  const pool = p.options.filter(
    (o) => o.feed === p.chosen.feed && !same(o, p.chosen) && o.quality >= floor,
  );
  const chosenSupply = supplyOfKey(p.chosen.rung.key);
  const otherSupply = (o: PricedOption) => supplyOfKey(o.rung.key) !== chosenSupply;
  const out = empty();

  out.rate_limit = finish(pool.filter(otherSupply).toSorted(byPrice));

  out.overloaded = finish([
    ...pool.filter((o) => !otherSupply(o)).toSorted(byPrice),
    ...pool.filter(otherSupply).toSorted(byPrice),
  ]);

  const chosenWindow = p.contextWindowFor?.(p.chosen.rung.key);
  if (chosenWindow !== undefined && chosenWindow > 0) {
    out.capacity = finish(
      pool
        .filter((o) => {
          const w = p.contextWindowFor?.(o.rung.key);
          // A window nobody published cannot be called larger, so it is not offered.
          return w !== undefined && w > chosenWindow && fitsContext(w, p.threadTokens);
        })
        .toSorted(byPrice),
    );
  }

  // A refusal is the vendor's habit, not one model's: another model of the same lineage refuses the same
  // way, so "another family" means another provider, strongest first.
  out.engagement = finish(
    pool.filter(otherSupply).toSorted((a, b) => b.quality - a.quality || byPrice(a, b)),
  );

  out.timeout = finish(
    pool
      .filter((o) => o.parts.timeSec < p.chosen.parts.timeSec)
      .toSorted((a, b) => a.parts.timeSec - b.parts.timeSec || byPrice(a, b)),
  );

  return { handPicked: false, byReason: out };
}
