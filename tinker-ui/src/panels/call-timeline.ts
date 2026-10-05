/**
 * CALL TIMELINE — the PURE half: store + geometry (TINKER_UI_DESIGN_BIBLE/context-window-panel.md
 * §5, step B5).
 *
 * Two lanes around one axis, ONE COLUMN PER MODEL CALL of the latest prompt (`promptView`), equal
 * widths, side by side in send order (2026-10-02; the time-proportional rate chart before it is
 * superseded, see "Columns" below). Top: the tokens each call SENT, stacked from the axis upward in
 * the bar's P3 order so the moral code touches the axis. Bottom: the tokens it got BACK, by kind.
 * The store itself keeps the whole session, with every call's timing: THIS SESSION counts from it,
 * and the title and tooltip read the times from it.
 *
 * No DOM, no clock, no network: every method takes the event time it is about, so vitest pins the
 * geometry (call-timeline.test.ts) and call-timeline-canvas.ts only draws what this file decides.
 *
 * Colours: none here. The keys this module hands the renderer ARE the SEGMENT_COLORS keys of
 * context-timeline.ts (P4), and the top lane's stacking order is DERIVED from that table's key order
 * rather than restated, so a new palette key cannot be silently left out of the lane.
 */

import {
  ANATOMY_CHARS_PER_TOKEN,
  estimateTokens,
} from "../../../src/shared/anatomy-token-estimate.js";
import { cacheSegments, fmtTokens, moralCodeState } from "./context-cache.js";
import { SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline.js";

// ─── Constants (each one is a spec number; the section it comes from is named) ───

/** P11 — the one estimator: ceil(chars / 3.5), the anatomy's ladder (src/shared owns it). */
export const CHARS_PER_TOKEN = ANATOMY_CHARS_PER_TOKEN;
/** §5.3 — G never drops below this, so an overnight idle always folds. */
export const GAP_FLOOR_MS = 60_000;
/** §5.3 — a folded idle gap is drawn this wide, in CSS px (the renderer multiplies by the DPR). */
export const BREAK_CSS_PX = 6;
/** §5.3 — breaks may take at most this share of the width; past it the OLDEST breaks merge. */
export const MAX_BREAK_FRACTION = 1 / 3;
/** §5.3 — full detail for the newest K = 4 × canvas width (device px) calls; older ones are binned. */
export const LOD_CALLS_PER_DEVICE_PX = 4;
/** §5.4 — the estimate → exact ease. The renderer skips it under prefers-reduced-motion. */
export const RESCALE_EASE_MS = 120;
/**
 * NOT in the spec — a choice, named so it can be argued with. The axis never zooms in below this
 * span, so the first seconds of a session GROW from the left instead of the very first call
 * filling the whole lane on its first frame. Kept below GAP_FLOOR_MS so it can never create a fold.
 */
export const MIN_SPAN_MS = 20_000;
/**
 * An open run that has said nothing for this long is not treated as live. A dropped terminator
 * must not pin the rAF loop, or grow a phantom block toward `now`, for the life of the page.
 */
export const RUN_STALE_MS = 10 * 60_000;

/** Turn-phase ticks closer than this belong to the same preparation window. */
const PREP_JOIN_MS = 90_000;
/** A producer timestamp further than this from the browser's receipt time is not trusted. */
const CLOCK_TRUST_MS = 5_000;
/** Same-kind output deltas closer than this share one sample (bounds samples to ~12/s). */
const SAMPLE_COALESCE_MS = 80;
/** Past this a call's samples are thinned (the kind boundaries and the anchor are kept). */
const MAX_SAMPLES_PER_CALL = 480;
const MAX_RUNS = 96;
const MAX_GAPS = 512;
const MAX_COMPACTIONS = 256;
/**
 * Output samples one run snapshot keeps, shared by its calls. The live store keeps up to 480 per
 * call; a 60-call run would be ~250 KB of JSON at that, and the page keeps one snapshot per session.
 */
export const SNAPSHOT_SAMPLES = 1_500;

// P11 — ceil(chars / 3.5). The live ramp, the tool-call input and every estimate go through the ONE
// anatomy estimator in src/shared (canonical-derivations.md caps estimateTokens implementations).
export { estimateTokens };

// ─── Keys ───

/** What a call produces, in the bottom lane. These ARE SEGMENT_COLORS keys (P4). */
export type OutputKind = "responseThinking" | "responseText" | "responseToolCalls";
export const OUTPUT_KINDS: readonly OutputKind[] = [
  "responseThinking",
  "responseText",
  "responseToolCalls",
];

/**
 * The top lane's stacking order, from the axis upward — P3, moral code first.
 *
 * DERIVED from SEGMENT_COLORS' key order, which context-timeline.ts documents as the bar's draw
 * order ("the key order here IS the draw order"). Restating the eight names here would be a second
 * copy of an order that already has an owner (design-principles #18).
 */
export const TOP_LANE_KEYS: readonly string[] = Object.keys(SEGMENT_COLORS).filter(
  (k) => !k.startsWith("response"),
);

/** The billed remainder the anatomy could not attribute — the bar's hatched span, reused (§5.3). */
export const UNITEMISED_KEY = "unitemised";

// ─── Types ───

export interface Interval {
  start: number;
  end: number;
}

export interface OutSample {
  t: number;
  /** Cumulative ESTIMATED output tokens of the call at t (all kinds). */
  cum: number;
  /** What was being produced over (previous sample, this sample]. */
  kind: OutputKind;
}

export type CompositionSnapshot = "pre-call" | "post-turn" | "unknown";

export interface CallPrompt {
  /** Billed prompt of THIS call (input + cacheRead + cacheWrite). Only ever a per-call figure. */
  exact?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** A size the producer ESTIMATED before the call (the `call` contract's promptTokensEstimate). */
  estimate?: number;
  /** Top-lane key → tokens (ceil(chars/3.5)). `moralCode: 0` is a measured absence (P10). */
  composition?: Readonly<Record<string, number>>;
  /** The anatomy's own totalTokens, used as the size when nothing exact landed. */
  compositionTotal?: number;
  snapshot?: CompositionSnapshot;
  /**
   * FORK 2026-10-02 — where `composition` came from. "call": the call's own `usage` frame, from a
   * producer that saw the prompt the provider received (cc-bridge: the CLI's transcript), summing
   * to the billed prompt. Unset: an anatomy row, the gateway's view. An anatomy row never replaces
   * a "call" composition: it describes another scope.
   */
  source?: "call";
}

export interface PromptStack {
  /** Height of the block, in tokens. */
  total: number;
  provenance: "exact" | "estimated" | "none";
  moral: "present" | "absent" | "unknown";
  /** P3 order from the axis up; the unitemised remainder always last. */
  pieces: ReadonlyArray<{ key: string; tokens: number }>;
}

export type OutProvenance = "estimated" | "exact" | "apportioned" | "aggregate";

export interface TimelineCall {
  id: string;
  runId: string;
  /** 1-based index of the call within its run (the tool loop's round). */
  index: number;
  sendAt: number;
  sendProvenance: "exact" | "inferred";
  firstTokenAt?: number;
  endAt?: number;
  endProvenance?: "exact" | "inferred";
  lastEventAt: number;
  model?: string;
  prompt: CallPrompt;
  /** Derived from `prompt` on every write — never assigned directly. */
  stack: PromptStack;
  chars: Record<OutputKind, number>;
  samples: OutSample[];
  /** Sum of estimateTokens(chars[kind]) — the ramp's own last value. */
  outEstimate: number;
  /** The output total once known: exact, apportioned from a turn total, or a history aggregate. */
  outFinal?: number;
  outProvenance: OutProvenance;
  /** When outFinal landed — the clock of the 120 ms estimate → exact ease. */
  finalAt?: number;
  stopReason?: string;
  /** Backfilled from a context-anatomy row: the TURN's timing drawn as one block. */
  historic?: boolean;
  /**
   * The `call` contract's identity this call is bound to (CallFrame.wireKey: lane + callIndex).
   * Unset while the call is known only from the §5.4 fallbacks.
   */
  wireKey?: string;
}

/** Older calls merged per device-pixel column (§5.3 "the store compacts itself"). */
export interface CallBin {
  start: number;
  end: number;
  count: number;
  /** A bin is drawn as tall as its tallest member — what the eye would see if all were drawn. */
  promptMax: number;
  /** Kept for the tooltip: §5.3's "sum of tokens". */
  promptSum: number;
  outMax: number;
  outSum: number;
}

export interface TurnSpan {
  runId: string;
  /** First event of the run. */
  start: number;
  /** Where the 1 px turn tick goes: the start of its preparation window when one was seen. */
  tickAt: number;
  /** lifecycle start — the model was named. Call 1's inferred send time (§5.4 fallback). */
  modelAt?: number;
  end?: number;
  historic?: boolean;
}

export interface ToolSpan {
  id: string;
  runId: string;
  name: string;
  start: number;
  end?: number;
  isError?: boolean;
}

/** The window the timeline draws: one prompt. See CallTimelineStore.promptView. */
export interface PromptView {
  /** The prompt's submission: its turn tick, or the start of the open preparation window. */
  start: number;
  /** Its turn's end. Undefined while the prompt is being prepared or answered. */
  end?: number;
  /** The run answering it; undefined while it is still being prepared. */
  runId?: string;
  /** 1-based, counted like THIS SESSION's turns; 0 when the session has no turn at all. */
  ordinal: number;
  /** Index in `calls` of the prompt's first call (calls are sorted by send time). */
  firstCall: number;
  /** How many calls the prompt has made so far. */
  calls: number;
  /** The lane denominators over this prompt's calls alone: largest prompt, largest output. */
  prompt: number;
  out: number;
  /**
   * Set when this window is NOT the newest prompt: the newest has nothing to draw, so the last run
   * that does is held on screen (owner, 2026-10-02). Its ordinal, and why it has nothing: still
   * being prepared or answered before its first call, a turn that made no model call, or a history
   * row (no per-call timing).
   */
  newer?: { ordinal: number; state: "preparing" | "no-calls" | "history" };
}

/**
 * A finished run as the page recorded it, in a form that survives a reload (plain JSON). The store
 * lives in the page, so without this a reload leaves only history rows, which are not drawn.
 */
export interface RunSnapshot {
  v: 1;
  runId: string;
  turn: { start: number; tickAt: number; modelAt?: number; end: number };
  model?: string;
  calls: SnapshotCall[];
  tools: Array<{ id: string; name: string; start: number; end?: number; isError?: boolean }>;
  compactions: CompactionBand[];
}

export type SnapshotCall = Omit<
  TimelineCall,
  "id" | "runId" | "stack" | "samples" | "finalAt" | "historic"
> & {
  /** [t − sendAt, cumulative tokens, index into OUTPUT_KINDS], thinned (thinSamples). */
  samples: Array<[number, number, number]>;
};

export interface CompactionBand {
  start: number;
  end?: number;
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  tokensDropped?: number;
  completed?: boolean;
  provenance?: string;
}

// ─── Small numeric helpers ───

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const nonNeg = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};
const clamp01 = (p: number): number => (p <= 0 ? 0 : p >= 1 ? 1 : p);

export function easeOutCubic(p: number): number {
  const q = 1 - clamp01(p);
  return 1 - q * q * q;
}

/** Nearest-rank percentile; 0 for an empty set. */
export function percentile(values: readonly number[], q: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) {
    return 0;
  }
  const rank = Math.min(v.length, Math.max(1, Math.ceil(clamp01(q) * v.length)));
  return v[rank - 1];
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const s = ms / 1000;
  if (s < 10) {
    return `${s.toFixed(1)} s`;
  }
  if (s < 60) {
    return `${Math.round(s)} s`;
  }
  const min = Math.round(s / 60);
  if (min < 60) {
    return `${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 48) {
    return `${h} h ${min % 60} min`;
  }
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// ─── Geometry: G, activity, the piecewise axis ───

/**
 * §5.3 — G = max(60 s, 3 × the p90 of intra-turn gaps). Derived, not frozen (design-principles
 * #19): a normal tool-loop pause never folds and an overnight idle always does.
 */
export function gapThresholdMs(
  intraTurnGaps: readonly number[],
  floorMs: number = GAP_FLOOR_MS,
): number {
  const gaps = intraTurnGaps.filter((g) => Number.isFinite(g) && g >= 0);
  return Math.max(floorMs, 3 * percentile(gaps, 0.9));
}

/** Sort, then merge every pair whose gap is ≤ joinGapMs. Inputs are never mutated. */
export function mergeActivity(intervals: readonly Interval[], joinGapMs: number): Interval[] {
  const sorted: Interval[] = [];
  for (const iv of intervals) {
    if (!Number.isFinite(iv.start) || !Number.isFinite(iv.end)) {
      continue;
    }
    sorted.push(
      iv.start <= iv.end ? { start: iv.start, end: iv.end } : { start: iv.end, end: iv.start },
    );
  }
  sorted.sort((a, b) => a.start - b.start);
  const join = Math.max(0, joinGapMs);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start - last.end <= join) {
      if (iv.end > last.end) {
        last.end = iv.end;
      }
    } else {
      out.push(iv);
    }
  }
  return out;
}

export interface AxisPiece {
  kind: "active" | "break";
  start: number;
  end: number;
  x0: number;
  x1: number;
  /** Breaks only: false for an old break merged into a younger one (drawn 0 px wide, no glyph). */
  glyph: boolean;
  /** Breaks only: how many idle gaps this glyph stands for (1, or more once old breaks merge). */
  folded: number;
}

export interface AxisLayout {
  width: number;
  t0: number;
  t1: number;
  /** Pixels per millisecond inside an active stretch — the same everywhere on the axis. */
  scale: number;
  gapMs: number;
  /** Active stretches and breaks, alternating, left to right; the last x1 is exactly `width`. */
  pieces: AxisPiece[];
}

/**
 * §5.3 — the whole observed span [t0, t1], always fitting `width`.
 *
 * Every active stretch (activity plus the gaps ≤ G inside it) is laid out at ONE linear scale;
 * every idle gap > G becomes a fixed `breakPx` break. Scale = (width − breaks) ÷ active time, so the
 * pieces always sum to exactly `width` — the invariant call-timeline.test.ts holds over random
 * inputs. When breaks would exceed `maxBreakFraction` of the width, the OLDEST gaps merge into one
 * glyph (the gaps before it collapse to 0 px): recent structure keeps its breaks, deep history
 * compresses, which is the way the context itself compacts.
 */
export function layoutAxis(
  activity: readonly Interval[],
  opts: {
    t0: number;
    t1: number;
    width: number;
    breakPx: number;
    gapMs: number;
    maxBreakFraction?: number;
  },
): AxisLayout {
  const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : 0;
  const t0 = Math.min(opts.t0, opts.t1);
  const t1 = Math.max(opts.t0, opts.t1);
  const gapMs = Math.max(0, opts.gapMs);
  // The two ends are anchors: whatever the activity, the axis starts at t0 and ends at t1.
  const clipped: Interval[] = [
    { start: t0, end: t0 },
    { start: t1, end: t1 },
  ];
  for (const iv of activity) {
    const s = Math.max(t0, Math.min(iv.start, iv.end));
    const e = Math.min(t1, Math.max(iv.start, iv.end));
    if (s <= e) {
      clipped.push({ start: s, end: e });
    }
  }
  const active = mergeActivity(clipped, gapMs);
  const nGaps = active.length - 1;
  const breakPx = Number.isFinite(opts.breakPx) && opts.breakPx > 0 ? opts.breakPx : 0;
  const frac = opts.maxBreakFraction ?? MAX_BREAK_FRACTION;
  const maxBreaks = breakPx > 0 ? Math.floor((width * frac) / breakPx) : nGaps;

  const gapPx: number[] = Array.from({ length: nGaps }, () => breakPx);
  const glyph: boolean[] = Array.from({ length: nGaps }, () => breakPx > 0);
  const folded: number[] = Array.from({ length: nGaps }, () => 1);
  if (nGaps > maxBreaks) {
    if (maxBreaks <= 0) {
      gapPx.fill(0);
      glyph.fill(false);
    } else {
      const merged = nGaps - maxBreaks + 1;
      for (let i = 0; i < merged - 1; i++) {
        gapPx[i] = 0;
        glyph[i] = false;
        folded[i] = 0;
      }
      folded[merged - 1] = merged;
    }
  }

  const breakTotal = gapPx.reduce((a, b) => a + b, 0);
  const activeMs = active.reduce((a, iv) => a + (iv.end - iv.start), 0);
  const avail = Math.max(0, width - breakTotal);
  const scale = activeMs > 0 ? avail / activeMs : 0;
  const pieces: AxisPiece[] = [];
  // Zero active time (one instant): right-align, so the newest thing sits at the right edge.
  let x = activeMs > 0 ? 0 : avail;
  for (let i = 0; i < active.length; i++) {
    const iv = active[i];
    const x1 = x + (iv.end - iv.start) * scale;
    pieces.push({
      kind: "active",
      start: iv.start,
      end: iv.end,
      x0: x,
      x1,
      glyph: false,
      folded: 0,
    });
    x = x1;
    if (i < nGaps) {
      pieces.push({
        kind: "break",
        start: iv.end,
        end: active[i + 1].start,
        x0: x,
        x1: x + gapPx[i],
        glyph: glyph[i],
        folded: folded[i],
      });
      x += gapPx[i];
    }
  }
  // Pin the right edge: float drift must neither leave a hairline of unpainted axis nor overshoot.
  if (pieces.length > 0) {
    pieces[pieces.length - 1].x1 = width;
  }
  return { width, t0, t1, scale, gapMs, pieces };
}

/** Time → x. Continuous and non-decreasing; linear inside a break so a straddling mark stays whole. */
export function xAt(layout: AxisLayout, t: number): number {
  const p = layout.pieces;
  if (p.length === 0) {
    return 0;
  }
  if (t <= p[0].start) {
    return p[0].x0;
  }
  const last = p[p.length - 1];
  if (t >= last.end) {
    return last.x1;
  }
  let lo = 0;
  let hi = p.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].start <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const piece = p[lo];
  const span = piece.end - piece.start;
  if (span <= 0) {
    return piece.x1;
  }
  // Clamped to the piece: float interpolation can land an ulp past x1, and past the last piece
  // that is past the canvas (the panel review measured 4.4e-16 over on 5 of 3,000 cases).
  return Math.min(piece.x1, piece.x0 + ((t - piece.start) / span) * (piece.x1 - piece.x0));
}

/**
 * xAt for a stream of NON-DECREASING times — the renderer's calls, bins, tools and turn ticks are
 * all stored in time order — as one forward sweep over the pieces instead of a binary search per
 * mark. Same answers as xAt (call-timeline.test.ts holds them equal); an out-of-order time falls
 * back to xAt without moving the cursor, so a stray never corrupts the sweep.
 */
export function sweepX(layout: AxisLayout): (t: number) => number {
  const p = layout.pieces;
  let i = 0;
  // A typed cell, not a `let`: a double held in a closure is re-boxed on every store — one
  // allocation per mark per frame, which is exactly the loop this function exists to make cheap.
  const lastT = new Float64Array([Number.NEGATIVE_INFINITY]);
  return (t: number): number => {
    if (p.length === 0 || t < lastT[0]) {
      return xAt(layout, t);
    }
    lastT[0] = t;
    if (t <= p[0].start) {
      return p[0].x0;
    }
    const last = p[p.length - 1];
    if (t >= last.end) {
      return last.x1;
    }
    while (i < p.length - 1 && p[i + 1].start <= t) {
      i++;
    }
    const piece = p[i];
    const span = piece.end - piece.start;
    if (span <= 0) {
      return piece.x1;
    }
    return Math.min(piece.x1, piece.x0 + ((t - piece.start) / span) * (piece.x1 - piece.x0));
  };
}

/** x → time, the inverse used by hit-testing. Returns the piece too, so a hover can name a break. */
export function tAt(layout: AxisLayout, x: number): { t: number; piece: AxisPiece | null } {
  const p = layout.pieces;
  if (p.length === 0) {
    return { t: layout.t0, piece: null };
  }
  if (x <= p[0].x0) {
    return { t: p[0].start, piece: p[0] };
  }
  const last = p[p.length - 1];
  if (x >= last.x1) {
    return { t: last.end, piece: last };
  }
  let lo = 0;
  let hi = p.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].x0 <= x) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const piece = p[lo];
  const w = piece.x1 - piece.x0;
  const t = w <= 0 ? piece.start : piece.start + ((x - piece.x0) / w) * (piece.end - piece.start);
  return { t, piece };
}

/**
 * §5.3 — t0 = the earliest retained event; t1 = now while a run is live or the last event is within
 * G of now, else the last event. `nearNow` is also the renderer's "keep animating" clause (§5.6).
 */
export function observedSpan(
  earliest: number,
  latest: number,
  now: number,
  live: boolean,
  gapMs: number,
  minSpanMs: number = MIN_SPAN_MS,
): { t0: number; t1: number; nearNow: boolean } | null {
  if (!Number.isFinite(earliest)) {
    return null;
  }
  const last = Number.isFinite(latest) ? latest : earliest;
  const nearNow = live || now - last <= gapMs;
  let t1 = nearNow ? Math.max(now, last) : last;
  if (t1 - earliest < minSpanMs) {
    t1 = earliest + minSpanMs;
  }
  return { t0: earliest, t1, nearNow };
}

// ─── LOD ───

/** §5.3 — K = 4 × canvas width (device px), with a floor so a 0-width first frame bins nothing. */
export function lodKeep(widthDevicePx: number): number {
  return Math.max(32, Math.ceil(LOD_CALLS_PER_DEVICE_PX * Math.max(0, widthDevicePx)));
}

/** Merge bins that land in the same device-pixel column of `layout`. */
export function mergeBins(bins: readonly CallBin[], layout: AxisLayout): CallBin[] {
  const sorted = bins.slice().sort((a, b) => a.start - b.start);
  const out: CallBin[] = [];
  let col = Number.NaN;
  for (const b of sorted) {
    const c = Math.floor(xAt(layout, b.start));
    const last = out[out.length - 1];
    if (last && c === col) {
      last.end = Math.max(last.end, b.end);
      last.count += b.count;
      last.promptMax = Math.max(last.promptMax, b.promptMax);
      last.promptSum += b.promptSum;
      last.outMax = Math.max(last.outMax, b.outMax);
      last.outSum += b.outSum;
    } else {
      out.push({ ...b });
      col = c;
    }
  }
  return out;
}

// ─── Estimate → exact ───

/** Scale every sample by target ÷ last estimate: the TIMING is kept, the total becomes exact. */
export function rescaleSamples(samples: readonly OutSample[], target: number): OutSample[] {
  const last = samples.length > 0 ? samples[samples.length - 1].cum : 0;
  if (!(Number.isFinite(target) && target >= 0) || last <= 0) {
    return samples.map((s) => ({ ...s }));
  }
  const f = target / last;
  return samples.map((s) => ({ t: s.t, cum: s.cum * f, kind: s.kind }));
}

/**
 * Integers that sum to round(total), proportional to `weights` (largest remainder). All-zero weights
 * split evenly. Used for §5.4's "turn total apportioned by each call's estimated share".
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) {
    return [];
  }
  const target = Math.max(0, Math.round(Number.isFinite(total) ? total : 0));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const wSum = w.reduce((a, b) => a + b, 0);
  const base = wSum > 0 ? w : w.map(() => 1);
  const sum = wSum > 0 ? wSum : n;
  const raw = base.map((x) => (x / sum) * target);
  const out = raw.map((r) => Math.floor(r));
  let rest = target - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++) {
    out[order[k].i] += 1;
    rest -= 1;
  }
  return out;
}

/** The output total the lane is scaled by: the final figure once known, else the live estimate. */
export function outputTotal(c: TimelineCall): number {
  return c.outFinal ?? c.outEstimate;
}

/**
 * The multiplier the renderer applies to a call's samples this frame: 1 while estimated, easing to
 * outFinal ÷ estimate over RESCALE_EASE_MS once the final figure lands (at once when `reduced`).
 */
export function rescaleFactor(c: TimelineCall, now: number, reduced: boolean): number {
  if (c.outFinal === undefined || c.outEstimate <= 0) {
    return 1;
  }
  const target = c.outFinal / c.outEstimate;
  const p = reduced || c.finalAt === undefined ? 1 : clamp01((now - c.finalAt) / RESCALE_EASE_MS);
  return 1 + (target - 1) * easeOutCubic(p);
}

/** True while this call's ramp is still easing toward its final total. */
export function isEasing(c: TimelineCall, now: number, reduced: boolean): boolean {
  return (
    !reduced &&
    c.finalAt !== undefined &&
    c.outEstimate > 0 &&
    now - c.finalAt >= 0 &&
    now - c.finalAt < RESCALE_EASE_MS
  );
}

/**
 * The samples the bottom lane draws. The measured estimate when there is one; a straight ramp to
 * the final total when a figure landed for a call that streamed nothing we could see (a tool-only
 * reply, a history row) — straight because its timing was never measured, and the edge says so.
 */
export function rampOf(c: TimelineCall): readonly OutSample[] {
  if (c.samples.length > 1 || c.outFinal === undefined || c.outFinal <= 0 || c.outEstimate > 0) {
    return c.samples;
  }
  const start = c.firstTokenAt ?? c.sendAt;
  const end = Math.max(start, c.endAt ?? c.lastEventAt);
  const kind: OutputKind = c.chars.responseToolCalls > 0 ? "responseToolCalls" : "responseText";
  return [
    { t: start, cum: 0, kind },
    { t: end, cum: c.outFinal, kind },
  ];
}

/**
 * At most `max` of `samples` (more only when the kind changes more often than that). Kept: the
 * first (the anchor at depth 0), the last, the last sample of every run of one kind, then evenly
 * spaced ones. A dropped sample merges two segments into one, and because the last sample of each
 * kind run stays, a merged segment never spans two kinds: every token keeps its kind and its total.
 */
export function thinSamples(samples: readonly OutSample[], max: number): OutSample[] {
  const n = samples.length;
  if (n <= Math.max(2, max)) {
    return samples.slice();
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  for (let i = 0; i < n - 1; i++) {
    if (samples[i].kind !== samples[i + 1].kind) {
      keep[i] = 1;
    }
  }
  const room = max - keep.reduce((a, k) => a + k, 0);
  if (room > 0) {
    const step = (n - 1) / (room + 1);
    for (let q = 1; q <= room; q++) {
      keep[Math.round(q * step)] = 1;
    }
  }
  return samples.filter((_, i) => keep[i] === 1);
}

// ─── Columns ───
//
// FORK 2026-10-02 (owner: "the graph has horizontal gaps where nothing is sent nor received, they
// should be cut out ... some lines are very thin horizonally and vertically, so let's not be so
// rigorous with the time factor, and present a simplified graph where more area is painted").
// SUPERSEDES the 2026-10-01 rate chart (tokens per second over time, rateColumns), whose tool runs and
// waits left empty stretches and whose quick calls were slivers. Each call of the prompt now gets ONE
// column of equal width, side by side in send order, so no stretch without data is drawn and no call
// is narrow for being fast. A column's height is its token count against the lane's largest; inside
// it the pieces stack (top: the prompt's buckets in P3 order, moral code at the axis; bottom: the
// reply by kind). Within a lane every column is as wide as the next, so the area is still the token
// count. Time is no longer on the axis: the title carries the prompt's span, each call's tooltip its
// send → first token and duration.

/** The least height a non-empty column, and each piece in it, is drawn with, in CSS px. */
export const COLUMN_FLOOR_CSS_PX = 2;

/**
 * Where a call's prompt was taken in: its send to its first token. Null while no token has arrived,
 * and for a history row, whose per-call timing was never recorded (one row is a whole turn).
 */
export function promptWindow(c: TimelineCall): Interval | null {
  if (c.historic) {
    return null;
  }
  const first = c.firstTokenAt ?? (c.samples.length > 0 ? c.samples[0].t : undefined);
  if (first === undefined) {
    return null;
  }
  return { start: c.sendAt, end: Math.max(c.sendAt, first) };
}

/** The last instant a call moved data: its newest output sample, else its first token, else its send. */
export function lastDataAt(c: TimelineCall): number {
  let t = c.sendAt;
  if (c.firstTokenAt !== undefined && c.firstTokenAt > t) {
    t = c.firstTokenAt;
  }
  const ramp = rampOf(c);
  if (ramp.length > 0 && ramp[ramp.length - 1].t > t) {
    t = ramp[ramp.length - 1].t;
  }
  return t;
}

/**
 * `n` columns across `width` device px: contiguous, in order, integer edges, the first at 0 and the
 * last ending at `width`. With more calls than pixels each still gets 1 px and neighbours overlap
 * (the later drawn over the earlier) rather than vanish.
 */
export function columnSlots(n: number, width: number): Array<{ x0: number; x1: number }> {
  const w = Math.max(0, Math.floor(width));
  const out: Array<{ x0: number; x1: number }> = [];
  if (n <= 0 || w === 0) {
    return out;
  }
  for (let i = 0; i < n; i++) {
    const x0 = Math.min(w - 1, Math.floor((i * w) / n));
    const x1 = Math.min(w, Math.max(x0 + 1, Math.floor(((i + 1) * w) / n)));
    out.push({ x0, x1 });
  }
  return out;
}

/**
 * A column's height in device px: `tokens` against the lane's largest `max`, never below `floorPx`
 * while it holds anything (a small reply stays visible), never above the lane.
 */
export function columnHeight(tokens: number, max: number, laneH: number, floorPx: number): number {
  if (!(tokens > 0) || !(max > 0) || !(laneH > 0)) {
    return 0;
  }
  const h = Math.round((tokens / max) * laneH);
  return Math.min(laneH, Math.max(h, Math.min(floorPx, laneH)));
}

/**
 * Integer heights for one column's pieces, in the given order, summing to exactly `heightPx`.
 * Proportional; every present piece at least `floorPx` whenever the column has room for all the
 * floors; what the floors add is taken from the LARGEST pieces first, and from the moral code only
 * when nothing else is left above its floor (P2/P3: the moral code is never cut to show a sliver).
 *
 * Not the bar's allocateBarSpans: that one is built for a ~300 px bar with free space beside it,
 * where a floor is tiny. A column can be a few pixels tall, where two floors outweigh the one piece
 * that bar allocator may cut, and it then cuts that piece, a third of the tokens, to nothing.
 */
export function stackHeights(
  pieces: ReadonlyArray<{ key: string; tokens: number }>,
  heightPx: number,
  floorPx: number,
): number[] {
  const H = Math.max(0, Math.round(heightPx));
  const tokens = pieces.map((p) => (p.tokens > 0 ? p.tokens : 0));
  const total = tokens.reduce((acc, t) => acc + t, 0);
  if (H === 0 || !(total > 0)) {
    return tokens.map(() => 0);
  }
  const present = tokens.filter((t) => t > 0).length;
  const floor = Math.max(0, Math.floor(floorPx));
  const min = present * floor <= H ? floor : 0;
  const h = tokens.map((t) => (t > 0 ? Math.max(min, (t / total) * H) : 0));
  let excess = h.reduce((acc, v) => acc + v, 0) - H;
  while (excess > 1e-9) {
    let big = -1;
    for (const moralLast of [false, true]) {
      for (let i = 0; i < h.length; i++) {
        const moral = pieces[i].key === "moralCode";
        if (moral !== moralLast || h[i] <= min + 1e-9) {
          continue;
        }
        if (big < 0 || h[i] > h[big]) {
          big = i;
        }
      }
      if (big >= 0) {
        break;
      }
    }
    if (big < 0) {
      break;
    }
    // Down to the next largest (so the cut is shared), never below the floor or past the excess.
    let next = min;
    for (let i = 0; i < h.length; i++) {
      if (i !== big && h[i] < h[big] && h[i] > next) {
        next = h[i];
      }
    }
    const take = Math.min(excess, h[big] - Math.max(min, next));
    h[big] -= take;
    excess -= take;
  }
  // Integers that sum to H, each the floor of its share or one more (largest remainder).
  return apportion(H, h);
}

/**
 * What a call sent back, by kind, as the bottom lane stacks it: each kind's estimated share, scaled
 * by `factor` (rescaleFactor: the estimate eased to the exact total, §5.4). A call whose reply was
 * never streamed to us (a tool-only answer) is its final total as one kind.
 */
export function outputPieces(
  c: TimelineCall,
  factor: number,
): Array<{ key: OutputKind; tokens: number }> {
  const kinds = OUTPUT_KINDS.map((key) => ({ key, tokens: estimateTokens(c.chars[key]) }));
  const est = kinds.reduce((acc, k) => acc + k.tokens, 0);
  if (est > 0) {
    const f = factor > 0 ? factor : 1;
    return kinds.map((k) => ({ key: k.key, tokens: k.tokens * f }));
  }
  const total = outputTotal(c);
  if (!(total > 0)) {
    return kinds;
  }
  const only: OutputKind =
    c.chars.responseToolCalls > 0 || c.stopReason === "tool_use"
      ? "responseToolCalls"
      : "responseText";
  return OUTPUT_KINDS.map((key) => ({ key, tokens: key === only ? total : 0 }));
}

// ─── Prompt composition ───

/**
 * The top-lane composition of an anatomy `contextSent`, or undefined when it itemises nothing.
 *
 * Read through the BAR's own readers, not a second field map: `cacheSegments` owns "which anatomy
 * field is Skills" (its BAR_FIELD_ORDER is not exported, and should not be copied), and
 * `moralCodeState` owns P10's line between a measured zero and a missing reading — cacheSegments
 * drops zeros, so without it an absent pack would read as an unmeasured one. One reader means the
 * lane and the bar cannot disagree about a segment.
 */
export function compositionFromContextSent(cs: unknown): Record<string, number> | undefined {
  if (!cs || typeof cs !== "object") {
    return undefined;
  }
  const src = cs as Record<string, unknown>;
  const out: Record<string, number> = {};
  let any = false;
  for (const seg of cacheSegments(src, 0)) {
    out[seg.key] = seg.tokens;
    any = true;
  }
  if (moralCodeState(src) === "absent") {
    out.moralCode = 0;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * The block a call draws: known components at true scale in P3 order, and — when an exact total is
 * larger than what they account for — the remainder as the hatched `unitemised` span (the bar's
 * rule, reused). Never stretched: a legend figure must stay the measured figure.
 */
export function promptStack(p: CallPrompt): PromptStack {
  const pieces: Array<{ key: string; tokens: number }> = [];
  let sum = 0;
  for (const key of TOP_LANE_KEYS) {
    const v = p.composition?.[key] ?? 0;
    if (v > 0) {
      pieces.push({ key, tokens: v });
      sum += v;
    }
  }
  const moralRaw = p.composition?.moralCode;
  const moral: PromptStack["moral"] =
    typeof moralRaw !== "number" ? "unknown" : moralRaw > 0 ? "present" : "absent";
  const exact = p.exact !== undefined && p.exact > 0 ? p.exact : undefined;
  if (exact !== undefined) {
    if (exact > sum) {
      pieces.push({ key: UNITEMISED_KEY, tokens: exact - sum });
    }
    return { total: Math.max(exact, sum), provenance: "exact", moral, pieces };
  }
  const est = Math.max(sum, p.compositionTotal ?? 0, p.estimate ?? 0);
  if (est > sum) {
    pieces.push({ key: UNITEMISED_KEY, tokens: est - sum });
  }
  return { total: est, provenance: est > 0 ? "estimated" : "none", moral, pieces };
}

// ─── The store ───

interface RunState {
  runId: string;
  turn: TurnSpan;
  model?: string;
  callIds: string[];
  open?: string;
  /** The last tool RESULT since the previous call closed: the next call's inferred send (§5.4). */
  pendingSendAt?: number;
  /** Saw `stream:"call"` for this run: sends come from the contract, not from inference. */
  exactCalls: boolean;
  /** The contract's call identity (CallFrame.wireKey) → the id of the call it names. */
  wire: Map<string, string>;
  cumChars: Partial<Record<OutputKind, number>>;
  closed: boolean;
  lastEventAt: number;
  /** A pre-call composition that arrived before call 1 opened. */
  preCall?: CallPrompt;
}

/**
 * The `stream:"call"` payload (A8) as it arrives: every field `unknown` until parseCallFrame has
 * read it. The contract's owner is src/infra/call-telemetry.ts, gateway side.
 */
export interface CallStreamData {
  phase?: unknown;
  callIndex?: unknown;
  t?: unknown;
  lane?: unknown;
  promptTokensEstimate?: unknown;
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  output?: unknown;
  stopReason?: unknown;
  model?: unknown;
  composition?: unknown;
}

/** One `stream:"call"` frame, read. Every count is present only when the producer measured it. */
export interface CallFrame {
  phase: "send" | "usage" | "end";
  /** Where the frame goes on the axis: the producer's `t` when the clocks agree, else receipt. */
  at: number;
  /**
   * The call's identity inside its run, as the contract defines it: lane + callIndex. An IDENTITY,
   * never a position — the wire counts from 0, TimelineCall.index from 1, and nothing is derived
   * from one about the other (reading the wire's index as the store's is what first put call 2 on
   * top of call 1). Undefined when the frame carries no usable callIndex.
   */
  wireKey?: string;
  promptTokensEstimate?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  stopReason?: string;
  model?: string;
  /**
   * FORK 2026-10-02 — this call's prompt, itemised by the producer (the contract's
   * CallComposition): top-lane key → tokens, summing to the billed prompt. Only top-lane keys,
   * only measured values; absent when the producer could not see the prompt.
   */
  composition?: Record<string, number>;
}

const CALL_FRAME_COUNTS = [
  "promptTokensEstimate",
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
] as const;

/**
 * The ONE reader of `stream:"call"` in the UI (B6, context-window-panel.md §6.2). app.ts parses
 * each frame once and applies it to the session's CallTimelineStore; the call record that comes
 * back is what the ctx-timeline's column is built from (context-timeline.ts callColumn). One
 * reader, one interpreter, two views, so the rail and the bottom bar cannot disagree about a
 * phase, a clock or an absent count. Returns null for anything that is not one of the contract's
 * three phases.
 */
export function parseCallFrame(d: unknown, receivedAt: number): CallFrame | null {
  if (!d || typeof d !== "object") {
    return null;
  }
  const x = d as CallStreamData;
  const phase = x.phase === "send" || x.phase === "usage" || x.phase === "end" ? x.phase : null;
  if (!phase) {
    return null;
  }
  // Every other mark on this axis is placed by the BROWSER's receipt time. The producer's `t` is
  // more precise, but it is the gateway's clock: trusted only while it agrees with the browser's
  // to within CLOCK_TRUST_MS, so a skewed host cannot slide exact sends past their own tokens.
  const sent = num(x.t);
  const f: CallFrame = {
    phase,
    at: sent !== undefined && Math.abs(sent - receivedAt) <= CLOCK_TRUST_MS ? sent : receivedAt,
  };
  const idx = nonNeg(x.callIndex);
  if (idx !== undefined) {
    const lane = typeof x.lane === "string" && x.lane ? x.lane : "?";
    f.wireKey = `${lane}:${Math.floor(idx)}`;
  }
  // P10 — the producer's absent-not-zero rule, mirrored: a finite count >= 0 is kept, so a
  // measured 0 (no cache hit) stays 0; anything else is left out rather than zeroed.
  for (const key of CALL_FRAME_COUNTS) {
    const v = nonNeg(x[key]);
    if (v !== undefined) {
      f[key] = v;
    }
  }
  const stop = typeof x.stopReason === "string" ? x.stopReason.trim() : "";
  if (stop) {
    f.stopReason = stop;
  }
  if (typeof x.model === "string" && x.model) {
    f.model = x.model;
  }
  // The itemised prompt: only on `usage`, only the top-lane keys, only measured values (P10).
  if (phase === "usage" && x.composition && typeof x.composition === "object") {
    const src = x.composition as Record<string, unknown>;
    const composition: Record<string, number> = {};
    for (const key of TOP_LANE_KEYS) {
      const v = nonNeg(src[key]);
      if (v !== undefined) {
        composition[key] = v;
      }
    }
    if (Object.keys(composition).length > 0) {
      f.composition = composition;
    }
  }
  return f;
}

export interface CacheSampleData {
  promptTokens?: unknown;
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  output?: unknown;
  contextTokens?: unknown;
  provider?: unknown;
  model?: unknown;
}

const zeroChars = (): Record<OutputKind, number> => ({
  responseThinking: 0,
  responseText: 0,
  responseToolCalls: 0,
});

/**
 * One session's calls. Fed by app.ts, one method per live stream event, with the §5.4 fallbacks:
 *
 *   send time      `call` send (A8) — else call 1: lifecycle start (the model was named), later
 *                  calls: the previous call's last tool RESULT          → sendProvenance "inferred"
 *   first token    the first thinking / text / tool delta of the call
 *   end            `call` end (A8) — else the first tool START after the call's output (the model
 *                  asked for a tool, so its response was complete), else the run's end
 *   prompt size    `call` usage, or a per-call `cache` sample — else the latest anatomy (badged)
 *   output         cumulative ceil(chars/3.5) per delta, rescaled to `call` end / per-call `cache`
 *                  output when exact, or APPORTIONED from the `effort` final turn total — never
 *                  promoted to exact afterwards (§5.4)
 */
export class CallTimelineStore {
  readonly calls: TimelineCall[] = [];
  bins: CallBin[] = [];
  readonly tools: ToolSpan[] = [];
  readonly compactions: CompactionBand[] = [];
  readonly preps: Interval[] = [];
  readonly turns: TurnSpan[] = [];
  /** Bumped on EVERY mutation — the renderer's cache key for scales, legend and tooltip text. */
  version = 0;
  /** Bumped only when an interval appears, closes or moves — the key of the merged-activity cache.
   *  A streaming delta moves `version` but not this, so the per-frame merge stays small. */
  structureVersion = 0;
  /** Completed turns seen live; the renderer re-announces (aria-live) when this moves. */
  turnsEnded = 0;
  /** Calls merged into bins, and turns dropped with them — both still counted in the summary. */
  binnedCalls = 0;
  droppedTurns = 0;
  earliestAt = Number.POSITIVE_INFINITY;
  latestAt = Number.NEGATIVE_INFINITY;

  private readonly runs = new Map<string, RunState>();
  private readonly callById = new Map<string, TimelineCall>();
  private readonly toolById = new Map<string, ToolSpan>();
  private readonly openTools = new Set<ToolSpan>();
  private readonly gaps: number[] = [];
  private openPrep: Interval | null = null;
  private openCompaction: CompactionBand | null = null;
  private seed: CallPrompt | null = null;
  private lastEnded: string | null = null;
  private closedCache: { sv: number; gapMs: number; merged: Interval[] } | null = null;
  private scaleCache = { version: -1, prompt: 0, out: 0 };
  private viewCache: { version: number; view: PromptView | null } = { version: -1, view: null };
  private gapCache = { sv: -1, gapMs: GAP_FLOOR_MS };

  /**
   * Every palette key a call has drawn (stack pieces, output kinds). The legend reads this rather
   * than walking every call on every delta — measured 0.35 ms a delta at 2,000 calls. Monotone on
   * purpose: a key whose calls were binned stays listed, because the bins still draw its history.
   */
  readonly seenKeys = new Set<string>();
  sawMoralAbsent = false;
  /** Bumped only when seenKeys or sawMoralAbsent grows — the legend's cache key. */
  keysVersion = 0;
  /** Calls mutated since the renderer last drained them (its numeric cache patches only these). */
  private readonly dirty = new Set<TimelineCall>();
  /** A call was inserted, moved or removed: indices shifted, so the renderer rebuilds in full. */
  private dirtyAll = true;

  // ── bookkeeping ──

  private seeKey(key: string): void {
    if (!this.seenKeys.has(key)) {
      this.seenKeys.add(key);
      this.keysVersion++;
    }
  }

  private seeStack(st: PromptStack): void {
    for (const p of st.pieces) {
      this.seeKey(p.key);
    }
    if (st.moral === "absent" && !this.sawMoralAbsent) {
      this.sawMoralAbsent = true;
      this.keysVersion++;
    }
  }

  private markCall(c: TimelineCall): void {
    if (!this.dirtyAll) {
      this.dirty.add(c);
    }
  }

  private markAll(): void {
    this.dirtyAll = true;
    this.dirty.clear();
  }

  private setFinal(c: TimelineCall, value: number, provenance: OutProvenance, at: number): void {
    c.outFinal = value;
    c.outProvenance = provenance;
    c.finalAt = at;
    this.markCall(c);
  }

  /**
   * The calls changed since the last drain — `all` when calls were inserted, moved or removed (so
   * any index the caller holds is stale). One consumer: the renderer's numeric cache.
   */
  drainDirty(): { all: boolean; calls: TimelineCall[] } {
    const out = { all: this.dirtyAll, calls: this.dirtyAll ? [] : Array.from(this.dirty) };
    this.dirtyAll = false;
    this.dirty.clear();
    return out;
  }

  private touch(t: number, structural: boolean): void {
    if (Number.isFinite(t)) {
      if (t < this.earliestAt) {
        this.earliestAt = t;
      }
      if (t > this.latestAt) {
        this.latestAt = t;
      }
    }
    this.version++;
    if (structural) {
      this.structureVersion++;
    }
  }

  private run(runId: string, t: number): RunState {
    let r = this.runs.get(runId);
    if (r) {
      r.lastEventAt = Math.max(r.lastEventAt, t);
      return r;
    }
    const turn: TurnSpan = { runId, start: t, tickAt: t };
    // A preparation window still open when the run appears is THIS turn's: the tick goes at its
    // start (the moment the prompt was submitted), and the window ends where the model begins.
    const prep = this.openPrep;
    if (prep && t - prep.end <= PREP_JOIN_MS) {
      turn.tickAt = Math.min(prep.start, t);
      prep.end = Math.max(prep.end, t);
    }
    this.openPrep = null;
    this.turns.push(turn);
    r = {
      runId,
      turn,
      callIds: [],
      exactCalls: false,
      wire: new Map(),
      cumChars: {},
      closed: false,
      lastEventAt: t,
    };
    this.runs.set(runId, r);
    if (this.runs.size > MAX_RUNS) {
      for (const [id, old] of this.runs) {
        if (old.closed) {
          this.runs.delete(id);
          break;
        }
      }
    }
    this.structureVersion++;
    return r;
  }

  private callsOf(r: RunState): TimelineCall[] {
    const out: TimelineCall[] = [];
    for (const id of r.callIds) {
      const c = this.callById.get(id);
      if (c) {
        out.push(c);
      }
    }
    return out;
  }

  private lastCallOf(r: RunState): TimelineCall | undefined {
    const id = r.callIds[r.callIds.length - 1];
    return id ? this.callById.get(id) : undefined;
  }

  private setPrompt(c: TimelineCall, patch: Partial<CallPrompt>): void {
    c.prompt = { ...c.prompt, ...patch };
    c.stack = promptStack(c.prompt);
    this.seeStack(c.stack);
    this.markCall(c);
  }

  private insertCall(c: TimelineCall): void {
    this.markAll();
    this.seeStack(c.stack);
    const a = this.calls;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].sendAt <= c.sendAt) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    a.splice(lo, 0, c);
  }

  private moveSend(c: TimelineCall, sendAt: number): void {
    if (c.sendAt === sendAt) {
      return;
    }
    const i = this.calls.indexOf(c);
    if (i >= 0) {
      this.calls.splice(i, 1);
    }
    c.sendAt = sendAt;
    this.insertCall(c);
  }

  private closeCall(c: TimelineCall, at: number, provenance: "exact" | "inferred"): void {
    if (c.endProvenance === "exact" && provenance === "inferred") {
      return;
    }
    c.endAt = Math.max(at, c.sendAt);
    c.endProvenance = provenance;
    this.markCall(c);
  }

  private openCall(
    r: RunState,
    t: number,
    index: number | undefined,
    sendProvenance: "exact" | "inferred",
  ): TimelineCall {
    const prev = r.open ? this.callById.get(r.open) : undefined;
    if (prev && prev.endAt === undefined) {
      this.closeCall(prev, prev.lastEventAt, "inferred");
    }
    const last = this.lastCallOf(r);
    const idx = index ?? r.callIds.length + 1;
    const inferred = Math.min(t, r.pendingSendAt ?? r.turn.modelAt ?? r.turn.start);
    const sendAt = sendProvenance === "exact" ? t : inferred;
    const base: CallPrompt = r.preCall && idx === 1 ? r.preCall : (this.seed ?? {});
    const c: TimelineCall = {
      id: `${r.runId}#${idx}`,
      runId: r.runId,
      index: idx,
      sendAt,
      sendProvenance,
      lastEventAt: t,
      model: r.model,
      prompt: { ...base },
      stack: promptStack(base),
      chars: zeroChars(),
      samples: [],
      outEstimate: 0,
      outProvenance: "estimated",
    };
    // §5.3's G is derived from these: the pause between two calls of one turn (the tool loop).
    if (last?.endAt !== undefined && sendAt >= last.endAt) {
      this.gaps.push(sendAt - last.endAt);
      if (this.gaps.length > MAX_GAPS) {
        this.gaps.shift();
      }
    }
    r.pendingSendAt = undefined;
    r.callIds.push(c.id);
    r.open = c.id;
    this.callById.set(c.id, c);
    this.insertCall(c);
    this.structureVersion++;
    return c;
  }

  private pushSample(c: TimelineCall, kind: OutputKind, t: number): void {
    const cum =
      estimateTokens(c.chars.responseThinking) +
      estimateTokens(c.chars.responseText) +
      estimateTokens(c.chars.responseToolCalls);
    c.outEstimate = cum;
    this.seeKey(kind);
    this.markCall(c);
    const s = c.samples;
    if (s.length === 0) {
      // The anchor: depth 0 at the first token, so every ramp starts on the axis.
      s.push({ t, cum: 0, kind });
    }
    const last = s[s.length - 1];
    if (s.length > 1 && last.kind === kind && t - last.t < SAMPLE_COALESCE_MS) {
      last.t = Math.max(last.t, t);
      last.cum = cum;
    } else {
      s.push({ t: Math.max(t, last.t), cum, kind });
    }
    if (s.length > MAX_SAMPLES_PER_CALL) {
      // Thin: drop every other interior sample whose neighbours share its kind.
      const kept: OutSample[] = [s[0]];
      for (let i = 1; i < s.length - 1; i++) {
        const keep = i % 2 === 0 || s[i].kind !== s[i + 1].kind || s[i].kind !== s[i - 1].kind;
        if (keep) {
          kept.push(s[i]);
        }
      }
      kept.push(s[s.length - 1]);
      c.samples = kept;
    }
  }

  private callForOutput(r: RunState, t: number): TimelineCall | null {
    if (r.closed) {
      return null;
    }
    const open = r.open ? this.callById.get(r.open) : undefined;
    if (open && open.endAt === undefined) {
      return open;
    }
    // Output after an INFERRED close with no tool result since: still the same response (a
    // tool_use block streamed mid-message). Re-open it rather than invent a call.
    const last = this.lastCallOf(r);
    if (last && last.endProvenance === "inferred" && r.pendingSendAt === undefined) {
      last.endAt = undefined;
      last.endProvenance = undefined;
      r.open = last.id;
      this.markCall(last);
      this.structureVersion++;
      return last;
    }
    return this.openCall(r, t, undefined, "inferred");
  }

  // ── live feed ──

  /** lifecycle start — the model was named (call 1's inferred send). */
  turnStart(runId: string, t: number, model?: string): void {
    if (!runId) {
      return;
    }
    const r = this.run(runId, t);
    if (r.closed) {
      // A fallback model carries the turn on the SAME runId after an error (the chat handler keeps
      // the run alive for exactly this). Re-open it, or every token of the fallback is dropped —
      // and mark its start as the next call's send, so its first token opens a NEW call rather
      // than resuming the failed one.
      r.closed = false;
      r.turn.end = undefined;
      r.pendingSendAt = t;
    }
    r.turn.modelAt ??= t;
    if (model) {
      r.model = model;
    }
    this.touch(t, true);
  }

  /** lifecycle end / error, or the chat final — whichever arrives first; idempotent. */
  turnEnd(runId: string, t: number): void {
    const r = this.runs.get(runId);
    if (!r || r.closed) {
      return;
    }
    const open = r.open ? this.callById.get(r.open) : undefined;
    if (open && open.endAt === undefined) {
      this.closeCall(
        open,
        Math.max(open.lastEventAt, open.firstTokenAt ?? open.sendAt),
        "inferred",
      );
    }
    r.open = undefined;
    for (const tool of this.openTools) {
      if (tool.runId === runId) {
        tool.end = Math.max(t, tool.start);
        this.openTools.delete(tool);
      }
    }
    r.turn.end = Math.max(t, r.turn.start);
    r.closed = true;
    r.lastEventAt = Math.max(r.lastEventAt, t);
    this.turnsEnded++;
    this.lastEnded = runId;
    this.touch(t, true);
  }

  /** A delta of output: `deltaChars` more characters of `kind` on this run's current call. */
  outputChars(runId: string, kind: OutputKind, deltaChars: number, t: number): void {
    if (!runId || !(deltaChars > 0)) {
      return;
    }
    const r = this.run(runId, t);
    const c = this.callForOutput(r, t);
    if (!c) {
      return;
    }
    if (c.firstTokenAt === undefined) {
      c.firstTokenAt = t;
      this.structureVersion++;
    }
    c.chars[kind] += deltaChars;
    this.pushSample(c, kind, t);
    c.lastEventAt = Math.max(c.lastEventAt, t);
    this.touch(t, false);
  }

  /** The streams carry CUMULATIVE text per run (thinking `d.text`, the chat delta's content); this
   *  turns it into a delta. A shrink is a new base (a restarted stream), counted from zero. */
  outputCumulative(runId: string, kind: OutputKind, cumChars: number, t: number): void {
    if (!runId || !Number.isFinite(cumChars) || cumChars < 0) {
      return;
    }
    const r = this.run(runId, t);
    const prev = r.cumChars[kind] ?? 0;
    const delta = cumChars >= prev ? cumChars - prev : cumChars;
    r.cumChars[kind] = cumChars;
    this.outputChars(runId, kind, delta, t);
  }

  /**
   * A tool started: the model's response that asked for it is complete (§5.4 fallback end), and
   * the call's tool-call input joins its output as `responseToolCalls`.
   */
  toolStart(runId: string, toolId: string, name: string, t: number, argsChars: number): void {
    if (!runId || !toolId) {
      return;
    }
    const r = this.run(runId, t);
    let c = r.open ? this.callById.get(r.open) : undefined;
    if (!c || c.endAt !== undefined) {
      const last = this.lastCallOf(r);
      // A second tool of the SAME response (parallel tool calls): no result has come back yet.
      // Otherwise a call that produced nothing but a tool call — invisible until now.
      c =
        last && r.pendingSendAt === undefined && !r.closed
          ? last
          : this.openCall(r, t, undefined, "inferred");
    }
    if (c.firstTokenAt === undefined) {
      c.firstTokenAt = t;
    }
    if (argsChars > 0) {
      c.chars.responseToolCalls += argsChars;
      this.pushSample(c, "responseToolCalls", t);
    }
    c.lastEventAt = Math.max(c.lastEventAt, t);
    if (c.endProvenance !== "exact") {
      this.closeCall(c, Math.max(c.endAt ?? t, t), "inferred");
    }
    if (r.open === c.id) {
      r.open = undefined;
    }
    const span: ToolSpan = { id: toolId, runId, name: name || "tool", start: t };
    this.tools.push(span);
    this.toolById.set(toolId, span);
    this.openTools.add(span);
    this.touch(t, true);
  }

  toolEnd(toolId: string, t: number, isError: boolean): void {
    const span = this.toolById.get(toolId);
    if (!span || span.end !== undefined) {
      return;
    }
    span.end = Math.max(t, span.start);
    span.isError = isError;
    this.openTools.delete(span);
    const r = this.runs.get(span.runId);
    if (r && !r.closed) {
      r.pendingSendAt = Math.max(r.pendingSendAt ?? t, t);
      r.lastEventAt = Math.max(r.lastEventAt, t);
    }
    this.touch(t, true);
  }

  /**
   * The `stream:"call"` contract (A8) from a RAW payload: read by parseCallFrame, the stream's one
   * reader, then applied. app.ts parses the frame itself and calls applyCall, because the call
   * record that comes back also feeds the ctx-timeline.
   */
  callEvent(runId: string, d: unknown, receivedAt: number): TimelineCall | null {
    const f = parseCallFrame(d, receivedAt);
    return f ? this.applyCall(runId, f) : null;
  }

  /**
   * One parsed `call` frame (A8). Consumed when present; the §5.4 fallbacks above stand in until.
   * Returns the call it landed on (the ctx-timeline builds its column from that record), or null
   * when there is none: no runId, an `end` for a call never seen, or a call already binned.
   */
  applyCall(runId: string, f: CallFrame): TimelineCall | null {
    if (!runId) {
      return null;
    }
    const at = f.at;
    const r = this.run(runId, at);
    r.exactCalls = true;
    if (f.model) {
      r.model = f.model;
    }
    let c = this.callForFrame(r, f);
    if (c === null) {
      return null;
    }
    if (f.phase === "send") {
      if (!c) {
        c = this.openCall(r, at, undefined, "exact");
      } else {
        this.moveSend(c, at);
        c.sendProvenance = "exact";
        this.structureVersion++;
      }
      if (f.promptTokensEstimate !== undefined && f.promptTokensEstimate > 0) {
        this.setPrompt(c, { estimate: f.promptTokensEstimate });
      }
    } else if (f.phase === "usage") {
      c ??= this.openCall(r, at, undefined, "inferred");
      let itemised: Partial<CallPrompt> | undefined;
      if (f.composition) {
        // FORK 2026-10-02 — the producer itemised THIS call's prompt: it replaces any anatomy
        // stand-in, and no later anatomy row replaces it (composition() skips source "call").
        let total = 0;
        for (const v of Object.values(f.composition)) {
          total += v;
        }
        itemised = {
          composition: f.composition,
          compositionTotal: total,
          snapshot: "pre-call",
          source: "call",
        };
      }
      this.setPromptParts(c, f, itemised);
    } else {
      if (!c) {
        return null;
      }
      this.closeCall(c, at, "exact");
      if (r.open === c.id) {
        r.open = undefined;
      }
      // `end` may carry the parts again: the call's FINAL usage, which supersedes `usage`'s.
      this.setPromptParts(c, f);
      if (f.output !== undefined) {
        this.setFinal(c, f.output, "exact", at);
      }
      if (f.stopReason) {
        c.stopReason = f.stopReason;
      }
      this.structureVersion++;
    }
    if (f.wireKey !== undefined && c.wireKey === undefined) {
      c.wireKey = f.wireKey;
      r.wire.set(f.wireKey, c.id);
    }
    if (f.model) {
      c.model = f.model;
    }
    c.lastEventAt = Math.max(c.lastEventAt, at);
    this.touch(at, false);
    return c;
  }

  /**
   * The call a frame names. By the contract's identity once it is bound; until then the frame
   * ADOPTS the call the §5.4 fallbacks already opened for it: the run's open call, or (usage /
   * end) its last call while no tool result has come back since, i.e. the same response. An
   * adopted call keeps its own `index`. undefined = the frame needs a new call; null = its call
   * was binned (compact), and a binned call is not resurrected.
   */
  private callForFrame(r: RunState, f: CallFrame): TimelineCall | null | undefined {
    const open = r.open ? this.callById.get(r.open) : undefined;
    if (f.wireKey === undefined) {
      return open;
    }
    const bound = r.wire.get(f.wireKey);
    if (bound !== undefined) {
      return this.callById.get(bound) ?? null;
    }
    if (open && open.wireKey === undefined) {
      return open;
    }
    if (f.phase !== "send") {
      const last = this.lastCallOf(r);
      if (last && last.wireKey === undefined && r.pendingSendAt === undefined) {
        return last;
      }
    }
    return undefined;
  }

  /**
   * The provider's prompt parts onto a call; its size is their sum (the contract: parts, not a sum,
   * so the addition can be checked). A part this frame did not measure keeps what an earlier frame
   * measured, so an `end` re-reporting some parts can never shrink the prompt by omission.
   */
  private setPromptParts(c: TimelineCall, f: CallFrame, extra?: Partial<CallPrompt>): void {
    const parts = this.promptParts(c, f);
    if (parts || extra) {
      // ONE write: a composition landing with its parts never passes through a stack whose exact
      // total outgrows the old buckets, which would flash (and, seenKeys being monotone, leave in
      // the legend) an "unitemised" piece that the very same frame accounts for.
      this.setPrompt(c, { ...parts, ...extra });
    }
  }

  private promptParts(c: TimelineCall, f: CallFrame): Partial<CallPrompt> | undefined {
    if (f.input === undefined && f.cacheRead === undefined && f.cacheWrite === undefined) {
      return undefined;
    }
    const input = f.input ?? c.prompt.input;
    const cacheRead = f.cacheRead ?? c.prompt.cacheRead;
    const cacheWrite = f.cacheWrite ?? c.prompt.cacheWrite;
    const exact = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    return exact > 0 ? { exact, input, cacheRead, cacheWrite } : undefined;
  }

  /**
   * A `stream:"cache"` sample. Per-call and exact on the embedded pipe; a TURN AGGREGATE on the
   * cc-bridge lane (F7), which P5 forbids from ever being drawn as one call's prompt. Returns
   * whether it was applied. The lane test is a heuristic and says so: provider `claude-code`, or a
   * prompt larger than the window it reports (a sum over calls, not a context).
   */
  cacheSample(runId: string, d: CacheSampleData, t: number): boolean {
    const prompt = nonNeg(d.promptTokens) ?? 0;
    const windowTokens = nonNeg(d.contextTokens) ?? 0;
    const aggregate =
      d.provider === "claude-code" || (windowTokens > 0 && prompt > windowTokens) || prompt <= 0;
    if (aggregate) {
      return false;
    }
    const r = runId ? this.runs.get(runId) : undefined;
    const pool = r ? this.callsOf(r) : this.calls;
    let target: TimelineCall | undefined;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].prompt.exact === undefined) {
        target = pool[i];
        break;
      }
    }
    if (!target) {
      return false;
    }
    this.setPrompt(target, {
      exact: prompt,
      input: nonNeg(d.input),
      cacheRead: nonNeg(d.cacheRead),
      cacheWrite: nonNeg(d.cacheWrite),
    });
    const out = nonNeg(d.output);
    if (out !== undefined && out > 0 && target.outProvenance !== "exact") {
      this.setFinal(target, out, "exact", t);
    }
    if (!target.model && typeof d.model === "string" && d.model) {
      target.model = d.model;
    }
    this.touch(t, false);
    return true;
  }

  /**
   * The `effort` final turn total (§5.4 fallback): apportioned across the run's calls that have no
   * exact figure, by their estimated share. APPORTIONED stays apportioned — a later exact figure
   * for the same call replaces it, but nothing ever relabels an apportioned number as exact.
   */
  turnOutput(runId: string, total: number, t: number): void {
    const r = this.runs.get(runId);
    if (!r || !(total > 0)) {
      return;
    }
    const calls = this.callsOf(r);
    const rest = calls.filter((c) => c.outProvenance !== "exact");
    if (rest.length === 0) {
      return;
    }
    const exactSum = calls
      .filter((c) => c.outProvenance === "exact")
      .reduce((a, c) => a + (c.outFinal ?? 0), 0);
    const shares = apportion(
      Math.max(0, total - exactSum),
      rest.map((c) => c.outEstimate),
    );
    rest.forEach((c, i) => this.setFinal(c, shares[i], "apportioned", t));
    this.touch(t, false);
  }

  /**
   * A context-anatomy row. A PRE-CALL row belongs to its call (call 1 today, A9); a POST-TURN row
   * holds this turn's replies and tool results (F5), so it is only a badged stand-in — it fills the
   * turn's calls that have nothing better and seeds the next calls until a real figure lands.
   */
  composition(runId: string | undefined, anatomy: unknown, t: number): void {
    if (!anatomy || typeof anatomy !== "object") {
      return;
    }
    const a = anatomy as Record<string, unknown>;
    const composition = compositionFromContextSent(a.contextSent);
    if (!composition) {
      return;
    }
    const cs = a.contextSent as Record<string, unknown>;
    const snapshot: CompositionSnapshot =
      a.snapshot === "pre-call" ? "pre-call" : a.snapshot === "post-turn" ? "post-turn" : "unknown";
    const seed: CallPrompt = {
      composition,
      compositionTotal: nonNeg(cs.totalTokens),
      snapshot,
    };
    const r = runId ? this.runs.get(runId) : undefined;
    if (r) {
      if (snapshot === "pre-call") {
        const round = num(a.roundNumber);
        const idx = round !== undefined && round >= 1 ? Math.floor(round) : 1;
        const c = this.callById.get(`${r.runId}#${idx}`);
        if (c && c.prompt.source !== "call") {
          this.setPrompt(c, seed);
        } else if (!c && idx === 1) {
          r.preCall = seed;
        }
      } else {
        for (const c of this.callsOf(r)) {
          if (c.prompt.snapshot !== "pre-call" && c.prompt.source !== "call") {
            this.setPrompt(c, seed);
          }
        }
      }
    }
    this.seed = seed;
    this.touch(t, false);
  }

  compactionStart(t: number, d: Record<string, unknown> = {}): void {
    if (this.openCompaction) {
      return;
    }
    const band: CompactionBand = {
      start: t,
      trigger: typeof d.trigger === "string" ? d.trigger : undefined,
    };
    this.openCompaction = band;
    this.compactions.push(band);
    if (this.compactions.length > MAX_COMPACTIONS) {
      this.compactions.shift();
    }
    this.touch(t, true);
  }

  compactionEnd(t: number, d: Record<string, unknown> = {}): void {
    let band = this.openCompaction;
    if (!band) {
      // An end whose start this page never saw: its duration, when reported, places the start.
      const dur = nonNeg(d.durationMs) ?? 0;
      band = { start: t - dur };
      this.compactions.push(band);
    }
    band.end = Math.max(t, band.start);
    band.trigger = band.trigger ?? (typeof d.trigger === "string" ? d.trigger : undefined);
    band.tokensBefore = nonNeg(d.tokensBefore);
    band.tokensAfter = nonNeg(d.tokensAfter);
    band.tokensDropped = nonNeg(d.tokensDropped);
    band.completed = typeof d.completed === "boolean" ? d.completed : undefined;
    band.provenance = typeof d.provenance === "string" ? d.provenance : undefined;
    this.openCompaction = null;
    this.touch(t, true);
  }

  /** A `turn-phase` event: the gateway is preparing a turn (the dotted axis segment). */
  prepTick(t: number): void {
    const p = this.openPrep;
    if (p && t - p.end <= PREP_JOIN_MS && t >= p.start) {
      p.end = t;
    } else {
      const fresh = { start: t, end: t };
      this.openPrep = fresh;
      this.preps.push(fresh);
    }
    this.touch(t, true);
  }

  /**
   * Backfill from `/tinker/api/context-anatomy/<session>` rows so t0 is the earliest RETAINED event,
   * not the page load (§5.3). One row per turn: its [timestampMs, +durationMs] becomes one block,
   * its composition the block's stack, its responseTokens the ramp's total — drawn straight and
   * labelled `aggregate`, because a row holds the turn, not its calls. Rows whose run is live here
   * are skipped: the live record wins.
   */
  loadHistory(rows: readonly unknown[]): boolean {
    let added = 0;
    const firstLive = this.calls.find((c) => !c.historic)?.sendAt ?? Number.POSITIVE_INFINITY;
    const known = new Set(this.turns.map((tr) => tr.runId));
    const sorted = rows
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({ x, ts: num(x.timestampMs) }))
      .filter((e): e is { x: Record<string, unknown>; ts: number } => e.ts !== undefined)
      .sort((a, b) => a.ts - b.ts);
    for (const { x, ts } of sorted) {
      const runId = typeof x.runId === "string" && x.runId ? x.runId : `history:${ts}`;
      if (known.has(runId) || (typeof x.runId !== "string" && ts >= firstLive)) {
        continue;
      }
      known.add(runId);
      const dur = nonNeg(x.durationMs) ?? 0;
      const end = ts + dur;
      const turn: TurnSpan = { runId, start: ts, tickAt: ts, end, historic: true };
      this.turns.push(turn);
      const composition = compositionFromContextSent(x.contextSent);
      const cs = (x.contextSent ?? {}) as Record<string, unknown>;
      const prompt: CallPrompt = composition
        ? {
            composition,
            compositionTotal: nonNeg(cs.totalTokens),
            snapshot:
              x.snapshot === "pre-call"
                ? "pre-call"
                : x.snapshot === "post-turn"
                  ? "post-turn"
                  : "unknown",
          }
        : {};
      const outTotal = nonNeg(x.responseTokens) ?? 0;
      const kinds: Array<[OutputKind, number]> = [
        ["responseThinking", nonNeg(x.responseThinkingTokens) ?? 0],
        ["responseText", nonNeg(x.responseTextTokens) ?? 0],
        ["responseToolCalls", nonNeg(x.responseToolCallTokens) ?? 0],
      ];
      const kindSum = kinds.reduce((acc, [, v]) => acc + v, 0);
      const samples: OutSample[] = [];
      if (outTotal > 0) {
        // A schematic ramp over the turn, kinds in the order a turn produces them. Its timing was
        // never measured; the renderer draws an `aggregate` edge dotted so it cannot pass for one.
        samples.push({ t: ts, cum: 0, kind: "responseText" });
        let cum = 0;
        let at = ts;
        const parts = kindSum > 0 ? kinds.filter(([, v]) => v > 0) : [["responseText", 1]];
        const partSum = kindSum > 0 ? kindSum : 1;
        for (const [kind, v] of parts as Array<[OutputKind, number]>) {
          cum += (v / partSum) * outTotal;
          at += (v / partSum) * dur;
          samples.push({ t: at, cum, kind });
        }
        samples[0].kind = samples[1]?.kind ?? "responseText";
      }
      const c: TimelineCall = {
        id: `${runId}#1`,
        runId,
        index: 1,
        sendAt: ts,
        sendProvenance: "inferred",
        endAt: end,
        endProvenance: "inferred",
        lastEventAt: end,
        model: typeof x.model === "string" && x.model ? x.model : undefined,
        prompt,
        stack: promptStack(prompt),
        chars: zeroChars(),
        samples,
        outEstimate: outTotal,
        outFinal: outTotal > 0 ? outTotal : undefined,
        outProvenance: "aggregate",
        historic: true,
      };
      this.callById.set(c.id, c);
      this.insertCall(c);
      for (const smp of samples) {
        this.seeKey(smp.kind);
      }
      if (ts < this.earliestAt) {
        this.earliestAt = ts;
      }
      if (end > this.latestAt) {
        this.latestAt = end;
      }
      added++;
    }
    if (added === 0) {
      return false;
    }
    this.turns.sort((a, b) => a.start - b.start);
    this.version++;
    this.structureVersion++;
    return true;
  }

  // ── retention ──

  /**
   * §5.3 — retention bounded in space. Beyond `keep` calls the oldest merge into per-pixel bins of
   * `layout` (and bins that crowd into one column re-merge as history compresses). The tools, turn
   * ticks and preparation windows of the binned stretch leave with their calls. Returns whether
   * anything changed.
   */
  compact(keep: number, layout: AxisLayout): boolean {
    const excess = this.calls.length - Math.max(1, keep);
    const width = Math.max(1, Math.ceil(layout.width));
    if (excess <= 0 && this.bins.length <= width) {
      return false;
    }
    const old = excess > 0 ? this.calls.splice(0, excess) : [];
    const units: CallBin[] = old.map((c) => ({
      start: c.sendAt,
      end: c.endAt ?? c.lastEventAt,
      count: 1,
      promptMax: c.stack.total,
      promptSum: c.stack.total,
      outMax: outputTotal(c),
      outSum: outputTotal(c),
    }));
    this.bins = mergeBins(this.bins.concat(units), layout);
    this.binnedCalls += old.length;
    for (const c of old) {
      this.callById.delete(c.id);
      const r = this.runs.get(c.runId);
      if (r) {
        r.callIds = r.callIds.filter((id) => id !== c.id);
        if (r.open === c.id) {
          r.open = undefined;
        }
      }
    }
    const cutoff = this.calls.length > 0 ? this.calls[0].sendAt : Number.POSITIVE_INFINITY;
    // One pass each (filter in place), never a splice per removal.
    const keepInPlace = <T>(arr: T[], keepIt: (x: T) => boolean): void => {
      let w = 0;
      for (const x of arr) {
        if (keepIt(x)) {
          arr[w++] = x;
        }
      }
      arr.length = w;
    };
    keepInPlace(this.tools, (tool) => {
      const gone = tool.end !== undefined && tool.end < cutoff;
      if (gone) {
        this.toolById.delete(tool.id);
      }
      return !gone;
    });
    keepInPlace(this.preps, (p) => p.end >= cutoff || p === this.openPrep);
    const before = this.turns.length;
    keepInPlace(this.turns, (turn) => turn.end === undefined || turn.end >= cutoff);
    this.droppedTurns += before - this.turns.length;
    this.markAll();
    this.version++;
    this.structureVersion++;
    return true;
  }

  // ── reads for the renderer ──

  /** G for the current data (§5.3), cached per structure version. */
  gapThreshold(): number {
    if (this.gapCache.sv !== this.structureVersion) {
      this.gapCache = { sv: this.structureVersion, gapMs: gapThresholdMs(this.gaps) };
    }
    return this.gapCache.gapMs;
  }

  /** A run is live while it is open AND has spoken within RUN_STALE_MS; so is a compaction. */
  isLive(now: number): boolean {
    if (this.openCompaction) {
      return true;
    }
    for (const r of this.runs.values()) {
      if (!r.closed && now - r.lastEventAt <= RUN_STALE_MS) {
        return true;
      }
    }
    return false;
  }

  hasOpenCompaction(): boolean {
    return this.openCompaction !== null;
  }

  /** Every CLOSED interval, merged with G, cached per structure version — the per-frame merge then
   *  only has to fold in the few open intervals (openActivity). */
  closedActivity(gapMs: number): Interval[] {
    const cache = this.closedCache;
    if (cache && cache.sv === this.structureVersion && cache.gapMs === gapMs) {
      return cache.merged;
    }
    const iv: Interval[] = [];
    for (const c of this.calls) {
      if (c.endAt !== undefined) {
        iv.push({ start: c.sendAt, end: c.endAt });
      }
    }
    for (const b of this.bins) {
      iv.push({ start: b.start, end: b.end });
    }
    for (const tool of this.tools) {
      if (tool.end !== undefined) {
        iv.push({ start: tool.start, end: tool.end });
      }
    }
    for (const k of this.compactions) {
      if (k.end !== undefined) {
        iv.push({ start: k.start, end: k.end });
      }
    }
    for (const p of this.preps) {
      iv.push({ start: p.start, end: p.end });
    }
    // A finished turn is active end to end — its tool loop never folds, whatever G says.
    for (const turn of this.turns) {
      if (turn.end !== undefined) {
        iv.push({ start: turn.tickAt, end: turn.end });
      }
    }
    const merged = mergeActivity(iv, gapMs);
    this.closedCache = { sv: this.structureVersion, gapMs, merged };
    return merged;
  }

  /**
   * The intervals still open, ending at `openEnd` (now while live, else the last event). Per
   * frame, so it never walks the calls: an open call always belongs to an unclosed run (turnEnd
   * closes the run's open call, openCall closes the previous one), and that run's turn interval
   * already covers it to `openEnd`. Tools are tracked in their own open set, because a tool event
   * can arrive for a run that already ended.
   */
  openActivity(openEnd: number): Interval[] {
    const iv: Interval[] = [];
    for (const r of this.runs.values()) {
      if (!r.closed) {
        iv.push({ start: r.turn.tickAt, end: Math.max(openEnd, r.turn.tickAt) });
      }
    }
    for (const tool of this.openTools) {
      iv.push({ start: tool.start, end: Math.max(openEnd, tool.start) });
    }
    if (this.openCompaction) {
      iv.push({
        start: this.openCompaction.start,
        end: Math.max(openEnd, this.openCompaction.start),
      });
    }
    return iv;
  }

  /** The two lane denominators: the largest prompt and the largest call output in view. */
  scales(): { prompt: number; out: number } {
    if (this.scaleCache.version !== this.version) {
      let prompt = 0;
      let out = 0;
      for (const c of this.calls) {
        prompt = Math.max(prompt, c.stack.total);
        out = Math.max(out, outputTotal(c));
      }
      for (const b of this.bins) {
        prompt = Math.max(prompt, b.promptMax);
        out = Math.max(out, b.outMax);
      }
      this.scaleCache = { version: this.version, prompt, out };
    }
    return this.scaleCache;
  }

  /**
   * FORK 2026-09-30 (the architect: "a graph that restarts every prompt and it shows me on the top what is
   * sent and in the bottom what is received"). The window the timeline DRAWS: the latest prompt.
   *
   * It starts where that prompt was submitted: the newest turn's tick (the start of its preparation
   * window when one was seen), or an open preparation window that began after that turn ended, i.e.
   * a prompt just sent whose run has not named a model yet. A preparation tick while a run is still
   * open never restarts the view. It ends at the turn's end, and stays open while the prompt is
   * being prepared or answered.
   *
   * A VIEW, not a reset: the store keeps the whole session, because THIS SESSION counts its turns
   * and calls from it (context-counters.ts). The lane denominators are taken over this prompt's
   * calls alone, so an old turn's larger prompt cannot flatten this one. Cached per version.
   *
   * FORK 2026-10-02 (the owner: "The CALL TIMELINE panel sometimes stays empty, it should always show
   * the last run instead"). When the newest prompt has no live-recorded call to draw (it is being
   * prepared, its turn made no call, or it is a history row), the view HOLDS the last run that has
   * one and names the newer prompt in `newer`. It restarts on the new prompt at its first call.
   */
  promptView(): PromptView | null {
    if (this.viewCache.version !== this.version) {
      this.viewCache = { version: this.version, view: this.computePromptView() };
    }
    return this.viewCache.view;
  }

  /** Index of the first call sent at or after `t` (calls are sorted by send time). */
  private firstCallFrom(t: number): number {
    const calls = this.calls;
    let lo = 0;
    let hi = calls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (calls[mid].sendAt < t) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private computePromptView(): PromptView | null {
    const newest = this.newestPromptView();
    if (!newest) {
      return null;
    }
    const calls = this.calls;
    for (let i = newest.firstCall; i < calls.length; i++) {
      if (!calls[i].historic) {
        return newest;
      }
    }
    let j = newest.firstCall - 1;
    while (j >= 0 && calls[j].historic) {
      j--;
    }
    if (j < 0) {
      // Nothing live recorded at all: the stage note stands (a fresh session, or a page whose last
      // run was never snapshotted).
      return newest;
    }
    const last = calls[j];
    const turn = this.turns.find((tr) => tr.runId === last.runId);
    let lo = this.firstCallFrom(turn?.tickAt ?? last.sendAt);
    while (lo > 0 && calls[lo - 1].runId === last.runId) {
      lo--;
    }
    let prompt = 0;
    let out = 0;
    for (let i = lo; i <= j; i++) {
      prompt = Math.max(prompt, calls[i].stack.total);
      out = Math.max(out, outputTotal(calls[i]));
    }
    return {
      start: Math.min(turn?.tickAt ?? last.sendAt, calls[lo].sendAt),
      end: turn?.end,
      runId: last.runId,
      ordinal: this.turnOrdinal(last.runId),
      firstCall: lo,
      calls: j + 1 - lo,
      prompt,
      out,
      newer: {
        ordinal: newest.ordinal,
        state: newest.end === undefined ? "preparing" : newest.calls > 0 ? "history" : "no-calls",
      },
    };
  }

  /** The newest prompt's window, whether or not it has anything to draw. */
  private newestPromptView(): PromptView | null {
    if (!Number.isFinite(this.earliestAt)) {
      return null;
    }
    let turn: TurnSpan | undefined;
    for (const tr of this.turns) {
      if (!turn || tr.tickAt >= turn.tickAt) {
        turn = tr;
      }
    }
    let running = false;
    for (const r of this.runs.values()) {
      if (!r.closed) {
        running = true;
        break;
      }
    }
    const prep = this.openPrep;
    let start: number;
    let end: number | undefined;
    let runId: string | undefined;
    let ordinal: number;
    if (prep && !running && (!turn || (turn.end !== undefined && prep.start > turn.end))) {
      start = prep.start;
      ordinal = this.droppedTurns + this.turns.length + 1;
    } else if (turn) {
      start = turn.tickAt;
      end = turn.end;
      runId = turn.runId;
      ordinal = this.turnOrdinal(turn.runId);
    } else {
      // Compactions only, no turn: the whole (short) record is the window.
      start = this.earliestAt;
      end = this.latestAt;
      ordinal = 0;
    }
    const calls = this.calls;
    const lo = this.firstCallFrom(start);
    let prompt = 0;
    let out = 0;
    for (let i = lo; i < calls.length; i++) {
      prompt = Math.max(prompt, calls[i].stack.total);
      out = Math.max(out, outputTotal(calls[i]));
    }
    return {
      start,
      end,
      runId,
      ordinal,
      firstCall: lo,
      calls: calls.length - lo,
      prompt,
      out,
    };
  }

  turnOrdinal(runId: string): number {
    const i = this.turns.findIndex((turn) => turn.runId === runId);
    return i < 0 ? 0 : this.droppedTurns + i + 1;
  }

  totals(): { turns: number; calls: number } {
    return {
      turns: this.droppedTurns + this.turns.length,
      calls: this.binnedCalls + this.calls.length,
    };
  }

  // ── the last run, across a reload (FORK 2026-10-02) ──

  /**
   * The newest FINISHED run that made at least one live-recorded call, as JSON-safe data, or null.
   * A run still answering is never snapshotted: after a reload its events keep arriving and the
   * live record rebuilds it. Its output samples are thinned to `maxSamples` in all (thinSamples).
   */
  lastRunSnapshot(maxSamples = SNAPSHOT_SAMPLES): RunSnapshot | null {
    const live = new Set<string>();
    for (const c of this.calls) {
      if (!c.historic) {
        live.add(c.runId);
      }
    }
    let turn: TurnSpan | undefined;
    for (const tr of this.turns) {
      if (
        tr.historic ||
        tr.end === undefined ||
        !live.has(tr.runId) ||
        this.runs.get(tr.runId)?.closed === false ||
        (turn && tr.tickAt < turn.tickAt)
      ) {
        continue;
      }
      turn = tr;
    }
    if (!turn || turn.end === undefined) {
      return null;
    }
    const runId = turn.runId;
    const end = turn.end;
    const calls = this.calls.filter((c) => c.runId === runId && !c.historic);
    const per = Math.max(2, Math.floor(maxSamples / calls.length));
    return {
      v: 1,
      runId,
      turn: { start: turn.start, tickAt: turn.tickAt, modelAt: turn.modelAt, end },
      model: this.runs.get(runId)?.model,
      calls: calls.map((c) => ({
        index: c.index,
        sendAt: c.sendAt,
        sendProvenance: c.sendProvenance,
        firstTokenAt: c.firstTokenAt,
        endAt: c.endAt,
        endProvenance: c.endProvenance,
        lastEventAt: c.lastEventAt,
        model: c.model,
        prompt: c.prompt,
        chars: c.chars,
        samples: thinSamples(c.samples, per).map((s): [number, number, number] => [
          s.t - c.sendAt,
          s.cum,
          OUTPUT_KINDS.indexOf(s.kind),
        ]),
        outEstimate: c.outEstimate,
        outFinal: c.outFinal,
        outProvenance: c.outProvenance,
        stopReason: c.stopReason,
        wireKey: c.wireKey,
      })),
      tools: this.tools
        .filter((x) => x.runId === runId)
        .map((x) => ({ id: x.id, name: x.name, start: x.start, end: x.end, isError: x.isError })),
      compactions: this.compactions
        .filter((k) => k.start <= end && (k.end ?? k.start) >= turn.tickAt)
        .map((k) => ({ ...k })),
    };
  }

  /**
   * Put a snapshot's run back (a page that just loaded). Refused — false, nothing changed — when it
   * is not a valid snapshot, or when this store already knows the run: the live record always wins.
   * The run comes back CLOSED and as recorded, not as a history row, so it draws exactly as before
   * the reload; a history row for it loaded later is skipped (loadHistory keys on runId).
   */
  restoreRun(snapshot: unknown): boolean {
    const snap = readRunSnapshot(snapshot);
    if (!snap || this.runs.has(snap.runId) || this.turns.some((tr) => tr.runId === snap.runId)) {
      return false;
    }
    const { runId } = snap;
    const turn: TurnSpan = { runId, ...snap.turn };
    this.turns.push(turn);
    this.turns.sort((a, b) => a.start - b.start);
    const r: RunState = {
      runId,
      turn,
      model: snap.model,
      callIds: [],
      exactCalls: snap.calls.some((c) => c.wireKey !== undefined),
      wire: new Map(),
      cumChars: {},
      closed: true,
      lastEventAt: snap.turn.end,
    };
    this.runs.set(runId, r);
    for (const c of snap.calls) {
      r.callIds.push(c.id);
      if (c.wireKey !== undefined) {
        r.wire.set(c.wireKey, c.id);
      }
      this.callById.set(c.id, c);
      this.insertCall(c);
      for (const s of c.samples) {
        this.seeKey(s.kind);
      }
      this.touch(c.sendAt, false);
      this.touch(c.lastEventAt, false);
    }
    for (const x of snap.tools) {
      if (this.toolById.has(x.id)) {
        continue;
      }
      const span: ToolSpan = { ...x, runId, end: x.end ?? snap.turn.end };
      this.tools.push(span);
      this.toolById.set(x.id, span);
    }
    for (const k of snap.compactions) {
      if (!this.compactions.some((have) => have.start === k.start)) {
        this.compactions.push(k);
      }
    }
    this.touch(turn.tickAt, true);
    this.touch(snap.turn.end, true);
    return true;
  }

  /** One sentence for the aria-live region, about the turn that finished last (§5.7). */
  lastTurnSummary(): string {
    const runId = this.lastEnded;
    if (!runId) {
      return "";
    }
    const turn = this.turns.find((tr) => tr.runId === runId);
    const calls = this.calls.filter((c) => c.runId === runId);
    if (!turn) {
      return "";
    }
    const peak = calls.reduce((m, c) => Math.max(m, c.stack.total), 0);
    const back = calls.reduce((a, c) => a + outputTotal(c), 0);
    const dur = (turn.end ?? turn.start) - turn.tickAt;
    return (
      `Turn ${this.turnOrdinal(runId)} finished: ${calls.length} call${calls.length === 1 ? "" : "s"}` +
      (peak > 0 ? `, up to ${fmtTokens(peak)} tokens sent` : "") +
      `, ${fmtTokens(back)} tokens back, ${fmtDuration(dur)}.`
    );
  }
}

// ─── Reading a snapshot back (FORK 2026-10-02) ───

const SEND_PROVENANCES = new Set(["exact", "inferred"]);
const OUT_PROVENANCES = new Set<string>(["estimated", "exact", "apportioned", "aggregate"]);
const SNAPSHOTS = new Set<string>(["pre-call", "post-turn", "unknown"]);
const PROMPT_COUNTS = [
  "exact",
  "input",
  "cacheRead",
  "cacheWrite",
  "estimate",
  "compositionTotal",
] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function readPrompt(v: unknown): CallPrompt {
  const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const p: CallPrompt = {};
  for (const key of PROMPT_COUNTS) {
    const n = nonNeg(x[key]);
    if (n !== undefined) {
      p[key] = n;
    }
  }
  if (x.composition && typeof x.composition === "object") {
    const composition: Record<string, number> = {};
    for (const [k, n] of Object.entries(x.composition as Record<string, unknown>)) {
      const tokens = nonNeg(n);
      if (tokens !== undefined) {
        composition[k] = tokens;
      }
    }
    p.composition = composition;
  }
  if (typeof x.snapshot === "string" && SNAPSHOTS.has(x.snapshot)) {
    p.snapshot = x.snapshot as CompositionSnapshot;
  }
  if (x.source === "call") {
    p.source = "call";
  }
  return p;
}

function readSnapshotCall(v: unknown, runId: string): TimelineCall | null {
  const x = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
  const index = num(x?.index);
  const sendAt = num(x?.sendAt);
  if (!x || index === undefined || index < 1 || sendAt === undefined) {
    return null;
  }
  const samples: OutSample[] = [];
  for (const s of Array.isArray(x.samples) ? x.samples : []) {
    const dt = Array.isArray(s) ? num(s[0]) : undefined;
    const cum = Array.isArray(s) ? nonNeg(s[1]) : undefined;
    const kind = Array.isArray(s) ? OUTPUT_KINDS[s[2] as number] : undefined;
    if (dt !== undefined && cum !== undefined && kind !== undefined) {
      samples.push({ t: sendAt + dt, cum, kind });
    }
  }
  const chars = zeroChars();
  const rawChars = (x.chars && typeof x.chars === "object" ? x.chars : {}) as Record<
    string,
    unknown
  >;
  for (const k of OUTPUT_KINDS) {
    chars[k] = nonNeg(rawChars[k]) ?? 0;
  }
  const prompt = readPrompt(x.prompt);
  const endProvenance = str(x.endProvenance);
  const outProvenance = str(x.outProvenance);
  return {
    id: `${runId}#${Math.floor(index)}`,
    runId,
    index: Math.floor(index),
    sendAt,
    sendProvenance: x.sendProvenance === "exact" ? "exact" : "inferred",
    firstTokenAt: num(x.firstTokenAt),
    endAt: num(x.endAt),
    endProvenance:
      endProvenance && SEND_PROVENANCES.has(endProvenance)
        ? (endProvenance as "exact" | "inferred")
        : undefined,
    lastEventAt: Math.max(sendAt, num(x.lastEventAt) ?? sendAt),
    model: str(x.model),
    prompt,
    stack: promptStack(prompt),
    chars,
    samples,
    outEstimate: nonNeg(x.outEstimate) ?? 0,
    outFinal: nonNeg(x.outFinal),
    outProvenance:
      outProvenance && OUT_PROVENANCES.has(outProvenance)
        ? (outProvenance as OutProvenance)
        : "estimated",
    stopReason: str(x.stopReason),
    wireKey: str(x.wireKey),
  };
}

/**
 * A RunSnapshot read back from storage, every field checked (it may be from an older build, or
 * hand-edited): null unless it names a run, a finished turn and at least one valid call.
 */
function readRunSnapshot(v: unknown): {
  runId: string;
  turn: { start: number; tickAt: number; modelAt?: number; end: number };
  model?: string;
  calls: TimelineCall[];
  tools: Array<{ id: string; name: string; start: number; end?: number; isError?: boolean }>;
  compactions: CompactionBand[];
} | null {
  const x = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
  const runId = str(x?.runId);
  if (!x || x.v !== 1 || !runId) {
    return null;
  }
  const t = (x.turn && typeof x.turn === "object" ? x.turn : {}) as Record<string, unknown>;
  const start = num(t.start);
  const tickAt = num(t.tickAt);
  const end = num(t.end);
  if (start === undefined || tickAt === undefined || end === undefined) {
    return null;
  }
  const calls: TimelineCall[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(x.calls) ? x.calls : []) {
    const c = readSnapshotCall(raw, runId);
    if (c && !ids.has(c.id)) {
      ids.add(c.id);
      calls.push(c);
    }
  }
  if (calls.length === 0) {
    return null;
  }
  const tools: Array<{ id: string; name: string; start: number; end?: number; isError?: boolean }> =
    [];
  for (const raw of Array.isArray(x.tools) ? x.tools : []) {
    const tool = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = str(tool.id);
    const at = num(tool.start);
    if (id && at !== undefined) {
      tools.push({
        id,
        name: str(tool.name) ?? "tool",
        start: at,
        end: num(tool.end),
        isError: typeof tool.isError === "boolean" ? tool.isError : undefined,
      });
    }
  }
  const compactions: CompactionBand[] = [];
  for (const raw of Array.isArray(x.compactions) ? x.compactions : []) {
    const k = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const at = num(k.start);
    if (at !== undefined) {
      compactions.push({
        start: at,
        end: num(k.end),
        trigger: str(k.trigger),
        tokensBefore: nonNeg(k.tokensBefore),
        tokensAfter: nonNeg(k.tokensAfter),
        tokensDropped: nonNeg(k.tokensDropped),
        completed: typeof k.completed === "boolean" ? k.completed : undefined,
        provenance: str(k.provenance),
      });
    }
  }
  return {
    runId,
    turn: { start, tickAt, modelAt: num(t.modelAt), end: Math.max(end, start) },
    model: str(x.model),
    calls,
    tools,
    compactions,
  };
}

// ─── Text (tooltip, aria) — here, not in the renderer, so it is testable ───

const label = (key: string): string => SEGMENT_LABELS[key] ?? key;

/**
 * §5.7 — every number of a call, as text, with its provenance (P5): call n of turn m, model,
 * send → first token, the prompt with its cache split, the top composition segments, output by
 * kind, duration and tokens/s.
 */
export function describeCall(c: TimelineCall, ctx: { turnOrdinal: number; now: number }): string[] {
  const lines: string[] = [];
  lines.push(
    `call ${c.index} of turn ${ctx.turnOrdinal || "?"}` +
      (c.model ? ` · ${c.model}` : "") +
      (c.historic ? " · history row" : ""),
  );
  if (c.historic) {
    lines.push("timing is the turn's, not one call's (anatomy row)");
  } else if (c.firstTokenAt !== undefined) {
    lines.push(
      `send → first token ${fmtDuration(c.firstTokenAt - c.sendAt)}` +
        (c.sendProvenance === "inferred" ? " (send inferred)" : " (send exact)"),
    );
  } else {
    lines.push(
      `waiting for the first token · ${fmtDuration(ctx.now - c.sendAt)}` +
        (c.sendProvenance === "inferred" ? " (send inferred)" : ""),
    );
  }
  const st = c.stack;
  if (st.total > 0) {
    let line = `prompt ${fmtTokens(st.total)} ${st.provenance}`;
    const p = c.prompt;
    if (p.exact !== undefined && (p.cacheRead !== undefined || p.cacheWrite !== undefined)) {
      const cr = p.cacheRead ?? 0;
      const cw = p.cacheWrite ?? 0;
      line += ` · cached ${fmtTokens(cr)} · written ${fmtTokens(cw)} · new ${fmtTokens(Math.max(0, p.exact - cr - cw))}`;
    }
    lines.push(line);
    const top = st.pieces
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((piece) => `${label(piece.key)} ${fmtTokens(piece.tokens)}`);
    const snap = c.prompt.snapshot;
    lines.push(
      `top: ${top.join(" · ") || "—"}` +
        (c.prompt.source === "call"
          ? " (split estimated from what was sent, total exact)"
          : snap && snap !== "unknown"
            ? ` (composition ${snap})`
            : snap
              ? " (composition, time unknown)"
              : ""),
    );
  } else {
    lines.push("prompt — (no size reported yet)");
  }
  lines.push(
    st.moral === "present"
      ? `moral code ${fmtTokens(c.stack.pieces.find((q) => q.key === "moralCode")?.tokens ?? 0)}`
      : st.moral === "absent"
        ? "moral code: absent"
        : "moral code — (not measured on this call)",
  );
  const total = outputTotal(c);
  const kinds = OUTPUT_KINDS.map((k) => [k, estimateTokens(c.chars[k])] as const).filter(
    ([, v]) => v > 0,
  );
  const f = c.outEstimate > 0 && total > 0 ? total / c.outEstimate : 1;
  lines.push(
    `output ${fmtTokens(Math.round(total))} ${c.outProvenance}` +
      (kinds.length > 0
        ? ` · ${kinds.map(([k, v]) => `${label(k).toLowerCase()} ${fmtTokens(Math.round(v * f))}`).join(" · ")}` +
          " (split estimated)"
        : ""),
  );
  const end = c.endAt ?? ctx.now;
  const genMs = end - (c.firstTokenAt ?? c.sendAt);
  lines.push(
    `${fmtDuration(end - c.sendAt)}${c.endAt === undefined ? " so far" : ""}` +
      (genMs > 0 && total > 0 && !c.historic
        ? ` · ${Math.round(total / (genMs / 1000))} tok/s`
        : "") +
      (c.stopReason ? ` · ${c.stopReason}` : ""),
  );
  return lines;
}

export function describeBin(b: CallBin): string[] {
  return [
    `${b.count} earlier call${b.count === 1 ? "" : "s"}, merged into one pixel column`,
    `prompt up to ${fmtTokens(b.promptMax)} · ${fmtTokens(b.promptSum)} summed`,
    `output up to ${fmtTokens(Math.round(b.outMax))} · ${fmtTokens(Math.round(b.outSum))} summed`,
    fmtDuration(b.end - b.start),
  ];
}
