/**
 * Thalamus candidate envelope — the SINGLE place that computes "which models is
 * thalamus going to route to right now", so the SMART x COST chart and the
 * router cannot disagree about it.
 *
 * WHY THIS MODULE EXISTS. The chart draws a distinct-coloured envelope around
 * the considered set so that when a new best-frontier model appears the
 * architect can see AT A GLANCE whether thalamus is considering it. That signal
 * is worth nothing unless the chart and the router compute the same set from the
 * same code. A hardcoded list in the panel with a comment claiming it matches
 * `src/agents/quota-aware-auto-model.ts` is the precise failure this feature
 * exists to prevent: the comment keeps reading true forever while the ladder
 * moves underneath it. So the quota predicate is IMPORTED from that router
 * (`providerQuotaExhaustion`), never re-derived; the ceiling reuses its exported
 * `COST_CEILING_MULTIPLIER`; and the exclusion vocabulary is its own
 * `CandidateExclusion` type rather than three matching string literals.
 *
 * LAYERING, called out because it is an inversion and was taken deliberately.
 * `src/shared` reaching up into `src/agents` is backwards. The correct end state
 * is `providerQuotaExhaustion` moving DOWN into `src/shared/quota-window.ts`
 * with both callers importing it from there; that file is outside this unit's
 * writes, so the import points up for now. Importing up is still strictly better
 * than copying — a copy is drift with a delay fuse, and drift is the whole thing
 * this module was built to stop.
 *
 * Browser-safe and dependency-free ON PURPOSE, the same way
 * `src/shared/quota-window.ts` is: `src/shared` is the proven client+server home
 * (tinker-ui/src/app.ts already imports ../../src/shared/fortune-cookies.js, and
 * tinker-ui/vite.config.ts opens server.fs.allow to [".", ".."] for exactly
 * that). No node:* imports, no I/O. The one outward edge costs nothing at run
 * time: `quota-aware-auto-model.ts`'s ONLY value import is
 * `src/shared/quota-window.js`, and its other three imports are `import type`
 * and are erased at build. THAT HAS TO STAY TRUE — a `node:*` value import added
 * to the router would break the browser bundle from a file nobody debugging the
 * chart would think to open.
 *
 * CLOCK DISCIPLINE — `nowMs` is ALWAYS an argument; this module never calls
 * Date.now(). Quoting `quota-window.ts`, because the reasoning is the same one:
 * "The browser re-evaluates on a 60s tick against data up to 5 minutes stale,
 * while the gateway reads a 10-minute snapshot behind a 30-minute HTTP cache. A
 * hidden clock inside this module would let the two sides disagree about the
 * same window; an explicit `nowMs` keeps every decision a pure function of its
 * inputs." An envelope that flickers because two processes read two different
 * clocks is worse than no envelope, because it still looks authoritative.
 *
 * THE BASIS IS A FIELD, NOT AN ASSUMPTION. `basis` reports it in the payload
 * rather than in a comment no consumer reads: "cost/token" by default, and
 * "cost/task" when — and only when — the caller supplies `tokensPerTask`.
 *
 * WHICH COST/TASK WAS REFUTED, AND WHICH IS INTENDED. These are two different
 * quantities, and an earlier version of this header collapsed them into one, so
 * it read as though cost/task were refuted outright. It is not.
 *
 *   REFUTED — a LOCALLY DERIVED cost/task: medians over our own
 *   `anatomy_events`. Over 4,519 tasks the session bucket explains eta-squared
 *   0.558 of the variance in tokens-per-task, effort 0.258, and the MODEL only
 *   0.187 — the one factor we could act on is the third-weakest of four. Worse,
 *   the ordering INVERTS under matching in 3 of 3 buckets, so that axis would
 *   not merely be noisy, it would sometimes rank models backwards. The cause is
 *   STRUCTURAL and more rows will not cure it: turns are not randomly assigned
 *   to models, so a median over our own traffic measures WHICH TASKS WE SENT
 *   WHERE at least as much as it measures the model — it measures the harness.
 *   Do not re-derive one here, and do not use `tokensPerTask` to smuggle one in.
 *
 *   INTENDED — a PUBLISHED per-task table anchored to third-party measurement.
 *   It is not our traffic at all, so the assignment bias above cannot enter it.
 *   The canonical copy lives TODAY in `tinker-ui/src/panels/smart-cost-chart.ts`:
 *   `SC_TOKEN_RULES` (:331) read through `scBaseTokens` (:386) and
 *   `scTokensPerTask` (:394) = base x EEG_EFFORT_MULT[effort], with the whole
 *   axis already normalised to `SC_REFERENCE` (:356) = opus-5 at `high`.
 *
 * ITS ROWS ARE NOT EQUALLY SOLID, and the per-row provenance at :312-330 says so:
 * claude-opus-5 MEASURED (OckBench, high = 6,745), kimi-k3 BENCHMARK-ANCHORED
 * (OckBench 12,250), claude-opus-4-8 ANCHORED to Anthropic's published "Opus 5
 * generates 26% fewer tokens than Opus 4.8 at max" — and THE OTHER TEN ROWS ARE
 * ESTIMATES, grok explicitly among them ("no public per-task measurement found").
 * That is why every candidate carries `costBasisConfidence`: a router that
 * silently treats an estimate as a measurement is the failure the field exists to
 * prevent, so the provenance travels WITH the number instead of sitting in a
 * comment beside a table in another tree.
 *
 * THE TABLE STAYS IN THE PANEL and arrives here as the `tokensPerTask` ARGUMENT,
 * for the same reason `relCostFor` is an argument: `src/shared` must not depend on
 * the browser tree, and this module imports nothing from it. Moving that table
 * DOWN into `src/shared` so the gateway and the chart read ONE copy is the right
 * end state and is a LATER UNIT — until it lands there are two homes for one fact,
 * so treat smart-cost-chart.ts as canonical and change it there first.
 *
 * NEVER MIX THE TWO BASES. Under cost/task a model with a published price but no
 * published token count has NO effective cost: it is not quietly ranked on its
 * cost/token figure, it is treated exactly like an unpriced model — never vetoed,
 * and it drops `costVerified`. Half a column in one unit and half in another is
 * how a cost axis inverts a conclusion while still looking perfectly sorted.
 * (`AgentModelEntryConfig.relCost` draws the boundary at the source: EUR per Mtok
 * of OUTPUT, "NOT weighted by tokens-per-task" — which is precisely why the
 * weighting has to arrive from OUTSIDE rather than be assumed into it.)
 *
 * THE VETO IS SCALE-INVARIANT, so it does not matter whether the supplier returns
 * absolute tokens or a figure already normalised to SC_REFERENCE: the ceiling is
 * the anchor's own effective cost x COST_CEILING_MULTIPLIER, both sides in the
 * same unit. Normalisation moves the printed numbers, never the membership — and
 * a CONSTANT token count reproduces the cost/token answer exactly, which is the
 * cheapest available proof that the two axes have not drifted apart.
 *
 * THE RULES, all settled by the architect — do not relitigate:
 *   1. Rank by `intelligenceIndex` DESCENDING. Cost is a VETO, never a
 *      preference and never a tie-break at the top level — see
 *      `quota-aware-auto-model.ts:18-27` and its comparator at :396.
 *   2. AN AA GAP BELOW 1.0 IS A TIE, broken on cost. The live pair that forced
 *      the rule: openai-codex/gpt-5.6-sol 60.9299 against xai/grok-4.6 60.9230 —
 *      a 0.0069 gap measured at DIFFERENT effort rungs. Ordering on it is
 *      reading noise as signal, so the two are tied and the cheaper one leads.
 *      That is why grok-4.6 wins that pair.
 *   3. A candidate dearer than COST_CEILING_MULTIPLIER x the ANCHOR's EFFECTIVE
 *      COST is excluded `cost-veto`. Veto, not preference: no tolerance band
 *      above it, and cost never promotes anyone across a band boundary. The
 *      effective cost is `relCost` on the token basis and `relCost x
 *      tokensPerTask` on the task basis — the RULE is byte-for-byte the same on
 *      either axis, only the quantity it reads changes.
 *   4. A candidate whose provider's token window is spent is excluded
 *      `provider-exhausted`.
 *
 * THE ANCHOR IS THE TOP-RANKED ROUTABLE MODEL, AND IT IS CHOSEN BEFORE THE
 * EXHAUSTION CHECK. The router measures candidates against the ORIGINAL model it
 * is replacing — which is exhausted by construction, since exhaustion is what
 * built the ladder in the first place. So anchoring on a model whose provider is
 * spent is the FAITHFUL reading, not an oversight. Anchoring on the surviving
 * pick instead was considered and rejected on two counts: it would disagree with
 * the router the moment the top model's window fills (the router keeps measuring
 * against opus-5's 0.2232 while the chart would switch to grok-4.6's 0.0536, and
 * a chart that contradicts the router is the failure this file exists to
 * prevent), and it would make the envelope collapse and re-inflate every time a
 * 5-hour bucket rolls over, which is the opposite of glanceable.
 *
 * WHAT THE ENVELOPE CAN AND CANNOT REVEAL — worth stating, because the whole
 * point is glancing at it and believing it. It WILL show a new model OUTSIDE the
 * set because it carries no `intelligenceIndex` (the common case: added to the
 * catalog before the AA refresh runs — thalamus can never place it in the order,
 * so it can never reach it), because its provider is spent, or because it is
 * dearer than the ceiling. It will NOT show a new BEST model as cost-vetoed: the
 * top-ranked model IS the anchor and is never measured against itself.
 */

import {
  COST_CEILING_MULTIPLIER,
  providerQuotaExhaustion,
  type CandidateExclusion,
} from "../agents/quota-aware-auto-model.js";
import type { UsageSnapshot } from "../infra/usage-snapshot-store.js";

/** Re-exported so a consumer never has to reach into `src/agents` for the reason strings. */
export type { CandidateExclusion };
export { COST_CEILING_MULTIPLIER };

/**
 * Two AA scores closer than this are a TIE, not an ordering.
 *
 * Artificial Analysis publishes per-effort rows, and the pair that forced this
 * rule was measured at DIFFERENT effort rungs: 60.9299 against 60.9230 is a
 * 0.0069 gap, which is instrument noise, not a ranking. Inside the band the
 * cheaper model leads. This is NOT cost creeping back in as a preference —
 * outside the band, cost cannot move a model by a single position.
 */
export const AA_TIE_BAND = 1;

/** The DEFAULT cost axis: EUR per Mtok of output, exactly as `relCostFor` returns it. */
export const THALAMUS_COST_BASIS = "cost/token";

/**
 * The axis this module switches to when the caller supplies `tokensPerTask`:
 * `relCost x tokensPerTask`, i.e. what one finished task costs rather than what
 * one token costs. See the header for WHICH cost/task this is (a published,
 * third-party-anchored table) and which one stays refuted (a median over our own
 * `anatomy_events`).
 */
export const THALAMUS_COST_BASIS_PER_TASK = "cost/task";

/** Which of the two axes actually ran. Reported in the payload, never assumed. */
export type ThalamusCostBasis = typeof THALAMUS_COST_BASIS | typeof THALAMUS_COST_BASIS_PER_TASK;

/**
 * How real the per-task token figure behind a candidate's cost actually is.
 *
 * ELEVEN OF THE THIRTEEN published rows are estimates (see the header), so a
 * consumer that draws an estimate and a measurement identically is overclaiming,
 * and this module refuses to help it. "unknown" is the honest default and is what
 * every candidate reports when no provenance supplier was passed — it is NEVER
 * silently upgraded to "estimated".
 */
export type ThalamusCostConfidence = "measured" | "anchored" | "estimated" | "unknown";

/**
 * The catalog shape, structural on purpose: the gateway passes
 * `cfg.agents.defaults.models` and the browser passes whatever the RPC handed
 * it, both unchanged. Only `intelligenceIndex` is read here — the price arrives
 * through `relCostFor`, so there is exactly ONE place a cost can come from.
 */
export type ThalamusCatalogEntry = { intelligenceIndex?: number };
export type ThalamusCatalog = Readonly<Record<string, ThalamusCatalogEntry | undefined>>;

/** One model inside the envelope. */
export type ThalamusConsidered = {
  key: string;
  provider: string;
  model: string;
  intelligenceIndex: number;
  /** From `relCostFor`. undefined means "nobody published one", NEVER "free". */
  relCost: number | undefined;
  /**
   * 1-BASED ladder position: `considered[0].rank === 1`, and rank 1 is `pick`.
   * Unrelated to `AgentModelEntryConfig.rank`, which is a UI display order.
   */
  rank: number;
  /**
   * PER-TASK BASIS ONLY — the three fields below are ABSENT (not undefined) when
   * `basis` is "cost/token", so a payload produced without a `tokensPerTask`
   * supplier is byte-for-byte what this module produced before the axis existed.
   *
   * What `tokensPerTask` returned for this key; undefined when its table had no
   * row, or returned a non-positive count, which makes `costPerTask` undefined
   * too rather than falling back to the cost/token figure.
   */
  tokensPerTask?: number | undefined;
  /** PER-TASK BASIS ONLY — `relCost x tokensPerTask`, the number the veto and the tie-break read. */
  costPerTask?: number | undefined;
  /** PER-TASK BASIS ONLY — how real `tokensPerTask` is. "unknown" when nobody said. */
  costBasisConfidence?: ThalamusCostConfidence;
};

/** One model outside it, carrying the reason the router itself would have recorded. */
export type ThalamusExcluded = { key: string; reason: CandidateExclusion };

export type ThalamusCandidatesResult = {
  /**
   * WHICH AXIS ACTUALLY RAN — "cost/task" when the caller supplied
   * `tokensPerTask`, "cost/token" otherwise. A field, not a comment, because
   * `ceiling` and every candidate's cost are IN THESE UNITS and a consumer that
   * guesses wrong is comparing two different quantities. See the header.
   */
  basis: ThalamusCostBasis;
  /** Ranked, best first. `considered.length + excluded.length === catalogSize`. */
  considered: ThalamusConsidered[];
  excluded: ThalamusExcluded[];
  /** The key thalamus routes to first — always `considered[0]`. Absent when nothing survived. */
  pick?: string;
  /**
   * The model whose price set the ceiling: the top-ranked ROUTABLE model, spent
   * provider or not. Exposed so a chart can label the boundary instead of
   * re-deriving the anchor rule and drifting from it.
   */
  anchorKey?: string;
  /**
   * The ANCHOR's effective cost x COST_CEILING_MULTIPLIER, IN THE UNITS `basis`
   * names — `relCost` on the token basis, `relCost x tokensPerTask` on the task
   * basis. Absent => the veto did not run at all.
   */
  ceiling?: number;
  /**
   * TRUE only when the 1.5x veto was FULLY applied: a ceiling could be formed
   * AND every considered model carried a cost ON THE ACTIVE BASIS. False is the
   * honest signal that the envelope's cost axis is partial — either the cost is
   * absent everywhere (no ceiling, so nothing was vetoed) or some survivor
   * slipped through uncosted. A metered model reading as free is precisely what
   * the veto exists to stop, which is why an uncosted SURVIVOR drops this and not
   * just an uncosted anchor. Same intent as the router's `COST_UNVERIFIED_MARKER`.
   *
   * ON THE TASK BASIS IT ALSO CATCHES A MISSING TOKEN COUNT, which is the new
   * hole that axis opens: a model can be perfectly priced and still have no
   * published tokens-per-task row, and the honest answer to that is "unknown",
   * never "reuse the cost/token number".
   */
  costVerified: boolean;
  /** Entries in the input catalog, so the two lists can be checked to cover it. */
  catalogSize: number;
  /** Echoes `nowMs`. This module has no clock of its own. */
  generatedAtMs: number;
};

export type ThalamusCandidatesParams = {
  catalog: ThalamusCatalog;
  snapshot: UsageSnapshot | undefined;
  /** ALWAYS supplied by the caller. See CLOCK DISCIPLINE in the header. */
  nowMs: number;
  /**
   * `provider/model` key -> cost per output token, or undefined when the
   * caller's table has no row for it.
   *
   * An ARGUMENT rather than an import on purpose. The canonical table lives in
   * `tinker-ui/src/panels/eeg-trace.ts` EEG_COST_TABLE (order-sensitive regex
   * rows serving this very chart) while the gateway holds an exact-key subset on
   * `AgentModelEntryConfig.relCost`, whose own doc says "Do NOT import or
   * duplicate that table here". Taking the lookup as a parameter also keeps this
   * unit's writes disjoint from the unit that owns the table, and makes the
   * predicate testable with a two-line stub.
   *
   * MUST RETURN undefined ON A MISS. Do NOT pass `eegRelCost` straight through:
   * it falls back to EEG_DEFAULT_REL_COST (2.58, verified at
   * eeg-trace.ts:562) for any model it does not recognise. Against a live
   * ceiling near 0.33 that invented price would COST-VETO a brand-new frontier
   * model straight out of the envelope, for a reason nobody published — the
   * exact blindness this chart was built to remove. Wrap it so a miss stays a
   * miss, and let `costVerified` report the hole.
   */
  relCostFor: (key: string) => number | undefined;
  /**
   * OPTIONAL PER-TASK BASIS. `provider/model` key -> average OUTPUT tokens to
   * complete ONE task on that model, or undefined when the caller's table has no
   * row for it.
   *
   * SUPPLIED => this module ranks and vetoes on `relCost x tokensPerTask` and
   * reports `basis: "cost/task"`. OMITTED => cost/token, byte-for-byte as before,
   * down to the absent per-candidate fields. The basis is decided by PRESENCE
   * alone: there is no separate flag that could get out of step with the data it
   * names, and no way to ask for cost/task without providing the numbers for it.
   *
   * An ARGUMENT rather than an import, for the same reason `relCostFor` is one:
   * `src/shared` must not depend on the browser tree, and the canonical table
   * lives in `tinker-ui/src/panels/smart-cost-chart.ts` today (`SC_TOKEN_RULES` /
   * `scBaseTokens` / `scTokensPerTask`). Moving it down here is a LATER UNIT.
   *
   * MUST RETURN undefined ON A MISS, and the trap is the exact twin of the one
   * `relCostFor` documents: do NOT pass `scTokensPerTask` straight through, because
   * `scBaseTokens` falls back to SC_TOKEN_DEFAULT (8,000) for any model it does not
   * recognise. Against a live ceiling that invented count would cost-veto a
   * brand-new frontier model for a figure nobody published. Wrap it so a miss stays
   * a miss, and let `costVerified` report the hole.
   *
   * A non-positive count is treated as a MISS, not as a free model — see
   * `positiveNumber`.
   */
  tokensPerTask?: (key: string) => number | undefined;
  /**
   * OPTIONAL provenance for `tokensPerTask`, same key, read ONLY when
   * `tokensPerTask` was supplied. A key it has no answer for reports "unknown".
   *
   * A SECOND argument rather than a richer return type from `tokensPerTask`,
   * because the provenance is prose in `smart-cost-chart.ts:312-330` and is
   * machine-readable nowhere: only the caller knows which row it actually used.
   * Without it `costBasisConfidence` could never be anything but "unknown".
   */
  costBasisConfidenceFor?: (key: string) => ThalamusCostConfidence | undefined;
  /**
   * Optional routability filter, the same `provider/model` key set the router
   * takes as `allowedModelKeys` (`buildAllowedModelSet`). Supplied => a key
   * outside it is excluded `not-routable`, exactly as the router excludes it.
   * Omitted => no filter, and `not-routable` means only "carries no AA score, so
   * thalamus cannot place it in the order at all". Pass it wherever the set is
   * available: without it this module cannot reproduce the router's OWN
   * not-routable rule, and an envelope can claim a model the gateway has no auth
   * profile for.
   */
  allowedModelKeys?: ReadonlySet<string>;
};

type Row = {
  key: string;
  provider: string;
  model: string;
  intelligenceIndex: number;
  relCost: number | undefined;
  tokensPerTask: number | undefined;
  /**
   * THE ONE QUANTITY EVERY COST RULE READS — the tie-break, the ceiling, the
   * veto and `costVerified`. One number rather than an `if (perTask)` branch at
   * each of those four sites, because four branches is how two axes drift apart
   * one rule at a time, which is the precise failure this module exists to stop.
   */
  effectiveCost: number | undefined;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Tokens-per-task must be STRICTLY POSITIVE, and a bad row is MISSING, not free.
 *
 * The exact mirror of the invented-price trap documented on `relCostFor`. There,
 * a made-up price would cost-veto a model for a reason nobody published; here, a
 * 0 or a negative would drive the effective cost to zero or below and float the
 * model to the TOP of its tie band, where no ceiling could ever reach it. Both
 * directions of fabricated data are refused the same way — undefined, with
 * `costVerified` reporting the hole.
 */
function positiveNumber(value: unknown): number | undefined {
  const finite = finiteNumber(value);
  return finite !== undefined && finite > 0 ? finite : undefined;
}

/**
 * The active basis applied to one row.
 *
 * cost/token: the published price, untouched. cost/task: price x tokens, and
 * UNDEFINED the moment either half is missing — never a silent fall back to the
 * cost/token figure. Half a column in one unit and half in another is how a cost
 * axis inverts a conclusion while still looking perfectly sorted, and undefined
 * already means "unchecked, never free" to every rule downstream.
 */
function effectiveCostOf(
  relCost: number | undefined,
  tokensPerTask: number | undefined,
  perTask: boolean,
): number | undefined {
  if (!perTask) {
    return relCost;
  }
  if (relCost === undefined || tokensPerTask === undefined) {
    return undefined;
  }
  return relCost * tokensPerTask;
}

/**
 * Final tie-break on the key, so the order is TOTAL and independent of input order.
 *
 * Load-bearing, not tidiness. The gateway enumerates `cfg.agents.defaults.models`
 * and the browser enumerates whatever the RPC serialised; two objects carrying
 * the same models in a different insertion order would otherwise produce two
 * different envelopes from identical data — the chart and the router disagreeing
 * over nothing at all. Leaning on `Array.prototype.sort` stability alone would
 * bake that insertion order into the answer.
 */
function byKey(a: Row, b: Row): number {
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
}

/**
 * Strict AA descending, with the sub-1.0 tie rule applied WITHIN BANDS.
 *
 * Banded rather than a pairwise "if the gap is under 1.0, compare cost"
 * comparator, and this is load-bearing: the pairwise version is not a strict
 * weak ordering and can cycle. Take A=62.0 (cost 9), B=61.2 (cost 5), C=61.0
 * (cost 1). A-B and B-C are ties broken on cost, so C beats B beats A, while A-C
 * is a 1.0 gap decided on AA, so A beats C. `Array.prototype.sort` handed a
 * cyclic comparator yields an implementation-defined order that can change with
 * input order alone — the silent drift this module exists to stop.
 *
 * A band is anchored on its HIGHEST-AA member and admits everyone within
 * AA_TIE_BAND of THAT member — not of the previous one, which would chain a long
 * gentle slope into a single band spanning many AA points. Anchoring on the head
 * bounds every band at strictly under one AA point, which is the only claim the
 * tie rule actually makes.
 *
 * Cost reorders a band only when EVERY member of it is priced ON THE ACTIVE
 * BASIS — `effectiveCost`, which on the task basis needs BOTH a price and a token
 * count. With a hole in either table there is no honest comparison to make, so
 * the band keeps its AA order rather than ranking on a guess — the same "missing
 * data never fires the cost rule" stance as the veto itself, and the reason a
 * missing token count must NOT fall back to cost/token: half a band ranked on one
 * axis and half on the other is a sorted-looking answer to no question at all.
 *
 * Inside a band, EQUAL cost falls back to AA and only then to the key: cost
 * breaks the tie, it does not replace the ranking rule underneath it.
 */
function orderCandidates(rows: readonly Row[]): Row[] {
  const byIntelligence = [...rows].sort(
    (a, b) => b.intelligenceIndex - a.intelligenceIndex || byKey(a, b),
  );
  const ordered: Row[] = [];
  let start = 0;
  while (start < byIntelligence.length) {
    const head = byIntelligence[start];
    let end = start + 1;
    while (
      end < byIntelligence.length &&
      head.intelligenceIndex - byIntelligence[end].intelligenceIndex < AA_TIE_BAND
    ) {
      end += 1;
    }
    const band = byIntelligence.slice(start, end);
    if (band.length > 1 && band.every((row) => row.effectiveCost !== undefined)) {
      band.sort(
        (a, b) =>
          (a.effectiveCost ?? 0) - (b.effectiveCost ?? 0) ||
          b.intelligenceIndex - a.intelligenceIndex ||
          byKey(a, b),
      );
    }
    ordered.push(...band);
    start = end;
  }
  return ordered;
}

/**
 * The models thalamus is going to route to, ranked, plus everything it dropped
 * and why.
 *
 * PURE: every input arrives in `params`, so a chart and a gateway handed the
 * same arguments produce byte-identical results. That is the contract the
 * envelope's credibility rests on.
 *
 * Every catalog key lands in exactly one of `considered` / `excluded`, so a
 * caller can assert the two cover the catalog and no model can go quietly
 * missing from the picture.
 */
export function thalamusCandidates(params: ThalamusCandidatesParams): ThalamusCandidatesResult {
  const { catalog, snapshot, nowMs, relCostFor, allowedModelKeys } = params;
  // THE BASIS IS DECIDED BY PRESENCE ALONE — supply the lookup and the module
  // switches axis. No separate flag that could get out of step with the data it
  // names, and no way to ask for cost/task without providing the numbers for it.
  const tokensFor = params.tokensPerTask;
  const confidenceFor = params.costBasisConfidenceFor;
  const perTask = tokensFor !== undefined;
  const keys = Object.keys(catalog);

  const rows: Row[] = [];
  const excluded: ThalamusExcluded[] = [];
  for (const key of keys) {
    const slash = key.indexOf("/");
    const intelligenceIndex = finiteNumber(catalog[key]?.intelligenceIndex);
    if (intelligenceIndex === undefined || slash <= 0 || slash === key.length - 1) {
      // No published AA score (or an unparseable key) means thalamus cannot place
      // this model in a strict-intelligence order AT ALL, so it can never be
      // reached — which is what "not-routable" means here. The router keeps these
      // in a separate `unranked` bag and drops them silently; surfacing them is
      // what lets the chart EXPLAIN a missing model instead of just omitting it.
      // Dropped rather than ranked last, for the router's reason: unknown is not
      // worst.
      excluded.push({ key, reason: "not-routable" });
      continue;
    }
    const relCost = finiteNumber(relCostFor(key));
    const tokens = tokensFor === undefined ? undefined : positiveNumber(tokensFor(key));
    rows.push({
      key,
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
      intelligenceIndex,
      relCost,
      tokensPerTask: tokens,
      effectiveCost: effectiveCostOf(relCost, tokens, perTask),
    });
  }

  const routable = (key: string): boolean =>
    allowedModelKeys === undefined || allowedModelKeys.has(key);

  const ordered = orderCandidates(rows);
  // THE ANCHOR: the top-ranked ROUTABLE model, chosen BEFORE the exhaustion
  // check so a transient spent window cannot move the ceiling. See the header.
  const anchor = ordered.find((row) => routable(row.key));
  const anchorCost = anchor?.effectiveCost;
  const ceiling = anchorCost === undefined ? undefined : anchorCost * COST_CEILING_MULTIPLIER;

  // Exhaustion is a property of the PROVIDER and the catalog carries many models
  // per provider, so it is resolved once each. Memoized for cost, but also so
  // every model on one provider is guaranteed the same verdict.
  const exhaustedByProvider = new Map<string, boolean>();
  const providerSpent = (provider: string): boolean => {
    const cached = exhaustedByProvider.get(provider);
    if (cached !== undefined) {
      return cached;
    }
    const spent = providerQuotaExhaustion(snapshot, provider, nowMs) !== null;
    exhaustedByProvider.set(provider, spent);
    return spent;
  };

  const considered: ThalamusConsidered[] = [];
  let survivorUnpriced = false;
  for (const row of ordered) {
    // Reasons are tested in the order `quota-aware-auto-model.ts` records them
    // (:400-412 — not-routable, cost-veto, provider-exhausted) so the ONE reason
    // reported here is reproducibly the first one the router would have written.
    if (!routable(row.key)) {
      excluded.push({ key: row.key, reason: "not-routable" });
      continue;
    }
    // A missing relCost is NEVER a veto: the veto must not fire on absent data,
    // or a model disappears from the envelope for a reason nobody published.
    // `costVerified` carries that gap instead.
    if (ceiling !== undefined && row.effectiveCost !== undefined && row.effectiveCost > ceiling) {
      excluded.push({ key: row.key, reason: "cost-veto" });
      continue;
    }
    if (providerSpent(row.provider)) {
      excluded.push({ key: row.key, reason: "provider-exhausted" });
      continue;
    }
    // "Unpriced" is measured on the ACTIVE basis: on cost/task a model with a
    // price but no token count is uncosted HERE, and says so through costVerified.
    if (row.effectiveCost === undefined) {
      survivorUnpriced = true;
    }
    // Written out rather than `{ ...row, rank }`: Row now carries `tokensPerTask`
    // and `effectiveCost`, and a spread would leak both into the token-basis
    // payload. The per-task fields are ABSENT there, not undefined — same
    // conditional-spread discipline as `pick` / `anchorKey` / `ceiling` below,
    // and the reason a caller that never opts in sees the payload it always saw.
    considered.push({
      key: row.key,
      provider: row.provider,
      model: row.model,
      intelligenceIndex: row.intelligenceIndex,
      relCost: row.relCost,
      rank: considered.length + 1,
      ...(perTask
        ? {
            tokensPerTask: row.tokensPerTask,
            costPerTask: row.effectiveCost,
            costBasisConfidence: confidenceFor?.(row.key) ?? "unknown",
          }
        : {}),
    });
  }

  const pick = considered.length === 0 ? undefined : considered[0].key;
  return {
    basis: perTask ? THALAMUS_COST_BASIS_PER_TASK : THALAMUS_COST_BASIS,
    considered,
    excluded,
    ...(pick === undefined ? {} : { pick }),
    ...(anchor === undefined ? {} : { anchorKey: anchor.key }),
    ...(ceiling === undefined ? {} : { ceiling }),
    costVerified: ceiling !== undefined && !survivorUnpriced,
    catalogSize: keys.length,
    generatedAtMs: nowMs,
  };
}
