// THALAMUS v4 — the card block in the routing panel (charter phase G; paper J19 v4.1 sections 5, 6 and 7).
//
// WHAT THIS IS FOR. One block at the top of the Thalamus card that says, in a line that is always true, what Thalamus v4 is
// doing: its mode, how many calls it has looked at today and how many it would have sent to a different model. Behind that
// line are three quiet expanders, each with a one-line summary: the recent calls (what it read, what each model would have
// cost, the rule that decided), the short lists (what was suggested for a task and what the agent really used), and the
// latest plan (the steps, the critical path, the hedges it would send).
//
// QUIET BY DEFAULT. Everything is closed. A row is one line; its detail opens under it. Nothing is drawn that has no data.
//
// OFF MEANS ABSENT. With no view (the plugin is off, missing, or the gateway has never heard of it) `renderThalamusV4`
// returns the empty string, so the card is exactly what it was before this block existed. A gateway that answers with an
// error draws one quiet line saying so, not an empty box.
//
// NO QUESTIONS, NO PROMPTS, NO TEXT. The data carries no task text and no Jev wording, so none can appear here.
//
// PURE. No DOM, no clock (`nowMs` is an argument), no network; it returns an HTML string so every sentence is unit-testable.

/** What `thalamus.panel` returns, less the `ok`. A projection: only what the block draws. */
export interface V4Option {
  key: string;
  effort?: string;
  feed?: string;
  price: number;
  quality?: number;
}
export interface V4Decision {
  id: string;
  ts: number;
  mode: string;
  incumbent: string;
  chosen: string;
  chosenEffort?: string;
  pick: string;
  switchKind: string;
  switchReason: string;
  nStar?: number | null;
  wouldChange: boolean;
  degraded: boolean;
  private: boolean;
  price: number;
  incumbentPrice?: number | null;
  reservedReason?: string | null;
  options: V4Option[];
  vetoes: Array<{ key: string; veto: string; detail?: string }>;
  domain?: string;
  topic?: string;
  stepKind?: string;
}
export interface V4ShownEntry {
  cardId: string;
  rank: number;
  prob: number;
  fit?: { value?: string };
}
export interface V4Use {
  taskId: string;
  ts: number;
  source: string;
  private: boolean;
  shuffled: boolean;
  listShown: boolean;
  listReason: string;
  listSource: string;
  noneFits: number;
  shown: V4ShownEntry[];
  used: Array<{ cardId: string; onList: boolean; rank?: number; via: string }>;
  outcome: string;
  mode: string;
  taskKind?: string;
}
export interface V4PlanUnit {
  unitId: string;
  copy: number;
  model?: string;
  effort?: string;
  startSec?: number;
  endSec?: number;
  slackSec?: number;
  onCritical: boolean;
  hedged: boolean;
  status: string;
  deps: string[];
}
export interface V4Plan {
  planId: string;
  ts: number;
  mode: string;
  units: V4PlanUnit[];
}
export interface ThalamusV4Panel {
  mode: string;
  ts: number;
  today: { calls: number; wouldChange: number };
  lastDecisionAt?: number;
  learning?: { enabled: boolean; apply: boolean };
  decisions: V4Decision[];
  uses: V4Use[];
  cardNames: Record<string, { name: string; kind: string }>;
  plans: V4Plan[];
}
export type ThalamusV4View =
  | { state: "ok"; panel: ThalamusV4Panel }
  | { state: "error"; message: string };

export interface V4RenderOptions {
  nowMs: number;
  /** Keys of the expanders the reader has open, so a repaint does not close them. */
  open?: ReadonlySet<string>;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const MUTED = "color:var(--muted)";
const ACCENT = "var(--accent)";
const ROW_STYLE = "font-size:10.5px;line-height:1.45";
const SUMMARY_STYLE =
  "cursor:pointer;list-style:none;display:block;padding:1px 0;outline:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
const LINE_STYLE = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
const MONO = "font-family:'SF Mono',monospace";

// ── words ────────────────────────────────────────────────────────────────────────────────────

/** The rule that decided a call, in plain words. An unknown reason is shown as it is, never hidden. */
export const SWITCH_WORDS: Readonly<Record<string, string>> = {
  "no-change": "already the best pick",
  "hand-picked": "you picked this model, so it stays",
  "fresh-point": "a new step, so nothing warm to lose",
  "run-exceeds-n-star": "a long run ahead, long enough to pay for the move",
  "single-step-pays": "one step, and it pays to move",
  stuck: "it failed the same way twice, so it tries a stronger model",
  "cache-cold": "the old model's cache had gone cold anyway",
  "incumbent-vetoed": "the current model is ruled out",
  "kept-below-n-star": "a short run is not worth the move",
};

/** The same reasons in a few words, for the one-line row; the full sentence is in the tooltip and the detail. */
export const SWITCH_SHORT: Readonly<Record<string, string>> = {
  "no-change": "already best",
  "hand-picked": "you picked it",
  "fresh-point": "new step",
  "run-exceeds-n-star": "long run ahead",
  "single-step-pays": "pays at once",
  stuck: "stuck twice",
  "cache-cold": "cache cold",
  "incumbent-vetoed": "ruled out",
  "kept-below-n-star": "short run",
};

export const VETO_WORDS: Readonly<Record<string, string>> = {
  privacy: "private source",
  policy: "vendor policy",
  "supply-spent": "plan used up",
  "supply-cooling": "rate-limited",
  "supply-unfunded": "no credit",
  capacity: "too big for it",
  engagement: "it refused this kind of work before",
  "not-allowed": "not allowed here",
};

export const FIT_WORDS: Readonly<Record<string, string>> = {
  "made-for": "made for it",
  "by-structure": "fits by structure",
  "covers-part": "covers part of it",
};

const OUTCOME_SENTENCE: Readonly<Record<string, string>> = {
  done: "It finished.",
  retried: "It had to retry.",
  corrected: "You corrected it.",
};

export function switchWords(reason: string): string {
  return SWITCH_WORDS[reason] ?? reason.replace(/-/g, " ");
}

/** `claude-code/claude-opus-5` → `claude-opus-5`; with an effort, `claude-opus-5 (high)`. */
export function shortModel(key: string, effort?: string): string {
  const slash = key.indexOf("/");
  const base = slash >= 0 ? key.slice(slash + 1) : key;
  return effort ? `${base} (${effort})` : base;
}

/** A model for the one-line row: the provider and the maker's prefix dropped, the effort left to the detail. */
export function headModel(key: string): string {
  return shortModel(key).replace(/^claude-/, "");
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A routing price in euro-equivalents for one call: two places from one euro up, four below, so small prices still differ. */
export const eur = (n: number): string =>
  !Number.isFinite(n) ? "—" : `€${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;

export const seconds = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 90) return `${Math.round(n)} s`;
  return `${(n / 60).toFixed(n < 600 ? 1 : 0)} min`;
};

// ── pieces ───────────────────────────────────────────────────────────────────────────────────

/** The words of a line of HTML, for the tooltip that shows the whole line when the row has been cut short. */
const plain = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function details(
  key: string,
  open: ReadonlySet<string> | undefined,
  summary: string,
  body: string,
  pad = "0",
  tip?: string,
): string {
  const isOpen = open?.has(key) === true;
  return (
    `<details class="t4-details" data-t4="${esc(key)}"${isOpen ? " open" : ""} style="${ROW_STYLE};min-width:0">` +
    `<summary style="${SUMMARY_STYLE}" title="${(tip ?? plain(summary)).replace(/"/g, "&quot;")}">${caretFor(isOpen)}${summary}</summary>` +
    `<div style="padding:2px 0 4px ${pad};min-width:0">${body}</div></details>`
  );
}

const line = (html: string, title?: string): string =>
  `<div style="${LINE_STYLE}"${title ? ` title="${esc(title)}"` : ""}>${html}</div>`;

/** The open/closed mark of a row. The page flips it on a toggle (`app.ts`); a repaint draws it from the open set. */
const caretFor = (isOpen: boolean): string =>
  `<span class="t4-caret" style="${MUTED};display:inline-block;width:10px">${isOpen ? "▾" : "▸"}</span>`;

/** A labelled group of one-line rows. The label is not a control; the rows are. */
const group = (label: string, body: string): string =>
  `<div style="margin-top:4px"><div style="${MUTED};font-size:9px;letter-spacing:0.05em;text-transform:uppercase">${label}</div>${body}</div>`;

// ── recent calls ─────────────────────────────────────────────────────────────────────────────

function decisionHead(d: V4Decision): string {
  const cur = headModel(d.incumbent);
  const to = headModel(d.chosen);
  const what =
    d.switchKind === "switch"
      ? `would move ${esc(cur)} → <b>${esc(to)}</b>`
      : d.switchKind === "fresh"
        ? `would start on <b>${esc(to)}</b>`
        : `stays on <b>${esc(cur)}</b>`;
  const why = SWITCH_SHORT[d.switchReason] ?? d.switchReason.replace(/-/g, " ");
  return (
    `<span style="${MUTED};${MONO};font-size:9.5px">${esc(clock(d.ts))}</span> ${what}` +
    ` <span style="${MUTED}">· ${esc(why)}</span>`
  );
}

/** The whole sentence for a call row, for its tooltip: the short line, then the rule in full. */
function decisionTip(d: V4Decision): string {
  return esc(`${plain(decisionHead(d))} — ${switchWords(d.switchReason)}`);
}

function optionRow(o: V4Option, d: V4Decision): string {
  const isChosen = o.key === d.chosen && (o.effort ?? "") === (d.chosenEffort ?? "");
  const isCurrent = o.key === d.incumbent;
  const mark = isChosen
    ? `<span style="color:${ACCENT}" title="the model this call would use">✓</span>`
    : `<span></span>`;
  const tag = isCurrent ? "now" : isChosen ? "chosen" : "";
  return (
    `<div style="display:grid;grid-template-columns:10px minmax(0,1fr) 40px 38px 58px;gap:5px;${isChosen ? "" : MUTED}">` +
    `${mark}<span style="${LINE_STYLE}" title="${esc(shortModel(o.key, o.effort))}">${esc(shortModel(o.key))}` +
    `${o.effort ? ` <span style="font-size:9px">${esc(o.effort)}</span>` : ""}</span>` +
    `<span style="font-size:9px;text-align:right">${tag}</span>` +
    `<span style="text-align:right" title="quality the model has to clear for this step">${o.quality === undefined ? "" : `q ${Math.round(o.quality)}`}</span>` +
    `<span style="text-align:right" title="routing price of this call">${esc(eur(o.price))}</span></div>`
  );
}

function decisionBody(d: V4Decision): string {
  const parts: string[] = [];
  const reads = [
    d.domain ? `kind of work: ${esc(d.domain)}` : "",
    d.topic && d.topic !== "none" ? `topic: ${esc(d.topic)}` : "",
    d.stepKind ? `this step: ${esc(d.stepKind)}` : "",
  ].filter(Boolean);
  if (reads.length) parts.push(`<div style="${MUTED}">${reads.join(" · ")}</div>`);
  if (d.degraded)
    parts.push(`<div style="${MUTED}">The reader was unsure, so it played safe.</div>`);
  if (d.private)
    parts.push(
      `<div style="${MUTED}">From a private source: read locally, nothing sent out.</div>`,
    );
  const opts = [...d.options].sort((a, b) => a.price - b.price).slice(0, 6);
  if (opts.length) {
    parts.push(
      `<div style="margin-top:2px">${opts.map((o) => optionRow(o, d)).join("")}</div>` +
        (d.options.length > opts.length
          ? `<div style="${MUTED};font-size:9.5px">and ${d.options.length - opts.length} more</div>`
          : ""),
    );
  }
  const rule = [`Rule: ${esc(switchWords(d.switchReason))}.`];
  if (typeof d.nStar === "number" && Number.isFinite(d.nStar))
    rule.push(`The move pays after about ${d.nStar.toFixed(1)} steps.`);
  parts.push(`<div style="margin-top:2px">${rule.join(" ")}</div>`);
  if (d.vetoes.length) {
    parts.push(
      `<div style="${MUTED}">Ruled out: ${d.vetoes
        .map(
          (v) =>
            `${esc(shortModel(v.key))} (${esc(VETO_WORDS[v.veto] ?? v.veto.replace(/-/g, " "))})`,
        )
        .join(", ")}</div>`,
    );
  }
  if (d.reservedReason)
    parts.push(
      `<div style="color:var(--warn,#c98b2e)">A reserved model was opened: ${esc(d.reservedReason)}.</div>`,
    );
  return parts.join("");
}

function callsSection(p: ThalamusV4Panel, o: V4RenderOptions): string {
  if (p.decisions.length === 0) return "";
  const last = p.lastDecisionAt ?? p.decisions[0].ts;
  const rows = p.decisions
    .map((d) =>
      details(`t4:d:${d.id}`, o.open, decisionHead(d), decisionBody(d), "14px", decisionTip(d)),
    )
    .join("");
  return group(
    `Recent calls · ${plural(p.decisions.length, "call")} · last ${esc(ago(o.nowMs - last))}`,
    rows,
  );
}

// ── short lists ──────────────────────────────────────────────────────────────────────────────

const ordinal = (n: number): string =>
  n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `#${n}`;

function cardName(p: ThalamusV4Panel, id: string): string {
  return p.cardNames[id]?.name ?? id.replace(/^[a-z]+:/, "");
}

function useHead(u: V4Use, p: ThalamusV4Panel): string {
  const list = u.shown.length
    ? plural(u.shown.length, "suggestion")
    : u.listReason === "none-leads"
      ? "nothing fit"
      : "no list";
  const used = u.used.length
    ? `used ${u.used.map((x) => `<b>${esc(cardName(p, x.cardId))}</b>${x.onList && x.rank ? ` (${ordinal(x.rank)})` : " (not on the list)"}`).join(", ")}`
    : "used nothing";
  return (
    `<span style="${MUTED};${MONO};font-size:9.5px">${esc(clock(u.ts))}</span>` +
    `${u.taskKind ? ` ${esc(u.taskKind)}` : ""} <span style="${MUTED}">· ${list} · ${used}</span>`
  );
}

function useBody(u: V4Use, p: ThalamusV4Panel): string {
  const rows = [...u.shown]
    .sort((a, b) => a.rank - b.rank)
    .map((e) => {
      const fit = e.fit?.value ? FIT_WORDS[e.fit.value] : undefined;
      const wasUsed = u.used.some((x) => x.cardId === e.cardId);
      return (
        `<div style="display:grid;grid-template-columns:18px 1fr 34px;gap:6px;${wasUsed ? "" : MUTED}">` +
        `<span>#${e.rank}</span><span style="${LINE_STYLE}">${wasUsed ? "✓ " : ""}${esc(cardName(p, e.cardId))}` +
        `${p.cardNames[e.cardId] ? ` <span style="font-size:9px">(${esc(p.cardNames[e.cardId].kind)})</span>` : ""}` +
        `${fit ? ` <span style="font-size:9px">· ${esc(fit)}</span>` : ""}</span>` +
        `<span style="text-align:right">${Math.round(e.prob * 100)}%</span></div>`
      );
    })
    .join("");
  const parts: string[] = [];
  if (rows) parts.push(rows);
  if (u.shown.length)
    parts.push(`<div style="${MUTED}">None of these fits: ${Math.round(u.noneFits * 100)}%.</div>`);
  parts.push(
    u.used.length
      ? `<div>Used: ${u.used
          .map(
            (x) =>
              `${esc(cardName(p, x.cardId))}${x.onList && x.rank ? `, it was ${ordinal(x.rank)} on the list` : ", it was not on the list"}`,
          )
          .join("; ")}.</div>`
      : `<div>The agent used none of them.</div>`,
  );
  const shown = u.mode === "enforce" && u.listShown;
  const tail = [
    esc(OUTCOME_SENTENCE[u.outcome] ?? `Outcome: ${u.outcome}.`),
    shown ? "The list was shown to the agent." : "The list was recorded, not shown to the agent.",
    u.shuffled
      ? `It ${shown ? "was" : "would have been"} shown in a shuffled order, to measure how much the agent follows position.`
      : "",
    u.private ? "From a private source: ranked locally, nothing sent out." : "",
  ].filter(Boolean);
  parts.push(`<div style="${MUTED}">${tail.join(" ")}</div>`);
  return parts.join("");
}

function listsSection(p: ThalamusV4Panel, o: V4RenderOptions): string {
  if (p.uses.length === 0) return "";
  const note = p.mode === "enforce" ? "shown to the agent" : "recorded, not shown to the agent";
  const rows = p.uses
    .map((u) => details(`t4:u:${u.taskId}`, o.open, useHead(u, p), useBody(u, p), "14px"))
    .join("");
  return group(`Short lists · ${plural(p.uses.length, "task")} · ${note}`, rows);
}

// ── plans ────────────────────────────────────────────────────────────────────────────────────

const MAX_PLAN_ROWS = 24;

function planRow(u: V4PlanUnit, total: number): string {
  const s = Math.max(0, u.startSec ?? 0);
  const e = Math.max(s, u.endSec ?? s);
  const left = total > 0 ? (s / total) * 100 : 0;
  const width = total > 0 ? Math.max(1.5, ((e - s) / total) * 100) : 100;
  const copy = u.copy === 1;
  const color = copy ? "var(--warn,#c98b2e)" : u.onCritical ? ACCENT : "var(--muted)";
  const bar =
    `<span style="position:relative;display:block;height:6px;border:1px solid var(--border);border-radius:2px;overflow:hidden">` +
    `<span style="position:absolute;top:0;bottom:0;left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:${copy ? "transparent" : color};${copy ? `border:1px dashed ${color};box-sizing:border-box` : ""}"></span></span>`;
  const label = copy
    ? `<span style="color:${color}">↳ copy of ${esc(u.unitId)}</span>`
    : `${u.onCritical ? `<span style="color:${ACCENT}" title="on the critical path: delaying it delays the whole plan">◆</span> ` : `<span style="display:inline-block;width:9px"></span> `}${esc(u.unitId)}`;
  const model = u.model ? shortModel(u.model) : esc(u.status);
  return (
    `<div style="display:grid;grid-template-columns:96px 1fr 88px;gap:6px;align-items:center;${u.onCritical || copy ? "" : MUTED}">` +
    `<span style="${LINE_STYLE}">${label}</span>${bar}` +
    `<span style="${LINE_STYLE};text-align:right;font-size:9.5px" title="${esc(model)} · ${esc(seconds(u.startSec))} to ${esc(seconds(u.endSec))}">${esc(model)}</span></div>`
  );
}

function plansSection(p: ThalamusV4Panel, o: V4RenderOptions): string {
  const plan = p.plans[0];
  if (!plan || plan.units.length === 0) return "";
  const originals = plan.units.filter((u) => u.copy === 0);
  const copies = plan.units.filter((u) => u.copy === 1);
  const total = Math.max(0, ...plan.units.map((u) => u.endSec ?? 0));
  const hedgeWord = plan.mode === "enforce" ? "sent" : "would send";
  const summary =
    `Latest plan <span style="${MUTED}">· ${plural(originals.length, "step")} · about ${esc(seconds(total))}` +
    `${copies.length ? ` · ${plural(copies.length, "hedge")} (${hedgeWord})` : ""}</span>`;
  const sorted = [...plan.units].sort(
    (a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || a.copy - b.copy,
  );
  const shown = sorted.slice(0, MAX_PLAN_ROWS);
  const body =
    shown.map((u) => planRow(u, total)).join("") +
    (sorted.length > shown.length
      ? `<div style="${MUTED};font-size:9.5px">and ${sorted.length - shown.length} more</div>`
      : "") +
    `<div style="${MUTED};font-size:9.5px;margin-top:2px">◆ is on the critical path. A dashed bar is a second copy of a slow step on another provider.</div>`;
  return group(
    `Plan · ${esc(ago(o.nowMs - plan.ts))}`,
    details(`t4:p:${plan.planId}`, o.open, summary, body, "14px"),
  );
}

// ── the block ────────────────────────────────────────────────────────────────────────────────

function modeWord(mode: string): string {
  return mode === "enforce" ? "enforcing" : mode;
}

function closedLine(view: ThalamusV4View): string {
  if (view.state === "error")
    return `Thalamus: <span style="${MUTED}">not answering right now</span>`;
  const p = view.panel;
  const tail =
    p.today.calls === 0
      ? "no calls yet today"
      : `${plural(p.today.calls, "call")} today · would have changed ${p.today.wouldChange}`;
  return `Thalamus: ${esc(modeWord(p.mode))} <span style="${MUTED}">· ${tail}</span>`;
}

/** The block for the routing card. The empty string when there is no view: off means absent. */
export function renderThalamusV4(view: ThalamusV4View | undefined, o: V4RenderOptions): string {
  if (!view) return "";
  const head = closedLine(view);
  let inner: string;
  if (view.state === "error") {
    inner = `<div style="${MUTED}">It could not be read just now: ${esc(view.message)}. It will try again.</div>`;
  } else {
    const p = view.panel;
    inner = callsSection(p, o) + listsSection(p, o) + plansSection(p, o);
    if (!inner)
      inner = `<div style="${MUTED}">Nothing recorded yet. It fills in as the agent works.</div>`;
    if (p.mode !== "enforce") {
      inner += `<div style="${MUTED};font-size:9.5px;margin-top:3px">Shadow mode: it only watches and writes down what it would do.</div>`;
    }
  }
  const body = details("t4:block", o.open, `<b style="font-weight:600">${head}</b>`, inner, "0");
  return (
    `<div class="thalamus-block thalamus-v4" style="display:grid;grid-template-columns:52px 1fr;gap:7px;align-items:start">` +
    `<span class="thalamus-key" style="font-family:'SF Mono',monospace;font-size:9px;letter-spacing:0.06em;color:var(--accent);padding-top:1px">V4</span>` +
    `<div class="thalamus-text" style="min-width:0;font-size:10.5px;line-height:1.42;color:var(--text,inherit)">${body}</div></div>`
  );
}
