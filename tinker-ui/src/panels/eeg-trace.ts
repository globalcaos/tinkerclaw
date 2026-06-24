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
// relative cost of (model × effort). The line sits at the effort the model
// ACTUALLY ran at (the executed level) — no "requested vs actual" halo overlay
// and no "forced" dashing: the EEG shows what happened (the user 2026-06-18).

// ─── Stops (MUST mirror app.ts THINK_STOPS order exactly) ───
// `short` = the compact tick label printed under the slider AND above the
// seismograph column (full labels collide at 8 stops in a ~280px panel).
export const EEG_STOPS: { lvl: string; label: string; short: string }[] = [
  { lvl: "", label: "Auto", short: "Auto" },
  { lvl: "minimal", label: "Minimal", short: "Min" },
  { lvl: "low", label: "Low", short: "Low" },
  { lvl: "medium", label: "Medium", short: "Med" },
  { lvl: "high", label: "High", short: "High" },
  { lvl: "xhigh", label: "xHigh", short: "xHi" },
  { lvl: "max", label: "Max", short: "Max" },
];

export interface EegSample {
  runId: string;
  model: string;
  provider: string;
  chosenLevel: string; // one of EEG_STOPS lvl values ("" = Auto/uncapped)
  subagent: boolean;
  parentRunId?: string;
  /** Subagent task text ("what this run is doing"), shown in the branch hover
   *  tooltip alongside the model. Falls back to the model name when absent. */
  label?: string;
  thinkingChars?: number; // measured thinking CHARACTERS (never tokens); fallback effort column when no executed level is echoed
  inputTokens?: number; // billed prompt tokens (summed across the run's rounds)
  outputTokens?: number; // generated tokens (run total)
  startedAt: number; // epoch ms
  endedAt?: number; // epoch ms (absent = still running)
  // FORK 2026-06-19 (bible §5.8h): true for a trace belonging to ANOTHER session
  // overlaid in the EEG "all" scope — drawn semi-transparent so the viewed
  // session's own (solid) trace stays distinguishable.
  dim?: boolean;
  // FORK 2026-06-19: which session this sample belongs to, so a merged "all"-scope
  // render draws ONE continuous main line per session (absent = the viewed store).
  sessionKey?: string;
}

export interface EegTurnEnd {
  turn: number;
  runId: string;
  endedAt: number;
  // FORK 2026-06-19: the prompt this turn answered — stored on the (persisted)
  // turnEnd so a marker click can scroll to the Nth user message (reload-proof,
  // unlike the client-only _eegTurn stamp) and a hover shows the prompt text.
  promptIndex?: number; // 0-based index among the session's user messages
  promptText?: string; // trimmed prompt text for the marker tooltip
}

// ─── Provider brand palette (bible §5.8h, the user's q6 full-palette pick) ───
// google is NOT here — it is special-cased as the rainbow gradient below.
export const EEG_PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#E8702A",
  openai: "#10A37F",
  deepseek: "#4D6BFE",
  mistral: "#FA520F",
  meta: "#0668E1",
  unknown: "#8A8F98", // xai / local / anything unrecognized = neutral gray
};

// FORK 2026-06-13 (eeg): infer the brand from EITHER a provider string OR a bare
// MODEL name — the live trace gets the cc-bridge model id ("claude-fable-5", no
// "claude-code/" prefix), so providerOf() returns the bare name and a plain
// provider-key lookup missed → gray. Matching model-name patterns keeps the trace
// branded (the user 2026-06-13: "why am I still seeing gray instead of orange").
export function eegProviderPaint(provider: string): { stroke: string; isRainbow: boolean } {
  const p = (provider || "").toLowerCase();
  if (p === "google" || p.startsWith("google") || /gemini|gemma|bison/.test(p)) {
    return { stroke: "url(#eeg-google)", isRainbow: true };
  }
  // anthropic — provider key OR a claude model name (cc-bridge = claude CLI)
  if (p === "claude-code" || p === "anthropic" || /claude|fable|opus|sonnet|haiku/.test(p)) {
    return { stroke: EEG_PROVIDER_COLORS.anthropic, isRainbow: false };
  }
  if (p === "openai" || /gpt|codex|(^|[^a-z])o\d/.test(p)) {
    return { stroke: EEG_PROVIDER_COLORS.openai, isRainbow: false };
  }
  if (/deepseek/.test(p)) return { stroke: EEG_PROVIDER_COLORS.deepseek, isRainbow: false };
  if (/mistral|mixtral/.test(p)) return { stroke: EEG_PROVIDER_COLORS.mistral, isRainbow: false };
  if (/llama|meta/.test(p)) return { stroke: EEG_PROVIDER_COLORS.meta, isRainbow: false };
  return { stroke: EEG_PROVIDER_COLORS[p] ?? EEG_PROVIDER_COLORS.unknown, isRainbow: false };
}

// ─── Cost model: thickness = the user's REAL per-use cost (€/Mtok output) ───
// relCost values ARE effective €/Mtok-output under the user's actual billing
// (2026-06-13), NOT API sticker — because the two providers are billed in
// fundamentally different ways:
//
//   ANTHROPIC (claude-code/*): a FLAT €200/month Max subscription, NOT metered
//   API. At an assumed 75% weekly-quota utilization the subscription amortizes
//   to ≈ €2 per sonnet-equivalent Mtok-output (≈ 7× cheaper than Anthropic's own
//   API). Each Anthropic model burns the shared quota at its weight (haiku 0.3,
//   sonnet 1, opus 5, fable 10 — Anthropic's own model weighting ≈ price ratio),
//   so effective €/Mtok = €2 × weight → haiku 0.6, sonnet 2, opus 10, fable 20.
//
//   OPENAI / GOOGLE (gpt-*, gemini-*): METERED API, every token billed at full
//   published output price (≈ €/Mtok): gpt-5.x ≈ 12, gemini Pro ≈ 12, gemini
//   Flash ≈ 2.5, mini ≈ 3. No subscription discount.
//
// Net effect: a frontier API model (gpt-5.5, gemini-pro ≈ €12) costs MORE per use
// than subscription Opus (€10) and far more than subscription Sonnet (€2) — which
// is exactly the user's point. These are ESTIMATES (the 75%-quota → €2/Mtok anchor
// is the big assumption); the measured halo will correct them later. Never present
// as measured (bible §5.8h invariant 3).
export const EEG_COST_TABLE: { modelMatch: RegExp; relCost: number }[] = [
  // Anthropic — subscription-amortized €/Mtok (€2 base × quota-burn weight)
  { modelMatch: /fable/i, relCost: 20 },
  { modelMatch: /opus/i, relCost: 10 },
  { modelMatch: /sonnet/i, relCost: 2 },
  { modelMatch: /haiku/i, relCost: 0.6 },
  // Google / OpenAI — metered API €/Mtok (full price). gemini rows BEFORE \bmini\b
  // for clarity; \b already keeps "gemini" (…e-mini…) out of the mini bucket.
  { modelMatch: /gemini.*pro/i, relCost: 12 },
  { modelMatch: /gemini.*flash/i, relCost: 2.5 },
  { modelMatch: /\bmini\b/i, relCost: 3 },
  { modelMatch: /gpt-5/i, relCost: 12 },
];
const EEG_DEFAULT_REL_COST = 5;

// Effort multiplier per stop. Auto ("") = UNCAPPED — the model picks its own
// budget, so it costs more than medium on average (§5.8g: Auto is never tier 0).
export const EEG_EFFORT_MULT: Record<string, number> = {
  "": 1.2,
  minimal: 0.5,
  low: 0.75,
  medium: 1,
  high: 1.5,
  xhigh: 2,
  max: 3,
};

// FORK 2026-06-20 (the user): the model's effective €/Mtok-output (EEG_COST_TABLE
// value, or the default for an unrecognized model). Shared by BOTH the stroke
// WIDTH (cost-per-token identity) and the segment LENGTH (euro cost = the §1 grid).
export function eegRelCost(model: string): number {
  for (const row of EEG_COST_TABLE) {
    if (row.modelMatch.test(model || "")) return row.relCost;
  }
  return EEG_DEFAULT_REL_COST;
}

export function eegCostWidthPx(model: string, level: string): number {
  const rel = eegRelCost(model);
  void level; // effort no longer scales thickness — it is the X column (below)
  // LINEAR in cost, anchored so SONNET (€2/Mtok) = 1.0px and FABLE (€20) = 10px
  // (the user 2026-06-13). width = relCost / 2. Proportional, NOT log-compressed.
  // Effort is shown by the X position, NOT thickness, so each model keeps ONE
  // identity width everywhere it appears (opus 5px, gpt-5.x/gemini-pro 6px,
  // gemini-flash 1.25px). Clamp gives a thin floor + headroom above fable.
  const w = rel / 2;
  return Math.min(11, Math.max(0.5, w));
}

// FORK 2026-06-14 (fluid-model-effort Drop 1, bible §5.84 amends §5.8h:501):
// concurrent same-(model,effort) subagents render as a DEPTH-SHADED STACK — up to
// 5 strands tightly overlapping at the column, the BOTTOM (drawn first, behind)
// darkest and each higher strand lighter, conveying count by depth; >5 adds an ×N
// badge. Replaces the old wide lateral fan. `step` is small so the band reads as a
// stack, not separate lanes.
export const EEG_STRAND_DEPTH_STEP = 1.4;

function eegLightenHex(hex: string, t: number): string {
  if (t <= 0) return hex; // preserve the exact brand color for the darkest strand
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const lift = (c: number) => Math.round(c + (255 - c) * Math.min(1, t));
  const r = lift((n >> 16) & 255);
  const g = lift((n >> 8) & 255);
  const b = lift(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// idx 0 = bottom/back (darkest), idx n-1 = top/front (lightest). Solid colors
// lighten toward white (capped so the top strand stays visible); the rainbow
// gradient can't be tinted, so it fades by opacity instead.
export function eegStrandShade(
  paint: { stroke: string; isRainbow: boolean },
  idx: number,
  n: number,
): { stroke: string; opacity: number } {
  const t = n <= 1 ? 0 : idx / (n - 1);
  if (paint.isRainbow) return { stroke: paint.stroke, opacity: 1 - 0.5 * t };
  return { stroke: eegLightenHex(paint.stroke, 0.55 * t), opacity: 1 };
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

// FORK 2026-06-13 (eeg): the effort COLUMN to draw the line at. In Auto/off (no
// pinned level) the router decides, so we show the effort the model ACTUALLY used
// — the measured thinkingChars bucket — instead of parking the line in the "Auto"
// gutter (the user 2026-06-13). A pinned level always wins.
function eegEffectiveLevel(s: EegSample): string {
  const lv = s.chosenLevel;
  if (!lv || lv === "off" || lv === "auto") {
    return typeof s.thinkingChars === "number" ? thinkingCharsLevel(s.thinkingChars) : "";
  }
  return lv;
}

// ─── Render constants ───
// PERMANENT retention (the user 2026-06-13): keep the WHOLE session so all activity
// is visible by scrolling — no drop-oldest. The high guard only backstops a
// pathological runaway; a normal session never reaches it.
const EEG_MAX_SAMPLES = 100000;
const ROW_H = 24; // px per EMPTY-paper placeholder row (real rows are token-sized)
const TOP_PAD = 26; // room for the stop labels above the paper
const BOTTOM_PAD = 14;
const ARC_HALF = 7; // bezier vertical half-span → ~14px of curve per column hop
// FORK 2026-06-19: half-gap each side of a prompt rule so the trunk visibly FINISHES
// then RESTARTS across the boundary, the two ends nearly touching (the user).
const EEG_TURN_GAP = 5;
// FORK 2026-06-20: half-gap each side of EVERY LLM call so consecutive calls read as
// DISTINCT segments, never one continuous spline (the user: "I don't see a clear
// separation between calls"). Smaller than EEG_TURN_GAP so the per-prompt break stays
// the stronger, dominant separation (call = small gap, prompt = big gap).
const EEG_CALL_GAP = 2;
const STRAND_CAP = 10; // bible §5.8h invariant 4: cap rendered strands per group; the dynamic ×N carries the true count (the user 2026-06-19: 10, was 5)

// ─── Segment LENGTH model: LENGTH = EURO COST → each €1 = one grid line ───
// FORK 2026-06-20 (the user): "make the horizontal lines mean one euro — the thinking
// should scale to the grid so we understand how much we spend on every prompt."
// LENGTH now directly encodes the segment's EURO cost: a prompt's trace HEIGHT,
// measured against the §1 horizontal grid (EEG_PX_PER_EURO px = €1, drawn in
// renderSvg), reads as how many euros that prompt cost. width still = the model's
// cost-PER-token identity (thick = an expensive model), so a thin-but-tall line =
// a cheap model that ran a LOT and still cost real money — exactly the signal the user
// wants. euros = relCost(€/Mtok-output) × weightedMtok, where the weighted token
// blend counts output ~5× input (the typical price ratio): weighted = output + 0.2·input.
// MIN floor keeps tiny (sub-€0.2) turns clickable + fits the column-hop bezier
// (≥ 2·ARC_HALF) — so the floor slightly over-draws the cheapest turns; the grid
// reading is exact for anything above it. MAX backstops a pathological single turn.
// The whole axis (and the grid pitch) rescales together with the wheel zoom.
export const EEG_PX_PER_EURO = 90; // vertical px per €1 of spend (the §1 grid pitch)
const EEG_INPUT_COST_RATIO = 0.2; // input price ÷ output price (typical 5:1)
const EEG_MIN_LEN = 16; // ≥ 2·ARC_HALF so the column-hop bezier always fits
const EEG_MAX_LEN = 600;

function eegWeightedTokens(s: EegSample): number {
  return (s.outputTokens ?? 0) + EEG_INPUT_COST_RATIO * (s.inputTokens ?? 0);
}
// FORK 2026-06-20 (the user): estimated euro cost of one sample. relCost is €/Mtok-output
// (subscription-amortized for Anthropic, metered for API providers — see EEG_COST_TABLE).
export function eegSampleEuros(s: EegSample): number {
  return (eegRelCost(s.model) * eegWeightedTokens(s)) / 1_000_000;
}
function eegSampleLength(s: EegSample): number {
  // length = euros × px/€; one grid cell (EEG_PX_PER_EURO) = €1 of spend.
  const L = EEG_PX_PER_EURO * eegSampleEuros(s);
  return Math.min(EEG_MAX_LEN, Math.max(EEG_MIN_LEN, L));
}

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

  // FORK 2026-06-19: stamp a run's endedAt from the AUTHORITATIVE lifecycle end
  // (so a finished subagent branch merges back even when its effort:final frame is
  // dropped — the "thinking forever" bug). Idempotent; only sets if still open.
  markEnded(runId: string, endedAt: number): void {
    const s = this.samples.get(runId);
    if (s && s.endedAt === undefined) {
      this.samples.set(runId, { ...s, endedAt });
    }
  }

  // FORK 2026-06-19: close any still-running SUBAGENT branch whose run is no longer
  // live (gone from activeRuns, or silent past the caller's bound) — clears the
  // "thinking forever" ghosts (dead 30× fan-outs that never got an end event).
  // Returns the closed runIds so the caller can also drop their activeRuns entry.
  // Main-session samples are NEVER swept (a main turn may legitimately think long).
  closeStaleRunning(isLive: (runId: string) => boolean, now: number): string[] {
    const closed: string[] = [];
    for (const [runId, s] of this.samples) {
      if (s.subagent && s.endedAt === undefined && !isLive(runId)) {
        this.samples.set(runId, { ...s, endedAt: now });
        closed.push(runId);
      }
    }
    return closed;
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

  // FORK 2026-06-13 (eeg): serialize for localStorage so the trace survives a hard
  // refresh (the in-memory store is wiped; app.ts rehydrates via backfill()).
  toSnapshot(): { samples: EegSample[]; ends: EegTurnEnd[] } {
    return { samples: [...this.samples.values()], ends: [...this.turnEnds] };
  }

  // FORK 2026-06-19: this store's samples tagged for a merged "all"-scope overlay
  // (renderSvg `overlay`) — a session id (for per-session main-line grouping) + dim.
  taggedSamples(tag: { sessionKey: string; dim: boolean }): EegSample[] {
    return [...this.samples.values()].map((s) => ({
      ...s,
      sessionKey: tag.sessionKey,
      dim: tag.dim,
    }));
  }

  renderSvg(opts: { width: number; zoom?: number; overlay?: EegSample[] }): string {
    // chronological, oldest first — row 0 of the chrono index sits at the BOTTOM.
    // `overlay` = OTHER sessions' samples (all-scope), drawn faint on the SAME axis.
    const all = [...this.samples.values(), ...(opts.overlay ?? [])].sort(
      (a, b) => a.startedAt - b.startedAt,
    );

    const width = Math.max(120, opts.width || 320);
    // vertical SCALE (the user 2026-06-13): the secondary-button wheel zooms the
    // whole length axis. Re-floor each row at 2·ARC_HALF so the column-hop bezier
    // still fits even when zoomed all the way out.
    const zoom = Math.min(20, Math.max(0.03, opts.zoom ?? 1));
    // FORK 2026-06-19: scale the bezier offsets + the per-row floor WITH the zoom so
    // zooming OUT genuinely shrinks the trace. Before this, every row floored at
    // 2·ARC_HALF (plus eegSampleLength's own 16px floor), so below zoom≈0.87 the height
    // was stuck at n·14px and a long interaction never fit ("deeper zoom-out does
    // nothing"). At zoom≥1 these equal ARC_HALF/EEG_TURN_GAP → the normal view is unchanged.
    const arc = ARC_HALF * Math.min(1, zoom);
    const turnGap = EEG_TURN_GAP * Math.min(1, zoom);
    const callGap = EEG_CALL_GAP * Math.min(1, zoom);
    const n = all.length;
    // Empty paper still draws the labeled AXIS (so the instrument is visible the
    // moment the panel opens) — only the TRACE strokes obey the no-placeholders
    // rule (§5.9): no fake lines, just the grid + a "waiting" hint.
    const EMPTY_ROWS = 5;
    // Per-sample LENGTH (length ∝ tokens, area ∝ cost) × zoom. Newest at TOP:
    // accumulate the cumulative top-offset from the newest (n-1) down to oldest.
    const lengths = all.map((s) => Math.max(2 * arc, eegSampleLength(s) * zoom));
    const rowTopArr: number[] = new Array(n);
    let accTop = TOP_PAD;
    for (let c = n - 1; c >= 0; c--) {
      rowTopArr[c] = accTop;
      accTop += lengths[c];
    }
    const contentLen = accTop - TOP_PAD; // = Σ lengths
    const height = TOP_PAD + (n > 0 ? contentLen : EMPTY_ROWS * ROW_H) + BOTTOM_PAD;

    const rowTop = (c: number): number => rowTopArr[c];
    const rowBot = (c: number): number => rowTopArr[c] + lengths[c];
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
    // FORK 2026-06-19: which TURN a timestamp falls in (count of completed turns at/before
    // it). Used to break the trunk AND clamp branch joins on a turn-NUMBER change, robustly.
    const turnOf = (t: number): number => this.turnEnds.filter((e) => e.endedAt <= t).length;

    const mains = all.filter((s) => !s.subagent);
    // the VIEWED session's main line = the trunk branches anchor to + the ×N counts
    const viewedMains = mains.filter((s) => !s.dim);
    // parent main-line column at instant t (for branch split/join anchors) — viewed trunk
    const mainColAt = (t: number): number => {
      let best: EegSample | undefined;
      for (const m of viewedMains) {
        if (m.startedAt <= t) best = m;
        else break;
      }
      if (!best && viewedMains.length > 0) best = viewedMains[0];
      return best ? colX(eegEffectiveLevel(best)) : colX("");
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

    // ── horizontal €-grid: one rule per €1 of trace length (the user 2026-06-20). Each
    // cell = EEG_PX_PER_EURO·zoom px = €1 of spend, anchored at the bottom (oldest =
    // session start) and counting UP, so a prompt's trace HEIGHT reads as its euro cost
    // and the gutter labels read as cumulative session spend. Drawn IN the svg (not the
    // old fixed-pitch CSS background) so it scales with zoom and aligns to the trace.
    const euroPitch = EEG_PX_PER_EURO * Math.min(20, Math.max(0.03, opts.zoom ?? 1));
    const gridBottom = height - BOTTOM_PAD;
    let euroGrid = "";
    if (euroPitch >= 4) {
      // skip an unreadable hairline mat when zoomed all the way out
      let e = 1;
      for (let gy = gridBottom - euroPitch; gy >= TOP_PAD; gy -= euroPitch, e++) {
        euroGrid +=
          `<line class="eeg-eurogrid" x1="0" y1="${fx(gy)}" x2="${width}" y2="${fx(gy)}"` +
          ` stroke="#8A8F98" stroke-opacity="0.16" stroke-width="1"/>`;
        euroGrid +=
          `<text class="eeg-eurolabel" x="${fx(width - 3)}" y="${fx(gy - 2)}" text-anchor="end"` +
          ` font-size="8" fill="#8A8F98">€${e}</text>`;
      }
    }

    // ── empty paper: axis only + a hint, no trace strokes ──
    if (n === 0) {
      const hint =
        `<text class="eeg-empty-hint" x="${fx(width / 2)}"` +
        ` y="${fx(TOP_PAD + (EMPTY_ROWS * ROW_H) / 2)}" text-anchor="middle"` +
        ` font-size="9" fill="#8A8F98">waiting for model activity…</text>`;
      return (
        `<svg class="eeg-svg" width="${width}" height="${height}"` +
        ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
        `${defs}${grid}${euroGrid}${hint}</svg>`
      );
    }

    // ── main-session trace: one continuous line, per-sample stroke style ──
    // Each sample's <path> = the incoming connector from the previous (older,
    // lower) main sample + its own vertical run; column hops are cubic beziers
    // spanning ~14px (ARC_HALF each side of the row boundary).
    // Group main samples by SESSION so a merged "all"-scope render draws ONE
    // continuous line per session (viewed session solid; others `dim` = faint).
    const mainsBySession = new Map<string, EegSample[]>();
    for (const s of mains) {
      const g = s.sessionKey ?? "__self";
      const arr = mainsBySession.get(g);
      if (arr) arr.push(s);
      else mainsBySession.set(g, [s]);
    }
    let trace = "";
    for (const group of mainsBySession.values()) {
      for (let m = 0; m < group.length; m++) {
        const s = group[m];
        const c = rowOf.get(s.runId)!;
        const x = colX(eegEffectiveLevel(s));
        const yT = rowTop(c);
        const yB = rowBot(c);
        const w = eegCostWidthPx(s.model, s.chosenLevel);
        const paint = eegProviderPaint(s.provider);
        const op = s.dim ? 0.32 : 1; // other sessions (all-scope) draw semi-transparent
        let d: string;
        const prev = m > 0 ? group[m - 1] : undefined;
        const next = m + 1 < group.length ? group[m + 1] : undefined;
        // FORK 2026-06-19: BREAK the trunk at each prompt boundary so the line
        // visibly FINISHES at a turn end and RESTARTS in the next turn, the two ends
        // nearly touching across the prompt rule (the user). startsTurn = a boundary
        // sits just before this sample (begins a new turn) → start EEG_TURN_GAP above
        // its bottom; endsTurn = one sits just after (this sample ends a turn) → stop
        // EEG_TURN_GAP below the marker instead of leaving a connector arc. Only the
        // VIEWED trunk breaks (this.turnEnds is the viewed session's).
        // FORK 2026-06-20: EVERY CALL is its own segment — no connector spline between
        // calls (the user: "the line is a continuous spline, I don't see a clear separation
        // between calls"). Each main sample draws a fresh VERTICAL run at its effort
        // column, inset by a small CALL gap at each end so consecutive calls visibly
        // finish + restart. A PROMPT boundary (turn change) uses the bigger TURN gap so
        // the per-prompt break stays the dominant separation (hierarchy: call < prompt).
        // This also means breaks no longer depend on turnEnds being recorded: even with
        // no turn boundaries the calls still separate, killing the continuous-spline look.
        const canBreak = !s.dim;
        const startsTurn =
          canBreak &&
          !!prev &&
          (turnOf(prev.startedAt) !== turnOf(s.startedAt) ||
            this.turnEnds.some((t) => t.endedAt > prev.startedAt && t.endedAt <= s.startedAt));
        const endsTurn =
          canBreak &&
          !!next &&
          (turnOf(s.startedAt) !== turnOf(next.startedAt) ||
            this.turnEnds.some((t) => t.endedAt > s.startedAt && t.endedAt <= next.startedAt));
        // gap below (toward the older neighbor) / above (toward the newer): TURN gap at a
        // prompt boundary, CALL gap between ordinary calls, none at the trace's open ends.
        const gapBelow = !prev ? 0 : startsTurn ? turnGap : callGap;
        const gapAbove = !next ? 0 : endsTurn ? turnGap : callGap;
        d = `M ${fx(x)} ${fx(yB - gapBelow)} L ${fx(x)} ${fx(yT + gapAbove)}`;
        // tag each trunk segment with the PROMPT (turn) it belongs to, so hovering the
        // line highlights the whole prompt + clicking it scrolls the chat (the user 2026-06-19).
        const mainTurn = s.dim ? -1 : this.turnEnds.filter((t) => t.endedAt <= s.startedAt).length;
        const mainTE = mainTurn >= 0 ? this.turnEnds[mainTurn] : undefined;
        const mainIdxAttr =
          mainTE && typeof mainTE.promptIndex === "number"
            ? ` data-eeg-prompt-index="${mainTE.promptIndex}"`
            : "";
        trace +=
          `<path class="eeg-main" d="${d}" fill="none" stroke="${paint.stroke}"` +
          ` stroke-opacity="${fx(op)}" stroke-width="${fx(w)}" stroke-linecap="round"` +
          ` data-eeg-run="${esc(s.runId)}"${mainIdxAttr}/>`;
      }
    }

    // ── subagent branches: split off the parent, strand, join back ──
    // ── subagent branches: each subagent is its OWN branch — it splits off the
    // main trunk at its real startedAt, runs up at its effort column, and merges
    // BACK into the trunk at its real endedAt (still-running → open to the top).
    // Concurrent same-(model,chosenLevel) strands get a small lateral offset +
    // depth-shade so they read as a stack. (bible §5.8h invariant 4, updated
    // 2026-06-19: show ALL branches as a real staggered tree + a DYNAMIC ×N that
    // re-labels at each concurrency change — replaces the cap-5 monolith + one
    // static badge.) `dim` strands (other sessions in "all" scope) draw faint.
    const subs = all.filter((s) => s.subagent);
    const byKey = new Map<string, EegSample[]>();
    for (const s of subs) {
      const k = `${s.model}|${s.chosenLevel}`;
      const arr = byKey.get(k);
      if (arr) arr.push(s);
      else byKey.set(k, [s]);
    }
    let branches = "";
    for (const items of byKey.values()) {
      items.sort((a, b) => a.startedAt - b.startedAt);
      // cap rendered strands per group so a big fan-out doesn't overwhelm the
      // paper — the dynamic ×N below still reports the true total (the user 2026-06-19).
      for (let i = 0; i < items.length && i < STRAND_CAP; i++) {
        const s = items[i];
        // lateral index = earlier-started siblings still running when s spawns
        let lat = 0;
        for (let j = 0; j < i; j++) {
          if ((items[j].endedAt ?? Infinity) > s.startedAt) lat++;
        }
        const paint = eegProviderPaint(s.provider);
        const w = eegCostWidthPx(s.model, s.chosenLevel);
        const shade = eegStrandShade(paint, Math.min(lat, 4), 5);
        // FORK 2026-06-19: fan strands to the LEFT (into the unused Auto columns),
        // not right — clamp so they never cross the left gutter (the user).
        const col = Math.max(
          EEG_PAD_LEFT,
          colX(eegEffectiveLevel(s)) - lat * EEG_STRAND_DEPTH_STEP,
        );
        // split off the explicit parent's column when it's a main sample, else
        // off the main trunk at this subagent's spawn time
        const parentSample = s.parentRunId ? this.samples.get(s.parentRunId) : undefined;
        const splitX =
          parentSample && !parentSample.subagent
            ? colX(eegEffectiveLevel(parentSample))
            : mainColAt(s.startedAt);
        const splitY = timeToY(s.startedAt);
        const ended = typeof s.endedAt === "number";
        // FORK 2026-06-20: floor the arch HEIGHT for an ended branch. A fast helper
        // whose start+end snap to the same row would otherwise split AND join at the
        // same trunk point → a CLOSED 1px teardrop (the user's "weird max↔low loop").
        // Newest-at-top: the join (newer endedAt) sits ABOVE the split; force it at
        // least arc*3 above so the branch reads as a small out-and-back arch — but
        // never above the paper's top pad (a branch that is the very newest event has
        // no room and stays flat until the next sample lands).
        const joinY = ended
          ? Math.max(TOP_PAD, Math.min(timeToY(s.endedAt as number), splitY - arc * 3))
          : TOP_PAD;
        // FORK 2026-06-19: if the subagent crossed a prompt boundary, merge back into ITS
        // OWN turn's trunk column (the first turnEnd after it started), NOT the later turn's
        // — so a helper from the previous prompt never draws a high→max line across the
        // prompt rule into the new turn's column (the user's "previous call's high into max").
        let joinClampT = s.endedAt as number;
        if (ended && turnOf(joinClampT) !== turnOf(s.startedAt)) {
          joinClampT = this.turnEnds.find((t) => t.endedAt > s.startedAt)?.endedAt ?? joinClampT;
        }
        const joinX = ended ? mainColAt(joinClampT) : col;
        const dimOp = s.dim ? 0.32 : 1;
        // FORK 2026-06-19: how many strands run in parallel at this spawn — shown on
        // hover so mousing over the bunch reads the multiplicity at that moment (the user).
        const concurrentAtSpawn = subs.filter(
          (x) =>
            !!x.dim === !!s.dim &&
            x.startedAt <= s.startedAt &&
            (x.endedAt ?? Infinity) > s.startedAt,
        ).length;
        const tip = esc(
          [
            s.label && s.label !== s.model ? s.label : null,
            s.model || null,
            s.chosenLevel || "auto",
            s.outputTokens ? `${s.outputTokens} tok` : null,
            concurrentAtSpawn >= 2 ? `${concurrentAtSpawn}× parallel here` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        const yOut = splitY - arc * 2;
        let d =
          `M ${fx(splitX)} ${fx(splitY)}` +
          ` C ${fx(splitX)} ${fx(splitY - arc)} ${fx(col)} ${fx(splitY - arc)} ${fx(col)} ${fx(yOut)}`;
        // FORK 2026-06-20: never let a SHORT branch (a fast helper that finishes
        // before the next trunk call, so splitY≈joinY) pinch into a CLOSED teardrop —
        // force a small straight run at the strand column so it reads as a real
        // out-and-back arch, not a meaningless 1px loop (the user: "weird max↔low loop").
        // Geometry stays honest: same split→strand-col→join columns/color/width.
        const yJoinInRaw = ended ? joinY + arc * 2 : joinY;
        const yJoinIn = ended ? Math.min(yJoinInRaw, yOut - arc) : yJoinInRaw;
        if (yJoinIn < yOut) d += ` L ${fx(col)} ${fx(yJoinIn)}`;
        if (ended) {
          d += ` C ${fx(col)} ${fx(joinY + arc)} ${fx(joinX)} ${fx(joinY + arc)} ${fx(joinX)} ${fx(joinY)}`;
        }
        branches +=
          `<path class="eeg-branch" d="${d}" fill="none" stroke="${shade.stroke}"` +
          ` stroke-opacity="${fx(shade.opacity * dimOp)}" stroke-width="${fx(w)}"` +
          ` stroke-linecap="round" data-eeg-run="${esc(s.runId)}"><title>${tip}</title></path>`;
      }
    }
    // ── dynamic ×N: GLOBAL subagent concurrency over time. Sweep the [start,end]
    // intervals and emit a ×K label at each CHANGE (×6 → ×9 → …), at that
    // instant's y in the left gutter — a live multiplicity gauge (replaces the
    // single static cluster badge).
    {
      const evs: { t: number; d: number }[] = [];
      for (const s of subs) {
        if (s.dim) continue; // the ×N gauge counts the VIEWED session's fan-out only
        evs.push({ t: s.startedAt, d: 1 });
        if (typeof s.endedAt === "number") evs.push({ t: s.endedAt as number, d: -1 });
      }
      evs.sort((a, b) => a.t - b.t || b.d - a.d); // at a tie, starts (+1) before ends (-1)
      let count = 0;
      let lastShown = 0;
      for (let i = 0; i < evs.length; i++) {
        count += evs[i].d;
        if (i + 1 < evs.length && evs[i + 1].t === evs[i].t) continue; // coalesce same instant
        if (count !== lastShown) {
          if (count >= 2) {
            branches += `<text class="eeg-xn" x="3" y="${fx(timeToY(evs[i].t))}" font-size="9">×${count}</text>`;
          }
          lastShown = count;
        }
      }
    }

    // ── PROMPT separators: a CLEAR solid rule per turn = one prompt (clickable →
    // app.ts scrolls the chat to that prompt + highlights it). The "t N" label is
    // dropped (the user 2026-06-19: meaningless); the full-width transparent rect is the
    // generous hit target. Internal LLM-call boundaries get only a SUBTLE tick (below).
    let markers = "";
    for (const t of this.turnEnds) {
      const y = timeToY(t.endedAt);
      const idxAttr =
        typeof t.promptIndex === "number" ? ` data-eeg-prompt-index="${t.promptIndex}"` : "";
      const attrs =
        `class="eeg-marker" data-eeg-turn="${esc(String(t.turn))}" data-eeg-run="${esc(t.runId)}"${idxAttr}` +
        ` style="cursor:pointer"`;
      // prompt text on hover (item 7): a <title> on the generous hit rect
      const pTip = t.promptText ? `<title>${esc(t.promptText)}</title>` : "";
      markers +=
        `<line ${attrs} x1="0" y1="${fx(y)}" x2="${width}" y2="${fx(y)}"` +
        ` stroke="#C9CDD4" stroke-opacity="0.5" stroke-width="1.3"/>`;
      markers += `<rect ${attrs} x="0" y="${fx(y - 6)}" width="${width}" height="12" fill="transparent">${pTip}</rect>`;
    }

    // ── SUBTLE internal LLM-call separators: a faint short tick at each viewed
    // main-sample (LLM-call) boundary — the within-a-prompt rhythm, distinct from the
    // bold prompt rules above (the user 2026-06-19).
    let callTicks = "";
    for (const s of viewedMains) {
      const c = rowOf.get(s.runId);
      if (c === undefined || c === 0) continue;
      const y = rowTop(c);
      callTicks +=
        `<line x1="${fx(EEG_PAD_LEFT)}" y1="${fx(y)}" x2="${fx(EEG_PAD_LEFT + 9)}" y2="${fx(y)}"` +
        ` stroke="#8A8F98" stroke-opacity="0.22" stroke-width="1"/>`;
    }

    // paint order: grid → call-ticks → branches → main trace → prompt rules (clickable on top)
    // ── per-PROMPT hit bands: one full-width transparent zone spanning each turn's
    // time-slice, tagged with that prompt's index/text. Click ANYWHERE in a band →
    // scroll the chat to that prompt; hover → highlight the whole prompt's line + show
    // its text. Makes the LINE the interactive unit, not just the thin separator rule.
    let promptZones = "";
    for (let k = 0; k < this.turnEnds.length; k++) {
      const te = this.turnEnds[k];
      if (typeof te.promptIndex !== "number") continue;
      const topY = timeToY(te.endedAt);
      const botY = k > 0 ? timeToY(this.turnEnds[k - 1].endedAt) : height - BOTTOM_PAD;
      if (botY - topY < 1) continue;
      const zTip = te.promptText ? `<title>${esc(te.promptText)}</title>` : "";
      promptZones +=
        `<rect class="eeg-promptzone" data-eeg-prompt-index="${te.promptIndex}"` +
        ` x="0" y="${fx(topY)}" width="${width}" height="${fx(botY - topY)}" fill="transparent">${zTip}</rect>`;
    }

    // paint order: grid → €-grid → call-ticks → branches → trunk → prompt rules → prompt hit-bands (top)
    return (
      `<svg class="eeg-svg" width="${width}" height="${height}"` +
      ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      `${defs}${grid}${euroGrid}${callTicks}${branches}${trace}${markers}${promptZones}</svg>`
    );
  }
}
