// The ONE place the Thalamus board is built: the rungs, the supplies and the context windows.
//
// WHAT THIS IS FOR. The chart, v2's per-request plan (`auto-reply/reply/model-selection.ts`) and v4's per-call
// router must compute from the same inputs, or the chart shows one thing and the router does another. Before this
// file v4 kept a copy of v2's block with a "keep in step" comment; the copy had already drifted (v4 read context
// windows from `models.providers`, v2 from the live catalog, and v4 ignored the agent's model allowlist). Both
// callers now go through here.
//
// WHAT IT DOES NOT DO. It reads nothing itself: the usage snapshot, the model catalog and the allowlist come in as
// arguments, so v2 keeps using what it already had in hand and a test can pin the result on a fixture.
//
// `thalamusCandidates` is passed in, not imported: it re-exports from `agents/quota-aware-auto-model.js`, which several
// reply tests replace with a partial mock, and v2 loads it with a dynamic import for that reason (see the comment in
// model-selection.ts). Passing the function keeps that import exactly where it was.

import { modelKey, normalizeModelRef } from "../agents/model-selection.js";
import { providerQuotaExhaustion } from "../agents/quota-aware-auto-model.js";
import { relCostLookup } from "../shared/rel-cost-table.js";
import type { thalamusCandidates } from "../shared/thalamus-candidates.js";
import { frontierRungsFor, type RouteSuggestion } from "../shared/thalamus-frontier.js";
import { isSecondOpinionOnlyKey, supplyStates } from "../shared/thalamus-supply.js";
import { readThalamusTierDefaults, thalamusTierForBias } from "./thalamus-tier-defaults.js";

export type ThalamusCandidatesFn = typeof thalamusCandidates;

export type ThalamusCatalog = Record<string, { intelligenceIndex: number }>;

/** The models the config publishes an index for, keyed by the normalized `provider/model`. Empty means "no router". */
export function buildThalamusCatalog(
  configuredModels: Record<string, { intelligenceIndex?: number } | undefined> | undefined,
): ThalamusCatalog {
  const catalog: ThalamusCatalog = {};
  for (const [rawKey, entry] of Object.entries(configuredModels ?? {})) {
    const index = entry?.intelligenceIndex;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    const slash = rawKey.indexOf("/");
    if (slash <= 0 || slash === rawKey.length - 1) continue;
    const ref = normalizeModelRef(rawKey.slice(0, slash), rawKey.slice(slash + 1));
    catalog[modelKey(ref.provider, ref.model)] = { intelligenceIndex: index };
  }
  return catalog;
}

/**
 * The architect's suggestion for the dial's current stop (the architect, 2026-10-02), as the router wants it: the key
 * normalised the way the catalog's keys are, so a file written as `claude-opus-5-5` meets the board's key. The ONE
 * reader both the per-turn router (model-selection.ts) and the per-call router (thalamus-board.ts) call, so they
 * cannot suggest different things.
 */
export function thalamusSuggestionFor(
  biasIdx: number | undefined,
  opts?: { file?: string },
): RouteSuggestion | undefined {
  const s = readThalamusTierDefaults(opts)[thalamusTierForBias(biasIdx)];
  if (!s) return undefined;
  const slash = s.model.indexOf("/");
  const ref = normalizeModelRef(s.model.slice(0, slash), s.model.slice(slash + 1));
  return { key: modelKey(ref.provider, ref.model), ...(s.effort ? { effort: s.effort } : {}) };
}

export type ThalamusBoardParts = {
  reachable: ReturnType<ThalamusCandidatesFn>;
  rungs: ReturnType<typeof frontierRungsFor>;
  /** Pay-per-call rungs (Google) kept off `rungs` by the subscription cost ceiling, for last-resort second opinions. */
  secondOpinionRungs: ReturnType<typeof frontierRungsFor>;
  supplies: ReturnType<typeof supplyStates>;
  contextWindowFor: (key: string) => number | undefined;
};

/**
 * The reachable rungs, the supplies and the context windows for one catalog.
 *
 * - A model with no published price is dropped, never defaulted (v2's rule: a rung at an invented price could win).
 * - Absent from the usage windows is UNKNOWN, never headroom.
 * - A model the catalog does not describe has an unknown window and passes the capacity veto.
 */
export function buildThalamusBoardParts(input: {
  catalog: ThalamusCatalog;
  thalamusCandidates: ThalamusCandidatesFn;
  snapshot: Parameters<ThalamusCandidatesFn>[0]["snapshot"];
  nowMs: number;
  allowedModelKeys?: ReadonlySet<string>;
  suggestedModelKey?: string;
  /** `{provider, id, contextWindow}` rows from the live model catalog. */
  windowRows: Iterable<{ provider: string; id: string; contextWindow?: number }>;
}): ThalamusBoardParts {
  const reachable = input.thalamusCandidates({
    catalog: input.catalog,
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    relCostFor: (key: string) => relCostLookup(key),
    suggestedModelKey: input.suggestedModelKey,
    allowedModelKeys:
      input.allowedModelKeys && input.allowedModelKeys.size > 0
        ? input.allowedModelKeys
        : undefined,
  });
  const rungs = reachable.considered.flatMap((c) =>
    c.relCost === undefined ? [] : frontierRungsFor(c.key, c.intelligenceIndex, c.relCost),
  );
  // Pay-per-call models (Google) are dearer than the 1.5x subscription ceiling, so `thalamusCandidates`
  // excludes them from `rungs`. Build their rungs separately so a cross-family second opinion can still
  // reach them strictly when no subscription family outside the builder's survives.
  const allowFilter =
    input.allowedModelKeys && input.allowedModelKeys.size > 0 ? input.allowedModelKeys : undefined;
  const secondOpinionRungs = Object.entries(input.catalog).flatMap(([key, entry]) => {
    if (!isSecondOpinionOnlyKey(key)) return [];
    if (allowFilter && !allowFilter.has(key)) return [];
    const slash = key.indexOf("/");
    const provider = slash > 0 ? key.slice(0, slash) : key;
    if (providerQuotaExhaustion(input.snapshot, provider, input.nowMs) !== null) return [];
    const rc = relCostLookup(key);
    return rc === undefined ? [] : frontierRungsFor(key, entry.intelligenceIndex, rc);
  });
  const supplies = supplyStates(input.snapshot?.windows, input.nowMs);
  const ctxByKey = new Map<string, number>();
  for (const row of input.windowRows) {
    if (typeof row.contextWindow === "number" && row.contextWindow > 0) {
      ctxByKey.set(modelKey(row.provider, row.id), row.contextWindow);
    }
  }
  return {
    reachable,
    rungs,
    secondOpinionRungs,
    supplies,
    contextWindowFor: (key) => ctxByKey.get(key),
  };
}
