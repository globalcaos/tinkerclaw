// tinker-ui/src/panels/eeg-trace.ts
// FORK 2026-06-13 (eeg): EEG seismograph renderer for the Models panel.
// Design: TINKER_UI_DESIGN_BIBLE/tinker-ui.md §5.8h. PURE module — no DOM access,
// no imports from app.ts: state in (record/turnEnd/backfill) → SVG string out
// (renderSvg), so it is unit-testable in isolation. app.ts owns the live event
// feed, the host div (which scrolls — SVG height = content height) and the
// click delegation on `.eeg-marker`.
//
// The paper is vertical: NEWEST sample at the TOP, one ~24px row per sample,
// row y grows with age. Main-session samples form ONE continuous trace whose
// x position is the chosen thinking-effort stop (the SAME 8 stops as the §5.8f
// slider — eegStopX is the single source of truth for stop→x; bible §5.8h
// invariant 2). Effort changes bend through cubic beziers (PyCharm git-graph
// style), never right-angle jumps. Color = provider brand, width = ESTIMATED
// relative cost of (model × effort), dashed = user-forced, halo = measured
// thinkingChars bucket (CHARS, never tokens — §5.8g honest-labels).

// ─── Stops (MUST mirror app.ts THINK_STOPS order exactly) ───
// `short` = the compact tick label printed under the slider AND above the
// seismograph column (full labels collide at 8 stops in a ~280px panel).
export const EEG_STOPS: { lvl: string; label: string; short: string }[] = [
  { lvl: "", label: "Auto", short: "Auto" },
  { lvl: "minimal", label: "Minimal", short: "Min" },
  { lvl: "low", label: "Low", short: "Low" },
  { lvl: "medium", label: "Medium", short: "Med" },
  { lvl: "adaptive", label: "Adaptive", short: "Adpt" },
  { lvl: "high", label: "High", short: "High" },
  { lvl: "xhigh", label: "xHigh", short: "xHi" },
  { lvl: "max", label: "Max", short: "Max" },
];

export interface EegSample {
  runId: string;
  model: string;
  provider: string;
  chosenLevel: string; // one of EEG_STOPS lvl values ("" = Auto/uncapped)
  forced: boolean; // true = user pinned model/effort via the sliders → dashed
  subagent: boolean;
  parentRunId?: string;
  thinkingChars?: number; // measured thinking CHARACTERS (never tokens) → halo
  startedAt: number; // epoch ms
  endedAt?: number; // epoch ms (absent = still running)
}

export interface EegTurnEnd {
  turn: number;
  runId: string;
  endedAt: number;
}

// ─── Provider brand palette (bible §5.8h, Oscar's q6 full-palette pick) ───
// google is NOT here — it is special-cased as the rainbow gradient below.
export const EEG_PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#E8702A",
  openai: "#10A37F",
  deepseek: "#4D6BFE",
  mistral: "#FA520F",
  meta: "#0668E1",
  unknown: "#8A8F98", // xai / local / anything unrecognized = neutral gray
};

export function eegProviderPaint(provider: string): { stroke: string; isRainbow: boolean } {
  const p = (provider || "").toLowerCase();
  if (p === "google" || p.startsWith("google")) {
    return { stroke: "url(#eeg-google)", isRainbow: true };
  }
  // FORK 2026-06-13 (eeg): cc-bridge = claude CLI → keep Anthropic branding
  // (same precedent as provider-logos.ts).
  if (p === "claude-code") return { stroke: EEG_PROVIDER_COLORS.anthropic, isRainbow: false };
  return { stroke: EEG_PROVIDER_COLORS[p] ?? EEG_PROVIDER_COLORS.unknown, isRainbow: false };
}

// ─── Cost model: thickness = relative cost of (model × effort) ───
// ESTIMATED relative output cost per model family (v1 lookup, first regex wins).
// Deliberately approximate: this table is a named export precisely so measured
// per-(model × effort) costs can REPLACE these estimates later without touching
// the renderer. Until then any thickness derived from it is an ESTIMATE — never
// present it as a measured figure (bible §5.8h invariant 3).
export const EEG_COST_TABLE: { modelMatch: RegExp; relCost: number }[] = [
  { modelMatch: /fable/i, relCost: 10 },
  { modelMatch: /opus/i, relCost: 5 },
  { modelMatch: /sonnet/i, relCost: 3 },
  { modelMatch: /haiku/i, relCost: 1 },
  // gemini rows BEFORE the \bmini\b row purely for clarity; \b already keeps
  // "gemini" (…e-mini…) from matching the mini bucket.
  { modelMatch: /gemini.*pro/i, relCost: 5 },
  { modelMatch: /gemini.*flash/i, relCost: 1.5 },
  // \bmini\b listed before gpt-5 so "gpt-5-mini" takes the cheap bucket.
  { modelMatch: /\bmini\b/i, relCost: 1.5 },
  { modelMatch: /gpt-5/i, relCost: 5 },
];
const EEG_DEFAULT_REL_COST = 3;

// Effort multiplier per stop. Auto ("") = UNCAPPED — the model picks its own
// budget, so it costs more than medium on average (§5.8g: Auto is never tier 0).
export const EEG_EFFORT_MULT: Record<string, number> = {
  "": 1.2,
  minimal: 0.5,
  low: 0.75,
  medium: 1,
  adaptive: 1.2,
  high: 1.5,
  xhigh: 2,
  max: 3,
};

export function eegCostWidthPx(model: string, level: string): number {
  let rel = EEG_DEFAULT_REL_COST;
  for (const row of EEG_COST_TABLE) {
    if (row.modelMatch.test(model || "")) {
      rel = row.relCost;
      break;
    }
  }
  const mult = EEG_EFFORT_MULT[level] ?? 1;
  const w = 1.5 * Math.log2(1 + rel * mult * 2);
  return Math.min(7, Math.max(1.5, w));
}

// ─── Shared column geometry (single source of truth for stop→x) ───
// The §5.8f effort slider markers MUST use this same helper — drift between the
// trace columns and the slider stops destroys the instrument's meaning (bible
// §5.8h invariant 2).
export const EEG_PAD_LEFT = 18;
export const EEG_PAD_RIGHT = 14;

// CSS `left:` expression (width-independent) that places a slider tick label's
// CENTER on the SAME x as this stop's seismograph column — the alignment the
// bible §5.8h invariant 2 demands. idx 0..n-1; pads match eegStopX exactly.
export function eegStopLeftCss(idx: number, n: number): string {
  if (n <= 1) return `${EEG_PAD_LEFT}px`;
  const span = EEG_PAD_LEFT + EEG_PAD_RIGHT;
  return `calc(${EEG_PAD_LEFT}px + (100% - ${span}px) * ${idx} / ${n - 1})`;
}

export function eegStopX(lvl: string, width: number): number {
  let idx = EEG_STOPS.findIndex((s) => s.lvl === lvl);
  if (idx < 0) idx = 0; // unknown level → Auto column (mirrors thinkStopIndexForLevel)
  const inner = Math.max(1, width - EEG_PAD_LEFT - EEG_PAD_RIGHT);
  return EEG_PAD_LEFT + (idx * inner) / (EEG_STOPS.length - 1);
}

// thinkingChars → effort-stop bucket for the measured-reality HALO. CHARS, not
// tokens — there is no provider reasoning-token count (§5.8g honest-labels);
// never label these buckets as tokens.
function thinkingCharsLevel(chars: number): string {
  if (chars <= 0) return "minimal";
  if (chars < 1500) return "low";
  if (chars < 6000) return "medium";
  if (chars < 15000) return "high";
  if (chars < 40000) return "xhigh";
  return "max";
}

// ─── Render constants ───
const EEG_MAX_SAMPLES = 400; // retained history cap (drop oldest)
const ROW_H = 24; // px of paper per sample row
const TOP_PAD = 26; // room for the stop labels above the paper
const BOTTOM_PAD = 14;
const ARC_HALF = 7; // bezier vertical half-span → ~14px of curve per column hop
const STRAND_CAP = 5; // bible §5.8h invariant 4: never render unbounded strands

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fx = (v: number): string => (Math.round(v * 100) / 100).toString();

interface SubCluster {
  items: EegSample[];
  start: number;
  end: number; // Infinity while any member is still running
}

export class EegTraceStore {
  // insertion order keyed by runId — record() upserts because effort events
  // arrive incrementally for the same run (live → final, §5.8g).
  private samples = new Map<string, EegSample>();
  private turnEnds: EegTurnEnd[] = []; // kept sorted by endedAt

  record(s: EegSample): void {
    const prev = this.samples.get(s.runId);
    if (prev) {
      // merge: later events only overwrite fields they actually carry,
      // and the sample keeps its original insertion position.
      const merged: EegSample = { ...prev };
      for (const k of Object.keys(s) as (keyof EegSample)[]) {
        const v = s[k];
        if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
      }
      this.samples.set(s.runId, merged);
      return;
    }
    this.samples.set(s.runId, { ...s });
    while (this.samples.size > EEG_MAX_SAMPLES) {
      const oldest = this.samples.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.samples.delete(oldest);
    }
  }

  turnEnd(e: EegTurnEnd): void {
    const i = this.turnEnds.findIndex((t) => t.turn === e.turn && t.runId === e.runId);
    if (i >= 0) this.turnEnds[i] = { ...e };
    else this.turnEnds.push({ ...e });
    this.turnEnds.sort((a, b) => a.endedAt - b.endedAt);
    if (this.turnEnds.length > EEG_MAX_SAMPLES) {
      this.turnEnds.splice(0, this.turnEnds.length - EEG_MAX_SAMPLES);
    }
  }

  // Rebuild-on-load path (§5.8h persistence): idempotent upserts, so feeding
  // the same history twice is harmless.
  backfill(samples: EegSample[], ends: EegTurnEnd[]): void {
    for (const s of samples) this.record(s);
    for (const e of ends) this.turnEnd(e);
  }

  clear(): void {
    this.samples.clear();
    this.turnEnds = [];
  }

  get isEmpty(): boolean {
    return this.samples.size === 0 && this.turnEnds.length === 0;
  }

  renderSvg(opts: { width: number }): string {
    // chronological, oldest first — row 0 of the chrono index sits at the BOTTOM
    const all = [...this.samples.values()].sort((a, b) => a.startedAt - b.startedAt);

    const width = Math.max(120, opts.width || 320);
    const n = all.length;
    // Empty paper still draws the labeled AXIS (so the instrument is visible the
    // moment the panel opens) — only the TRACE strokes obey the no-placeholders
    // rule (§5.9): no fake lines, just the grid + a "waiting" hint.
    const EMPTY_ROWS = 5;
    const rows = n > 0 ? n : EMPTY_ROWS;
    const height = TOP_PAD + rows * ROW_H + BOTTOM_PAD;

    const rowTop = (c: number): number => TOP_PAD + (n - 1 - c) * ROW_H;
    const rowBot = (c: number): number => rowTop(c) + ROW_H;
    const rowOf = new Map<string, number>();
    all.forEach((s, c) => rowOf.set(s.runId, c));
    // time → y: the paper position the timeline had reached at instant t
    // (top edge of the row of the last sample started at/before t).
    const timeToY = (t: number): number => {
      let c = -1;
      for (let i = 0; i < n; i++) {
        if (all[i].startedAt <= t) c = i;
        else break;
      }
      return c < 0 ? rowBot(0) : rowTop(c);
    };
    const colX = (lvl: string): number => eegStopX(lvl, width);

    const mains = all.filter((s) => !s.subagent);
    // parent main-line column at instant t (for branch split/join anchors)
    const mainColAt = (t: number): number => {
      let best: EegSample | undefined;
      for (const m of mains) {
        if (m.startedAt <= t) best = m;
        else break;
      }
      if (!best && mains.length > 0) best = mains[0];
      return best ? colX(best.chosenLevel) : colX("");
    };

    // ── defs: google rainbow, defined ONCE ──
    const defs =
      `<defs><linearGradient id="eeg-google" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="#4285F4"/>` +
      `<stop offset="33%" stop-color="#EA4335"/>` +
      `<stop offset="66%" stop-color="#FBBC05"/>` +
      `<stop offset="100%" stop-color="#34A853"/>` +
      `</linearGradient></defs>`;

    // ── column gridlines + top labels (the 8 shared stops, short form) ──
    let grid = "";
    for (const stop of EEG_STOPS) {
      const x = fx(colX(stop.lvl));
      grid +=
        `<line class="eeg-grid" x1="${x}" y1="${TOP_PAD - 4}" x2="${x}" y2="${height - BOTTOM_PAD}"` +
        ` stroke="#8A8F98" stroke-opacity="0.18" stroke-width="1"/>`;
      grid +=
        `<text class="eeg-collabel" x="${x}" y="${TOP_PAD - 10}" text-anchor="middle"` +
        ` font-size="8" fill="#8A8F98">${esc(stop.short)}</text>`;
    }

    // ── empty paper: axis only + a hint, no trace strokes ──
    if (n === 0) {
      const hint =
        `<text class="eeg-empty-hint" x="${fx(width / 2)}"` +
        ` y="${fx(TOP_PAD + (EMPTY_ROWS * ROW_H) / 2)}" text-anchor="middle"` +
        ` font-size="9" fill="#8A8F98">waiting for model activity…</text>`;
      return (
        `<svg class="eeg-paper" width="${width}" height="${height}"` +
        ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
        `${defs}${grid}${hint}</svg>`
      );
    }

    // ── halos (measured reality, drawn BEHIND everything else) ──
    // Prediction (line at chosenLevel) vs actuality (halo at the thinkingChars
    // bucket) divergence is the debugging signal.
    let halos = "";
    for (const s of all) {
      if (typeof s.thinkingChars !== "number") continue;
      const c = rowOf.get(s.runId)!;
      const hx = fx(colX(thinkingCharsLevel(s.thinkingChars)));
      const w = eegCostWidthPx(s.model, s.chosenLevel);
      const paint = eegProviderPaint(s.provider);
      halos +=
        `<line class="eeg-halo" x1="${hx}" y1="${rowBot(c)}" x2="${hx}" y2="${rowTop(c)}"` +
        ` stroke="${paint.stroke}" stroke-opacity="0.18" stroke-width="${fx(w * 2.6)}"` +
        ` stroke-linecap="round"/>`;
    }

    // ── main-session trace: one continuous line, per-sample stroke style ──
    // Each sample's <path> = the incoming connector from the previous (older,
    // lower) main sample + its own vertical run; column hops are cubic beziers
    // spanning ~14px (ARC_HALF each side of the row boundary).
    let trace = "";
    for (let m = 0; m < mains.length; m++) {
      const s = mains[m];
      const c = rowOf.get(s.runId)!;
      const x = colX(s.chosenLevel);
      const yT = rowTop(c);
      const yB = rowBot(c);
      const w = eegCostWidthPx(s.model, s.chosenLevel);
      const paint = eegProviderPaint(s.provider);
      // solid = router's choice; dashed = user-pinned via the sliders
      const dash = s.forced ? ` stroke-dasharray="6 4"` : "";
      let d: string;
      const prev = m > 0 ? mains[m - 1] : undefined;
      if (!prev) {
        d = `M ${fx(x)} ${yB} L ${fx(x)} ${yT + ARC_HALF}`;
      } else {
        const pc = rowOf.get(prev.runId)!;
        const px = colX(prev.chosenLevel);
        const pTop = rowTop(pc) + ARC_HALF; // where prev's vertical stopped
        if (px === x) {
          d = `M ${fx(x)} ${pTop} L ${fx(x)} ${yT + ARC_HALF}`;
        } else {
          const yIn = yB - ARC_HALF;
          const midY = (pTop + yIn) / 2;
          d =
            `M ${fx(px)} ${pTop} C ${fx(px)} ${fx(midY)} ${fx(x)} ${fx(midY)} ${fx(x)} ${yIn}` +
            ` L ${fx(x)} ${yT + ARC_HALF}`;
        }
      }
      trace +=
        `<path class="eeg-main" d="${d}" fill="none" stroke="${paint.stroke}"` +
        ` stroke-width="${fx(w)}" stroke-linecap="round"${dash}` +
        ` data-eeg-run="${esc(s.runId)}"/>`;
    }

    // ── subagent branches: split off the parent, strand, join back ──
    // Concurrency stacking: overlapping-in-time subagents with the SAME
    // (model + chosenLevel) cluster into parallel strands; ≥5 concurrent draws
    // EXACTLY 5 strands + an ×N badge (invariant 4).
    const subs = all.filter((s) => s.subagent);
    const byKey = new Map<string, EegSample[]>();
    for (const s of subs) {
      const k = `${s.model}|${s.chosenLevel}`;
      const arr = byKey.get(k);
      if (arr) arr.push(s);
      else byKey.set(k, [s]);
    }
    const clusters: SubCluster[] = [];
    for (const items of byKey.values()) {
      items.sort((a, b) => a.startedAt - b.startedAt);
      let cur: SubCluster | null = null;
      for (const s of items) {
        const sEnd = s.endedAt ?? Infinity;
        if (cur && s.startedAt <= cur.end) {
          cur.items.push(s);
          cur.end = Math.max(cur.end, sEnd);
        } else {
          cur = { items: [s], start: s.startedAt, end: sEnd };
          clusters.push(cur);
        }
      }
    }
    let branches = "";
    for (const cl of clusters) {
      const lead = cl.items[0];
      const x = colX(lead.chosenLevel);
      const w = eegCostWidthPx(lead.model, lead.chosenLevel);
      const paint = eegProviderPaint(lead.provider);
      const dash = lead.forced ? ` stroke-dasharray="6 4"` : "";
      const leadRow = rowOf.get(lead.runId)!;
      const ySplit = rowBot(leadRow);
      // split from the explicit parent's column when known, else from wherever
      // the main line was at split time
      const parentSample = lead.parentRunId ? this.samples.get(lead.parentRunId) : undefined;
      const parentX =
        parentSample && !parentSample.subagent
          ? colX(parentSample.chosenLevel)
          : mainColAt(cl.start);
      const hasEnd = Number.isFinite(cl.end);
      // join no lower than the strand's own row top; running → open to the top
      const yJoin = hasEnd ? Math.min(timeToY(cl.end), rowTop(leadRow)) : TOP_PAD;
      const jx = hasEnd ? mainColAt(cl.end) : 0;
      const nTotal = cl.items.length;
      const nDraw = Math.min(STRAND_CAP, nTotal);
      const step = w + 1.5; // lateral stacking step, centered on the column
      for (let i = 0; i < nDraw; i++) {
        const sx = x + (i - (nDraw - 1) / 2) * step;
        const yOut = ySplit - ARC_HALF * 2;
        const yJoinIn = hasEnd ? yJoin + ARC_HALF * 2 : yJoin;
        let d =
          `M ${fx(parentX)} ${ySplit}` +
          ` C ${fx(parentX)} ${ySplit - ARC_HALF} ${fx(sx)} ${ySplit - ARC_HALF} ${fx(sx)} ${yOut}`;
        if (yJoinIn < yOut) d += ` L ${fx(sx)} ${fx(yJoinIn)}`;
        if (hasEnd) {
          d += ` C ${fx(sx)} ${fx(yJoin + ARC_HALF)} ${fx(jx)} ${fx(yJoin + ARC_HALF)} ${fx(jx)} ${fx(yJoin)}`;
        }
        branches +=
          `<path class="eeg-branch" d="${d}" fill="none" stroke="${paint.stroke}"` +
          ` stroke-width="${fx(w)}" stroke-linecap="round"${dash}` +
          ` data-eeg-run="${esc(lead.runId)}"/>`;
      }
      if (nTotal >= STRAND_CAP) {
        // magnitude badge at the split point (5 strands stand in for all N)
        const bx = x + ((nDraw - 1) / 2) * step + 5;
        const fill = paint.isRainbow ? "#8A8F98" : paint.stroke;
        branches +=
          `<text class="eeg-xn" x="${fx(bx)}" y="${ySplit - 4}" font-size="9"` +
          ` fill="${fill}">×${nTotal}</text>`;
      }
    }

    // ── turn markers: dashed line + 't N' label + generous invisible hit rect ──
    // app.ts delegates clicks on `.eeg-marker` (scroll chat to that turn).
    let markers = "";
    for (const t of this.turnEnds) {
      const y = timeToY(t.endedAt);
      const attrs =
        `class="eeg-marker" data-eeg-turn="${t.turn}" data-eeg-run="${esc(t.runId)}"` +
        ` style="cursor:pointer"`;
      markers +=
        `<line ${attrs} x1="2" y1="${y}" x2="${width - 2}" y2="${y}"` +
        ` stroke="#8A8F98" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="4 4"/>`;
      markers +=
        `<text ${attrs} x="${width - 4}" y="${y - 3}" text-anchor="end" font-size="8"` +
        ` fill="#8A8F98">t ${t.turn}</text>`;
      markers += `<rect ${attrs} x="0" y="${y - 5}" width="${width}" height="10" fill="transparent"/>`;
    }

    // paint order: grid → halos → branches → main trace → markers (clickable on top)
    return (
      `<svg class="eeg-paper" width="${width}" height="${height}"` +
      ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      `${defs}${grid}${halos}${branches}${trace}${markers}</svg>`
    );
  }
}
