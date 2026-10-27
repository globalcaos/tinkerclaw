// THALAMUS — which model the "Rewind and retry with ‹model›" button would use.
//
// FORK 2026-10-02 (the architect, full deploy): "Refusals are detected only. No automatic re-route, no veto in routing. Two
// buttons under a reply read as refused: Rewind, and Rewind and retry with ‹model› (model chosen by Thalamus from
// another family, shown with its logo)." His observation behind it: once a refusal is in the context, the next model
// tends to agree with it, which is why the retry rewinds first and why it must come from somewhere else.
//
// WHAT IT PICKS. The best rung for the task's domain among the models of ANOTHER VENDOR than the one that refused
// (`supplyOfKey` differs: the same unit the cooling store and the allowlist use; same-vendor models share the policy
// that refused). "Best" is the measured domain strength when there is one, then the AA index; a model with a measured
// row ranks above one without, because a measurement beats an absence. Its strongest effort is the rung, since this
// is a second try of a turn the first model failed.
//
// WHAT IT NEVER PICKS. A supply that is spent, cooling or unfunded; a model whose window the job does not fit; the
// reserved set (it is one vendor's top model, and the vendor is the one excluded when that vendor refused; when
// another vendor refused it is still not drifted into); and, when the source is private, anything outside the
// providers approved for private content, which for a private task on `claude-code` leaves nothing, so the pick is
// undefined and the page shows Rewind alone.
//
// NOTHING IS SENT, RETRIED OR VETOED HERE. This is a pure reading of the board; the page decides what to do with it.
//
// PURE. No clock beyond `nowMs`, no I/O.

import { feasibility } from "./thalamus-feasibility.js";
import {
  domainStrengthFor,
  isReservedKey,
  type DomainStrength,
  type FrontierRung,
  type TaskDomain,
} from "./thalamus-frontier.js";
import { supplyOfKey, type SupplyId, type SupplyState } from "./thalamus-supply.js";

export type RetryPick = {
  /** `provider/model`. */
  model: string;
  effort: string;
  /** The vendor (supply) the retry would run on. */
  family: SupplyId;
  domain: TaskDomain;
  /** The measured strength it was picked on, when there was one. */
  strength?: number;
  /** One line a human reads. */
  reason: string;
};

export type RetryPickParams = {
  rungs: readonly FrontierRung[];
  supplies: ReadonlyMap<SupplyId, SupplyState>;
  /** The model that refused, `provider/model`. Its vendor is excluded. */
  refusingKey: string;
  domain: TaskDomain;
  cooling?: ReadonlySet<SupplyId>;
  unfunded?: ReadonlySet<SupplyId>;
  contextWindowFor?: (key: string) => number | undefined;
  estimatedTokens?: number;
  /** When set (a private source), only models of these providers may be picked. */
  allowedProviders?: readonly string[];
  strengthFor?: (key: string, domain: TaskDomain) => DomainStrength | undefined;
  nowMs: number;
};

const providerOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf("/")));

/** Undefined when no model of another vendor can take the turn. */
export function retryPick(p: RetryPickParams): RetryPick | undefined {
  const strengthFor = p.strengthFor ?? domainStrengthFor;
  const refusingSupply = supplyOfKey(p.refusingKey);
  const feasible = new Map<string, FrontierRung[]>();
  for (const r of p.rungs) {
    if (supplyOfKey(r.key) === refusingSupply) continue;
    if (isReservedKey(r.key)) continue;
    if (p.allowedProviders && !p.allowedProviders.includes(providerOf(r.key))) continue;
    const f = feasibility(r.key, {
      supplies: p.supplies,
      cooling: p.cooling,
      unfunded: p.unfunded,
      contextWindowFor: p.contextWindowFor,
      estimatedTokens: p.estimatedTokens,
      nowMs: p.nowMs,
    });
    if (!f.ok) continue;
    const list = feasible.get(r.key) ?? [];
    list.push(r);
    feasible.set(r.key, list);
  }
  type Cand = { rung: FrontierRung; p: number | undefined };
  const cands: Cand[] = [];
  for (const rungs of feasible.values()) {
    const strongest = rungs.reduce((a, b) => (b.smart > a.smart ? b : a));
    cands.push({
      rung: strongest,
      p: p.domain === "general" ? undefined : strengthFor(strongest.key, p.domain)?.p,
    });
  }
  if (cands.length === 0) return undefined;
  cands.sort((a, b) => {
    const am = a.p !== undefined;
    const bm = b.p !== undefined;
    if (am !== bm) return am ? -1 : 1;
    if (am && bm && a.p !== b.p) return (b.p as number) - (a.p as number);
    return b.rung.smart - a.rung.smart || a.rung.cost - b.rung.cost;
  });
  const best = cands[0];
  return {
    model: best.rung.key,
    effort: best.rung.effort,
    family: supplyOfKey(best.rung.key),
    domain: p.domain,
    ...(best.p !== undefined ? { strength: best.p } : {}),
    reason:
      best.p !== undefined
        ? `best measured ${p.domain} strength outside ${refusingSupply} (p${(best.p * 100).toFixed(0)})`
        : `smartest model outside ${refusingSupply}${p.domain === "general" ? "" : ` (no measured ${p.domain} row)`}`,
  };
}
