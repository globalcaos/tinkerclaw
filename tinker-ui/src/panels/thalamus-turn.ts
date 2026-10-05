/**
 * THALAMUS — the present turn, and nothing else (the architect, 2026-10-01).
 *
 * "The thalamus panel gives too much information right now, let's simplify it all. It should only contain information
 * about the present turn's model/effort decisions. I want to know the models/efforts involved, and if a different
 * model/effort was chosen due to either censorship or best-of on a particular task. Also, I would like to know if
 * different models cooperated in a particular turn, and which part did each do."
 *
 * So the card answers three questions about ONE turn, the one running or the last one that ran:
 *   1. PICKED — what Thalamus chose and why (the gateway's own decision, `stream:"thalamus"`, see
 *      src/infra/thalamus-turn-telemetry.ts): the dial tier, best-of a domain, a tier default, censorship.
 *   2. WHO DID WHAT — every model that worked on the turn, at what effort, doing which part (main reply, a
 *      subagent's task, a model that took over after a failure), with a bar for how much of the turn it did and a
 *      pulse while it is still running. The rows come from the same samples the EEG draws, so the card and the trace
 *      below it can never disagree.
 *   3. NOTHING TO DECIDE — with the model AND the effort fixed by hand, Thalamus does nothing, and the panel says so
 *      in its title and stays folded (app.ts owns the fold).
 *
 * PURE: no DOM, no clock, no network. app.ts hands in the snapshot, the decision and a model-name formatter.
 */
import type { EegSample, EegTurnEnd } from "./eeg-trace.js";

export interface ThalamusTurnDecision {
  at: number;
  model: string;
  effort: string;
  tier: string;
  why: string[];
  instead?: { model: string; effort: string };
  /** The stop's suggestion: kept, or moved and why (full deploy, 2026-10-02). */
  suggestion?: {
    state: "kept" | "moved";
    model: string;
    effort: string;
    cause?: "better" | "cooling" | "spent" | "unfunded" | "capacity" | "engagement";
    gainPct?: number;
  };
  /** A cooling supply changed the pick; `untilMs` is when it reopens (absent when no reset is known). */
  cooling?: { from: { model: string; effort: string }; supply: string; untilMs?: number };
  declined: { model: string; detail: string }[];
  domain: string;
  subject: string;
  mode: string;
  panel: string[];
  chair?: string;
}

export interface ThalamusTurnFallback {
  at: number;
  from: string;
  to: string;
  reason: string;
}

export interface TurnMember {
  runId: string;
  model: string;
  provider: string;
  /** Effort the run executed at; "" when the model reported none. */
  effort: string;
  role: "main" | "subagent";
  /** What a subagent was asked to do. */
  task?: string;
  tokens: number;
  running: boolean;
  startedAt: number;
}

export interface ThalamusTurnView {
  /** True while some run of the turn has not ended. */
  live: boolean;
  /** When the turn began (the end of the previous one), 0 when unknown. */
  since: number;
  members: TurnMember[];
  tools: number;
  decision?: ThalamusTurnDecision;
  fallbacks: ThalamusTurnFallback[];
}

/** The turn to show: the one in flight, else the last finished one. Samples of older turns are not this turn. */
export function presentTurnSamples(
  samples: readonly EegSample[],
  ends: readonly EegTurnEnd[],
): { samples: EegSample[]; since: number; live: boolean } {
  const endTimes = ends.map((e) => e.endedAt).sort((a, b) => a - b);
  const last = endTimes.length ? endTimes[endTimes.length - 1] : 0;
  const prev = endTimes.length > 1 ? endTimes[endTimes.length - 2] : 0;
  const after = samples.filter((s) => s.startedAt > last);
  if (after.length > 0) {
    return { samples: after, since: last, live: after.some((s) => s.endedAt === undefined) };
  }
  const lastTurn = samples.filter((s) => s.startedAt > prev && s.startedAt <= last);
  return { samples: lastTurn, since: prev, live: false };
}

export function buildThalamusTurnView(
  snapshot: { samples: readonly EegSample[]; ends: readonly EegTurnEnd[] },
  turn: { decision?: ThalamusTurnDecision; fallbacks: readonly ThalamusTurnFallback[] } | undefined,
): ThalamusTurnView {
  const { samples, since, live } = presentTurnSamples(snapshot.samples, snapshot.ends);
  const members: TurnMember[] = samples
    .filter((s) => !s.tool)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => ({
      runId: s.runId,
      model: s.model,
      provider: s.provider,
      effort: s.chosenLevel,
      role: s.subagent ? "subagent" : "main",
      ...(s.subagent && s.label ? { task: s.label } : {}),
      tokens: (s.outputTokens ?? 0) + (s.inputTokens ?? 0),
      running: s.endedAt === undefined,
      startedAt: s.startedAt,
    }));
  const tools = samples.filter((s) => s.tool).length;
  // A decision belongs to this turn only if it was made after the previous turn ended.
  const decision = turn?.decision && turn.decision.at > since ? turn.decision : undefined;
  const fallbacks = (turn?.fallbacks ?? []).filter((f) => f.at > since);
  return { live, since, members, tools, ...(decision ? { decision } : {}), fallbacks };
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const EFFORT_WORD: Record<string, string> = {
  "": "auto",
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  adaptive: "auto",
};
export const effortWord = (lvl: string): string => EFFORT_WORD[lvl] ?? lvl;

const DOMAIN_WORD: Record<string, string> = {
  code: "code",
  frontend: "front-end work",
  agentic: "agent work",
  data: "data work",
  maths: "maths",
  science: "science",
  reason: "reasoning",
  write: "writing",
  languages: "languages",
  psych: "people questions",
  instruct: "following instructions",
  context: "long context",
  vision: "images",
  factual: "facts",
  world: "world knowledge",
};

const FAILOVER_WORD: Record<string, string> = {
  rate_limit: "hit its rate limit",
  overloaded: "was overloaded",
  timeout: "timed out",
  billing: "had no credit",
  auth: "failed to sign in",
  auth_permanent: "failed to sign in",
  format: "sent a malformed reply",
  model_not_found: "was not found",
  session_expired: "lost its session",
  empty_response: "answered nothing",
};

export interface ThalamusTurnRenderOpts {
  /** Friendly model name ("Opus 5"). */
  modelName: (id: string) => string;
  /** Provider brand colour for a row's bar. */
  colorOf: (model: string, provider: string) => string;
  /** "16:20" for an epoch ms, in the reader's own time. Absent: local hours and minutes. */
  clock?: (ms: number) => string;
}

const localClock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const MOVED_CAUSE: Record<string, string> = {
  capacity: "it does not fit this job",
  engagement: "it declines this subject",
  unfunded: "it has no credit",
};

/** The "why" chips of the decision, in plain words. */
export function whyPhrases(d: ThalamusTurnDecision, o: ThalamusTurnRenderOpts): string[] {
  const out: string[] = [];
  const instead = d.instead
    ? `${o.modelName(d.instead.model)}${d.instead.effort ? ` · ${effortWord(d.instead.effort)}` : ""}`
    : "";
  for (const w of d.why) {
    if (w === "best-of") {
      const dom = DOMAIN_WORD[d.domain] ?? d.domain;
      out.push(`best at ${dom}${instead ? `, instead of ${instead}` : ""}`);
    } else if (w === "tier-default") {
      out.push(`your ${d.tier} default${instead ? `, instead of ${instead}` : ""}`);
    } else if (w === "kept") {
      out.push(`kept your ${d.tier} suggestion`);
    } else if (w === "moved") {
      const sg = d.suggestion;
      const cause =
        sg?.cause === "better"
          ? `${DOMAIN_WORD[d.domain] ?? d.domain} is better served here${sg.gainPct ? ` (+${Math.round(sg.gainPct)} %)` : ""}`
          : (MOVED_CAUSE[sg?.cause ?? ""] ?? "");
      out.push(
        `moved off your ${d.tier} suggestion${instead ? ` (${instead})` : ""}${cause ? `: ${cause}` : ""}`,
      );
    } else if (w === "cooling") {
      const c = d.cooling;
      const from = c ? o.modelName(c.from.model) : instead;
      const until = c?.untilMs ? ` until ${(o.clock ?? localClock)(c.untilMs)}` : "";
      out.push(`${from ? `${from} is` : "the supply is"} cooling${until}, so the next best runs`);
    } else if (w === "censorship") {
      const who = [...new Set(d.declined.map((x) => o.modelName(x.model.split("@")[0])))].join(
        ", ",
      );
      const what = d.subject && d.subject !== "none" ? `${d.subject} questions` : "this subject";
      out.push(`skipped ${who}: it declines ${what}`);
    } else if (w === "bias") {
      out.push(`${d.tier} dial`);
    }
  }
  return out;
}

/** Plain words for a planned cooperation (debate, build and review, fan-out); "" for a solo turn. */
export function planPhrase(d: ThalamusTurnDecision, o: ThalamusTurnRenderOpts): string {
  if (!d.mode || d.mode === "solo") return "";
  const names = d.panel.map((m) => o.modelName(m));
  const chair = d.chair ? `, ${o.modelName(d.chair)} decides` : "";
  if (d.mode === "debate") return `planned a debate: ${names.join(" + ")}${chair}`;
  if (d.mode === "build-debug") return `planned build and review: ${names.join(" + ")}${chair}`;
  if (d.mode === "fan-out")
    return `planned a fan-out on ${names.join(", ") || "one leaf model"}${chair}`;
  return `planned ${d.mode}: ${names.join(" + ")}${chair}`;
}

/** The whole card body. `idle` (model and effort both fixed by hand) draws one quiet line. */
export function renderThalamusTurn(
  view: ThalamusTurnView,
  o: ThalamusTurnRenderOpts & { idle: boolean; modelPinned: boolean },
): string {
  if (o.idle) {
    return '<div class="thal-turn thal-idle">Model and effort are fixed by you, so Thalamus has nothing to decide.</div>';
  }
  const parts: string[] = [];
  const d = view.decision;
  if (d) {
    const eff = d.effort ? ` · ${esc(effortWord(d.effort))}` : "";
    const why = whyPhrases(d, o)
      .map((w) => `<span class="thal-why">${esc(w)}</span>`)
      .join("");
    parts.push(
      `<div class="thal-pick"><span class="thal-k">picked</span><b>${esc(o.modelName(d.model))}${eff}</b>${why}</div>`,
    );
    const plan = planPhrase(d, o);
    if (plan) parts.push(`<div class="thal-plan">${esc(plan)}</div>`);
  } else if (o.modelPinned) {
    parts.push(
      '<div class="thal-pick"><span class="thal-k">model</span>fixed by you · Thalamus sets the effort</div>',
    );
  } else if (view.members.length === 0) {
    parts.push('<div class="thal-pick thal-wait">Waiting for the next turn.</div>');
  }
  for (const f of view.fallbacks) {
    const why = FAILOVER_WORD[f.reason] ?? f.reason.replace(/_/g, " ");
    parts.push(
      `<div class="thal-fallback">${esc(o.modelName(f.to))} took over: ${esc(o.modelName(f.from))} ${esc(why)}</div>`,
    );
  }
  if (view.members.length > 0) {
    const max = Math.max(1, ...view.members.map((m) => m.tokens));
    const distinct = new Set(view.members.map((m) => m.model)).size;
    const head =
      distinct > 1 ? `${distinct} models worked on this turn` : view.live ? "working" : "this turn";
    const rows = view.members
      .map((m) => {
        const pct = m.tokens > 0 ? Math.max(3, Math.round((m.tokens / max) * 100)) : 3;
        const part = m.role === "main" ? "main reply" : m.task ? m.task : "subagent";
        const tok = fmtTokens(m.tokens);
        return (
          `<div class="thal-row${m.running ? " is-running" : ""}" title="${esc(m.model)}">` +
          `<span class="thal-who">${esc(o.modelName(m.model))}<i>${esc(effortWord(m.effort))}</i></span>` +
          `<span class="thal-part">${esc(part)}</span>` +
          `<span class="thal-tok">${tok ? esc(tok) : ""}</span>` +
          `<span class="thal-bar"><span style="width:${pct}%;background:${esc(o.colorOf(m.model, m.provider))}"></span></span>` +
          "</div>"
        );
      })
      .join("");
    const tools =
      view.tools > 0
        ? `<div class="thal-tools">+ ${view.tools} tool call${view.tools === 1 ? "" : "s"}</div>`
        : "";
    parts.push(
      `<div class="thal-team"><div class="thal-team-head">${esc(head)}</div>${rows}${tools}</div>`,
    );
  }
  return `<div class="thal-turn${view.live ? " is-live" : ""}">${parts.join("")}</div>`;
}
