// THALAMUS v4 — the types every v4 module shares (design doc section 7, paper J19 v4.0).
//
// TYPES ONLY. No logic, no imports of values, nothing that touches a clock, the disk or the network,
// so the gateway, the plugin and the browser bundle can all import this file. v2's types
// (`FrontierRung`, `SupplyState`, `TaskDomain`, `SubjectClass`, `FeasibilityVeto`) are reused
// by import, never copied.

import type { FeasibilityVeto, SubjectClass } from "./thalamus-feasibility.js";
import type { FrontierRung, TaskDomain } from "./thalamus-frontier.js";
import type { ReservedReason } from "./thalamus-plan.js";

/** One (model route, effort) point. v2's rung: key, effort, smart (AA height), cost (EUR/task). */
export type Rung = FrontierRung;

/** How an option is fed the work (paper section 3, "one price per option"). */
export type Feed = "thread" | "brief" | "digest";

/** Which harness runs the call. Same vocabulary as `call-telemetry.ts` `CallLane`. */
export type Lane = "embedded" | "cc-bridge";

/**
 * What a money figure is. `list` is the vendor's public per-token price; `plan` is the fee of a
 * subscription spread over the tokens it serves. With `planFactor` at its default of 1.0 a
 * subscription is priced at list price, which is a fair yardstick inside one vendor and a wrong
 * one across vendors. Every priced option and every decision row carries this tag so the
 * learning job never reads a list-priced subscription call as money actually spent.
 */
export type MoneyBasis = "list" | "plan";

/** Jev's confidence, 0..1, as the vendor returns it. */
export type Confidence = number;

/** Where a read came from. `fallback` means Jev was silent or below the confidence floor. */
export type ReadSource = "jev" | "local" | "fallback";

export type Answered<T> = { value: T; conf: Confidence; source: ReadSource };

export type Urgency = "waiting" | "today" | "whenever";
export type Depth = "mechanical" | "routine" | "deep";
export type Shape = "answer" | "parts" | "chain";
export type Needs = "all" | "recent" | "item";
export type StepKind = "plan" | "tool" | "read" | "write" | "check" | "answer";
export type OutcomeState = "done" | "retry" | "stuck" | "refused" | "check";

/** The task read: once per request, again when the plan changes (paper section 4). */
export type TaskRead = {
  id: string;
  ts: number;
  sessionKey: string;
  kind: Answered<TaskDomain>;
  /** 1 lookup, 2 routine, 3 involved, 4 hard, 5 research. */
  difficulty: Answered<1 | 2 | 3 | 4 | 5>;
  topic: Answered<SubjectClass>;
  urgency: Answered<Urgency>;
  shape: Answered<Shape>;
  /** Decided from where the task came from, before any read. */
  private: boolean;
};

/** The step read: before each model call that is not a plain continuation. */
export type StepRead = {
  id: string;
  ts: number;
  sessionKey: string;
  callIndex: number;
  kind: Answered<StepKind>;
  depth: Answered<Depth>;
  needs: Answered<Needs>;
  /** Level 0..4 of "how many mechanical steps probably follow"; N by level is config. */
  runLength: Answered<0 | 1 | 2 | 3 | 4>;
  /** Pending item id -> whether it can run at the same time as the others. */
  parallelOk: Record<string, Answered<boolean>>;
  /** The step changes something outside the conversation, or states a fact others will rely on. */
  commitsOrClaims: Answered<boolean>;
};

export type OutcomeRead = {
  id: string;
  ts: number;
  callIndex: number;
  state: Answered<OutcomeState>;
};

/** Cache behaviour of one vendor family. Built from the price table; multipliers are of base input. */
export type CachePolicy = {
  readMult: number;
  write5mMult: number;
  write1hMult: number;
  /** Lifetime of the tier a new write lands in when the call does not say. */
  ttlMs: number;
  /** false when the vendor never published the lifetime and 5 minutes is assumed (cautious). */
  ttlKnown: boolean;
  /** The vendor caches on its own and charges no write premium: new tokens cost base input. */
  automatic: boolean;
};

/** One entry per (conversation, model): how much of the conversation is warm, and until when. */
export type CacheLedgerEntry = {
  conversationKey: string;
  modelKey: string;
  warmTokens: number;
  writtenAtMs: number;
  ttlMs: number;
  lastReadAtMs: number;
};

/** What a call is expected to bill, split the way the vendor bills it. */
export type CallPrediction = { cachedIn: number; uncachedIn: number; writeIn: number };

/** A rung together with a way of feeding it, and the token counts that feed implies. */
export type Option = {
  rung: Rung;
  feed: Feed;
  inputTokens: number;
  expectedOutputTokens: number;
};

export type PriceParts = {
  /** EUR. */
  money: number;
  /** false: no price row for the model, so `money` is v2's per-task figure, not a per-call one. */
  moneyKnown: boolean;
  /**
   * true: no price row for the model and no priced anchor to scale from, so `money` is v2's
   * per-task figure, in the wrong unit. The router sorts such an option after every priced one.
   */
  unanchored: boolean;
  /** Quota multiplier, `1 + lambda * shadow`, floored. */
  pace: number;
  /** Seconds the option takes. */
  timeSec: number;
  /** Seconds it adds to the critical path (time beyond the unit's slack). */
  critSec: number;
  pFail: number;
  /** EUR to recover from a failure of this option. */
  recovery: number;
};

export type VetoKind = FeasibilityVeto | "privacy" | "policy";
export type VetoRecord = { veto: VetoKind; detail?: string };

export type PricedOption = Option & {
  parts: PriceParts;
  /** Price of this one call. */
  price: number;
  /**
   * Average price per step over the expected run of steps: a cold candidate pays its cache write on
   * the first step and reads cheaply on the rest. Equals `price` for one-shot feeds and one step.
   */
  runPrice: number;
  moneyBasis: MoneyBasis;
  /** The quality estimate that was compared with the dial's bar. */
  quality: number;
  /** The prediction that priced the input side. */
  prediction: CallPrediction;
};

export type SwitchReason =
  | "no-change"
  | "hand-picked"
  | "fresh-point"
  | "run-exceeds-n-star"
  | "single-step-pays"
  | "stuck"
  | "cache-cold"
  | "incumbent-vetoed"
  | "kept-below-n-star"
  | "mid-thread-off"
  | "preference-changed";

export type SwitchDecision = {
  /** `fresh` = a new unit, a check, a finish or a digest: nothing warm to lose. */
  kind: "keep" | "switch" | "fresh";
  reason: SwitchReason;
  nStar?: number;
  expectedRun?: number;
};

/**
 * What became of the architect's suggestion for the dial's stop in one per-call decision (the architect, 2026-10-02:
 * "his picks are suggestions"). Same rule as the per-turn router (`thalamusRoute` in thalamus-frontier.ts): the
 * suggestion's thread option is the pick unless a veto removed it or a rival clearing the dial's bar still beats
 * it for this task's measured domain strength after the prior.
 */
export type CallSuggestion = {
  state: "kept" | "moved" | "ignored";
  key: string;
  effort?: string;
  /** Moved: a rival that wins on the domain strength (`better`), or the veto that removed the suggestion. */
  cause?: string;
  /** Moved for a better rung: the rung that won, and its lead in percent. */
  to?: string;
  gainPct?: number;
};

export type CallDecision = {
  id: string;
  ts: number;
  runId: string;
  callIndex: number;
  lane: Lane;
  mode: "shadow" | "enforce";
  taskReadId?: string;
  stepReadId?: string;
  dialIdx: number;
  options: PricedOption[];
  vetoes: Array<{ key: string } & VetoRecord>;
  /** The quality an option had to clear for this step, in AA points (the dial's bar less the depth relief). */
  bar?: number;
  /** The lowest-priced option before the switch policy. */
  pick: PricedOption;
  /** What the call will actually use after the switch policy (the incumbent when it holds). */
  chosen: PricedOption;
  incumbent: string;
  switch: SwitchDecision;
  moneyBasis: MoneyBasis;
  /** Why a reserved model (Fable) was admitted; absent when none was. */
  reservedReason?: ReservedReason;
  /** Present when the stop had a suggestion and the call was not hand-picked. */
  suggestion?: CallSuggestion;
  /** The read behind this decision was cautious (Jev silent, unsure, or a private source). */
  degraded: boolean;
  applied: boolean;
  wouldChange: boolean;
  reason: string;
};

/** What happened to a decision (table `outcomes`). */
export type LedgerRow = {
  decisionId: string;
  actualModel: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  durationMs: number;
  ttftMs?: number;
  stopReason?: string;
  outcome: OutcomeState | "error";
  refused: boolean;
  moneyBasis: MoneyBasis;
};

/** A unit of a plan graph (paper section 6.1). Used from phase E; declared here so the types stay in one file. */
export type Unit = {
  id: string;
  task: string;
  kind: "read" | "work" | "check" | "combine" | "write";
  inputs: string[];
  outputs: string[];
  writes: string[];
  estIn: number;
  estOut: number;
  /** How much thought the unit needs. Absent: from its kind (a read is routine, a check or a combine is deep). */
  depth?: Depth;
  sharedStart?: { id: string; tokens: number };
  model: string | "auto";
  urgency: Urgency;
  private: boolean;
};

export type PlanGraph = {
  id: string;
  units: Unit[];
  edges: Array<{ from: string; to: string; why: "input" | "same-write" }>;
  criticalPath: string[];
  slackSec: Record<string, number>;
};
