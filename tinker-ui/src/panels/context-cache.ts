// FORK 2026-07-25 (the architect): "Context Cache" — the right-rail panel that answers two questions
// about the LAST API call: how much of the model's context window did it fill, and how much of
// that was replayed from the provider's prompt cache instead of being billed as fresh input.
//
// FORK 2026-08-28 (the architect): renamed "CONTEXT WINDOW" in the UI, and the window bar is now drawn
// against a FIXED 1M-token ruler instead of against whichever model happened to answer. The
// module ids stay `cache-*` on purpose — see the app.ts markup note.
//
// Pure render module — no DOM, no network, no clock. String in / string out, so every number,
// every division guard and every escape is pinned by context-cache.test.ts without a browser.
//
// Ownership split:
//   - this file owns the NUMBERS and the markup skeleton (innerHTML of #cache-panel-body);
//   - the stylesheet owns the colours of the cache-split bar (--read / --write / --fresh), the
//     absolute positioning of the two window overlays, and the button chrome;
//   - context-timeline.ts owns the per-segment palette and labels, and eeg-trace.ts owns the
//     per-PROVIDER identity STROKE. They are IMPORTED, never re-declared, so the timeline,
//     the treemap, the seismograph and this panel cannot drift on what "Skills" or "anthropic"
//     looks like.

import type { DropProvenance, SessionCounters } from "./context-counters.js";
import { RESPONSE_COLOR, SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline.js";
import { EEG_GOOGLE_GLOW, eegProviderPaint } from "./eeg-trace.js";

/**
 * FORK 2026-08-29 (the architect: switching opus -> grok left the window outline unchanged; "it should
 * have gone white").
 *
 * The outline used to take provider-logos.ts's PROVIDER_COLORS, which is the CHIP-FILL table:
 * there xai is the true brand black, drawn as a background behind a white logo. As a 1px STROKE
 * on a dark rail that is invisible — switching to Grok looked like nothing had happened even
 * once the width was right.
 *
 * eeg-trace.ts already solved exactly this, and its comment says so: `EEG_PROVIDER_COLORS.xai`
 * is a light grey precisely because the true brand black is invisible on the rail's `--surface`
 * paper. That table is the rail's identity-as-a-LINE palette, which is what this outline is, so
 * the panel now shares it with the seismograph instead of borrowing the fill palette. It also
 * resolves by model id as well as provider, so the OpenRouter vendors (all of whom report
 * provider "openrouter") keep their own colours.
 *
 * Both colours are NAMED here and never re-quoted: `EEG_PROVIDER_COLORS` (eeg-trace.ts) owns the
 * stroke, `--surface` (base.css) owns the paper. A hex pasted into this file — even into prose —
 * is a second copy of a value neither module would touch on a theme change, which is exactly why
 * right-rail-cache-palette.mjs scans the comments too (right-rail-interaction.md §7).
 *
 * Google resolves to an SVG gradient url() that means nothing to a CSS border, so the rainbow
 * is flattened to the same solid the SMART x COST chart uses.
 */
function windowOutlineColor(provider: string | undefined, model: string | undefined): string {
  const paint = eegProviderPaint(provider ?? "", model ?? "");
  return paint.isRainbow ? EEG_GOOGLE_GLOW : paint.stroke;
}

/** One input component of the prompt, already normalised onto the billed prompt total. */
export interface CacheSegment {
  key: string;
  label: string;
  color: string;
  tokens: number;
  pct: number;
}

export interface CachePanelState {
  model?: string;
  provider?: string;
  /** The model's max context window, in tokens. */
  maxWindow?: number;
  /** input + cacheRead + cacheWrite of the LAST API call — the billed prompt size. */
  promptTokens?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  /** Anatomy `contextSent` block: per-component token ESTIMATES, ceil(chars/3.5). */
  contextSent?: Record<string, unknown>;
  /** Epoch ms of the event being shown. The host owns any "ago" rendering — this module never
   *  reads the clock, which is what keeps it testable. */
  lastEventMs?: number;
  /** Where maxWindow came from. 'unknown' is SURFACED in the meta line, never hidden. */
  windowSource?: "anatomy" | "session" | "catalog" | "unknown";

  // FORK 2026-09-24 (B2) — P1/P5. The bar is IN only, so it matters WHEN the composition was
  // measured. A pre-call row is the real thing; a post-turn row holds this turn's replies and tool
  // results (F5) and must say so rather than pass for the input of a call. Left undefined until the
  // host sets it, which renders no badge — the honest state while A9 is still being built.
  compositionSnapshot?: "pre-call" | "post-turn";
  /** FORK 2026-09-25 — the (run, round) of the anatomy row `contextSent` was taken from, when that
   *  row named them. HOST BOOKKEEPING: only `keepsPreCallComposition` reads them, and nothing here
   *  paints them. */
  compositionRunId?: string;
  compositionRound?: number;
  /** P5 — where the billed numbers came from, when the host knows. A turn aggregate is DETECTED
   *  here without it (the maxWindow guard below), so silence never claims "exact". */
  usageProvenance?: "exact" | "estimated" | "aggregate" | "apportioned";
  /** Measured width of the bar in DEVICE pixels, when a host measures it. Only the minimum-width
   *  floors read it; see BAR_BUDGET_DEVICE_PX for the conservative default. */
  barDevicePx?: number;

  // FORK 2026-08-29 (the architect: "we will have a section called 'this call' and another named 'this
  // context' ... it does not make sense to represent in a graph an unbounded value, so we will
  // turn it into a couple panels").
  /** Tokens dropped from the transcript by the LAST compaction/eviction this page watched on this
   *  session (context-counters.ts CountersState.lastDropped). */
  lastEvictedTokens?: number;
  /** Where that size came from (P5): the claude CLI's own figures, or a local estimate. */
  lastEvictedProvenance?: DropProvenance;
  /** THIS SESSION, as context-counters.ts sessionCounters joins it (the row's counts, the call
   *  store's turns and calls, the per-drop `saved`). This module only paints what it is handed,
   *  so the counters stay testable and the renderer stays pure. */
  sessionStats?: SessionCounters;
  /** Stat keys whose value changed recently and should GLOW. Computed by app.ts against a
   *  deadline it owns, so a repaint mid-glow keeps glowing instead of restarting or dropping. */
  glow?: readonly string[];
}

/**
 * FORK 2026-09-25 — the owner's context-bar complaint, second half (context-window-panel.md F5).
 *
 * Does the panel KEEP the composition it holds when an anatomy row arrives? The host (app.ts, its
 * `context-anatomy` branch) took every row's `contextSent`, last write wins. Since A9 a turn
 * writes two rows for ONE (run, round): the pre-call row before the request, the post-turn row
 * after it. So live, the bar swapped to the post-turn composition at every turn end, while a
 * reload painted the pre-call one: the anatomy DB's upsert (context-anatomy-db.ts
 * insertAnatomyEvent) keeps it, because only the pre-call row itemises the prompt that was sent;
 * by post-turn the turn's own message has slid into the conversation.
 *
 * The rule is the ctx-timeline's merge (context-timeline.ts pushEvent), so the bar and the timeline
 * cannot disagree: a PRE-CALL composition survives a POST-TURN row of the SAME (run, round). Any
 * other row replaces it: another run or round, a pre-call row, and a row that does not name its
 * run, its round or its snapshot (nothing to match, so the old last-write-wins).
 *
 * Only the composition is held back (with its badge and key). The host still takes the row's other
 * fields (model, provider, window), as pushEvent overlays the rest of the row.
 */
export function keepsPreCallComposition(
  held: Pick<CachePanelState, "compositionSnapshot" | "compositionRunId" | "compositionRound">,
  row: { runId?: string; roundNumber?: number; snapshot?: "pre-call" | "post-turn" },
): boolean {
  return (
    held.compositionSnapshot === "pre-call" &&
    row.snapshot === "post-turn" &&
    typeof row.runId === "string" &&
    row.runId !== "" &&
    row.runId === held.compositionRunId &&
    typeof row.roundNumber === "number" &&
    row.roundNumber === held.compositionRound
  );
}

/**
 * The INPUT components of a prompt, in the order the BAR draws them.
 *
 * FORK 2026-09-24 (B2, context-window-panel.md P3) — renamed from ANATOMY_FIELDS because it is no
 * longer "the order the anatomy event reports them": it is the order of IMPORTANCE, and `moralCode`
 * leads it. On the non-Claude lanes the pack physically sits inside a user message and on the
 * cc-bridge lane inside the CLI's own transcript, so ordering by position in the prompt would bury
 * the one component that must never be the thing that gets trimmed. The other seven keep the
 * anatomy's own order, which already matched P3.
 *
 * The key and field strings are spelled here as literals rather than imported from
 * context-timeline.ts on purpose: the frontmatter gate in context-window-panel.md pins THE PALETTE
 * IMPORT TO A SINGLE LINE (its regex is not DOTALL), and a five-name import would be wrapped by the
 * formatter and break it. The `moral-code-first` gate asserts the two files agree instead.
 */
const BAR_FIELD_ORDER: ReadonlyArray<readonly [string, string]> = [
  ["moralCode", "moralCodeTokens"],
  ["systemPrompt", "systemPromptTokens"],
  ["injectedFiles", "injectedFilesTotalTokens"],
  ["skills", "skillsTokens"],
  ["toolSchemas", "toolSchemasTokens"],
  ["conversation", "conversationHistoryTokens"],
  ["toolResults", "toolResultsTokens"],
  ["userMessage", "userMessageTokens"],
];

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);

/** A usable positive number, or 0. Every division below is guarded by this. */
const pos = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** CSS percentage literal — 2dp, trailing zeros dropped, so float noise never reaches the DOM
 *  as `width:8.000000000000002%`. */
const wpct = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(2))) : "0");

/** Same unit ladder as `fmtChars` in context-treemap.ts: one decimal, lowercase k, capital M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/** Epoch ms as "YYYY-MM-DD HH:MM" in UTC, or "" for anything a Date cannot hold. Formats the stamp
 *  it is handed; never reads the clock. */
function utcMinute(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "";
  }
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "";
}

/**
 * The anatomy segments of the window bar, AT TRUE SCALE.
 *
 * Deliberately NOT stretched onto the billed prompt total. On the CLI pipe the gateway only
 * assembles part of the prompt — the claude CLI owns its own transcript — so `contextSent`
 * routinely accounts for ~49k of a ~482k billed call. Scaling the estimates up to meet the
 * billed number made the bar tidy but made every legend figure a ~10x lie (measured
 * 2026-07-25: System 6.5k rendered as 64.0k). The measured components are therefore reported
 * as measured, and `renderCachePanelHtml` draws the shortfall as one explicitly labelled
 * "Unitemised" span instead of silently inflating what we did measure.
 *
 * `pct` is taken of the billed total when known, else of the segment sum.
 */
export function cacheSegments(
  contextSent: Record<string, unknown> | undefined,
  total: number,
): CacheSegment[] {
  if (!contextSent) {
    return [];
  }
  const raw: Array<{ key: string; tokens: number }> = [];
  for (const [key, field] of BAR_FIELD_ORDER) {
    const tokens = pos(contextSent[field]);
    if (tokens > 0) {
      raw.push({ key, tokens });
    }
  }
  const sum = raw.reduce((acc, r) => acc + r.tokens, 0);
  const billed = pos(total);
  const pctBase = billed > 0 ? billed : sum;
  return raw.map((r) => ({
    key: r.key,
    label: SEGMENT_LABELS[r.key] ?? r.key,
    color: SEGMENT_COLORS[r.key] ?? "",
    tokens: r.tokens,
    pct: pctBase > 0 ? (r.tokens / pctBase) * 100 : 0,
  }));
}

/**
 * FORK 2026-08-28 (the architect: "we should visualize the colorful graph of a 1M token window, which I
 * think is the maximum for now").
 *
 * The window bar used to be drawn against `maxWindow` — whichever model answered last. That made
 * the bar meaningless as a COMPARISON: a 190k prompt on a 200k-window model and a 950k prompt on
 * a 1M-window model both rendered as "95% full", identical pictures of very different situations,
 * and switching tabs silently rescaled the ruler under you.
 *
 * The ruler is now FIXED at 1M — the largest window in play today — so the same number of tokens
 * always draws the same width, and the model's own window is drawn ON TOP as an outline
 * (`cache-window-frame`) instead of being the denominator.
 */
export const CONTEXT_SCALE_TOKENS = 1_000_000;

/**
 * Denominator of the window bar. Fixed at CONTEXT_SCALE_TOKENS, but never SMALLER than the
 * numbers it has to draw: a >1M model (or a call that overruns everything we know about) must
 * still fit inside the box rather than painting spans past 100% and getting clipped.
 */
export function contextScaleTokens(maxWindow: number, used: number): number {
  return Math.max(CONTEXT_SCALE_TOKENS, pos(maxWindow), pos(used));
}

/**
 * Tokens the provider billed that the gateway's anatomy could not attribute to a component.
 *
 * FORK 2026-09-24 (B2) — the `sum > 0` guard is gone. It meant a call with NO anatomy block at all
 * reported a shortfall of ZERO, so the bar drew nothing while the line above it printed "1.0k
 * sent": a number with no span under it, which is exactly the P2 mismatch this wave exists to end.
 * A prompt we could not break down AT ALL is 100% unitemised, and it is now drawn as such. The
 * overshoot direction is unchanged — an anatomy that exceeds the billed figure still yields 0,
 * never a negative span.
 */
export function unitemisedTokens(segments: CacheSegment[], promptTokens: number): number {
  const sum = segments.reduce((acc, seg) => acc + seg.tokens, 0);
  const billed = pos(promptTokens);
  return billed > sum ? billed - sum : 0;
}

/** The key the moral code draws under, in the palette and in BAR_FIELD_ORDER. */
const MORAL_CODE_KEY = "moralCode";
/** The anatomy field A9 will carry the pack's size in. */
const MORAL_CODE_TOKENS_FIELD = "moralCodeTokens";
/** The billed remainder's key — labelled by SEGMENT_LABELS, painted by CSS, never a palette hex. */
const UNITEMISED_KEY = "unitemised";

export type MoralCodeState = "present" | "absent" | "unknown";

/**
 * P3 meets P10. "The absence of the ethics is a state to see" — and P10 is equally firm that absent
 * is not zero, and that unknown is not absent. Both rules land on this function.
 *
 * The pre-call producer that reports `moralCodeTokens` (A9) is being built in parallel and is not
 * in the tree yet. If a MISSING field meant "absent", every call on every lane would paint a red
 * warning about a pack that is almost certainly there and merely unmeasured — a fabricated claim
 * wearing a measurement's clothes, which is the precise failure P10 exists to stop. So:
 *
 *   field missing / not a number  -> "unknown"  no slot on the bar, a dash in THIS CALL
 *   field present, 0              -> "absent"   the red-outlined empty slot, legend says so
 *   field present, > 0            -> "present"  the first coloured span on the bar
 *
 * The day A9 lands, every row carries the field and the slot becomes unconditional with no further
 * change here. That is the whole point of splitting the third state out instead of defaulting it.
 */
export function moralCodeState(contextSent: Record<string, unknown> | undefined): MoralCodeState {
  const v = contextSent?.[MORAL_CODE_TOKENS_FIELD];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return "unknown";
  }
  return v > 0 ? "present" : "absent";
}

/**
 * The bar's width in DEVICE pixels — the budget the minimum-width floors are measured against.
 *
 * 394 = the 420 px right rail (`#app` grid-template-columns, base.css) less `.rpanel`'s 12 px
 * padding either side, less the bar's own 1 px borders (everything is `box-sizing: border-box`, so
 * the border eats the content box). Held at dpr 1 deliberately: that is the WIDEST reading of
 * "2 device px", so a HiDPI screen only ever gets more moral code than the floor promises, never
 * less. A host that measures the bar passes `barDevicePx` and the floor shrinks to the true 2 px.
 */
export const BAR_BUDGET_DEVICE_PX = 394;

/** P3 — the moral code is never narrower than this. Its tooltip carries the true size. */
export const MORAL_CODE_MIN_DEVICE_PX = 2;

/**
 * The allocation grid: hundredths of one percent, which is exactly the precision `wpct` hands the
 * DOM. Allocating on this INTEGER grid — rather than in floats rounded on the way out — is what
 * makes P2 provable rather than probable: the spans are integers that sum to GRID by construction,
 * so the rendered widths sum to exactly 100% and `overflow: hidden` has nothing left to clip.
 */
const GRID = 10_000;

export interface BarSpan {
  key: string;
  tokens: number;
  /** Width as a CSS percentage of the bar, at the 2dp precision the DOM receives. */
  pct: number;
  /** True when a floor widened this span past its true share — the tooltip says so. */
  floored: boolean;
}

/**
 * P2 — "the bar cannot overflow, BY CONSTRUCTION".
 *
 * Floors are stated in device pixels, because "at least 2 px" is not a thing a percentage can say
 * at an unknown rail width; everything else keeps its EXACT share of the ruler, so a span that was
 * never starved draws exactly the width it always drew. Who pays, in order (P2): the FREE span
 * first — which needs no code, free simply being whatever the grid has left — then the LARGEST
 * segment, repeatedly.
 *
 * Never the moral code. That exclusion is EXPLICIT rather than inferred from "is it floored",
 * which was the tempting shortcut: a big pack is not floored and therefore becomes the largest
 * eligible victim. Under the precondition below the two agree (the only deficit is the floor
 * itself); they part as soon as a caller hands a ruler shorter than what is drawn. Measured
 * 2026-09-24 on 5,000 cases from the property test's generator with the ruler held at
 * max(1M, window): the floored-proxy version cut the moral code below its own floor 607 times,
 * this one 0. The last-resort pass below is reachable only when the moral code alone is wider
 * than the whole bar, where drawing it at 100% is the right answer — it IS the whole context —
 * not a violation.
 *
 * Precondition the renderer supplies: `scale` is max(1M, the model window, the DRAWN total), so no
 * span can exceed the ruler and the only deficit that ever arises is the floor itself. Measured on
 * 20,000 renderer-shaped cases: 0 over-budget, 0 moral codes below the floor, 0 negative spans.
 */
export function allocateBarSpans(
  drawn: ReadonlyArray<{ key: string; tokens: number }>,
  scale: number,
  opts?: { barDevicePx?: number; minPx?: Readonly<Record<string, number>> },
): { spans: BarSpan[]; freePct: number } {
  const budget = pos(opts?.barDevicePx) || BAR_BUDGET_DEVICE_PX;
  const denom = pos(scale);
  const tokens = drawn.map((d) => pos(d.tokens));

  // True share, on the grid. Math.round is what wpct did at render time, so an unfloored span keeps
  // byte-for-byte the width it has always had.
  const units = tokens.map((t) => (denom > 0 ? Math.round((t / denom) * GRID) : 0));
  // A floor arrives in device px; ceil it onto the grid so the slot is never a hair under promise.
  const floors = drawn.map((d) =>
    Math.min(GRID, Math.ceil((pos(opts?.minPx?.[d.key]) / budget) * GRID)),
  );
  const floored = drawn.map((_, i) => floors[i] > units[i]);
  for (let i = 0; i < units.length; i++) {
    if (floored[i]) {
      units[i] = floors[i];
    }
  }

  let deficit = units.reduce((acc, u) => acc + u, 0) - GRID;
  while (deficit > 0) {
    let big = -1;
    for (let i = 0; i < units.length; i++) {
      if (floored[i] || units[i] <= 0 || drawn[i].key === MORAL_CODE_KEY) {
        continue;
      }
      if (big < 0 || units[i] > units[big]) {
        big = i;
      }
    }
    if (big < 0) {
      break;
    }
    const take = Math.min(units[big], deficit);
    units[big] -= take;
    deficit -= take;
  }
  // Last resort — only reachable when the protected span alone outgrows the bar.
  for (let i = 0; i < units.length && deficit > 0; i++) {
    const take = Math.min(units[i], deficit);
    units[i] -= take;
    deficit -= take;
  }

  const spans = drawn.map((d, i) => ({
    key: d.key,
    tokens: tokens[i],
    pct: units[i] / 100,
    floored: floored[i],
  }));
  const free = Math.max(0, GRID - units.reduce((acc, u) => acc + u, 0));
  return { spans, freePct: free / 100 };
}

/** innerHTML for `#cache-panel-body`. */
export function renderCachePanelHtml(s: CachePanelState): string {
  const promptTokens = pos(s.promptTokens);
  if (promptTokens <= 0 && !s.contextSent) {
    return (
      '<div style="color:var(--muted);font-size:12px;padding:8px">' +
      "Idle — waiting for the first model call.</div>"
    );
  }

  const segs = cacheSegments(s.contextSent, promptTokens);
  const maxWindow = pos(s.maxWindow);
  // What this call occupies. promptTokens is billed truth; the anatomy sum is the fallback for
  // the window BEFORE usage lands. Since B2 (2026-09-24) both halves are DRAWN — the anatomy
  // segments plus the unitemised remainder up to promptTokens — and the free span is whatever the
  // allocation leaves, so the bar stays honest with no anatomy block at all (all unitemised).
  // FORK 2026-07-28 — `promptTokens` is NOT always this call's context size. On the cc-bridge
  // lane (provider `claude-code`, the live primary) the embedded producer receives a TURN
  // AGGREGATE: the CLI's terminal `result` usage, summed across every internal API call of the
  // turn. Measured live: 6,448,106 and 1,029,656 against 1,000,000-token windows whose real
  // context was 52,116 — the panel rendered "645%".
  //
  // A prompt larger than the whole window is not a context size, so it may not drive the WINDOW
  // bar. When it fails that test the bar draws the anatomy composition alone (no unitemised
  // remainder), which is the honest per-call figure (it decodes to the same 52,116) and was already the fallback for
  // "before usage lands". The split bar below is deliberately NOT guarded: cacheRead/cacheWrite
  // come from the SAME aggregate as promptTokens, so cached/written/new stay internally
  // consistent whether the sample covers one call or a whole turn — ratios survive aggregation.
  const promptTokensIsContextSized =
    promptTokens > 0 && (maxWindow <= 0 || promptTokens <= maxWindow);
  // The billed prompt minus what the anatomy could attribute. On the CLI pipe this is the claude
  // CLI's own transcript, which the gateway never sees and so cannot break down. Drawn rather than
  // hidden: the gap is real, and it is usually the LARGEST part of the prompt. Guarded for the same
  // reason as the composition below — with a turn aggregate this would be 6,448,106 - 52,116,
  // painting an "unitemised" span that swallows the entire bar.
  const unitemised = promptTokensIsContextSized ? unitemisedTokens(segs, promptTokens) : 0;
  const moral = moralCodeState(s.contextSent);

  // P3's draw order, assembled once. `cacheSegments` already returns moralCode first when the pack
  // is present (BAR_FIELD_ORDER owns that order); an ABSENT pack enters here as a zero-token span
  // that the allocator floors to 2 device px, which is how "no ethics on this call" becomes
  // something you can SEE rather than a span of width nothing.
  const drawn: Array<{ key: string; tokens: number }> = [];
  if (moral === "absent") {
    drawn.push({ key: MORAL_CODE_KEY, tokens: 0 });
  }
  for (const seg of segs) {
    drawn.push({ key: seg.key, tokens: seg.tokens });
  }
  if (unitemised > 0) {
    drawn.push({ key: UNITEMISED_KEY, tokens: unitemised });
  }

  // FORK 2026-09-24 (B2, P2) — the printed number is the sum of the spans DRAWN in the bar, full
  // stop. It used to be `used`, which was promptTokens whenever that looked plausible; when the
  // post-turn anatomy overshot the billed figure the bar drew one quantity while the line above it
  // printed another, and the difference was silently clipped (F5). This is also the ruler's input,
  // which is the other half of the same fix: max(1M, the model window, the DRAWN total).
  const drawnTokens = drawn.reduce((acc, d) => acc + d.tokens, 0);
  // FORK 2026-08-28 — the denominator is the FIXED 1M ruler, not the model's window. See
  // CONTEXT_SCALE_TOKENS above for why. The old behaviour ("the real window when we know it,
  // otherwise the call itself") survives as the OUTLINE drawn on top: the window is still
  // stated, it is just no longer the thing that decides how wide a token is.
  const scale = contextScaleTokens(maxWindow, drawnTokens);

  // FORK 2026-09-24 (B2, P2/P3). The spans are no longer each computed against the ruler and then
  // hoped to add up: allocateBarSpans lays the whole row out on one integer grid, floors the moral
  // code, pays that floor out of the free span (then out of the largest segment, never out of the
  // moral code) and returns a row that sums to exactly 100%. Nothing can reach the bar's
  // overflow:hidden to be clipped, because nothing is ever wider than the box.
  const alloc = allocateBarSpans(drawn, scale, {
    barDevicePx: s.barDevicePx,
    minPx: { [MORAL_CODE_KEY]: MORAL_CODE_MIN_DEVICE_PX },
  });
  const segByKey = new Map<string, CacheSegment>(
    segs.map((seg) => [seg.key, seg] as [string, CacheSegment]),
  );
  const unitemisedShare = ((unitemised / (promptTokens || 1)) * 100).toFixed(1);
  const segSpans = alloc.spans
    .map((sp) => {
      const w = `width:${wpct(sp.pct)}%`;
      if (sp.key === UNITEMISED_KEY) {
        const t = `${SEGMENT_LABELS[UNITEMISED_KEY]} — ${fmtTokens(sp.tokens)} (${unitemisedShare}%) · billed but not broken down by the gateway (CLI-managed history)`;
        return `<span class="cache-seg cache-seg--unitemised" style="${w}" title="${esc(t)}"></span>`;
      }
      if (sp.key === MORAL_CODE_KEY && sp.tokens <= 0) {
        const t =
          "moral code: absent — this call carried no ethics pack. An empty slot, drawn at its floor, because an absence you cannot see is one nobody acts on.";
        return `<span class="cache-seg cache-seg--moral-absent" style="${w}" title="${esc(t)}"></span>`;
      }
      const seg = segByKey.get(sp.key);
      if (!seg) {
        return "";
      }
      const t =
        `${seg.label} — ${fmtTokens(seg.tokens)} (${seg.pct.toFixed(1)}%)` +
        (sp.floored ? " · drawn at its 2px minimum so it cannot vanish" : "");
      const cls = sp.key === MORAL_CODE_KEY ? "cache-seg cache-seg--moral" : "cache-seg";
      return `<span class="${cls}" style="${w};background:${seg.color}" title="${esc(t)}"></span>`;
    })
    .join("");

  // P2 — the free span is the REMAINDER of the allocation, not an independent subtraction. The two
  // agreed for as long as nothing was floored; deriving it here means they cannot stop agreeing.
  const freeSpan = `<span class="cache-seg cache-seg--free" style="width:${wpct(alloc.freePct)}%"></span>`;

  // FORK 2026-08-28 (the architect: "an empty rectangle on top of the graph, in the color of the
  // provider, to show the context window of the specific model being used").
  //
  // An OUTLINE, not a fill: this is a ruler mark, not a quantity. A filled box would read as a
  // fourth data colour competing with the anatomy segments it sits over. It is positioned
  // absolutely by the stylesheet (which is why .cache-bar--window is position:relative) and
  // appended AFTER the flex spans so it paints above them.
  //
  // The colour comes from the same identity-stroke table the seismograph uses — imported, never
  // re-declared, so the rail cannot end up with two different "anthropic" oranges. See
  // windowOutlineColor for why this is the EEG table and not the chip-fill one.
  const windowFrame =
    maxWindow > 0
      ? `<span class="cache-window-frame" style="width:${wpct((maxWindow / scale) * 100)}%;` +
        `border-color:${windowOutlineColor(s.provider, s.model)}"` +
        ` title="${esc(`${s.model || s.provider || "model"} window — ${fmtTokens(maxWindow)} of the ${fmtTokens(scale)} scale`)}"></span>`
      : "";

  // FORK 2026-08-28 (the architect: "if the present context exceeds the window that we want to use, it
  // should warn by a red transparent blink on the excess context that need trimming").
  //
  // An absolute OVERLAY, deliberately not another flex span: the excess is the tail of the very
  // same tokens the coloured segments already draw, so laying it out in the flex row would add
  // its width a second time and push the free span off the end. Drawn over the region between
  // the window outline and the end of `drawnTokens`.
  const excess = maxWindow > 0 && drawnTokens > maxWindow ? drawnTokens - maxWindow : 0;
  const excessOverlay =
    excess > 0
      ? `<span class="cache-window-excess" style="left:${wpct((maxWindow / scale) * 100)}%;` +
        `width:${wpct((excess / scale) * 100)}%"` +
        ` title="${esc(`${fmtTokens(excess)} over the ${fmtTokens(maxWindow)} window — this much context must be trimmed`)}"></span>`
      : "";

  const identity = [s.model, s.provider].filter((v): v is string => Boolean(v)).map(esc);
  const windowMeta =
    // The percentage stays against the MODEL's window, not the 1M ruler: "how full am I" is a
    // question about the window that will actually reject the next call. The ruler is stated
    // separately so the bar's geometry is readable rather than inferred.
    (maxWindow > 0
      ? `${fmtTokens(drawnTokens)} / ${fmtTokens(maxWindow)} · ${Math.round((drawnTokens / maxWindow) * 100)}%`
      : `${fmtTokens(drawnTokens)} sent`) +
    ` · of ${fmtTokens(scale)}` +
    // Short by design: this element is single-line with ellipsis, so a long caveat would be
    // the first thing clipped — leaving a string that still reads as a plain fill.
    (promptTokens > 0 && !promptTokensIsContextSized ? " · measured" : "") +
    // FORK 2026-09-24 (B2, P1/P5) — WHEN the composition was measured. A post-turn row holds this
    // turn's replies and tool results, so a bar drawn from it is not the input of a call and must
    // not pass for one. Silent until a host sets the field: claiming "pre-call" without a producer
    // would be the confident-but-false label P5 exists to stop.
    (s.compositionSnapshot === "post-turn"
      ? " · post-turn"
      : s.compositionSnapshot === "pre-call"
        ? " · pre-call"
        : "") +
    (identity.length > 0 ? ` · ${identity.join(" · ")}` : "") +
    (s.windowSource === "unknown" ? " (window unknown)" : "");

  const cacheRead = pos(s.cacheRead);
  const cacheWrite = pos(s.cacheWrite);
  // Derived rather than read from `input` on purpose: the producer defines
  // promptTokens = input + cacheRead + cacheWrite, so this IS `input` whenever the fields agree —
  // and when they don't, the three parts still cannot sum past the billed prompt.
  const fresh = Math.max(0, promptTokens - cacheRead - cacheWrite);

  // P3 — "the legend says 'moral code: absent'". In words as well as in the bar, because a coloured
  // swatch alone reads as a thing that is PRESENT; the dot here is an empty red outline, mirroring
  // the slot. It leads the legend for the same reason the slot leads the bar.
  const windowLegend =
    (moral === "absent"
      ? `<span class="cache-legend-item" title="This call carried no moral-code pack.">` +
        `<i class="cache-dot cache-dot--moral-absent"></i>moral code: absent</span>`
      : "") +
    segs
      .map(
        (seg) =>
          `<span class="cache-legend-item"><i class="cache-dot" style="background:${seg.color}"></i>` +
          `${esc(seg.label)} ${fmtTokens(seg.tokens)}</span>`,
      )
      .join("") +
    (unitemised > 0
      ? `<span class="cache-legend-item" title="Billed but not broken down by the gateway` +
        ` (CLI-managed conversation history)."><i class="cache-dot cache-dot--unitemised"></i>` +
        `Unitemised ${fmtTokens(unitemised)}</span>`
      : "");

  // Only the WINDOW is a bar, and that is the point. It is the one quantity here with a real
  // denominator — the model's context window against the fixed 1M ruler. Everything below is
  // UNBOUNDED (the architect: "it does not make sense to represent in a graph an unbounded value"): a
  // billed prompt on the cc-bridge lane is a turn aggregate with no ceiling, and the session
  // counters only ever grow. Drawing those as bars invents a denominator, which is exactly how
  // this panel once rendered "645%". They are numbers, so they are shown as numbers.
  const title = (label: string, value: string) =>
    `<div class="cache-meta cache-meta--title"><span>${label}</span><span>${value}</span></div>`;

  const glowing = new Set(s.glow ?? []);
  /** One stat cell. `key` is the glow contract with app.ts and the test hook; it never changes
   *  when the label does. A cell with nothing to say renders a dash rather than a fake 0. */
  const stat = (key: string, label: string, value: number | undefined, help: string): string => {
    const shown = typeof value === "number" && Number.isFinite(value) ? fmtTokens(value) : "—";
    return (
      `<div class="cache-stat${glowing.has(key) ? " cache-stat--glow" : ""}" data-stat="${key}"` +
      ` title="${esc(help)}"><span class="cache-stat-k">${esc(label)}</span>` +
      `<span class="cache-stat-v">${shown}</span></div>`
    );
  };
  /** Plain counts (turns, compactions) must NOT go through the token unit ladder — "1.2k" is
   *  right for tokens and absurd for a number of turns. B3: `atLeast` marks a FLOOR (a count the
   *  panel knows is at least this) with "≥", and never the dash (P5: count or floor is part of it). */
  const countStat = (
    key: string,
    label: string,
    value: number | undefined,
    help: string,
    atLeast = false,
  ) => {
    const shown =
      typeof value === "number" && Number.isFinite(value)
        ? `${atLeast ? "≥" : ""}${String(value)}`
        : "—";
    return (
      `<div class="cache-stat${glowing.has(key) ? " cache-stat--glow" : ""}" data-stat="${key}"` +
      ` title="${esc(help)}"><span class="cache-stat-k">${esc(label)}</span>` +
      `<span class="cache-stat-v">${shown}</span></div>`
    );
  };

  const ss = s.sessionStats ?? {};
  const pct = (part: number) =>
    promptTokens > 0 ? ` (${((part / promptTokens) * 100).toFixed(0)}%)` : "";

  // P5 — provenance belongs in the LABEL, not in a footnote. On the cc-bridge lane the billed
  // number is the CLI's terminal `result` usage summed over every internal call of the turn;
  // heading that "THIS CALL" is exactly the mislabel P5 names, and it is how this panel once
  // rendered "645%". The guard that already refuses to let an aggregate drive the bar now renames
  // the section it does drive, so the number and its name cannot disagree.
  const callIsAggregate =
    (promptTokens > 0 && !promptTokensIsContextSized) || s.usageProvenance === "aggregate";
  const callTitle = callIsAggregate ? "THIS TURN (aggregate)" : "THIS CALL";
  const callValue =
    promptTokens > 0
      ? `${fmtTokens(promptTokens)} billed${callIsAggregate ? " · summed over the turn" : ""}`
      : "";

  // FORK 2026-09-30 (the architect: "just add an extra number after 'this call', also purple if you will,
  // with the amount of output tokens total per this call"). The bar above draws only what was SENT,
  // so the model's reply is a number here, right after the label, in the output purple. It replaces
  // the OUTPUT cell that sat at the end of the grid: the same figure twice in one section is how the
  // two drift. `data-stat="output"` keeps app.ts's glow on it when the figure changes.
  const output = pos(s.output);
  const callOut =
    `<span class="cache-out${glowing.has("output") ? " cache-stat--glow" : ""}" data-stat="output"` +
    ` style="color:${RESPONSE_COLOR}"` +
    ` title="${esc(`Output: tokens the model generated in reply${callIsAggregate ? ", summed over the turn" : " on this call"}. Not on the bar above, which draws only the input sent.`)}">` +
    `${output > 0 ? fmtTokens(output) : "—"} out</span>`;

  const thisCall =
    stat(
      "moral",
      "moral code",
      moral === "present"
        ? pos(s.contextSent?.[MORAL_CODE_TOKENS_FIELD])
        : moral === "absent"
          ? 0
          : undefined,
      moral === "absent"
        ? "This call carried NO moral-code pack. A zero that was read, not a reading that is missing."
        : "Size of the ethics pack sent with this call. A dash means no producer has reported it yet — unknown, which is not the same as absent.",
    ) +
    stat(
      "cached",
      "cached",
      promptTokens > 0 ? cacheRead : undefined,
      `Replayed from the provider prompt cache${pct(cacheRead)} — billed at roughly a tenth of fresh input. The single biggest lever on cost.`,
    ) +
    stat(
      "written",
      "written",
      promptTokens > 0 ? cacheWrite : undefined,
      "Written INTO the cache by this call — billed at a premium. A large value means the prefix was rewritten, so the next call cannot replay it.",
    ) +
    stat(
      "new",
      "new",
      promptTokens > 0 ? fresh : undefined,
      "Fresh prompt tokens billed as ordinary input.",
    ) +
    stat(
      "unitemised",
      "unitemised",
      promptTokens > 0 ? unitemised : undefined,
      "Billed but not broken down by the gateway — on the CLI pipe this is the claude CLI's own transcript, which the gateway never sees.",
    ) +
    stat(
      "evicted",
      "evicted",
      s.lastEvictedTokens,
      "Tokens dropped from the transcript by the last compaction or eviction this page watched on this session." +
        (s.lastEvictedProvenance === "exact"
          ? " Exact: the claude CLI's own before and after."
          : s.lastEvictedProvenance === "estimated"
            ? " ESTIMATE: a local chars-per-token count, not a billed figure."
            : " A dash: none watched yet, or its producer did not measure its size."),
    );

  // B3 (2026-09-25) — `saved` is context-counters.ts's per-drop integral (F4), painted as handed:
  // undefined paints "—". Nothing here rebuilds it. The pre-B3 evicted × turns product, which
  // charged every drop against every turn of the session (the ones before it included), is gone,
  // with the ratchet branch that kept it reachable for one old test (2026-09-25).
  const saved = ss.saved;
  const lastAt = utcMinute(ss.lastCompactionAt);
  const thisSession =
    countStat(
      "turns",
      "turns",
      ss.turns,
      "Turns on this session: one per run the call timeline has seen, its history (the session's retained anatomy rows) plus the live runs since. ≥ marks a floor: the history is still loading, or it was cut at its row limit.",
      ss.turnsAtLeast === true,
    ) +
    countStat(
      "calls",
      "calls",
      ss.calls,
      "Model calls on this session, from the call timeline's record of each one (the call stream, else its fallbacks). A history row is a whole turn drawn as ONE call, so once history is loaded this is a floor (≥).",
      ss.callsAtLeast === true,
    ) +
    countStat(
      "compactions",
      "compactions",
      ss.compactions,
      "Compactions on this session as the gateway's session row counts them, so a reload, another tab or another browser shows the same number. Each is a prefix rewrite, so it costs a cache miss on the next call. A dash: the row does not carry the count." +
        (lastAt ? ` Last compaction or eviction: ${lastAt} UTC.` : ""),
    ) +
    countStat(
      "evictions",
      "evictions",
      ss.evictions,
      "Evictions on this session (the EVICT button: the oldest turns dropped, no model call), read from the gateway's session row. A dash: the row does not carry the count.",
    ) +
    stat(
      "evicted-total",
      "dropped",
      ss.evictedTokens,
      "Tokens dropped by every compaction and eviction on this session, read from the gateway's session row. A win: it is context you are no longer paying to resend. A dash: the row does not carry the total.",
    ) +
    stat(
      "saved",
      "saved",
      saved,
      "ESTIMATE, over the drops this page has watched: each drop's tokens × the model calls made since it, roughly what resending that context would have cost had it stayed. Drops from before this page opened are not in it. Indicative only, not a billed figure.",
    );

  // FORK 2026-09-07 — THIS CALL carries its OWN legend. right-rail-interaction.md §7: the two
  // sections have DIFFERENT denominators, so each states its own; one legend serving both is how
  // the reader carries the bar's scale onto figures that are not on it. The bar above divides by
  // the fixed CONTEXT_SCALE_TOKENS ruler, everything under THIS CALL divides by this one call's
  // billed prompt.
  //
  // That rule OUTLIVED the split bar (removed 2026-08-29: an unbounded value must not be drawn as
  // a width) because its reason did not go anywhere — numbers printed under a bar are read against
  // that bar unless something says otherwise. So this legend names the scale in words instead of
  // keying colours: there is no bar below this line, so a `cache-legend-item` swatch here would be
  // a dot pointing at nothing, and it would inflate a count that measures the WINDOW bar's
  // segments.
  const splitLegend =
    promptTokens > 0
      ? `cached + written + new = ${fmtTokens(promptTokens)} billed on this ${callIsAggregate ? "turn" : "call"}` +
        ` · not the ${fmtTokens(scale)} ruler above`
      : "nothing billed on this call yet";

  // The frame and the excess are appended AFTER the flex spans: both are absolutely positioned by
  // the stylesheet, so they are out of flow and paint on top in source order.
  return (
    title("WINDOW", windowMeta) +
    `<div class="cache-bar cache-bar--window">${segSpans}${freeSpan}` +
    `${windowFrame}${excessOverlay}</div>` +
    `<div class="cache-legend cache-legend--window">${windowLegend}</div>` +
    `<div class="cache-meta cache-meta--title"><span>${callTitle}</span>${callOut}<span>${callValue}</span></div>` +
    `<div class="cache-stats cache-stats--call">${thisCall}</div>` +
    `<div class="cache-legend cache-legend--split">${splitLegend}</div>` +
    title("THIS SESSION", "") +
    `<div class="cache-stats cache-stats--session">${thisSession}</div>`
  );
}
