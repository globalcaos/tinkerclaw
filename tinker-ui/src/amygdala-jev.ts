import { renderMarker } from "./amygdala-cards.js";
import {
  DID_WORD,
  esc,
  fmtAnswer,
  fmtClock,
  fmtClockS,
  fmtDuration,
  GLYPH,
} from "./amygdala-html.js";
/**
 * Jev in the chat: after each reply, at most two windows in TypeSafe's look (design block 5b, §9.2), deliberately foreign
 * to the theme. the architect 2026-10-05: "two kinds of messages, one with a summary of the checks it performed, which should
 * expand into a nice diagram of what it did and when ... and another type of entry ... with actions it would have taken,
 * for me to revise."
 *
 * 1. CHECKS: one line, collapsed by default. Opened, a check timeline in the call timeline's encoding
 *    (context-window-panel.md §5.3): one equal-width column per step, the checks made before the step stacked above the
 *    axis and the checks made after it below, coloured by what code did with the answer. A click on a column lists that
 *    step's answers, each with its probability, latency and 👍/👎.
 * 2. WOULD HAVE: the actions Jev would have taken (took, when enforcing), one row each with its step, its reasons and the
 *    vote. Open by default, because it is there to be reviewed. A card that waits for an answer (enforce mode), the refusal
 *    offer (Rewind, retry) and the Rewound line ride on their action's row.
 *
 * Pure HTML-string builders; app.ts handles the `data-amy-act` attributes by delegation. A question's wording never
 * appears: names, ids, versions and answers only.
 */
import type { CodeDid, InterventionView, JevDecision, TurnView } from "./amygdala-types.js";

type Change = Exclude<CodeDid, "ok">;

/** What a change is, said as a person would: shadow ("would have") and enforced. */
const CHANGE_WORDS: Record<Change, [string, string]> = {
  held: ["Would have held this step", "Held this step"],
  proof: ["Would have asked for proof before this step", "Asked for proof before this step"],
  ask: ["Would have asked you before this step", "Asked you before this step"],
  note: ["Would have added a note for the agent", "Added a note for the agent"],
  "sent-back": [
    "Would have sent the reply back to be finished",
    "Sent the reply back to be finished",
  ],
  refusal: ["Would have marked the reply as a refusal", "Marked the reply as a refusal"],
};

/** Counted in the WOULD HAVE line: singular, plural. */
const COUNT_WORDS: Record<Change, [string, string]> = {
  held: ["held", "held"],
  proof: ["proof check", "proof checks"],
  "sent-back": ["sent back", "sent back"],
  note: ["note", "notes"],
  ask: ["question", "questions"],
  refusal: ["refusal", "refusals"],
};

/** Strongest first: the colour a step's axis mark takes when it holds more than one change. */
const SEVERITY: Change[] = ["refusal", "held", "sent-back", "proof", "ask", "note"];

const IV_DID: Record<InterventionView["kind"], Change> = {
  hold: "held",
  proof: "proof",
  ask: "ask",
  note: "note",
  "send-back": "sent-back",
  refusal: "refusal",
};

/** The cube mark on the magenta disc, lifted from the design page. */
const CUBE_SVG =
  '<span class="amy-jev-disc"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1E1E1E" stroke-width="2.6" stroke-linejoin="miter"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12 3 7M12 12l9-5M12 12v10"/></svg></span>';

/** The pill's class, and the colour class of a cell in the timeline. */
const PILL_CLASS: Record<CodeDid, string> = {
  ok: "ok",
  held: "held",
  proof: "note",
  note: "note",
  ask: "note",
  "sent-back": "back",
  refusal: "refusal",
};

function bar(
  act: string,
  runKey: string,
  kind: string,
  kindCls: string,
  summary: string,
  open: boolean | null,
): string {
  const attrs = act ? ` data-amy-act="${act}" data-run="${esc(runKey)}"` : "";
  const twisty = open === null ? "" : `<span class="amy-jtw">${open ? "▾" : "▸"}</span>`;
  return (
    `<div class="amy-jev-bar"${attrs}>${CUBE_SVG}<span class="amy-jttl">JEV</span>` +
    `<span class="amy-jkind${kindCls ? ` ${kindCls}` : ""}">${esc(kind)}</span>` +
    `<span class="amy-jsm">${esc(summary)}</span>${twisty}</div>`
  );
}

// ─── CHECKS ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One column of the timeline: a tool call (its pre and post checks), the prompt, or the stop. */
export interface JevStep {
  label: string;
  ts: number;
  toolUseId?: string;
  /** Checks made before the step ran (prompt and pre-tool seams). */
  before: JevDecision[];
  /** Checks made after it (post-tool and stop seams). */
  after: JevDecision[];
}

const isBefore = (d: JevDecision): boolean => d.seam === "prompt" || d.seam === "pre-tool";

/**
 * The steps of a reply in time order. A tool call's checks share its tool use id, even when parallel calls interleave;
 * without one, consecutive checks on the same step label share a column, except that a check made before a step never
 * joins a column that already has checks made after it (the same command run twice is two steps).
 */
export function stepsOf(decisions: JevDecision[]): JevStep[] {
  const out: JevStep[] = [];
  const byTool = new Map<string, JevStep>();
  for (const d of [...decisions].sort((a, b) => a.ts - b.ts)) {
    const before = isBefore(d);
    let s = d.toolUseId ? byTool.get(d.toolUseId) : undefined;
    if (!s && !d.toolUseId) {
      const last = out[out.length - 1];
      if (last && !last.toolUseId && last.label === d.stepLabel && !(before && last.after.length))
        s = last;
    }
    if (!s) {
      s = { label: d.stepLabel, ts: d.ts, before: [], after: [] };
      if (d.toolUseId) {
        s.toolUseId = d.toolUseId;
        byTool.set(d.toolUseId, s);
      }
      out.push(s);
    }
    (before ? s.before : s.after).push(d);
  }
  return out;
}

function worstOf(ds: JevDecision[]): Change | undefined {
  return SEVERITY.find((k) => ds.some((d) => d.codeDid === k));
}

/** Changes touch the axis, the quiet answers stack beyond them; each group in time order. */
function stackOrder(ds: JevDecision[]): JevDecision[] {
  return [...ds.filter((d) => d.codeDid !== "ok"), ...ds.filter((d) => d.codeDid === "ok")];
}

const VB_W = 520;
const LANE = 40;
const AX = 8;
const TL_H = LANE * 2 + AX;
const n2 = (v: number): number => Math.round(v * 100) / 100;

function stepTitle(s: JevStep): string {
  const worst = worstOf([...s.before, ...s.after]);
  return (
    `${s.label}\n${fmtClockS(s.ts)} · ${s.before.length} before it ran, ${s.after.length} after` +
    (worst ? ` · ${DID_WORD[worst]}` : "")
  );
}

/** The timeline drawing: rectangles only, so it may stretch to the window's width without distorting text. */
export function renderTimelineSvg(runKey: string, steps: JevStep[], selected?: number): string {
  const n = steps.length;
  if (n === 0) return "";
  const colW = VB_W / n;
  const maxStack = Math.max(1, ...steps.map((s) => Math.max(s.before.length, s.after.length)));
  const unit = Math.min(8, LANE / maxStack);
  const gapY = unit >= 4 ? 1 : 0;
  const w = n2(Math.max(colW - (colW >= 4 ? 1 : 0), 0.5));
  const cell = (x: number, y: number, d: JevDecision): string =>
    `<rect class="amy-tc amy-tc-${PILL_CLASS[d.codeDid]}${d.cacheHit ? " amy-cached" : ""}" x="${n2(x)}" y="${n2(y)}" width="${w}" height="${n2(Math.max(unit - gapY, 0.5))}"/>`;
  const parts: string[] = [];
  if (selected !== undefined && selected >= 0 && selected < n)
    parts.push(
      `<rect class="amy-tsel" x="${n2(selected * colW)}" y="0" width="${n2(colW)}" height="${TL_H}"/>`,
    );
  parts.push(
    `<line class="amy-tax" x1="0" x2="${VB_W}" y1="${LANE + AX / 2}" y2="${LANE + AX / 2}" vector-effect="non-scaling-stroke"/>`,
  );
  steps.forEach((s, i) => {
    const x = i * colW;
    stackOrder(s.before).forEach((d, k) => parts.push(cell(x, LANE - (k + 1) * unit, d)));
    stackOrder(s.after).forEach((d, k) => parts.push(cell(x, LANE + AX + k * unit, d)));
    const worst = worstOf([...s.before, ...s.after]);
    if (worst)
      parts.push(
        `<rect class="amy-tmark amy-tc-${PILL_CLASS[worst]}" x="${n2(x)}" y="${LANE + 1}" width="${w}" height="${AX - 2}"/>`,
      );
  });
  const k = esc(runKey);
  steps.forEach((s, i) =>
    parts.push(
      `<rect class="amy-tcol" data-amy-act="jev-col" data-run="${k}" data-col="${i}" x="${n2(i * colW)}" y="0" width="${n2(colW)}" height="${TL_H}"><title>${esc(stepTitle(s))}</title></rect>`,
    ),
  );
  return (
    `<svg class="amy-tl" viewBox="0 0 ${VB_W} ${TL_H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="${esc(`Check timeline: ${n} ${n === 1 ? "step" : "steps"}`)}">${parts.join("")}</svg>`
  );
}

function pct(x: number): number {
  return Math.max(0, Math.min(100, Math.round((Number.isFinite(x) ? x : 0) * 100)));
}

function labelButton(d: JevDecision, value: "1" | "-1", glyph: string): string {
  return `<button class="amy-lab" data-amy-act="label" data-target-id="${esc(d.id)}" data-target-kind="verdict" data-kind="useful" data-value="${value}">${glyph}</button>`;
}

/** One answer of a step, opened on click: probability, confidence, version, latency and the 👍/👎 on the answer. */
export function renderRow(turnId: string, d: JevDecision, openRows: ReadonlySet<string>): string {
  const cls = PILL_CLASS[d.codeDid];
  const weak = d.weak ? '<span class="amy-jw" title="rests on inferred fields">~</span>' : "";
  const degraded = d.degraded ? '<span class="amy-jx" title="judge degraded">!</span>' : "";
  const row =
    `<div class="amy-jr" data-amy-act="jev-row" data-turn="${esc(turnId)}" data-id="${esc(d.id)}">` +
    `<span class="amy-jg">${GLYPH[d.codeDid]}</span>` +
    `<span class="amy-jq">${esc(d.questionName)}${weak}${degraded}</span>` +
    `<span class="amy-ja">${esc(fmtAnswer(d))}</span>` +
    `<span class="amy-jo ${cls}">${esc(DID_WORD[d.codeDid])}</span></div>`;
  const meta = [`${Math.round(d.latencyMs)} ms`];
  if (d.cacheHit) meta.push("cached");
  const detail =
    `<div class="amy-jd${openRows.has(d.id) ? " amy-show" : ""}">` +
    `<span class="amy-prob"><i style="width:${pct(d.prob)}%"></i></span>` +
    `${esc(d.prob.toFixed(2))} · confidence ${esc(d.confidence.toFixed(2))} · <span class="amy-mt">question</span> ${esc(d.questionId)} v${esc(d.version)}<br>` +
    `${esc(meta.join(" · "))}<br>` +
    `<span class="amy-mt">read by:</span> code did ${esc(DID_WORD[d.codeDid])} ` +
    `${labelButton(d, "1", "👍")}${labelButton(d, "-1", "👎")}</div>`;
  return row + detail;
}

function stepDetail(s: JevStep, openRows: ReadonlySet<string>): string {
  const seam = (title: string, ds: JevDecision[]): string =>
    ds.length
      ? `<div class="amy-tseam">${esc(title)}</div>` +
        ds.map((d) => renderRow(d.turnId, d, openRows)).join("")
      : "";
  return (
    `<div class="amy-tdet"><div class="amy-jstep"><span class="amy-mt">├ ${esc(s.label)} · ${esc(fmtClockS(s.ts))}</span></div>` +
    seam("before it ran", s.before) +
    seam("after it ran", s.after) +
    `</div>`
  );
}

/** "99 checks · 31 steps · 09:38–09:52". */
export function checksSummary(decisions: JevDecision[]): string {
  const n = decisions.length;
  const steps = stepsOf(decisions).length;
  const ts = decisions.map((d) => d.ts);
  const a = fmtClock(Math.min(...ts));
  const b = fmtClock(Math.max(...ts));
  return (
    `${n} ${n === 1 ? "check" : "checks"} · ${steps} ${steps === 1 ? "step" : "steps"} · ` +
    (a === b ? a : `${a}–${b}`)
  );
}

export interface JevChecksOptions {
  open: boolean;
  /** The step column the owner clicked; its answers are listed under the timeline. */
  col?: number;
  openRows: ReadonlySet<string>;
  /** Steps of this reply the judge was not asked about (the hard rules alone ran). */
  rulesOnly?: number;
}

const LEGEND: [string, string][] = [
  ["ok", "ok"],
  ["note", "note · proof · ask"],
  ["held", "held"],
  ["back", "sent back"],
  ["refusal", "refusal"],
];

/** The CHECKS window for one reply; "" when Jev answered nothing in it. */
export function renderJevChecks(
  runKey: string,
  decisions: JevDecision[],
  o: JevChecksOptions,
): string {
  if (decisions.length === 0) return "";
  const steps = stepsOf(decisions);
  const n = decisions.length;
  const col = o.col !== undefined && o.col >= 0 && o.col < steps.length ? o.col : undefined;
  const first = steps[0]!.ts;
  const last = Math.max(...decisions.map((d) => d.ts));
  const maxBefore = Math.max(...steps.map((s) => s.before.length));
  const maxAfter = Math.max(...steps.map((s) => s.after.length));
  const head =
    `<div class="amy-thead"><b>CHECK TIMELINE</b><span>${steps.length} ${steps.length === 1 ? "step" : "steps"} · ` +
    `${esc(fmtClockS(first))} → ${esc(fmtClockS(last))} · ${esc(fmtDuration(last - first))}</span></div>`;
  const lanes =
    `<div class="amy-tlanes"><span class="amy-tcap amy-tcap-top">before it ran ↑ ${maxBefore}</span>` +
    `<span class="amy-tcap amy-tcap-bot">after it ran ↓ ${maxAfter}</span>` +
    `${renderTimelineSvg(runKey, steps, col)}</div>`;
  const mid =
    steps.length > 2
      ? `<span>${esc(fmtClockS(steps[Math.floor(steps.length / 2)]!.ts))}</span>`
      : "";
  const ticks =
    steps.length > 1
      ? `<div class="amy-tticks"><span>${esc(fmtClockS(first))}</span>${mid}<span>${esc(fmtClockS(steps[steps.length - 1]!.ts))}</span></div>`
      : "";
  // The legend lists what the drawing painted, the call timeline's rule.
  const present = new Set(decisions.map((d) => PILL_CLASS[d.codeDid]));
  const cachedN = decisions.filter((d) => d.cacheHit).length;
  const legend =
    `<div class="amy-tleg">` +
    LEGEND.filter(([cls]) => present.has(cls))
      .map(([cls, text]) => `<span><i class="amy-tc-${cls}"></i>${esc(text)}</span>`)
      .join("") +
    (cachedN ? `<span><i class="amy-tc-ok amy-cached"></i>cached</span>` : "") +
    `<span class="amy-tleg-r">columns are steps in order, not equal times</span></div>`;
  const detail =
    col !== undefined
      ? stepDetail(steps[col]!, o.openRows)
      : `<div class="amy-thint">Click a column to see that step's checks.</div>`;
  const judgeMs = decisions.filter((d) => !d.cacheHit).reduce((t, d) => t + d.latencyMs, 0);
  const rulesOnly = o.rulesOnly
    ? ` · ${o.rulesOnly} ${o.rulesOnly === 1 ? "step" : "steps"} on the hard rules only`
    : "";
  const k = esc(runKey);
  return (
    `<div class="amy-jev amy-jev-checks${o.open ? " amy-open" : ""}" data-run="${k}">` +
    bar("jev-toggle", runKey, "checks", "", checksSummary(decisions), o.open) +
    `<div class="amy-jev-body">${head}${lanes}${ticks}${legend}${detail}` +
    `<div class="amy-jft">${n} ${n === 1 ? "check" : "checks"} · ${cachedN} cached · judge ${esc(fmtDuration(judgeMs))}${esc(rulesOnly)}</div>` +
    `</div></div>`
  );
}

/** The one-line CHECKS window when Jev was not asked (design §9.2). */
export function renderJevNotConsulted(
  runKey: string,
  reason: "real-steps-stay-local" | "judge-down",
): string {
  const text =
    reason === "real-steps-stay-local"
      ? "not consulted (real steps stay local) · rules only"
      : "unreachable · judge checks skipped";
  return (
    `<div class="amy-jev amy-jev-checks amy-jev-off" data-run="${esc(runKey)}">` +
    bar("", runKey, "checks", "", text, null) +
    `</div>`
  );
}

// ─── WOULD HAVE ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One action: a decision that changed something, or an intervention no judge answer explains (a hard rule). */
export interface JevAction {
  key: string;
  did: Change;
  turnId: string;
  ts: number;
  step: string;
  /** The judge's answers that drove it. */
  reasons: JevDecision[];
  /** The intervention's chips (the rules), shown when no judge answer drove it. */
  chips: string[];
  iv?: InterventionView;
}

/** The actions of the given turns in time order: one per decision (its driving answers grouped), then lone interventions. */
export function actionsOf(turns: TurnView[]): JevAction[] {
  const out: JevAction[] = [];
  for (const t of turns) {
    const byKey = new Map<string, JevAction>();
    for (const d of t.decisions) {
      if (d.codeDid === "ok") continue;
      const key =
        d.decisionId ?? d.interventionId ?? `${d.stepLabel}|${d.seam}|${d.codeDid}|${d.ts}`;
      const a = byKey.get(key);
      if (a) a.reasons.push(d);
      else
        byKey.set(key, {
          key,
          did: d.codeDid,
          turnId: t.turnId,
          ts: d.ts,
          step: d.stepLabel,
          reasons: [d],
          chips: [],
        });
    }
    const used = new Set<string>();
    for (const a of byKey.values()) {
      const first = a.reasons[0]!;
      const iv = t.interventions.find(
        (i) =>
          (first.decisionId !== undefined && i.decisionId === first.decisionId) ||
          (first.interventionId !== undefined && i.id === first.interventionId),
      );
      if (iv) {
        a.iv = iv;
        used.add(iv.id);
      }
      out.push(a);
    }
    for (const iv of t.interventions) {
      if (used.has(iv.id)) continue;
      out.push({
        key: iv.id,
        did: IV_DID[iv.kind] ?? "note",
        turnId: t.turnId,
        ts: iv.ts,
        step: iv.cmd ?? "",
        reasons: [],
        chips: iv.chips,
        iv,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** "4 to review: 1 sent back · 3 notes", or "nothing to review". */
export function actionsSummary(actions: JevAction[]): string {
  if (actions.length === 0) return "nothing to review";
  const parts: string[] = [];
  for (const k of ["held", "proof", "sent-back", "note", "ask", "refusal"] as const) {
    const c = actions.filter((a) => a.did === k).length;
    if (c > 0) parts.push(`${c} ${COUNT_WORDS[k][c === 1 ? 0 : 1]}`);
  }
  return `${actions.length} to review: ${parts.join(" · ")}`;
}

export interface JevActionsOptions {
  open: boolean;
  /** Votes already given this session, by target id (1 or -1). */
  votes?: ReadonlyMap<string, number>;
  /** Shadow mode words an action as "would have" (default true). */
  shadow?: boolean;
  /** Markup that rides on an action's row: a card waiting for an answer, the refusal offer, the Rewound line. */
  extra?: (a: JevAction) => string;
}

/** A vote targets the decision when there is one, else the first answer; a lone rule with no decision has no vote. */
function voteTarget(a: JevAction): { id: string; kind: "decision" | "verdict" } | undefined {
  const first = a.reasons[0];
  if (first?.decisionId) return { id: first.decisionId, kind: "decision" };
  if (first) return { id: first.id, kind: "verdict" };
  if (a.iv?.decisionId) return { id: a.iv.decisionId, kind: "decision" };
  return undefined;
}

function renderAction(a: JevAction, o: JevActionsOptions): string {
  const target = voteTarget(a);
  const voted = target ? o.votes?.get(target.id) : undefined;
  const vote = (value: 1 | -1, text: string): string =>
    `<button class="amy-jvote${voted === value ? " amy-voted" : ""}" data-amy-act="label" data-target-id="${esc(target!.id)}" ` +
    `data-target-kind="${target!.kind}" data-kind="useful" data-value="${value}">${text}</button>`;
  const votes = target
    ? `<div class="amy-ja-votes" title="Was that the right call?">${vote(1, "👍 right call")}${vote(-1, "👎 wrong call")}</div>`
    : "";
  const why = a.reasons.length
    ? `<span class="amy-mt">because Jev answered</span> ` +
      a.reasons.map((d) => `<b>${esc(d.questionName)}</b> → ${esc(fmtAnswer(d))}`).join(" · ")
    : a.chips.length
      ? `<span class="amy-mt">because of the rules</span> ${a.chips.map((c) => esc(c)).join(" · ")}`
      : "";
  const extra = o.extra?.(a) ?? "";
  return (
    `<div class="amy-jact" data-turn="${esc(a.turnId)}" data-action="${esc(a.key)}"><div class="amy-ja-main">` +
    `<div class="amy-jc-head"><span class="amy-jg">${GLYPH[a.did]}</span>` +
    `<span class="amy-jo ${PILL_CLASS[a.did]}">${esc(DID_WORD[a.did])}</span>` +
    `<b>${esc(CHANGE_WORDS[a.did][o.shadow === false ? 1 : 0])}</b>` +
    `<span class="amy-ja-time">${esc(fmtClock(a.ts))}</span></div>` +
    (a.step
      ? `<div class="amy-jc-step"><span class="amy-mt">step</span> ${esc(a.step)}</div>`
      : "") +
    (why ? `<div class="amy-jc-why">${why}</div>` : "") +
    `</div>${votes}` +
    (extra ? `<div class="amy-ja-extra">${extra}</div>` : "") +
    `</div>`
  );
}

/** The WOULD HAVE window for one reply; "" when Jev would have changed nothing in it. */
export function renderJevActions(runKey: string, turns: TurnView[], o: JevActionsOptions): string {
  const actions = actionsOf(turns);
  const markers = turns.flatMap((t) => t.markers);
  if (actions.length === 0 && markers.length === 0) return "";
  const kind = o.shadow === false ? "acted" : "would have";
  const rows = actions.map((a) => renderAction(a, o)).join("");
  const marks = markers.map((m) => renderMarker(m)).join("");
  return (
    `<div class="amy-jev amy-jev-act${o.open ? " amy-open" : ""}" data-run="${esc(runKey)}">` +
    bar("jev-act-toggle", runKey, kind, "amy-jkind-act", actionsSummary(actions), o.open) +
    `<div class="amy-jev-body">${rows}${marks}</div></div>`
  );
}
