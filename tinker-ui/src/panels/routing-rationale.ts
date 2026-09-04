// FORK 2026-07-25 (the architect): the ORCA card in the Models side panel, under the model slider.
// Three VERY short sections — MODEL, EFFORT, FAN-OUT — each answering "why this?" in plain
// language. Two hard rules from the architect:
//   1. If a model or effort is FIXED, just say so. No justification for a decision the user
//      already made; extra words there are noise, not transparency.
//   2. Within a turn THALAMUS routes each job separately, so FAN-OUT lists those calls and
//      explains each in the simplest words available — no scores, no model-speak.
//
// NAMING (settled 2026-07-29): this card is THALAMUS, the allocation control plane — which
// model, which effort, which fan-out. ORCA is the parallel-CODING orchestrator: edit-units,
// file leases, per-unit commits. They meet at `unit`/`task`: ORCA says what the jobs are,
// THALAMUS says who runs each. Nothing rendered here is an ORCA concern, which is why the
// card label was renamed. The feed is still called orca-routes.jsonl because ORCA's conductor
// is its current writer — the writer is not the owner of the concept.
//
// Pure render model (no DOM deps, returns an HTML string) — same shape as the other panels/
// modules, so every sentence is unit-testable without a browser.
//
// SOURCE OF TRUTH for the burn-down math: src/agents/effort-allocator.ts
// (deriveQuotaPressure + allocateEffort). The constants below are MIRRORED from there so the
// card can explain an Auto pick client-side without a round trip. If the allocator's
// constants change, change them here too — the test pins the mirrored formula, not the prose.

import { eegStopLeftCss } from "./eeg-trace.js";

/** Convexity of the urgency ramp toward the weekly reset (effort-allocator URGENCY_EXP). */
const URGENCY_EXP = 2.5;
/** How hard "late in the week + headroom left" lifts the burn floor (effort-allocator BURN_AGGRO). */
const BURN_AGGRO = 1.6;
/** The allocator's effort ladder, ascending (effort-allocator LADDER). */
const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const pct = (n: number): string => `${Math.round(clamp01(n) * 100)}%`;

/** One routing call ORCA made during this turn, as the Conductor recorded it. */
export interface RouteDecision {
  /** the edit-unit / job id */
  unit: string;
  /** plain-language job description, if the caller gave one */
  task?: string;
  /** 'solo' | 'debate' | 'build-debug' */
  mode: string;
  /** friendly name of the model that leads the job, e.g. "Opus 5" */
  model: string;
  /** friendly name of the cross-provider reviewer (build-debug) */
  critic?: string;
  /** friendly names of the independent answerers (debate) */
  panel?: string[];
  /** the domain the router classified this job into — the key it actually chose on */
  domain?: string;
  /** the router's one-line justification for THIS supplier, verbatim. Carries whether the
   *  pick came from measured outcomes or published priors ("prior only" vs "(3 measured)"),
   *  which is the difference between a routing log and a routing explanation. */
  why?: string;
}

export interface RoutingSignals {
  /** Human label of the model in force, e.g. "Opus 5". */
  modelLabel: string;
  /** true when the user pinned it on the MODEL slider (pin beats routing). */
  modelPinned: boolean;
  /** Effort in force, e.g. "high"; empty/"Auto" when the allocator decides. */
  effortLabel: string;
  /** true when the user pinned an effort stop. */
  effortPinned: boolean;
  /** Weekly (7d) quota utilization, 0..1. */
  util7d?: number;
  /** Epoch ms at which the binding weekly quota resets. */
  weeklyResetAt?: number;
  /** now, epoch ms (injected so the sentences are testable). */
  nowMs: number;
  /** Concurrent-agent cap the orchestration runtime enforces. */
  parallelCap?: number;
  /** Host core count the cap was derived from. */
  cores?: number;
  /** Routing calls made during this turn, newest last. */
  routes?: RouteDecision[];
  /** Intelligence rank of the leading model within the routable pool (1 = smartest). */
  modelRank?: number;
  /** How many models the slider offers (the routable pool). */
  poolSize?: number;
  /** Absolute path of orca-policy.md, as reported by the gateway. */
  policyPath?: string;
  /** Fast↔smart dial position, 0..BIAS_STOPS.length-1. Undefined ⇒ the balanced default. */
  biasIdx?: number;
  /** Whether the BIAS dial is LIVE — true only while the MODEL slider is on Auto, because a
   *  pinned model bypasses THALAMUS allocation entirely and the dial then drives nothing.
   *
   *  Optional, and it DEFAULTS to `!modelPinned`, which is the same fact app.ts already
   *  computes one field up. That default is deliberate: the gate is correct the moment this
   *  renderer ships, whether or not the caller is updated in the same breath, and an explicit
   *  value still wins when app.ts has a better answer than "the model is pinned". */
  biasEnabled?: boolean;
  /** FORK 2026-09-03: what THALAMUS would route to at this session's BIAS — the cheapest
   *  rung on the €/task Pareto frontier within the dial's gap of the best, computed by
   *  src/shared/thalamus-frontier.ts (the module the reply-path router and the chart's
   *  yellow envelope both call). `model` is the friendly label; `effort` may be "" for a
   *  ladderless model; `cost` is €/TASK, not €/Mtok. Absent ⇒ no line is drawn. */
  frontierPick?: {
    model: string;
    effort: string;
    smart: number;
    cost: number;
    frontierSize: number;
  };
}

export interface BurnExplanation {
  /** 0 = chill, 1 = burn as hard as possible (allocator's `shouldBurn`). */
  burnDemand: number;
  /** Fraction of the weekly window elapsed, 0..1. */
  weekElapsed: number;
  /** Unspent weekly cap, 0..1. */
  headroom: number;
  /** The effort floor that burn demand implies. */
  floor: (typeof LADDER)[number];
}

/** Mirror of deriveQuotaPressure + the burn FLOOR half of allocateEffort. The allocator can go
 *  ABOVE this floor (task weight, exploration); it never goes below it, which is what makes the
 *  floor the honest one-line reason for an Auto pick. */
export function explainBurn(s: RoutingSignals): BurnExplanation | null {
  const util7d = s.util7d;
  if (typeof util7d !== "number" || typeof s.weeklyResetAt !== "number") {
    return null;
  }
  if (s.weeklyResetAt <= s.nowMs) {
    return null;
  }
  const weekElapsed = clamp01(1 - (s.weeklyResetAt - s.nowMs) / WEEK_MS);
  const urgency = Math.pow(weekElapsed, URGENCY_EXP);
  const headroom = clamp01(1 - util7d);
  const behindPace = clamp01(weekElapsed - util7d);
  const burnDemand = clamp01(BURN_AGGRO * urgency * headroom + behindPace);
  const idx = Math.min(
    LADDER.length - 1,
    Math.max(0, Math.round(burnDemand * (LADDER.length - 1))),
  );
  return { burnDemand, weekElapsed, headroom, floor: LADDER[idx] };
}

/** FORK 2026-07-26 (the architect): the fast↔smart dial. Seven stops like the EFFORT slider, left
 *  "fast" and right "smart", answering one question — how many tokens is a better answer
 *  worth on this session? It biases ORCHESTRATION spend (how many models, how much
 *  composition), which is a different axis from the EFFORT slider above it (how hard ONE
 *  model thinks). Both can be moved independently and both are obeyed.
 *
 *  `quality` maps onto the Conductor's own two tiers: `fugu` = exactly one worker per job,
 *  `ultra` = compose (debate / build-and-debug where the evidence earns it). */
export const BIAS_STOPS = [
  { short: "fast", label: "fast", quality: "fugu", effort: "low", panelSize: 1 },
  { short: "quick", label: "quick", quality: "fugu", effort: "medium", panelSize: 1 },
  { short: "lean", label: "lean", quality: "fugu", effort: "high", panelSize: 1 },
  { short: "bal", label: "balanced", quality: "ultra", effort: "high", panelSize: 2 },
  { short: "deep", label: "deep", quality: "ultra", effort: "high", panelSize: 3 },
  { short: "wide", label: "wide", quality: "ultra", effort: "xhigh", panelSize: 3 },
  { short: "smart", label: "smart", quality: "ultra", effort: "max", panelSize: 4 },
] as const;

/** Default dial position — balanced. Named so app.ts and the tests agree on it. */
export const BIAS_DEFAULT_IDX = 3;

/** Why the dial is inert, said in the row's own tooltip. Exported so the test pins the
 *  REASON rather than my phrasing of it. It names the WAY OUT as well as the state: the ask
 *  was that the dial "become usable", so a tooltip that only admits the dial is dead adds
 *  nothing the missing thumb did not already say. Name the lever that brings it back. */
export const BIAS_LOCKED_TITLE =
  "The BIAS dial applies to Auto (THALAMUS) routing — it is inert while a model is " +
  "pinned. Put the MODEL slider back to Auto to use it.";

/** Is the dial live? Auto ⇒ yes. An explicit `biasEnabled` wins; otherwise the MODEL pin
 *  decides, since pinning a model is exactly what takes THALAMUS out of the loop. */
export function isBiasLive(s: RoutingSignals): boolean {
  return s.biasEnabled ?? !s.modelPinned;
}

/** Clamp any stored value into a real stop. */
export function biasStop(idx?: number) {
  const i = Number.isFinite(idx) ? Math.round(idx as number) : BIAS_DEFAULT_IDX;
  return BIAS_STOPS[Math.min(BIAS_STOPS.length - 1, Math.max(0, i))];
}

/** The fast↔smart slider, rendered directly under the ORCA title. Deliberately the SAME
 *  markup/classes as the EFFORT slider so the two read as siblings (the architect's request).
 *
 *  FORK 2026-08-29 (the architect): "the thalamus panel slider should then become usable, otherwise
 *  the circle should not be there at all." The dial only means something while the MODEL
 *  slider is on Auto — pin a model and THALAMUS is out of the loop, so the dial drives
 *  nothing. When it is inert the input is `disabled` (so it cannot be dragged, and the
 *  delegated `input`/`change` listeners in app.ts never fire, which also means no stray
 *  prefrontal.orcaBias write) and the ROW carries `is-locked`, the hook base.css uses to take
 *  the THUMB away. Greying a live-looking control was the thing he rejected. */
export function renderBiasSlider(s: RoutingSignals): string {
  const idx = Math.min(
    BIAS_STOPS.length - 1,
    Math.max(0, Number.isFinite(s.biasIdx) ? (s.biasIdx as number) : BIAS_DEFAULT_IDX),
  );
  const stop = BIAS_STOPS[idx];
  const locked = !isBiasLive(s);
  return (
    // The lock state goes on the ROW, never on the input. Every locked rule in base.css reads
    // `.orca-bias-row.is-locked input[type="range"]::…`, so the class has to sit on an
    // ANCESTOR — put it on the input and the thumb quietly comes back. A disabled control with
    // no stated reason is a bug report waiting to happen, so the row says why in its title.
    '<div class="model-think-slider-row orca-bias-row' +
    (locked ? " is-locked" : "") +
    '"' +
    (locked ? ` title="${esc(BIAS_LOCKED_TITLE)}"` : "") +
    ">" +
    '<span class="model-slider-caption">BIAS</span>' +
    // BOTH classes on purpose: `.model-think-slider` carries every track/thumb rule, which is
    // what "same appearance as the effort slider" actually means; `.orca-bias-slider` is only
    // the hook the listeners use to tell the two apart. Nothing may be appended to this
    // attribute — routing-rationale.test.ts asserts it VERBATIM.
    '<input type="range" class="model-think-slider orca-bias-slider" min="0" max="' +
    String(BIAS_STOPS.length - 1) +
    '" step="1" value="' +
    String(idx) +
    '" aria-label="Speed vs intelligence: ' +
    esc(stop.label) +
    '"' +
    (locked ? " disabled" : "") +
    ">" +
    renderBiasStops(idx) +
    "</div>"
  );
}

/** Tick row — mirrors renderSliderStops in app.ts (kept local so this module stays pure). */
function renderBiasStops(activeIdx: number): string {
  let out = '<div class="model-slider-stops">';
  for (let i = 0; i < BIAS_STOPS.length; i++) {
    const cls = i === activeIdx ? "model-slider-stop active" : "model-slider-stop";
    // The stops are absolutely positioned; without an inline `left` they all stack at 0.
    out +=
      `<span class="${cls}" style="left:${eegStopLeftCss(i, BIAS_STOPS.length)}">` +
      `${esc(BIAS_STOPS[i].short)}</span>`;
  }
  return out + "</div>";
}

// Each section states the CHOICE and its WHY — nothing about the standing rule that
// produced it. The policy is fixed, lives in orca-policy.md, and is one click away at the
// foot of the card (the architect 2026-07-25: "should not explain the policy behind it all, which
// is fixed"). Keeping the rule out of here is what makes a badly-routed job visible: the
// line is short enough that a wrong domain or a wrong model jumps out.

/** MODEL — the choice and why it is in force. Pinned ⇒ state it and stop. */
export function modelLine(s: RoutingSignals): string {
  if (s.modelPinned) {
    return `Fixed to <b>${esc(s.modelLabel)}</b>.`;
  }
  const rank =
    typeof s.modelRank === "number" && typeof s.poolSize === "number"
      ? ` — top of the chain (rank ${s.modelRank} of ${s.poolSize})`
      : " — top of the chain";
  return `<b>${esc(s.modelLabel)}</b>${rank}.`;
}

/** EFFORT — the level and the two numbers that produced it. Pinned ⇒ state it and stop. */
export function effortLine(s: RoutingSignals): string {
  if (s.effortPinned && s.effortLabel && s.effortLabel !== "Auto") {
    return `Fixed at <b>${esc(s.effortLabel)}</b>.`;
  }
  const burn = explainBurn(s);
  if (!burn) {
    return `<b>Auto</b> — no weekly quota reading yet.`;
  }
  return (
    `<b>${esc(burn.floor)}</b> — ${pct(burn.weekElapsed)} into the week, ` +
    `${pct(burn.headroom)} of quota unspent.`
  );
}

/** Longest job label we will print. One line per job is the whole point of the section; the
 *  Conductor writes the unit's FULL prompt into `task` (thousands of chars — one 2026-07-27 run
 *  carried 26KB across 8 units), so an unclipped label turned the card into a wall of prompt
 *  text. Clip here, at the only place that renders it. */
const JOB_LABEL_MAX = 72;

/** The job's short name. A `task` that honours the contract (a one-line description) is used
 *  as-is; when it is really a prompt, the unit id — a slug like `panel-render` — is the better
 *  short name, and only if there is no unit do we clip the prompt itself. */
export function jobLabel(r: RouteDecision): string {
  const firstLine = (r.task ?? "").split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (firstLine && firstLine.length <= JOB_LABEL_MAX) {
    return firstLine;
  }
  if (r.unit) {
    return r.unit.length > JOB_LABEL_MAX
      ? `${r.unit.slice(0, JOB_LABEL_MAX - 1).trimEnd()}…`
      : r.unit;
  }
  return firstLine ? `${firstLine.slice(0, JOB_LABEL_MAX - 1).trimEnd()}…` : "job";
}

/** Plain-English gloss of ONE routing call. The domain tag is the WHY — it is the key the
 *  router actually chose on, so a mis-classified job is spotted at a glance. */
export function describeRoute(r: RouteDecision): string {
  const what = esc(jobLabel(r));
  const tag = r.domain ? ` <span class="routing-why-dom">${esc(r.domain)}</span>` : "";
  let body: string;
  if (r.mode === "debate" && r.panel && r.panel.length > 1) {
    const others = r.panel.map(esc).join(", ");
    body = `${what}${tag} — ${others} each answer alone, then <b>${esc(r.model)}</b> picks.`;
  } else if (r.mode === "build-debug" && r.critic) {
    body = `${what}${tag} — <b>${esc(r.model)}</b> does it, <b>${esc(r.critic)}</b> checks it.`;
  } else {
    body = `${what}${tag} — <b>${esc(r.model)}</b> alone.`;
  }
  // The justification hangs off the line as a tooltip rather than taking a second line.
  // My first version put it in a <div>, which doubled the height of every route — exactly
  // the bloat this card exists to avoid. Hover keeps it debuggable at zero vertical cost.
  return r.why ? `<span title="${esc(r.why)}">${body}</span>` : body;
}

/** FAN-OUT — the cap, plus this turn's routing calls if there were any. */
export function fanOutLine(s: RoutingSignals): string {
  const cap =
    typeof s.parallelCap === "number"
      ? `<b>${s.parallelCap} at once</b>` + (s.cores ? ` — cores−2 of ${s.cores}.` : ".")
      : `<b>One agent per job</b>.`;
  const routes = s.routes ?? [];
  if (routes.length === 0) {
    return cap;
  }
  // ONE LINE, always (the architect 2026-07-29: "Fan-out should only be one line"). A <ul> of one
  // <li> per route grew the card without bound on a fan-out, and the `why` note I added
  // earlier today made every route two lines — the opposite of what this card is for.
  //
  // The detail is not dropped, it moves to hover: the full per-route narration (including
  // each router justification) goes in a title attribute, so the line stays scannable while
  // remaining debuggable. A single route — the normal-turn case — reads inline.
  if (routes.length === 1) {
    const r = routes[0];
    return `${cap} ${describeRoute(r)}`;
  }
  const detail = routes
    .map((r) => `${r.unit || "job"}: ${r.model}${r.why ? ` — ${r.why}` : ""}`)
    .join(" · ");
  const domains = [...new Set(routes.map((r) => r.domain).filter(Boolean))].join(", ");
  return (
    `${cap} <b>${routes.length} jobs</b> this turn` +
    (domains ? ` <span class="routing-why-dom">${esc(domains)}</span>` : "") +
    ` <span class="routing-why-more" title="${esc(detail)}">(hover for each)</span>`
  );
}

/** The footer link. the architect 2026-07-26: "swap the 'why these rules?' button with a link to the
 *  actual md, which should open the orca-policy.md". Uses the app's `.fs-link` convention (a
 *  globally delegated click → `config.openExternalFile`), so it opens the REAL file in the
 *  system viewer — the same file orca-policy-drift.test.ts pins against the running code.
 *  A link, not an in-panel copy, means there is no second rendering of the rules to drift. */
export function policyLink(policyPath?: string): string {
  if (!policyPath) {
    return "";
  }
  return (
    '<div class="routing-why-foot">' +
    `<code class="fs-link routing-why-policy" data-path="${esc(policyPath)}" ` +
    'title="Open orca-policy.md">why these rules? \u2197</code>' +
    "</div>"
  );
}

/** ONE line under the dial (2026-09-03): where the dial's position lands on the frontier.
 *  Not a `routing-why-row` — those are the three fixed sections the tests count — and not
 *  the MODEL line, which states the model IN FORCE; this states what THALAMUS WOULD do,
 *  which is the only thing the dial changes. Empty when the caller had no priced rungs. */
export function frontierLine(s: RoutingSignals): string {
  const p = s.frontierPick;
  if (!p) {
    return "";
  }
  return (
    '<div class="routing-why-frontier">THALAMUS would route → <b>' +
    esc(p.model) +
    "</b>" +
    (p.effort ? ` @${esc(p.effort)}` : "") +
    ` · idx ${p.smart.toFixed(1)} · €${Number(p.cost.toPrecision(3))}/task` +
    ` (frontier of ${p.frontierSize} rungs)</div>`
  );
}

/** The ORCA card: the fast↔smart dial, the frontier line, then this turn's three choices,
 *  then the policy link. */
export function renderRoutingRationale(s: RoutingSignals): string {
  const row = (key: string, text: string): string =>
    `<div class="routing-why-row"><span class="routing-why-key">${key}</span>` +
    `<span class="routing-why-text">${text}</span></div>`;
  return (
    renderBiasSlider(s) +
    '<div class="routing-why">' +
    frontierLine(s) +
    row("MODEL", modelLine(s)) +
    row("EFFORT", effortLine(s)) +
    row("FAN-OUT", fanOutLine(s)) +
    policyLink(s.policyPath) +
    "</div>"
  );
}
