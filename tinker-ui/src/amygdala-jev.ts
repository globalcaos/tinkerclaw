import { DID_WORD, esc, fmtAnswer, GLYPH } from "./amygdala-html.js";
/**
 * The Jev window (design block 5b, §9.2): a deliberately foreign-looking, collapsed-by-default window in the chat.
 * Opened, it shows first what the amygdala would have changed in the turn, one card per decision with its step, its
 * reasons and the votes in view; every other answered question sits in a folded section below (the architect 2026-10-02:
 * "keep only the things that Jarvis would have changed, clearly so I can evaluate"). Pure HTML-string builders; app.ts handles the
 * `data-amy-act` attributes by delegation. A question's wording never appears: names, ids, versions and answers only.
 */
import type { CodeDid, JevDecision, TurnView } from "./amygdala-types.js";

export interface JevWindowOptions {
  open: boolean;
  openRows: ReadonlySet<string>;
  now?: number;
  /** The "answers that changed nothing" section is unfolded. */
  othersOpen?: boolean;
  /** Votes already given this session, by target id (1 or -1). */
  votes?: ReadonlyMap<string, number>;
  /** Shadow mode words a change as "would have" (default true). */
  shadow?: boolean;
}

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

interface ChangeGroup {
  did: Change;
  label: string;
  reasons: JevDecision[];
}

/** The would-be changes of a turn, one per decision (its driving answers grouped), in order. */
export function changesOf(decisions: JevDecision[]): ChangeGroup[] {
  const byKey = new Map<string, ChangeGroup>();
  for (const d of decisions) {
    if (d.codeDid === "ok") continue;
    const key = d.decisionId ?? d.interventionId ?? `${d.stepLabel}|${d.seam}|${d.codeDid}|${d.ts}`;
    const g = byKey.get(key);
    if (g) g.reasons.push(d);
    else byKey.set(key, { did: d.codeDid, label: d.stepLabel, reasons: [d] });
  }
  return [...byKey.values()];
}

/** The cube mark on the magenta disc, lifted from the design page. */
const CUBE_SVG =
  '<span class="amy-jev-disc"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1E1E1E" stroke-width="2.6" stroke-linejoin="miter"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12 3 7M12 12l9-5M12 12v10"/></svg></span>';

const PILL_CLASS: Record<CodeDid, string> = {
  ok: "ok",
  held: "held",
  proof: "note",
  note: "note",
  ask: "note",
  "sent-back": "back",
  refusal: "refusal",
};

/** "2 to review: 1 held · 1 sent back · 64 answers", or "nothing changed · 64 answers". */
export function summarise(decisions: JevDecision[]): string {
  const n = decisions.length;
  const answers = `${n} ${n === 1 ? "answer" : "answers"}`;
  const changes = changesOf(decisions);
  if (changes.length === 0) return `nothing changed · ${answers}`;
  const parts: string[] = [];
  for (const k of ["held", "proof", "sent-back", "note", "ask", "refusal"] as const) {
    const c = changes.filter((g) => g.did === k).length;
    if (c > 0) parts.push(`${c} ${DID_WORD[k]}`);
  }
  return `${changes.length} to review: ${parts.join(" · ")} · ${answers}`;
}

/** Consecutive rows with the same step label and seam share one header. */
export function groupBySteps(
  decisions: JevDecision[],
): { label: string; seam: string; rows: JevDecision[] }[] {
  const out: { label: string; seam: string; rows: JevDecision[] }[] = [];
  for (const d of decisions) {
    const last = out[out.length - 1];
    if (last && last.label === d.stepLabel && last.seam === d.seam) last.rows.push(d);
    else out.push({ label: d.stepLabel, seam: d.seam, rows: [d] });
  }
  return out;
}

function pct(x: number): number {
  return Math.max(0, Math.min(100, Math.round((Number.isFinite(x) ? x : 0) * 100)));
}

function labelButton(d: JevDecision, value: "1" | "-1", glyph: string): string {
  return `<button class="amy-lab" data-amy-act="label" data-target-id="${esc(d.id)}" data-target-kind="verdict" data-kind="useful" data-value="${value}">${glyph}</button>`;
}

function renderRow(turnId: string, d: JevDecision, openRows: ReadonlySet<string>): string {
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

function renderChange(g: ChangeGroup, o: JevWindowOptions): string {
  const first = g.reasons[0]!;
  const target = first.decisionId ?? first.id;
  const targetKind = first.decisionId ? "decision" : "verdict";
  const voted = o.votes?.get(target);
  const vote = (value: 1 | -1, text: string) =>
    `<button class="amy-jvote${voted === value ? " amy-voted" : ""}" data-amy-act="label" data-target-id="${esc(target)}" ` +
    `data-target-kind="${targetKind}" data-kind="useful" data-value="${value}">${text}</button>`;
  const why = g.reasons
    .map((d) => `<li><b>${esc(d.questionName)}</b> → ${esc(fmtAnswer(d))}</li>`)
    .join("");
  return (
    `<div class="amy-jchange">` +
    `<div class="amy-jc-head"><span class="amy-jg">${GLYPH[g.did]}</span>` +
    `<span class="amy-jo ${PILL_CLASS[g.did]}">${esc(DID_WORD[g.did])}</span>` +
    `<b>${esc(CHANGE_WORDS[g.did][o.shadow === false ? 1 : 0])}</b></div>` +
    `<div class="amy-jc-step"><span class="amy-mt">step</span> ${esc(g.label)}</div>` +
    `<div class="amy-jc-why"><span class="amy-mt">because Jev answered</span><ul>${why}</ul></div>` +
    `<div class="amy-jc-vote"><span class="amy-mt">Was that the right call?</span>` +
    `${vote(1, "👍 right call")}${vote(-1, "👎 wrong call")}</div></div>`
  );
}

/** The whole window for one turn; "" when the turn has no answered decision. */
export function renderJevWindow(turn: TurnView, o: JevWindowOptions): string {
  const ds = turn.decisions;
  if (ds.length === 0) return "";
  const changes = changesOf(ds);
  const quiet = ds.filter((d) => d.codeDid === "ok");
  const head =
    changes.length > 0
      ? `<div class="amy-jsec">To review (${changes.length})</div>${changes.map((g) => renderChange(g, o)).join("")}`
      : `<div class="amy-jnone">Nothing would have changed in this turn.</div>`;
  const groups = groupBySteps(quiet)
    .map(
      (g) =>
        `<div class="amy-jstep"><span class="amy-mt">├ ${esc(g.label)}</span></div>` +
        g.rows.map((d) => renderRow(turn.turnId, d, o.openRows)).join(""),
    )
    .join("");
  const cached = ds.filter((d) => d.cacheHit).length;
  const t = esc(turn.turnId);
  const others =
    quiet.length > 0
      ? `<div class="amy-jothers-bar" data-amy-act="jev-others" data-turn="${t}">` +
        `<span class="amy-jtw">${o.othersOpen ? "▾" : "▸"}</span> ${quiet.length} ${quiet.length === 1 ? "answer" : "answers"} that changed nothing</div>` +
        `<div class="amy-jothers${o.othersOpen ? " amy-show" : ""}">${groups}</div>`
      : "";
  return (
    `<div class="amy-jev${o.open ? " amy-open" : ""}" data-turn="${t}">` +
    `<div class="amy-jev-bar" data-amy-act="jev-toggle" data-turn="${t}">${CUBE_SVG}` +
    `<span class="amy-jttl">JEV</span><span class="amy-jsm">${esc(summarise(ds))}</span>` +
    `<span class="amy-jtw">${o.open ? "▾" : "▸"}</span></div>` +
    `<div class="amy-jev-body">${head}${others}` +
    `<div class="amy-jft">${ds.length} answers · ${cached} cached</div></div></div>`
  );
}

/** The one-line window when Jev was not asked (design §9.2). */
export function renderJevNotConsulted(
  turnId: string,
  reason: "real-steps-stay-local" | "judge-down",
): string {
  const text =
    reason === "real-steps-stay-local"
      ? "not consulted (real steps stay local) · rules only"
      : "unreachable · judge checks skipped";
  return (
    `<div class="amy-jev amy-jev-off" data-turn="${esc(turnId)}">` +
    `<div class="amy-jev-bar">${CUBE_SVG}<span class="amy-jttl">JEV</span>` +
    `<span class="amy-jsm">${esc(text)}</span></div></div>`
  );
}
