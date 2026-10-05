/**
 * CALL TIMELINE — the DRAWING half (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §5.3–5.7, B5).
 *
 * One Canvas 2D element, plus DOM overlay text (the title row, the two lane scales, the legend, the
 * tooltip, the aria-live line) so every word is crisp at any DPR and readable by assistive tech (§5.5).
 *
 * FORK 2026-10-02 (the owner) — ONE COLUMN PER CALL of the latest prompt, equal widths, side by side:
 * top the tokens each call sent, stacked by bucket; bottom what it got back, by kind. No time on the
 * axis, so no empty stretch and no sliver of a quick call (the 2026-10-01 rate chart is superseded,
 * call-timeline.ts "Columns"). The canvas redraws when data arrives (and through the 120 ms
 * estimate → exact ease), and is still otherwise. Every geometric decision is made by the pure
 * module call-timeline.ts; this file turns it into pixels.
 *
 * Mounted ONCE into the static `#cache-timeline` host that sits BESIDE `#cache-panel-body` (P9):
 * renderCachePanel() rewrites that body's innerHTML on every event, and a canvas inside it would be
 * destroyed within one model call. Nothing here is rebuilt after mount.
 *
 * Budget (§5.6): each frame is timed with performance.now() into a ring of the last 240 frames and
 * the p95 is exposed by debugSnapshot() — an unmeasured budget is not a budget (design-principles
 * #20). What keeps a frame cheap: no layout reads (sizes come from a ResizeObserver) and no
 * getComputedStyle (the palette is read at mount and on a DPR change); fills and strokes batched
 * into one Path2D per style; and only the latest prompt's calls are walked, once, one column each.
 * Since 2026-10-01 a frame runs per data event, not per animation tick, so the budget matters far
 * less than when the 2,000-call whole-session view (measured 2026-09-24 at p95 1.5–3.4 ms) redrew at
 * 60 Hz. The in-browser reading is still the verdict.
 *
 * Colours: segment and output colours ONLY from SEGMENT_COLORS (P4); the neutrals and the red come
 * from the base.css tokens (--text, --muted, --border, --red), read once. No hex lives here.
 */

import {
  BREAK_CSS_PX,
  COLUMN_FLOOR_CSS_PX,
  UNITEMISED_KEY,
  columnHeight,
  columnSlots,
  describeCall,
  fmtDuration,
  isEasing,
  lastDataAt,
  layoutAxis,
  lodKeep,
  outputPieces,
  promptWindow,
  rescaleFactor,
  stackHeights,
  type CallTimelineStore,
  type TimelineCall,
} from "./call-timeline.js";
import { fmtTokens } from "./context-cache.js";
import { SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline.js";

/** §5.3 — the canvas is 72 CSS px: top lane, an 8 px axis band, bottom lane. */
export const CANVAS_CSS_HEIGHT = 72;
const AXIS_CSS_PX = 8;
/** §5.6 — the per-frame scripting budget the p95 is judged against. */
export const FRAME_BUDGET_MS = 2;
const PERF_RING = 240;
/** §5.7 — prefers-reduced-motion: no eases, and redraw at most 4 Hz. */
const REDUCED_FRAME_MS = 250;
/** Both lanes' fill. Provenance (exact, estimated, apportioned) is in the tooltip, not the paint. */
const LANE_ALPHA = 0.85;
const STYLE_ID = "call-timeline-style";

type Dash = "solid" | "dashed" | "dotted";

export interface CallTimelineDeps {
  /** Host truth: is a run live on the viewed session? AND-ed with the store's own evidence. */
  isLive: () => boolean;
}

export interface CallTimelineDebug {
  frames: number;
  sampled: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;
  overBudget: boolean;
  animating: boolean;
  visible: boolean;
  documentHidden: boolean;
  reducedMotion: boolean;
  cssWidth: number;
  dpr: number;
  lodKeep: number;
  calls: number;
  bins: number;
  tools: number;
  turns: number;
}

export interface CallTimelineView {
  /** Point the view at a session's store (null = nothing attached). Cheap when unchanged. */
  setStore(store: CallTimelineStore | null): void;
  /** Data changed: draw once, and keep drawing while something moves. */
  invalidate(): void;
  /** The §5.6 perf probe — p95 of the last 240 frames against FRAME_BUDGET_MS. */
  debugSnapshot(): CallTimelineDebug;
  /** Re-read the base.css tokens (a theme change would call this; there is one theme today). */
  refreshPalette(): void;
  destroy(): void;
}

// ─── Styles: tokens only, injected once (tinker-ui has no per-module stylesheet) ───

// .ctl-sr is pinned top:0;left:0 (2026-10-02). The announcer is appended last, so its static
// spot hung 1 px below the host, and that pixel gave the CONTEXT WINDOW panel a scrollbar.
const CSS = `
#cache-timeline{position:relative;margin-top:8px}
.ctl-stage{position:relative;margin-top:3px;border:1px solid var(--border);border-radius:3px;background:var(--surface)}
.ctl-canvas{display:block;width:100%;height:${CANVAS_CSS_HEIGHT}px;outline:none;cursor:crosshair;border-radius:2px}
.ctl-canvas:focus-visible{box-shadow:0 0 0 1px var(--accent)}
.ctl-scale{position:absolute;right:3px;font:9px/1 "SF Mono",monospace;color:var(--muted);pointer-events:none;padding:1px 3px;border-radius:2px;background:color-mix(in srgb,var(--surface) 78%,transparent)}
.ctl-scale--out{top:2px}
.ctl-scale--in{bottom:2px}
.ctl-scale:empty{display:none}
.ctl-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 10px;text-align:center;font-size:10px;color:var(--muted);pointer-events:none}
.ctl-empty[hidden]{display:none}
.ctl-tip{position:absolute;bottom:calc(100% + 4px);z-index:6;padding:5px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:10px/1.4 "SF Mono",monospace;white-space:pre-line;pointer-events:none;box-shadow:0 6px 18px color-mix(in srgb,var(--bg) 75%,transparent)}
.ctl-tip[hidden]{display:none}
.ctl-legend{margin-top:4px}
.ctl-dot--compaction{background:color-mix(in srgb,var(--red) 35%,transparent)}
.ctl-sr{position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ─── Palette ───

interface Paint {
  text: string;
  muted: string;
  border: string;
  red: string;
  hatch: CanvasPattern | string;
}

function readPaint(ctx: CanvasRenderingContext2D | null, dpr: number): Paint {
  const cs = getComputedStyle(document.documentElement);
  // Fallbacks are palette entries, never literals: a missing token must not smuggle in a colour.
  const tok = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  const text = tok("--text", SEGMENT_COLORS.userMessage);
  const paint: Paint = {
    text,
    muted: tok("--muted", SEGMENT_COLORS.userMessage),
    border: tok("--border", SEGMENT_COLORS.userMessage),
    red: tok("--red", SEGMENT_COLORS.conversation),
    hatch: text,
  };
  // The unitemised hatch, mirroring .cache-seg--unitemised (135°, 17 % / 9 % of --text).
  const size = Math.max(4, Math.round(6 * dpr));
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  if (t && ctx) {
    t.fillStyle = text;
    t.globalAlpha = 0.09;
    t.fillRect(0, 0, size, size);
    t.globalAlpha = 0.17;
    t.lineWidth = size / 2;
    t.strokeStyle = text;
    t.beginPath();
    for (let k = -size; k <= size * 2; k += size) {
      t.moveTo(k, size);
      t.lineTo(k + size, 0);
    }
    t.stroke();
    paint.hatch = ctx.createPattern(tile, "repeat") ?? text;
  }
  return paint;
}

// ─── Mount ───

export function mountCallTimeline(host: HTMLElement, deps: CallTimelineDeps): CallTimelineView {
  ensureStyle();
  host.textContent = "";

  const title = document.createElement("div");
  title.className = "cache-meta cache-meta--title";
  const titleK = document.createElement("span");
  titleK.textContent = "CALL TIMELINE";
  const titleV = document.createElement("span");
  title.append(titleK, titleV);

  const stage = document.createElement("div");
  stage.className = "ctl-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "ctl-canvas";
  canvas.setAttribute("role", "img");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Call timeline: no model calls yet.");
  // The class names keep the gateway's view (--out = sent out, --in = coming back in); the WORDS on
  // screen take the model's, like every other figure in the panel. Until 2026-09-30 the input stack
  // was captioned "out", which read as "this lane is output" (the architect).
  const scaleOut = document.createElement("span");
  scaleOut.className = "ctl-scale ctl-scale--out";
  scaleOut.title =
    "Top lane: one column per call, the tokens it sent, stacked by what they are. The tallest column is the largest prompt of this view, named here.";
  const scaleIn = document.createElement("span");
  scaleIn.className = "ctl-scale ctl-scale--in";
  scaleIn.title =
    "Bottom lane: one column per call, the tokens it got back, by kind. The tallest column is the largest reply of this view, named here.";
  const empty = document.createElement("div");
  empty.className = "ctl-empty";
  empty.textContent = "No model calls yet";
  const tip = document.createElement("div");
  tip.className = "ctl-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  stage.append(canvas, scaleOut, scaleIn, empty, tip);

  const legend = document.createElement("div");
  legend.className = "cache-legend ctl-legend";
  const announcer = document.createElement("div");
  announcer.className = "ctl-sr";
  announcer.setAttribute("aria-live", "polite");
  host.append(title, stage, legend, announcer);

  const ctx = canvas.getContext("2d");
  let dpr = window.devicePixelRatio || 1;
  let paint = readPaint(ctx, dpr);
  let cssWidth = 0;
  let visible = false;
  const motion =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = Boolean(motion?.matches);
  let store: CallTimelineStore | null = null;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let animating = false;
  let lastFrameStart = 0;
  /** What the last frame drew: the calls and their columns, in device px — hit tests read this. */
  let drawn: { calls: TimelineCall[]; slots: Array<{ x0: number; x1: number }> } | null = null;
  let selectedId: string | null = null;
  let hover: { kind: "call"; id: string } | null = null;
  let tipVersion = -1;
  let legendKey = "";
  let seenTurnsEnded = -1;
  let seenStore: CallTimelineStore | null = null;
  const costs = new Float64Array(PERF_RING);
  let frames = 0;
  let lastCost = 0;
  // ── scheduling (§5.6): a frame only when visible, and a loop only while something moves ──

  function schedule(): void {
    if (!visible || document.hidden || raf !== 0 || timer !== null) {
      return;
    }
    if (reduced) {
      const wait = Math.max(0, REDUCED_FRAME_MS - (performance.now() - lastFrameStart));
      timer = setTimeout(frame, wait);
    } else if (typeof requestAnimationFrame === "function") {
      raf = requestAnimationFrame(frame);
    } else {
      timer = setTimeout(frame, 16);
    }
  }

  function frame(): void {
    raf = 0;
    timer = null;
    lastFrameStart = performance.now();
    let more = false;
    try {
      more = draw();
    } catch (err) {
      // A drawing bug must not take the rail down with it; one console line is the trace.
      console.warn("[call-timeline] draw failed", err);
    }
    lastCost = performance.now() - lastFrameStart;
    costs[frames % PERF_RING] = lastCost;
    frames++;
    animating = more;
    if (more) {
      schedule();
    }
  }

  function invalidate(): void {
    schedule();
  }

  // ── batching: one Path2D per style, filled / stroked once per frame ──
  //
  // Keyed alpha → (dash →) style → path: a few Map hits and no string built per mark — at 2,000
  // calls that is tens of thousands of allocations a frame avoided.

  const fills = new Map<number, Map<string, Path2D>>();
  const strokes = new Map<number, Map<Dash, Map<string, Path2D>>>();
  function fillPath(style: string, alpha: number): Path2D {
    let byStyle = fills.get(alpha);
    if (!byStyle) {
      byStyle = new Map();
      fills.set(alpha, byStyle);
    }
    let p = byStyle.get(style);
    if (!p) {
      p = new Path2D();
      byStyle.set(style, p);
    }
    return p;
  }
  function strokePath(style: string, dash: Dash, alpha: number): Path2D {
    let byDash = strokes.get(alpha);
    if (!byDash) {
      byDash = new Map();
      strokes.set(alpha, byDash);
    }
    let byStyle = byDash.get(dash);
    if (!byStyle) {
      byStyle = new Map();
      byDash.set(dash, byStyle);
    }
    let p = byStyle.get(style);
    if (!p) {
      p = new Path2D();
      byStyle.set(style, p);
    }
    return p;
  }
  function colourOf(style: string): string | CanvasPattern {
    switch (style) {
      case UNITEMISED_KEY:
        return paint.hatch;
      case "@text":
        return paint.text;
      case "@muted":
        return paint.muted;
      case "@border":
        return paint.border;
      case "@red":
        return paint.red;
      default:
        return SEGMENT_COLORS[style] ?? paint.muted;
    }
  }
  function flush(c: CanvasRenderingContext2D): void {
    for (const [alpha, byStyle] of fills) {
      c.globalAlpha = alpha;
      for (const [style, p] of byStyle) {
        c.fillStyle = colourOf(style);
        c.fill(p);
      }
    }
    // Strokes after every fill: edges, rules, capsules and the focus ring sit on top.
    const lw = Math.max(1, Math.round(dpr));
    c.lineWidth = lw;
    for (const [alpha, byDash] of strokes) {
      c.globalAlpha = alpha;
      for (const [dash, byStyle] of byDash) {
        c.setLineDash(dash === "dashed" ? [3 * lw, 2 * lw] : dash === "dotted" ? [lw, 2 * lw] : []);
        for (const [style, p] of byStyle) {
          c.strokeStyle = colourOf(style);
          c.stroke(p);
        }
      }
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
    fills.clear();
    strokes.clear();
  }

  // ── the prompt on screen ──

  /**
   * FORK 2026-10-01 — the calls the graph draws: the latest prompt's (`promptView`), oldest first. A
   * history row is left out: it is a whole turn whose per-call timing was never recorded, so any
   * shape drawn for it would be invented. FORK 2026-10-02 — or the last run with calls, held while
   * the newest prompt has none (`view.newer`), so the range ends at the view's last call.
   */
  function timedCalls(s: CallTimelineStore): TimelineCall[] {
    const view = s.promptView();
    const out: TimelineCall[] = [];
    if (!view) {
      return out;
    }
    const end = Math.min(s.calls.length, view.firstCall + view.calls);
    for (let i = view.firstCall; i < end; i++) {
      if (!s.calls[i].historic) {
        out.push(s.calls[i]);
      }
    }
    return out;
  }

  // ── the frame ──

  function draw(): boolean {
    if (!ctx) {
      return false;
    }
    const d = window.devicePixelRatio || 1;
    if (d !== dpr) {
      dpr = d;
      paint = readPaint(ctx, dpr);
    }
    const W = Math.max(0, Math.round(cssWidth * dpr));
    const H = Math.round(CANVAS_CSS_HEIGHT * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    if (W === 0) {
      return false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const axisH = Math.max(4, Math.round(AXIS_CSS_PX * dpr));
    const laneH = Math.floor((H - axisH) / 2);
    const axisTop = laneH;
    const axisBot = laneH + axisH;
    const axisMid = axisTop + Math.floor(axisH / 2) + 0.5;
    const px = Math.max(1, Math.round(dpr));

    const s = store;
    const now = Date.now();
    // §5.3 retention: the store bins its oldest calls per pixel of the session's time span. The
    // drawing no longer reads time, so that span is laid out here, and only when binning is due.
    if (s && Number.isFinite(s.earliestAt)) {
      const keep = lodKeep(W);
      if (s.calls.length > keep || s.bins.length > W) {
        s.compact(
          keep,
          layoutAxis([{ start: s.earliestAt, end: s.latestAt }], {
            t0: s.earliestAt,
            t1: s.latestAt,
            width: W,
            breakPx: BREAK_CSS_PX * dpr,
            gapMs: s.gapThreshold(),
          }),
        );
      }
    }
    const calls = s ? timedCalls(s) : [];
    if (!s || calls.length === 0) {
      // The empty state still draws the axis, so the panel reads as a waiting instrument.
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = paint.border;
      ctx.fillRect(0, Math.floor(axisMid), W, px);
      ctx.globalAlpha = 1;
      drawn = null;
      updateOverlay(s, calls, null);
      return false;
    }

    // The prompt's span, first send → last token, for the title only: time is not on the axis.
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    let easing = false;
    let inMax = 0;
    let outMax = 0;
    const outs = calls.map((c) => {
      t0 = Math.min(t0, c.sendAt);
      t1 = Math.max(t1, lastDataAt(c));
      if (isEasing(c, now, reduced)) {
        easing = true;
      }
      inMax = Math.max(inMax, c.stack.total);
      const pieces = outputPieces(c, rescaleFactor(c, now, reduced));
      outMax = Math.max(
        outMax,
        pieces.reduce((acc, p) => acc + p.tokens, 0),
      );
      return pieces;
    });

    // One column per call, equal widths, side by side: the time between and inside calls is cut out.
    // Wide columns keep a 1 px seam at their right edge so neighbours read as separate calls.
    const slots = columnSlots(calls.length, W);
    drawn = { calls, slots };
    const floorPx = Math.max(1, Math.round(COLUMN_FLOOR_CSS_PX * dpr));
    // The legend names what THIS frame painted (2026-10-02), not every key the session ever saw: a
    // bare `send` estimate is briefly one unitemised block, and a session-wide record would list
    // "Unitemised" under a graph that no longer shows any.
    const legendOf = { keys: new Set<string>(), absent: false, compactions: false };
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const { x0, x1 } = slots[i];
      const w = Math.max(1, x1 - x0 - (x1 - x0 >= 6 * px ? px : 0));

      // 1. Top lane — what the call sent, stacked up from the axis in P3 order (moral code first,
      //    the unitemised remainder last).
      const inH = columnHeight(c.stack.total, inMax, laneH, floorPx);
      if (inH > 0) {
        const pieces = c.stack.pieces;
        const hs = stackHeights(pieces, inH, floorPx);
        let y = axisTop;
        for (let q = 0; q < pieces.length; q++) {
          if (hs[q] > 0) {
            y -= hs[q];
            fillPath(pieces[q].key, LANE_ALPHA).rect(x0, y, w, hs[q]);
            legendOf.keys.add(pieces[q].key);
          }
        }
      }
      // P3 in the lane: a call that carried NO ethics pack gets a red rule on the axis under its
      // column. A stroke, so it is painted after every fill.
      if (c.stack.moral === "absent") {
        legendOf.absent = true;
        const rule = strokePath("@red", "solid", 1);
        rule.moveTo(x0, axisTop - px / 2);
        rule.lineTo(x0 + w, axisTop - px / 2);
      }

      // 2. Bottom lane — what came back, stacked down from the axis by kind.
      const pieces = outs[i];
      const outH = columnHeight(
        pieces.reduce((acc, p) => acc + p.tokens, 0),
        outMax,
        laneH,
        floorPx,
      );
      if (outH > 0) {
        const hs = stackHeights(pieces, outH, floorPx);
        let y = axisBot;
        for (let q = 0; q < pieces.length; q++) {
          if (hs[q] > 0) {
            fillPath(pieces[q].key, LANE_ALPHA).rect(x0, y, w, hs[q]);
            legendOf.keys.add(pieces[q].key);
            y += hs[q];
          }
        }
      }
    }

    // 3. Axis band — one baseline across the width: there is no idle stretch left to mark.
    fillPath("@border", 1).rect(0, Math.floor(axisMid), W, px);

    // 4. Compactions inside the prompt — a red seam at the column edge where each one began.
    const view = s.promptView();
    const from = view?.start ?? t0;
    for (const k of s.compactions) {
      if (k.start < from || (view?.end !== undefined && k.start > view.end)) {
        continue;
      }
      const j = calls.findIndex((c) => c.sendAt >= k.start);
      const x = j < 0 ? W - 2 * px : slots[j].x0;
      fillPath("@red", 0.85).rect(Math.max(0, x - px), 0, 2 * px, H);
      legendOf.compactions = true;
    }

    // 5. The selected / hovered call, outlined across both lanes.
    const focusId = selectedId ?? (hover?.kind === "call" ? hover.id : null);
    const fi = focusId ? calls.findIndex((c) => c.id === focusId) : -1;
    if (fi >= 0) {
      const { x0, x1 } = slots[fi];
      strokePath("@text", "solid", 0.9).rect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), H - 1);
    }

    flush(ctx);
    updateOverlay(s, calls, { t0, t1 }, inMax, outMax, legendOf);
    // Only the estimate → exact ease keeps the loop running; otherwise the next data event redraws.
    return easing;
  }

  // ── DOM overlay (text) — written only when it changes, never re-laid-out per frame ──

  function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  function updateOverlay(
    s: CallTimelineStore | null,
    calls: readonly TimelineCall[],
    span: { t0: number; t1: number } | null,
    inMax = 0,
    outMax = 0,
    legendOf?: { keys: ReadonlySet<string>; absent: boolean; compactions: boolean },
  ): void {
    const view = s?.promptView() ?? null;
    // What the stage says when there is nothing to draw.
    let note = "";
    if (!view) {
      note = "No model calls yet";
    } else if (calls.length === 0 && view.calls > 0) {
      note = `Prompt ${view.ordinal} is from history: its per-call timing was not recorded. The next prompt draws live.`;
    } else if (calls.length === 0) {
      note = view.ordinal > 0 ? `Preparing prompt ${view.ordinal}…` : "Preparing the prompt…";
    }
    setText(empty, note);
    if (empty.hidden !== (note === "")) {
      empty.hidden = note === "";
    }
    if (!s || !view) {
      setText(titleV, "");
      titleV.removeAttribute("title");
      setText(scaleOut, "");
      setText(scaleIn, "");
      setLegend("");
      return;
    }
    const n = calls.length;
    const last = calls[n - 1];
    // Sent, and no token back yet: the graph holds still, and the title says why.
    const waiting = last !== undefined && last.endAt === undefined && promptWindow(last) === null;
    const dur = span && n > 0 ? fmtDuration(span.t1 - span.t0) : "";
    const parts = [view.ordinal > 0 ? `prompt ${view.ordinal}` : "this prompt"];
    if (n > 0) {
      parts.push(`${n} call${n === 1 ? "" : "s"}`);
    }
    if (dur) {
      parts.push(dur);
    }
    if (waiting) {
      parts.push("waiting for the first token");
    }
    // FORK 2026-10-02 — the held run is not the newest prompt: say which one is, and why it is not
    // drawn yet.
    const newer = view.newer;
    if (newer) {
      const p = newer.ordinal > 0 ? `prompt ${newer.ordinal}` : "next prompt";
      parts.push(
        newer.state === "preparing"
          ? `${p} preparing…`
          : newer.state === "history"
            ? `${p}: no per-call record`
            : `${p}: no model call`,
      );
    }
    const titleText = parts.join(" · ");
    setText(titleV, titleText);
    // The row ellipsizes (.cache-meta--title, nowrap) in a narrow rail; the hover keeps the whole.
    if (titleV.title !== titleText) {
      titleV.title = titleText;
    }
    setText(scaleOut, inMax > 0 ? `in ↑ ${fmtTokens(Math.round(inMax))}` : "");
    setText(scaleIn, outMax > 0 ? `out ↓ ${fmtTokens(Math.round(outMax))}` : "");
    if (legendOf) {
      // The swatches of what this frame painted, in the bar's order; the output kinds follow.
      const order = Object.keys(SEGMENT_COLORS).filter((k) => legendOf.keys.has(k));
      const unitemised = legendOf.keys.has(UNITEMISED_KEY);
      setLegend(
        `${order.join(",")}|${unitemised}|${legendOf.absent}|${legendOf.compactions}`,
        order,
        unitemised,
        legendOf.absent,
        legendOf.compactions,
      );
    } else {
      setLegend("");
    }
    // aria (§5.7): the canvas label follows each completed turn; the live region announces it once.
    if (seenStore !== s || seenTurnsEnded !== s.turnsEnded) {
      const announce = seenStore === s && s.turnsEnded > seenTurnsEnded;
      seenStore = s;
      seenTurnsEnded = s.turnsEnded;
      const summary = s.lastTurnSummary();
      canvas.setAttribute(
        "aria-label",
        `Call timeline of the latest prompt: ${n} model call${n === 1 ? "" : "s"}${dur ? ` over ${dur}` : ""}.` +
          " One column per call. Top lane: the tokens each call sent, by bucket. Bottom lane: the tokens it got back, by kind." +
          (summary ? ` ${summary}` : "") +
          " Left and right arrow keys step through the calls.",
      );
      if (announce && summary) {
        announcer.textContent = summary;
      }
    }
    if (!tip.hidden && s.version !== tipVersion) {
      renderTip(false);
    }
  }

  /** Rebuilt only when what is painted changes kind (the key string), never per delta. */
  function setLegend(
    key: string,
    order: string[] = [],
    unitemised = false,
    absent = false,
    compactions = false,
  ): void {
    if (key === legendKey) {
      return;
    }
    legendKey = key;
    legend.textContent = "";
    const item = (dotClass: string, text: string, colour?: string, help?: string): void => {
      const span = document.createElement("span");
      span.className = "cache-legend-item";
      if (help) {
        span.title = help;
      }
      const dot = document.createElement("i");
      dot.className = dotClass ? `cache-dot ${dotClass}` : "cache-dot";
      if (colour) {
        dot.style.background = colour;
      }
      span.append(dot, document.createTextNode(text));
      legend.append(span);
    };
    // The same swatches as the bar's legend, in the bar's order; the output kinds follow.
    if (absent) {
      item(
        "cache-dot--moral-absent",
        "moral code: absent",
        undefined,
        "A call carried no ethics pack.",
      );
    }
    let unitemisedPlaced = false;
    for (const k of order) {
      if (k.startsWith("response") && unitemised && !unitemisedPlaced) {
        item("cache-dot--unitemised", SEGMENT_LABELS[UNITEMISED_KEY] ?? UNITEMISED_KEY);
        unitemisedPlaced = true;
      }
      item("", SEGMENT_LABELS[k] ?? k, SEGMENT_COLORS[k]);
    }
    if (unitemised && !unitemisedPlaced) {
      item("cache-dot--unitemised", SEGMENT_LABELS[UNITEMISED_KEY] ?? UNITEMISED_KEY);
    }
    if (compactions) {
      item(
        "ctl-dot--compaction",
        "compaction",
        undefined,
        "The session's context was being compacted.",
      );
    }
  }

  // ── tooltip, hover, keyboard (§5.7) ──

  /** The middle of the focused call's column, in CSS px. */
  function tipAnchorX(): number | null {
    if (!drawn) {
      return null;
    }
    const id = selectedId ?? (hover?.kind === "call" ? hover.id : null);
    const i = id ? drawn.calls.findIndex((k) => k.id === id) : -1;
    return i >= 0 ? (drawn.slots[i].x0 + drawn.slots[i].x1) / 2 / dpr : null;
  }

  /** Place the tooltip by its edge nearer the middle, so its own width is never measured. */
  function placeTip(xCss: number): void {
    const w = cssWidth;
    if (xCss <= w / 2) {
      tip.style.left = `${Math.max(0, Math.round(xCss - 8))}px`;
      tip.style.right = "auto";
      tip.style.maxWidth = `${Math.max(160, Math.round(w - xCss + 8))}px`;
    } else {
      tip.style.left = "auto";
      tip.style.right = `${Math.max(0, Math.round(w - xCss - 8))}px`;
      tip.style.maxWidth = `${Math.max(160, Math.round(xCss + 8))}px`;
    }
  }

  function renderTip(reposition: boolean, lines?: string[]): void {
    const s = store;
    if (!s) {
      hideTip();
      return;
    }
    let text = lines;
    if (!text) {
      const id = selectedId ?? (hover?.kind === "call" ? hover.id : null);
      const c = id ? s.calls.find((k) => k.id === id) : undefined;
      if (c) {
        text = describeCall(c, { turnOrdinal: s.turnOrdinal(c.runId), now: Date.now() });
      }
    }
    if (!text) {
      hideTip();
      return;
    }
    tipVersion = s.version;
    setText(tip, text.join("\n"));
    tip.hidden = false;
    if (reposition) {
      const x = tipAnchorX();
      if (x !== null) {
        placeTip(x);
      }
    }
  }

  function hideTip(): void {
    if (!tip.hidden) {
      tip.hidden = true;
    }
  }

  /** The call whose column is under `xDevice`, from what the last frame drew. Columns tile the width,
   *  so every x inside it names a call; a later column wins where two share a pixel. */
  function hitTest(xDevice: number): TimelineCall | null {
    if (!drawn) {
      return null;
    }
    for (let i = drawn.slots.length - 1; i >= 0; i--) {
      if (xDevice >= drawn.slots[i].x0 && xDevice < drawn.slots[i].x1) {
        return drawn.calls[i];
      }
    }
    return null;
  }

  function onPointerMove(ev: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const xCss = ev.clientX - rect.left;
    const hit = hitTest(xCss * dpr);
    if (!hit) {
      hover = null;
      if (!selectedId) {
        hideTip();
      }
    } else {
      // The pointer outranks a keyboard selection: whoever moved last is who the tooltip answers.
      selectedId = null;
      hover = { kind: "call", id: hit.id };
      renderTip(true);
    }
    invalidate();
  }

  function onPointerLeave(): void {
    hover = null;
    if (!selectedId) {
      hideTip();
    }
    invalidate();
  }

  function step(delta: number | "first" | "last"): void {
    const s = store;
    // ← → Home End step through the calls on screen, never into ones the graph does not draw.
    const calls = s ? timedCalls(s) : [];
    if (calls.length === 0) {
      return;
    }
    const i = selectedId ? calls.findIndex((c) => c.id === selectedId) : -1;
    const count = calls.length;
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? count - 1
          : i < 0
            ? count - 1
            : Math.min(count - 1, Math.max(0, i + delta));
    selectedId = calls[next].id;
    renderTip(true);
    invalidate();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "ArrowLeft") {
      step(-1);
    } else if (ev.key === "ArrowRight") {
      step(1);
    } else if (ev.key === "Home") {
      step("first");
    } else if (ev.key === "End") {
      step("last");
    } else if (ev.key === "Escape") {
      selectedId = null;
      hideTip();
      canvas.blur();
      invalidate();
    } else {
      return;
    }
    ev.preventDefault();
  }

  function onFocus(): void {
    // A click focuses the canvas too: keep the call under the pointer rather than jumping away.
    if (hover?.kind === "call") {
      selectedId = hover.id;
      renderTip(true);
      invalidate();
    } else {
      step("last");
    }
  }

  function onBlur(): void {
    selectedId = null;
    if (!hover) {
      hideTip();
    }
    invalidate();
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("focus", onFocus);
  canvas.addEventListener("blur", onBlur);

  // ── observers: size, visibility, motion preference ──

  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const e of entries) {
            cssWidth = e.contentRect.width;
          }
          invalidate();
        })
      : null;
  if (ro) {
    ro.observe(canvas);
  } else {
    cssWidth = canvas.clientWidth;
  }

  // Folded (`model:cache` hides the body with display:none), scrolled away, or the rail panel
  // collapsed: all read as "not intersecting", so one observer pauses every one of those.
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            visible = e.isIntersecting;
          }
          if (visible) {
            invalidate();
          }
        })
      : null;
  if (io) {
    io.observe(canvas);
  } else {
    visible = true;
  }

  // The last pause case: the document itself hidden. rAF stops there; the reduced-motion timer
  // does not, which is why schedule() checks document.hidden and this re-arms on return.
  const onVisibility = (): void => {
    if (!document.hidden) {
      invalidate();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  const onMotion = (): void => {
    reduced = Boolean(motion?.matches);
    invalidate();
  };
  motion?.addEventListener("change", onMotion);

  return {
    setStore(next: CallTimelineStore | null): void {
      if (next !== store) {
        store = next;
        selectedId = null;
        hover = null;
        hideTip();
      }
      invalidate();
    },
    invalidate,
    debugSnapshot(): CallTimelineDebug {
      const sampled = Math.min(frames, PERF_RING);
      const sorted = Array.from(costs.subarray(0, sampled)).sort((a, b) => a - b);
      const q = (p: number): number =>
        sampled === 0 ? 0 : sorted[Math.min(sampled - 1, Math.max(0, Math.ceil(p * sampled) - 1))];
      const p95 = q(0.95);
      return {
        frames,
        sampled,
        lastMs: Number(lastCost.toFixed(3)),
        p50Ms: Number(q(0.5).toFixed(3)),
        p95Ms: Number(p95.toFixed(3)),
        maxMs: Number((sampled > 0 ? sorted[sampled - 1] : 0).toFixed(3)),
        budgetMs: FRAME_BUDGET_MS,
        overBudget: p95 > FRAME_BUDGET_MS,
        animating,
        visible,
        documentHidden: document.hidden,
        reducedMotion: reduced,
        cssWidth,
        dpr,
        lodKeep: lodKeep(Math.round(cssWidth * dpr)),
        calls: store?.calls.length ?? 0,
        bins: store?.bins.length ?? 0,
        tools: store?.tools.length ?? 0,
        turns: store ? store.totals().turns : 0,
      };
    },
    refreshPalette(): void {
      paint = readPaint(ctx, dpr);
      invalidate();
    },
    destroy(): void {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motion?.removeEventListener("change", onMotion);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("focus", onFocus);
      canvas.removeEventListener("blur", onBlur);
      host.textContent = "";
    },
  };
}
