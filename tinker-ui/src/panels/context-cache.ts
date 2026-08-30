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

import { SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline.js";
import { EEG_GOOGLE_GLOW, eegProviderPaint } from "./eeg-trace.js";

/**
 * FORK 2026-08-29 (the architect: switching opus -> grok left the window outline unchanged; "it should
 * have gone white").
 *
 * The outline used to take provider-logos.ts's PROVIDER_COLORS, which is the CHIP-FILL table:
 * there xai is "#111", the true brand black, drawn as a background behind a white logo. As a
 * 1px STROKE on a dark rail that is invisible — switching to Grok looked like nothing had
 * happened even once the width was right.
 *
 * eeg-trace.ts already solved exactly this, and its comment says so: xai is "#B7BBC2" because
 * "black brand is invisible on the #2a2318 paper". That table is the rail's identity-as-a-LINE
 * palette, which is what this outline is, so the panel now shares it with the seismograph
 * instead of borrowing the fill palette. It also resolves by model id as well as provider, so
 * the OpenRouter vendors (all of whom report provider "openrouter") keep their own colours.
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

  // FORK 2026-08-29 (the architect: "we will have a section called 'this call' and another named 'this
  // context' ... it does not make sense to represent in a graph an unbounded value, so we will
  // turn it into a couple panels").
  /** Tokens dropped from the transcript by the LAST compaction/eviction on this session. */
  lastEvictedTokens?: number;
  /** Accumulated over the session's lifetime. app.ts owns the accumulation; this module only
   *  paints what it is handed, so the counters stay testable and the renderer stays pure. */
  sessionStats?: {
    turns?: number;
    compactions?: number;
    /** Sum of every eviction/compaction saving observed on this session. */
    evictedTokens?: number;
  };
  /** Stat keys whose value changed recently and should GLOW. Computed by app.ts against a
   *  deadline it owns, so a repaint mid-glow keeps glowing instead of restarting or dropping. */
  glow?: readonly string[];
}

/** The 7 INPUT components of a prompt, in the order the anatomy event reports them. */
const ANATOMY_FIELDS: ReadonlyArray<readonly [string, string]> = [
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
  for (const [key, field] of ANATOMY_FIELDS) {
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

/** Tokens the provider billed that the gateway's anatomy could not attribute to a component. */
export function unitemisedTokens(segments: CacheSegment[], promptTokens: number): number {
  const sum = segments.reduce((acc, seg) => acc + seg.tokens, 0);
  const billed = pos(promptTokens);
  return sum > 0 && billed > sum ? billed - sum : 0;
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
  const segSum = segs.reduce((acc, seg) => acc + seg.tokens, 0);
  const maxWindow = pos(s.maxWindow);
  // What this call occupies. promptTokens is billed truth; the anatomy sum is the fallback for
  // the window BEFORE usage lands. Driving the free span off THIS (rather than off the sum of
  // the rendered segment widths) keeps the bar honest when there is no anatomy block at all.
  // FORK 2026-07-28 — `promptTokens` is NOT always this call's context size. On the cc-bridge
  // lane (provider `claude-code`, the live primary) the embedded producer receives a TURN
  // AGGREGATE: the CLI's terminal `result` usage, summed across every internal API call of the
  // turn. Measured live: 6,448,106 and 1,029,656 against 1,000,000-token windows whose real
  // context was 52,116 — the panel rendered "645%".
  //
  // A prompt larger than the whole window is not a context size, so it may not drive the WINDOW
  // bar. When it fails that test we fall through to `segSum`, the anatomy composition, which is
  // the honest per-call figure (it decodes to the same 52,116) and was already the fallback for
  // "before usage lands". The split bar below is deliberately NOT guarded: cacheRead/cacheWrite
  // come from the SAME aggregate as promptTokens, so cached/written/new stay internally
  // consistent whether the sample covers one call or a whole turn — ratios survive aggregation.
  const promptTokensIsContextSized =
    promptTokens > 0 && (maxWindow <= 0 || promptTokens <= maxWindow);
  const used = promptTokensIsContextSized ? promptTokens : segSum;
  // FORK 2026-08-28 — the denominator is now the FIXED 1M ruler, not the model's window. See
  // CONTEXT_SCALE_TOKENS above for why. The old behaviour ("the real window when we know it,
  // otherwise the call itself") survives as the OUTLINE drawn on top: the window is still
  // stated, it is just no longer the thing that decides how wide a token is.
  const scale = contextScaleTokens(maxWindow, used);

  const segSpans = segs
    .map((seg) => {
      const w = (seg.tokens / scale) * 100;
      const title = `${seg.label} — ${fmtTokens(seg.tokens)} (${seg.pct.toFixed(1)}%)`;
      return (
        `<span class="cache-seg" style="width:${wpct(w)}%;background:${seg.color}"` +
        ` title="${esc(title)}"></span>`
      );
    })
    .join("");

  // The billed prompt minus what the anatomy could attribute. On the CLI pipe this is the
  // claude CLI's own transcript, which the gateway never sees and so cannot break down. Drawn
  // rather than hidden: the gap is real, and it is usually the LARGEST part of the prompt.
  // Guarded for the same reason as `used`: with a turn aggregate this would be
  // 6,448,106 - 52,116, painting an "unitemised" span that swallows the entire bar.
  const unitemised = promptTokensIsContextSized ? unitemisedTokens(segs, promptTokens) : 0;
  const unitemisedSpan =
    unitemised > 0
      ? `<span class="cache-seg cache-seg--unitemised"` +
        ` style="width:${wpct((unitemised / scale) * 100)}%"` +
        ` title="${esc(`Unitemised — ${fmtTokens(unitemised)} (${((unitemised / (promptTokens || 1)) * 100).toFixed(1)}%) · billed but not broken down by the gateway (CLI-managed history)`)}"></span>`
      : "";

  // FORK 2026-08-28 — always drawn now. `scale` is a constant floor, so unlike `maxWindow` it can
  // never be 0, and the headroom to the end of the 1M ruler is exactly the thing the fixed scale
  // exists to show.
  const freeWidth = Math.max(0, 100 - (used / scale) * 100);
  const freeSpan = `<span class="cache-seg cache-seg--free" style="width:${wpct(freeWidth)}%"></span>`;

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
  // the window outline and the end of `used`.
  const excess = maxWindow > 0 && used > maxWindow ? used - maxWindow : 0;
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
      ? `${fmtTokens(used)} / ${fmtTokens(maxWindow)} · ${Math.round((used / maxWindow) * 100)}%`
      : `${fmtTokens(used)} sent`) +
    ` · of ${fmtTokens(scale)}` +
    // Short by design: this element is single-line with ellipsis, so a long caveat would be
    // the first thing clipped — leaving a string that still reads as a plain fill.
    (promptTokens > 0 && !promptTokensIsContextSized ? " · measured" : "") +
    (identity.length > 0 ? ` · ${identity.join(" · ")}` : "") +
    (s.windowSource === "unknown" ? " (window unknown)" : "");

  const cacheRead = pos(s.cacheRead);
  const cacheWrite = pos(s.cacheWrite);
  // Derived rather than read from `input` on purpose: the producer defines
  // promptTokens = input + cacheRead + cacheWrite, so this IS `input` whenever the fields agree —
  // and when they don't, the three parts still cannot sum past the billed prompt.
  const fresh = Math.max(0, promptTokens - cacheRead - cacheWrite);

  const windowLegend =
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
   *  right for tokens and absurd for a number of turns. */
  const countStat = (key: string, label: string, value: number | undefined, help: string) => {
    const shown = typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
    return (
      `<div class="cache-stat${glowing.has(key) ? " cache-stat--glow" : ""}" data-stat="${key}"` +
      ` title="${esc(help)}"><span class="cache-stat-k">${esc(label)}</span>` +
      `<span class="cache-stat-v">${shown}</span></div>`
    );
  };

  const ss = s.sessionStats ?? {};
  const pct = (part: number) =>
    promptTokens > 0 ? ` (${((part / promptTokens) * 100).toFixed(0)}%)` : "";

  const thisCall =
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
      "Tokens dropped from the transcript before this prompt was submitted, by the last compaction or eviction. Estimated on the anatomy's chars/3.5 ladder.",
    ) +
    stat(
      "output",
      "output",
      pos(s.output) > 0 ? pos(s.output) : undefined,
      "Tokens the model generated in reply.",
    );

  const thisSession =
    countStat(
      "turns",
      "turns",
      ss.turns,
      "Model calls on this session. Seeded from the anatomy row's own turn counter when the tab attaches, then advanced by the live cache stream.",
    ) +
    countStat(
      "compactions",
      "compactions",
      ss.compactions,
      "Compactions and evictions completed on this session — each one is a prefix rewrite, so it costs a cache miss on the next call.",
    ) +
    stat(
      "evicted-total",
      "evicted",
      ss.evictedTokens,
      "Total context dropped by every compaction and eviction on this session. A win: it is the memory you are no longer paying to resend.",
    ) +
    stat(
      "saved",
      "saved",
      typeof ss.evictedTokens === "number" && typeof ss.turns === "number" && ss.turns > 0
        ? ss.evictedTokens * ss.turns
        : undefined,
      "ESTIMATE. Evicted tokens multiplied by the turns since — roughly what resending that context would have cost had it stayed. Indicative only, not a billed figure.",
    );

  // The frame and the excess are appended AFTER the flex spans: both are absolutely positioned by
  // the stylesheet, so they are out of flow and paint on top in source order.
  return (
    title("WINDOW", windowMeta) +
    `<div class="cache-bar cache-bar--window">${segSpans}${unitemisedSpan}${freeSpan}` +
    `${windowFrame}${excessOverlay}</div>` +
    `<div class="cache-legend cache-legend--window">${windowLegend}</div>` +
    title("THIS CALL", promptTokens > 0 ? `${fmtTokens(promptTokens)} billed` : "") +
    `<div class="cache-stats cache-stats--call">${thisCall}</div>` +
    title("THIS SESSION", "") +
    `<div class="cache-stats cache-stats--session">${thisSession}</div>`
  );
}
