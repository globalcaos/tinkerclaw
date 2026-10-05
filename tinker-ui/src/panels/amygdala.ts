import { esc, fmtAgo, fmtClock, fmtEur } from "../amygdala-html.js";
/**
 * The amygdala panel (design blocks 7-10, §9.1): the right-rail body, the composer dot and their small pure helpers.
 * DOM-free HTML-string builders; every dynamic string goes through `esc`; interactions are `data-amy-act` attributes
 * that app.ts handles by delegation. Returns "" when the amygdala is not available so the v3.1 panel stays.
 */
import type {
  ChangeView,
  DotState,
  InterventionKind,
  InterventionView,
  QuestionRow,
  StatusView,
} from "../amygdala-types.js";

export interface PanelInput {
  available: boolean;
  status: StatusView | null;
  questions: QuestionRow[];
  changes: ChangeView[];
  precedents: number;
  spend: { eur: number; eur30: number; calls: number } | null;
  strip: { hour: number; ok: number; noteAsk: number; held: number }[];
  interventionsToday: InterventionView[];
  now: number;
}

export interface PanelUi {
  /** Expander ids that are open (`health|today|questions|learning|cost`). */
  open: ReadonlySet<string>;
}

/** A seam quiet for longer than this is amber; never heard from is grey. */
const SEAM_STALE_MS = 30 * 60_000;

const KIND_ICON: Record<InterventionKind, string> = {
  hold: "✋",
  proof: "🔎",
  ask: "❓",
  "send-back": "🔁",
  note: "⚡",
  refusal: "✋",
};

export function renderDot(state: DotState, title: string): string {
  return `<span class="amy-dot amy-dot--${state}" data-amy-act="dot" title="${esc(title)}"></span>`;
}

export function statusLine(status: StatusView | null): { text: string; bad: boolean } {
  if (!status) return { text: "Not watching", bad: false };
  return { text: status.line, bad: status.state === "degraded" };
}

export function stripBars(strip: PanelInput["strip"]): string {
  const total = (h: PanelInput["strip"][number]) => h.ok + h.noteAsk + h.held;
  const busiest = strip.reduce((m, h) => Math.max(m, total(h)), 0);
  const bars = strip
    .map((h) => {
      const t = total(h);
      const height = busiest > 0 ? (t / busiest) * 100 : 0;
      const seg = (cls: string, n: number) =>
        n > 0
          ? `<span class="amy-strip-${cls}" style="height:${((n / t) * 100).toFixed(1)}%"></span>`
          : "";
      const title = `${String(h.hour).padStart(2, "0")}:00 · ${h.ok} proceeded · ${h.noteAsk} note/ask · ${h.held} held`;
      return `<div class="amy-strip-bar" title="${esc(title)}" style="height:${height.toFixed(1)}%">${seg("ok", h.ok)}${seg("note", h.noteAsk)}${seg("held", h.held)}</div>`;
    })
    .join("");
  const legend =
    `<div class="amy-legend"><span><i class="amy-lg-ok"></i>proceeded</span>` +
    `<span><i class="amy-lg-note"></i>note / ask</span><span><i class="amy-lg-held"></i>held</span></div>`;
  return `<div class="amy-strip${busiest === 0 ? " amy-strip--empty" : ""}">${bars}</div>${legend}`;
}

export function learningRows(changes: ChangeView[]): {
  applied: ChangeView[];
  pending: ChangeView[];
} {
  return {
    applied: changes.filter(
      (c) => !c.exceptional && (c.status === "applied" || c.status === "undone"),
    ),
    pending: changes.filter((c) => c.status === "pending"),
  };
}

function dotFor(state: DotState): string {
  return `<span class="amy-dot amy-dot--${state}"></span>`;
}

function seamDot(now: number, ts: number | null): DotState {
  if (ts === null || ts <= 0) return "grey";
  return now - ts > SEAM_STALE_MS ? "amber" : "green";
}

function kv(label: string, value: string, dot: DotState | null): string {
  return `<span>${esc(label)}</span><span class="amy-v">${esc(value)}</span>${dot ? dotFor(dot) : "<span></span>"}`;
}

function fmtVal(v: unknown): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v) ?? "";
}

function replayLine(c: ChangeView): string {
  const r = c.replaySummary;
  const parts = [`${r.relaxed} of ${r.cases} proceed`];
  if (r.tightened > 0) parts.push(`${r.tightened} tightened`);
  parts.push(
    r.mustCatchLost === 0 ? "no must-catch case lost" : `${r.mustCatchLost} must-catch lost`,
  );
  return parts.join(" · ");
}

function acc(id: string, title: string, summary: string, open: boolean, body: string): string {
  return (
    `<div class="amy-acc${open ? " amy-acc--open" : ""}">` +
    `<div class="amy-ah" data-amy-act="acc" data-acc="${id}" role="button" tabindex="0">` +
    `<span class="amy-tw">${open ? "▾" : "▸"}</span>${esc(title)}<span class="amy-s">${summary}</span></div>` +
    `<div class="amy-ab">${open ? body : ""}</div></div>`
  );
}

function healthBody(p: PanelInput, s: StatusView | null): string {
  if (!s) return `<div class="amy-muted">Not watching.</div>`;
  const seams: [keyof StatusView["seams"], string][] = [
    ["prompt", "Your prompt"],
    ["pre", "Before tools"],
    ["post", "After tools"],
    ["stop", "End of turn"],
  ];
  const rows = seams.map(([k, label]) =>
    kv(label, fmtAgo(p.now, s.seams[k].lastTs), seamDot(p.now, s.seams[k].lastTs)),
  );
  rows.push(
    kv("Hard rules", `${s.rules.n} · v${s.rules.version}`, s.rules.n > 0 ? "green" : "red"),
  );
  const silent = s.judge.silentSince;
  if (silent !== undefined) {
    const min = Math.max(0, Math.round((p.now - silent) / 60_000));
    rows.push(kv("Judge", `silent ${min} min`, "red"));
    rows.push(kv("Now doing", "hard rules only", "amber"));
  } else {
    const ms = s.judge.lastMs;
    const dot: DotState = ms === null ? "grey" : s.judge.errors > 0 ? "amber" : "green";
    rows.push(
      kv("Judge", `${ms === null ? "no answer yet" : `${ms} ms`} · ${s.judge.errors} errors`, dot),
    );
  }
  rows.push(kv("Mode", s.mode === "enforce" ? "enforcing" : "shadow", null));
  return `<div class="amy-kv">${rows.join("")}</div><button class="amy-btn" data-amy-act="canary">Run canary</button>`;
}

function labelButtons(decisionId: string): string {
  const b = (value: string, glyph: string) =>
    `<button class="amy-lab" data-amy-act="label" data-target-id="${esc(decisionId)}" data-target-kind="decision" data-kind="useful" data-value="${value}">${glyph}</button>`;
  return b("1", "👍") + b("-1", "👎");
}

function todayBody(p: PanelInput, s: StatusView | null): string {
  const rows = p.interventionsToday
    .map(
      (iv) =>
        `<div class="amy-iv"><span class="amy-t">${esc(fmtClock(iv.ts))}</span><span>${KIND_ICON[iv.kind] ?? "⚡"}</span>` +
        `<span>${esc(iv.title)}</span><span>${iv.decisionId ? labelButtons(iv.decisionId) : ""}</span></div>`,
    )
    .join("");
  const quiet = Math.max(0, (s?.checksToday ?? 0) - p.interventionsToday.length);
  return `${rows}<div class="amy-muted amy-small">${quiet} steps proceeded without a word.</div>`;
}

/** "Curiosity: did it …?" → the paper's name in bold, then the question (the architect 2026-10-01: find them by the paper). */
function nameHtml(name: string): string {
  const i = name.indexOf(": ");
  return i > 0
    ? `<b class="amy-qlabel">${esc(name.slice(0, i))}</b>${esc(name.slice(i))}`
    : esc(name);
}

/** A prompt's name; with a file it opens that .md through the app's `.fs-link` handler (the architect 2026-09-30). */
function promptName(q: QuestionRow): string {
  if (!q.file) return `<span class="amy-qname">${nameHtml(q.name)}</span>`;
  return (
    `<code class="fs-link amy-qlink amy-qname" data-path="${esc(q.file)}" ` +
    `title="Open ${esc(q.id)}.md: the idea, examples and the question">${nameHtml(q.name)}</code>`
  );
}

/** Rows under a header per family, as the J11 paper groups them (the architect 2026-10-01); the gateway sends them in order. */
function questionsBody(p: PanelInput): string {
  let family: string | undefined;
  const rows = p.questions
    .map((q) => {
      const head =
        q.family && q.family !== family
          ? `<div class="amy-qfam"><b>${esc(q.familyTitle ?? q.family)}</b>` +
            (q.familySubtitle ? ` · <span>${esc(q.familySubtitle)}</span>` : "") +
            `</div>`
          : "";
      family = q.family;
      const right =
        q.right === null
          ? `<span class="amy-muted amy-small">no labels yet</span>`
          : `<div class="amy-bar"><i class="${q.right < 0.7 ? "amy-warn" : ""}" style="width:${Math.round(q.right * 100)}%"></i></div>`;
      return (
        `${head}<div class="amy-qrow${q.status === "off" ? " amy-qrow--off" : ""}">${promptName(q)}` +
        `<span class="amy-muted">v${esc(q.version)}</span><span class="amy-muted">${esc(q.today)}</span>${right}</div>`
      );
    })
    .join("");
  return (
    `<div class="amy-qrow amy-qhead amy-muted amy-small"><span>prompt</span><span>ver</span><span>today</span><span>right</span></div>${rows}` +
    `<div class="amy-muted amy-small">Right = agreed with your 👍/👎. Click a name to read what it does, with examples, or to edit it.</div>`
  );
}

function learningBody(p: PanelInput): string {
  const { applied, pending } = learningRows(p.changes);
  const items = applied
    .map((c) => {
      const undone = c.status === "undone";
      return (
        `<div class="amy-lo${undone ? " amy-lo--undone" : ""}"><span>${c.kind === "tighten" ? "↑" : "↓"}</span>` +
        `<span>${esc(c.questionName)} ${esc(fmtVal(c.from))} → ${esc(fmtVal(c.to))}</span>` +
        (undone
          ? "<span></span>"
          : `<button class="amy-btn amy-btn--small" data-amy-act="undo" data-change="${esc(c.id)}">Undo</button>`) +
        `<small>${esc(replayLine(c))}</small></div>`
      );
    })
    .join("");
  const tightened = applied.filter((c) => c.kind === "tighten" && c.status === "applied").length;
  const rows = [
    kv(
      "Waiting for you",
      pending.length === 0 ? "none" : String(pending.length),
      pending.length > 0 ? "amber" : "green",
    ),
    kv("Tightened by itself", String(tightened), null),
    kv("Precedents", String(p.precedents), null),
  ].join("");
  return `${items}<div class="amy-kv amy-kv--top">${rows}</div>`;
}

function costBody(p: PanelInput): string {
  if (!p.spend) return `<div class="amy-muted">No spend figures yet.</div>`;
  return `<div class="amy-kv">${kv("Today", fmtEur(p.spend.eur), null)}${kv("Last 30 days", fmtEur(p.spend.eur30), null)}${kv("Judge calls", String(p.spend.calls), null)}</div>`;
}

function headDot(s: StatusView | null): DotState {
  if (!s) return "grey";
  return s.state === "degraded" ? "red" : s.state === "shadow" ? "amber" : "green";
}

export function renderAmygdalaPanelBody(p: PanelInput, ui: PanelUi): string {
  if (!p.available) return "";
  const s = p.status;
  const line = statusLine(s);
  const degraded = s?.state === "degraded";
  const isOpen = (id: string) => ui.open.has(id) || (id === "health" && degraded);

  const seamsFiring = s
    ? Object.values(s.seams).filter((x) => x.lastTs !== null && x.lastTs > 0).length
    : 0;
  const healthSummary = s
    ? `${degraded && s.judge.silentSince !== undefined ? "judge silent" : `${seamsFiring} seams firing`} · ${dotFor(headDot(s))}`
    : "";
  const off = p.questions.filter((q) => q.status === "off").length;
  const { applied, pending } = learningRows(p.changes);
  const loosened = applied.filter((c) => c.status === "applied" && c.kind !== "tighten").length;
  const learningSummary =
    pending.length > 0
      ? `${pending.length} waiting for you`
      : `${loosened} loosened by itself · undo`;

  return (
    `<div class="amy-panel">` +
    `<div class="amy-p-head"><span>🧠</span><b>Amygdala</b><span class="amy-sp"></span>${renderDot(headDot(s), line.text)}</div>` +
    `<div class="amy-p-line${line.bad ? " amy-p-line--bad" : ""}">${esc(line.text)}</div>` +
    stripBars(p.strip) +
    acc("health", "Health", healthSummary, isOpen("health"), healthBody(p, s)) +
    acc(
      "today",
      "Today",
      esc(`${p.interventionsToday.length} interventions`),
      isOpen("today"),
      todayBody(p, s),
    ) +
    acc(
      "questions",
      "Jev prompts",
      esc(`${p.questions.length} · ${off} off`),
      isOpen("questions"),
      questionsBody(p),
    ) +
    acc("learning", "Learning", esc(learningSummary), isOpen("learning"), learningBody(p)) +
    acc(
      "cost",
      "Cost",
      esc(fmtEur(p.spend?.eur ?? s?.spendEurToday ?? 0) + " today"),
      isOpen("cost"),
      costBody(p),
    ) +
    `</div>`
  );
}
