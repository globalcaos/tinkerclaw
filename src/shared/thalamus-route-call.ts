// THALAMUS v4 — the per-call decision (design doc section 11.1; paper J19 v4.0 P§7 step 5).
//
// WHAT THIS IS FOR. v2's `thalamusPlan` decides once per task. `routeCall` decides at every model
// call: it lists the options (rung x feed), drops what the vetoes forbid, prices the rest, takes the
// cheapest that clears the dial's bar, and then lets the switch policy overrule a pick that would
// move a running thread. The task-level plan stays v2's; this is the second level of the same loop.
//
// HOW IT WAS DERIVED. Order and rules are the paper's:
//   1. A model the user picked by hand is never replaced, and nothing else runs (P§7 step 6).
//   2. Vetoes first (privacy, policy, capacity, quota), then price.
//   3. Describe, then decide: the reads describe, the prices choose. A read never names a model.
//   4. Low confidence or a silent reader never makes a route cheaper or riskier (P§4): the whole
//      thread, no switch, the stronger of the two cheapest options, and every vendor with a topic
//      restriction left out.
//   5. The reserved set (Fable) is reached only by a named reason, as in v2.
//
// PURE. No clock, no I/O; every input is an argument.

import { isWarm, ledgerKey, type CacheLedger } from "./thalamus-cache-ledger.js";
import type { RefusalLedger } from "./thalamus-feasibility.js";
import {
  isReservedKey,
  SUGGESTION_PRIOR,
  THALAMUS_ANCHOR_KEY,
  domainStrengthFor,
} from "./thalamus-frontier.js";
import type { FrontierRung, RouteSuggestion } from "./thalamus-frontier.js";
import { enumerateOptions, type FeedTokens } from "./thalamus-options.js";
import type { ReservedReason } from "./thalamus-plan.js";
import { amortize, barFor, priceOption, qualityOf, type PriceContext } from "./thalamus-price.js";
import type { SupplyId, SupplyState } from "./thalamus-supply.js";
import { decideSwitch, switchRatios } from "./thalamus-switch.js";
import type {
  Answered,
  CallDecision,
  CallSuggestion,
  Depth,
  Lane,
  Needs,
  OutcomeState,
  PricedOption,
  StepRead,
  TaskRead,
} from "./thalamus-v4-types.js";
import { applyVetoes, type PolicyTable } from "./thalamus-vetoes.js";

/** Below this Jev confidence an answer counts as unsure. A starting value; P§9 test 1 measures it. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

/**
 * How likely another try of a stuck step fails again. "Stuck" means the same failure twice, so a
 * third try mostly fails too. A stronger model is worth its price when it costs no more than the
 * incumbent's price divided by (1 - this): the chain of retries it replaces. A STARTING GUESS
 * (design doc section 16, O9); the ledger's stuck-then-fixed record tunes it.
 */
export const STUCK_REPEAT_FAIL = 0.8;

/** Expected mechanical steps by the step read's run-length level (design doc section 11.3). */
export const DEFAULT_RUN_LENGTH_N: readonly number[] = [0, 1.5, 4, 8, 15];

const sure = (a: Answered<unknown>, floor: number): boolean =>
  a.source !== "fallback" && a.conf >= floor;

/** Is the topic answer unreliable? Then nobody checked the topic. */
export function topicUnsure(task: TaskRead, floor = DEFAULT_CONFIDENCE_FLOOR): boolean {
  return !sure(task.topic, floor);
}

/** Is any answer the step's routing rests on unreliable? */
export function stepUnsure(step: StepRead, floor = DEFAULT_CONFIDENCE_FLOOR): boolean {
  return [step.kind, step.depth, step.needs, step.runLength, step.commitsOrClaims].some(
    (a) => !sure(a, floor),
  );
}

export type RouteCallParams = {
  id: string;
  ts: number;
  runId: string;
  callIndex: number;
  lane: Lane;
  mode: "shadow" | "enforce";

  rungs: readonly FrontierRung[];
  supplies: ReadonlyMap<SupplyId, SupplyState>;
  cache: CacheLedger;
  conversationKey: string;
  task: TaskRead;
  step: StepRead;

  incumbentKey: string;
  incumbentEffort?: string;
  /** The user picked this model: nothing else is considered. */
  handPicked: boolean;

  dialIdx: number;
  /** The dial's intelligence bar in AA points, from v2's anchored dial (`thalamusRoute().target`). */
  dialBar: number;
  feedTokens: FeedTokens;
  hasLongResult?: boolean;
  expectedOutputTokens: (rung: FrontierRung) => number;

  approvedProviders: readonly string[];
  policy?: PolicyTable;
  refusals?: RefusalLedger;
  cooling?: ReadonlySet<SupplyId>;
  unfunded?: ReadonlySet<SupplyId>;
  contextWindowFor?: (key: string) => number | undefined;

  confidenceFloor?: number;
  runLengthN?: readonly number[];
  outcome?: OutcomeState;
  /** A new unit, a finish, a digest: nothing warm to lose. */
  freshPoint?: boolean;
  /** A named reason to admit the reserved set (dial at its top stop, ballistic window). */
  reservedReason?: ReservedReason;
  /**
   * The architect's suggestion for the dial's stop (model, effort), the same one the per-turn router reads
   * (`thalamusSuggestionFor`). Ignored for a hand-picked call. The suggestion's thread option is the pick unless a
   * veto removed it or a rival that clears the dial's bar still beats it, for this task's measured domain strength,
   * after the 10 % prior. See `SUGGESTION_PRIOR` for why only measured strength moves it.
   */
  suggestion?: RouteSuggestion;
  /**
   * `false`: a thread already running is never switched, only fresh points are (design doc 11.3, `enforce.midThread`).
   * Undefined keeps the switch policy as it was. The plugin passes the flag in enforce mode only.
   */
  midThread?: boolean;

  strengthFor?: (key: string, domain: TaskRead["kind"]["value"]) => number | undefined;
  anchorKey?: string;
  slackSec?: number;
  timeFor?: PriceContext["timeFor"];
  pFailFor?: PriceContext["pFailFor"];
  planFactor?: PriceContext["planFactor"];
  eurPerUsd?: number;
  writeTier?: PriceContext["writeTier"];
};

const fallbackRung = (key: string, effort: string): FrontierRung => ({
  key,
  effort,
  smart: 0,
  cost: 0,
  basis: "headline",
});

/**
 * Decide one call. Undefined when nothing survives the vetoes: the caller leaves the call alone
 * (routing is an optimisation, never a gate, as in v2).
 */
export function routeCall(p: RouteCallParams): CallDecision | undefined {
  const floor = p.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const runN = p.runLengthN ?? DEFAULT_RUN_LENGTH_N;
  const topicCautious = topicUnsure(p.task, floor);
  const stepCautious = stepUnsure(p.step, floor);
  const cautious = topicCautious || stepCautious;

  const base = {
    id: p.id,
    ts: p.ts,
    runId: p.runId,
    callIndex: p.callIndex,
    lane: p.lane,
    mode: p.mode,
    taskReadId: p.task.id,
    stepReadId: p.step.id,
    dialIdx: p.dialIdx,
    incumbent: p.incumbentKey,
    degraded: cautious,
    applied: false,
  };

  // The depth the bar uses. An unsure step is treated as deep: no relief, never cheaper.
  const depth: Depth = stepCautious ? "deep" : p.step.depth.value;
  const needs: Needs = stepCautious ? "all" : p.step.needs.value;

  const priceCtx: PriceContext = {
    cache: p.cache,
    conversationKey: p.conversationKey,
    nowMs: p.ts,
    supplies: p.supplies,
    urgency: p.task.urgency.value,
    depth,
    slackSec: p.slackSec ?? 0,
    qualityFor: (key, _effort, smart) => {
      const anchor = p.anchorKey ?? THALAMUS_ANCHOR_KEY;
      const strengthOf =
        p.strengthFor ?? ((k: string, d: TaskRead["kind"]["value"]) => domainStrengthFor(k, d)?.p);
      return qualityOf(
        smart,
        strengthOf(key, p.task.kind.value),
        strengthOf(anchor, p.task.kind.value),
      );
    },
    anchorRung: p.rungs.find((r) => r.key === (p.anchorKey ?? THALAMUS_ANCHOR_KEY)),
    timeFor: p.timeFor,
    pFailFor: p.pFailFor,
    planFactor: p.planFactor,
    eurPerUsd: p.eurPerUsd,
    writeTier: p.writeTier,
  };

  // 1. A hand-picked model is never replaced. Nothing else runs.
  if (p.handPicked) {
    const rung =
      p.rungs.find(
        (r) => r.key === p.incumbentKey && r.effort === (p.incumbentEffort ?? r.effort),
      ) ?? fallbackRung(p.incumbentKey, p.incumbentEffort ?? "");
    const only = priceOption(
      {
        rung,
        feed: "thread",
        inputTokens: p.feedTokens.thread,
        expectedOutputTokens: p.expectedOutputTokens(rung),
      },
      priceCtx,
    );
    return {
      ...base,
      options: [only],
      vetoes: [],
      pick: only,
      chosen: only,
      switch: { kind: "keep", reason: "hand-picked" },
      moneyBasis: only.moneyBasis,
      wouldChange: false,
      reason: "hand-picked model kept",
    };
  }

  const vetoParams = {
    supplies: p.supplies,
    cooling: p.cooling,
    unfunded: p.unfunded,
    contextWindowFor: p.contextWindowFor,
    estimatedTokens: p.feedTokens.thread,
    refusals: p.refusals,
    nowMs: p.ts,
    private: p.task.private,
    approvedProviders: p.approvedProviders,
    topic: p.task.topic.value,
    cautious: topicCautious,
    policy: p.policy,
  };

  // 2. Vetoes, in two passes: the reserved set is closed unless a named reason opens it, and it
  //    opens on its own only when nothing else survives ("feasibility"), as in v2.
  const pool = (allowReserved: boolean) =>
    applyVetoes(
      p.rungs.filter((r) => allowReserved || !isReservedKey(r.key)),
      vetoParams,
    );
  let reservedReason = p.reservedReason;
  let outcome = pool(reservedReason !== undefined);
  if (outcome.passed.length === 0 && reservedReason === undefined) {
    const opened = pool(true);
    if (opened.passed.length > 0) {
      reservedReason = "feasibility";
      outcome = opened;
    }
  }
  const vetoes = outcome.vetoes;
  if (outcome.passed.length === 0) return undefined;

  // 3. Options, priced. A thread option is averaged over the expected run of steps, so a cold
  //    candidate's cache write is spread over the steps that follow (P§5.1). The N* guard in the
  //    switch policy below stays the rule; this only makes the pick see the same trade.
  const steps = Math.max(1, cautious ? 1 : (runN[p.step.runLength.value] ?? 0));
  const options = enumerateOptions({
    rungs: outcome.passed,
    needs,
    feedTokens: p.feedTokens,
    hasLongResult: stepCautious ? false : p.hasLongResult,
    expectedOutputTokens: p.expectedOutputTokens,
  }).map((o) => amortize(priceOption(o, priceCtx), steps, priceCtx));
  if (options.length === 0) return undefined;

  // 4. The cheapest that clears the bar; if none clears it, the best quality that survived.
  const bar = barFor(p.dialBar, depth);
  // An option with no price and no priced anchor goes after every priced one, however cheap v2's
  // per-task figure makes it look; it is picked only when it is the only one that clears the bar.
  const byPrice = (a: PricedOption, b: PricedOption): number =>
    Number(a.parts.unanchored) - Number(b.parts.unanchored) ||
    a.runPrice - b.runPrice ||
    Number(b.rung.key === p.incumbentKey) - Number(a.rung.key === p.incumbentKey) ||
    b.quality - a.quality;
  const clearing = options.filter((o) => o.quality >= bar).sort(byPrice);
  let pick: PricedOption;
  if (clearing.length === 0) {
    pick = [...options].sort((a, b) => b.quality - a.quality || byPrice(a, b))[0];
  } else if (cautious && clearing.length > 1) {
    // "The stronger of two rungs": of the two cheapest that clear the bar, the stronger.
    pick = clearing.slice(0, 2).sort((a, b) => b.quality - a.quality)[0];
  } else {
    pick = clearing[0];
  }

  // 4b. The suggestion. A kept suggestion is the pick; a rival that clears the bar and still wins for this task
  //     after the prior replaces it. A vetoed suggestion is explained, never forced.
  let suggestionRes: CallSuggestion | undefined;
  if (p.suggestion) {
    const sg = p.suggestion;
    const mine = options.filter((o) => o.feed === "thread" && o.rung.key === sg.key);
    const sOpt =
      (sg.effort ? mine.find((o) => o.rung.effort === sg.effort) : undefined) ??
      mine.reduce<PricedOption | undefined>(
        (a, b) =>
          !a || Math.abs(b.quality - pick.quality) < Math.abs(a.quality - pick.quality) ? b : a,
        undefined,
      );
    if (!sOpt) {
      const v = vetoes.find((x) => x.key === sg.key);
      suggestionRes = v
        ? {
            state: "moved",
            key: sg.key,
            ...(sg.effort ? { effort: sg.effort } : {}),
            cause: v.veto,
          }
        : { state: "ignored", key: sg.key, ...(sg.effort ? { effort: sg.effort } : {}) };
    } else {
      const domain = p.task.kind.value;
      const strengthOf =
        p.strengthFor ?? ((k: string, d: TaskRead["kind"]["value"]) => domainStrengthFor(k, d)?.p);
      const sP =
        domain === "general" || !sure(p.task.kind, floor) ? undefined : strengthOf(sg.key, domain);
      let rival: PricedOption | undefined;
      let rivalP = -Infinity;
      if (sP !== undefined) {
        for (const o of clearing) {
          if (o.feed !== "thread" || o.rung.key === sg.key) continue;
          const rp = strengthOf(o.rung.key, domain);
          if (rp === undefined) continue;
          if (
            rp > rivalP ||
            (rp === rivalP && rival !== undefined && o.runPrice < rival.runPrice)
          ) {
            rival = o;
            rivalP = rp;
          }
        }
      }
      if (rival && sP !== undefined && rivalP > sP * (1 + SUGGESTION_PRIOR)) {
        pick = rival;
        suggestionRes = {
          state: "moved",
          key: sg.key,
          effort: sOpt.rung.effort,
          cause: "better",
          to: `${rival.rung.key}${rival.rung.effort ? `@${rival.rung.effort}` : ""}`,
          gainPct: Math.round((rivalP / sP - 1) * 100),
        };
      } else {
        pick = sOpt;
        suggestionRes = { state: "kept", key: sg.key, effort: sOpt.rung.effort };
      }
    }
  }

  // 5. The switch policy.
  const incumbentOption =
    options.find(
      (o) =>
        o.rung.key === p.incumbentKey &&
        o.feed === "thread" &&
        o.rung.effort === (p.incumbentEffort ?? o.rung.effort),
    ) ?? options.find((o) => o.rung.key === p.incumbentKey && o.feed === "thread");
  const incumbentVetoed = vetoes.some((v) => v.key === p.incumbentKey);
  const fresh = p.freshPoint === true || pick.feed !== "thread" || p.step.kind.value === "check";
  const incumbentWarm = isWarm(p.cache.get(ledgerKey(p.conversationKey, p.incumbentKey)), p.ts);
  const expectedRun = cautious ? 0 : (runN[p.step.runLength.value] ?? 0);

  let sw = decideSwitch({
    incumbentKey: p.incumbentKey,
    pickKey: pick.rung.key,
    handPicked: false,
    // A cautious call never switches a running thread, but a fresh point has nothing to hold.
    fresh: cautious ? false : fresh,
    expectedRun,
    incumbentCold: !incumbentWarm,
    outcome: p.outcome,
    strongerCheaperThanRetry:
      p.outcome === "stuck" &&
      incumbentOption !== undefined &&
      pick.quality > incumbentOption.quality &&
      pick.price * (1 - STUCK_REPEAT_FAIL) <= incumbentOption.price,
    ratios: switchRatios(p.incumbentKey, pick.rung.key),
  });
  // A stuck call is the exception: the harness counted two identical failures, which is evidence no unsure read
  // can outweigh, and the stuck rule above already asks for a price test before it switches.
  if (
    cautious &&
    p.outcome !== "stuck" &&
    sw.kind !== "keep" &&
    !incumbentVetoed &&
    incumbentOption
  ) {
    sw = { kind: "keep", reason: "kept-below-n-star", expectedRun };
  }
  // `enforce.midThread` off: a running thread is never switched, only fresh points are. A vetoed incumbent
  // still has to go (below).
  if (
    p.midThread === false &&
    !fresh &&
    sw.kind !== "keep" &&
    !incumbentVetoed &&
    incumbentOption &&
    suggestionRes?.state !== "kept"
  ) {
    sw = { kind: "keep", reason: "mid-thread-off", expectedRun };
  }
  // A picker preference is a fresh instruction. Cost and feasibility can still reject it, but once it is kept
  // it must replace the model already running; otherwise changing the default has no effect until a new thread.
  if (suggestionRes?.state === "kept" && pick.rung.key !== p.incumbentKey) {
    sw = { kind: "switch", reason: "preference-changed" };
  }
  if (incumbentVetoed && pick.rung.key !== p.incumbentKey) {
    sw = { kind: "switch", reason: "incumbent-vetoed" };
  }

  const chosen = sw.kind === "keep" && incumbentOption ? incumbentOption : pick;
  const wouldChange =
    chosen.rung.key !== p.incumbentKey ||
    (p.incumbentEffort !== undefined && chosen.rung.effort !== p.incumbentEffort) ||
    chosen.feed !== "thread";

  return {
    ...base,
    options,
    vetoes,
    bar,
    pick,
    chosen,
    switch: sw,
    moneyBasis: chosen.moneyBasis,
    ...(reservedReason ? { reservedReason } : {}),
    ...(suggestionRes ? { suggestion: suggestionRes } : {}),
    wouldChange,
    reason:
      `${chosen.rung.key}${chosen.rung.effort ? `@${chosen.rung.effort}` : ""} via ${chosen.feed}` +
      `; ${sw.kind} (${sw.reason})` +
      (vetoes.length ? `; ${vetoes.length} vetoed` : "") +
      (cautious ? "; cautious read" : ""),
  };
}
