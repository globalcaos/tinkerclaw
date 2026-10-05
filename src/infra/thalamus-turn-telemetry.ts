// FORK 2026-10-01 — single owner of the `stream:"thalamus"` agent-event contract.
//
// WHY. the architect asked for a THALAMUS panel that shows only the present turn: "the models/efforts involved, and if a
// different model/effort was chosen due to either censorship or best-of on a particular task". The reply path already
// computes all of that for every Auto turn (`createModelSelectionState` in src/auto-reply/reply/model-selection.ts
// builds a ThalamusPlan from the prompt), but it sent it only to a journal row. The browser recomputed its own plan
// WITHOUT the prompt, so it could never know the domain, the subject class or the vetoes, which are exactly the reasons
// he asked to see. This module publishes the gateway's own decision instead of a second guess.
//
// THE CONTRACT, two phases on one stream:
//   decision  once per Auto turn, at model selection: what runs (model + effort), the dial tier, and WHY.
//   fallback  a model failed mid-turn and another took over: from, to, and the failure reason.
//
// WHY, as data, never prose the UI must parse (FORK 2026-10-02: the architect's picks are SUGGESTIONS, one per dial stop):
//   kept          the model the architect suggested for this stop runs (at its effort).
//   moved         it did not: another rung beat it for this task after the 10 % prior, or the job did not fit it
//                 (context, allowlist). `suggestion.cause` says which; `gainPct` is the lead when it was a better rung.
//   cooling       the suggested supply (or the one the open board would have used) hit a limit and is cooling until
//                 `cooling.untilMs`; the turn runs on the best supply still open.
//   best-of       no suggestion on this stop: the frontier swapped the dial's pick for a measured specialist of the
//                 prompt's domain.
//   bias          the dial's own pick on the €/task frontier, nothing else applied.
//   censorship    at least one model family was skipped because it keeps declining this subject class (the
//                 `engagement` veto, src/shared/thalamus-feasibility.ts). Listed in `declined`, with its own line.
//
// SESSION, NOT RUN. Model selection happens before a run id exists. The event carries the session key and a
// synthetic run id (`thalamus:<sessionKey>`); the UI keys the panel by session, which is the tab.
import { THALAMUS_DEFAULT_BIAS_IDX } from "../shared/thalamus-frontier.js";
import type { CoolingShift, PlanSuggestion } from "../shared/thalamus-plan.js";
import { supplyOfKey } from "../shared/thalamus-supply.js";
import { emitAgentEvent } from "./agent-events.js";

export type ThalamusTurnWhy = "bias" | "best-of" | "kept" | "moved" | "cooling" | "censorship";
export type ThalamusTurnTier = "budget" | "default" | "smart";

/** What became of the stop's suggestion this turn, as the card draws it. */
export interface ThalamusTurnSuggestion {
  state: "kept" | "moved";
  /** The suggested model and the effort it was suggested at. */
  model: string;
  effort: string;
  /** Moved: why. `better` = another rung won after the prior; the rest are the reasons the job could not use it. */
  cause?: "better" | "cooling" | "spent" | "unfunded" | "capacity" | "engagement";
  /** Moved for a better rung: how far the winner leads, in percent, on the task's measured domain strength. */
  gainPct?: number;
}

/** A cooling supply changed this turn's pick: the rung the open board would have run, and when the supply reopens. */
export interface ThalamusTurnCooling {
  from: { model: string; effort: string };
  supply: string;
  /** Epoch ms; absent when the limit stated no reset and the store has none. */
  untilMs?: number;
}

export interface ThalamusTurnDecision {
  phase: "decision";
  /** provider/model that runs the turn. */
  model: string;
  /** Effort rung the turn runs at; "" when the model has no effort ladder. */
  effort: string;
  tier: ThalamusTurnTier;
  biasIdx: number;
  /** The prompt's classified domain ("general" when nothing specific). */
  domain: string;
  /** Every reason that applies, strongest first. Always at least one. */
  why: ThalamusTurnWhy[];
  /** What the turn did NOT run: the suggestion that moved, the cooled pick, or the dial's own pick under best-of. */
  instead?: { model: string; effort: string };
  /** Present when the stop has a suggestion that is on the board: kept, or moved and why. */
  suggestion?: ThalamusTurnSuggestion;
  /** Present when a cooling supply changed the pick. */
  cooling?: ThalamusTurnCooling;
  /** Model families skipped because they keep declining this subject (censorship). */
  declined: { model: string; detail: string }[];
  /** The subject class that triggered the censorship check ("none" when nothing sensitive). */
  subject: string;
  /** solo | debate | build-debug | fan-out — whether several models were planned to cooperate. */
  mode: string;
  panel: string[];
  chair?: string;
  /** Recovery ladder behind the primary. */
  chain: string[];
  /** The router's own one-line reason, verbatim. */
  reason: string;
}

export interface ThalamusTurnFallback {
  phase: "fallback";
  from: string;
  to: string;
  /** FailoverReason ("rate_limit", "overloaded", "timeout", ...), or "unknown". */
  reason: string;
  detail?: string;
}

/** The dial's three stops, in the router's own banding (src/infra/thalamus-tier-defaults.ts thalamusTierForBias). */
export function thalamusTurnTier(biasIdx: number): ThalamusTurnTier {
  const b = Number.isFinite(biasIdx) ? Math.round(biasIdx) : THALAMUS_DEFAULT_BIAS_IDX;
  return b <= 2 ? "budget" : b === 3 ? "default" : "smart";
}

export interface ThalamusTurnDecisionInput {
  routedKey: string;
  effort: string;
  biasIdx: number;
  domain: string;
  subject?: string;
  /** What became of the stop's suggestion (`ThalamusPlan.suggestion`); absent when the stop has none. */
  suggestion?: PlanSuggestion;
  /** `ThalamusPlan.coolingShift`: a cooling supply moved the pick. */
  coolingShift?: CoolingShift;
  /** The frontier's final rung and the dial's own rung (route.rung / route.biasRung). */
  routeRung?: { key: string; effort?: string };
  biasRung?: { key: string; effort?: string };
  vetoes?: readonly { key: string; veto: string; detail?: string }[];
  mode?: string;
  panel?: readonly string[];
  chair?: string;
  chain?: readonly string[];
  reason?: string;
}

/** Pure: the plan, reduced to what the panel shows. Unit-tested in thalamus-turn-telemetry.test.ts. */
export function buildThalamusTurnDecision(i: ThalamusTurnDecisionInput): ThalamusTurnDecision {
  const why: ThalamusTurnWhy[] = [];
  let instead: ThalamusTurnDecision["instead"];
  let suggestion: ThalamusTurnSuggestion | undefined;
  let cooling: ThalamusTurnCooling | undefined;
  const sg = i.suggestion;
  if (sg?.state === "kept") {
    why.push("kept");
    suggestion = { state: "kept", model: sg.key, effort: sg.effort };
  } else if (sg?.state === "moved") {
    const limit = sg.cause === "cooling" || sg.cause === "spent";
    why.push(limit ? "cooling" : "moved");
    instead = { model: sg.key, effort: sg.effort };
    suggestion = {
      state: "moved",
      model: sg.key,
      effort: sg.effort,
      cause: sg.cause,
      ...(sg.gainPct !== undefined ? { gainPct: sg.gainPct } : {}),
    };
    if (limit) {
      cooling = {
        from: { model: sg.key, effort: sg.effort },
        supply: supplyOfKey(sg.key),
        ...(sg.untilMs !== undefined ? { untilMs: sg.untilMs } : {}),
      };
    }
  } else if (i.coolingShift) {
    why.push("cooling");
    instead = { model: i.coolingShift.from.key, effort: i.coolingShift.from.effort };
    cooling = {
      from: { model: i.coolingShift.from.key, effort: i.coolingShift.from.effort },
      supply: i.coolingShift.supply,
      ...(i.coolingShift.untilMs !== undefined ? { untilMs: i.coolingShift.untilMs } : {}),
    };
  }
  const bestOf = !!i.routeRung && !!i.biasRung && i.routeRung.key !== i.biasRung.key;
  if (bestOf && !sg && !i.coolingShift) {
    why.push("best-of");
    instead = { model: i.biasRung!.key, effort: i.biasRung!.effort ?? "" };
  }
  // One row per family: the veto is per rung, and a family has several rungs.
  const declined: { model: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const v of i.vetoes ?? []) {
    if (v.veto !== "engagement") continue;
    const detail = v.detail ?? "";
    const family = detail.split(" ")[0] || v.key;
    if (seen.has(family)) continue;
    seen.add(family);
    declined.push({ model: v.key, detail });
  }
  if (declined.length > 0) why.push("censorship");
  if (why.length === 0 || (why.length === 1 && why[0] === "censorship")) why.unshift("bias");
  return {
    phase: "decision",
    model: i.routedKey,
    effort: i.effort,
    tier: thalamusTurnTier(i.biasIdx),
    biasIdx: i.biasIdx,
    domain: i.domain || "general",
    why,
    ...(instead ? { instead } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(cooling ? { cooling } : {}),
    declined,
    subject: i.subject || "none",
    mode: i.mode || "solo",
    panel: [...(i.panel ?? [])],
    ...(i.chair ? { chair: i.chair } : {}),
    chain: [...(i.chain ?? [])],
    reason: i.reason ?? "",
  };
}

/** Publish the turn's decision for the session's tab. Fire-and-forget: telemetry never throws into the reply path. */
export function emitThalamusTurnDecision(
  sessionKey: string | undefined,
  decision: ThalamusTurnDecision,
): void {
  if (!sessionKey) return;
  try {
    emitAgentEvent({
      runId: `thalamus:${sessionKey}`,
      sessionKey,
      stream: "thalamus",
      data: { ...decision, t: Date.now() },
    });
  } catch {
    /* never break the turn for a panel */
  }
}

/** Publish a mid-turn model fallback. The run's own context supplies the session key. */
export function emitThalamusTurnFallback(
  runId: string | undefined,
  f: Omit<ThalamusTurnFallback, "phase">,
): void {
  if (!runId || !f.from || !f.to) return;
  try {
    emitAgentEvent({
      runId,
      stream: "thalamus",
      data: { phase: "fallback", ...f, t: Date.now() },
    });
  } catch {
    /* never break the turn for a panel */
  }
}
