// tinker-ui/src/panels/smart-cost-chart.ts
// FORK 2026-08-06 (the architect): SMARTNESS × COST constellation chart — Artificial
// Analysis style (log cost × linear quality), one CONSTELLATION per model: a
// circle per thinking-effort level, connected. Circle area ∝ context window;
// colour = the model's EEG trace colour (resolveEegPaint), so the chart agrees
// with the seismograph, the glows and the MODELS panel.
//
// FORK 2026-08-06 #2 (the architect): PER-TASK mode. Research into average tokens per
// task (OckBench, arXiv:2511.05722 — the only public benchmark that measures
// output tokens PER TASK across models AND effort levels — plus family anchors:
// Anthropic's "Opus 5 = 26% fewer tokens than Opus 4.8 at max", DeepSeek-V4-Pro
// ≈3.6× Kimi K3, the Overthinking Tax on small models) feeds a second position
// per dot: cost-per-task = cost-per-Mtok × tokens-per-task, normalized so the
// REFERENCE — Claude Opus 5 at its top REAL effort, `high` — does not move.
// (It read "MAX effort" until 2026-08-25, a setting Anthropic does not expose
// for that model class.) Dots are outline
// circles carrying the model's logo; a toggle animates them (CSS transform,
// slow, staggered, reversible) to the per-task position, with faint ghost
// outlines marking where each one lands.
//
// PURE module — no DOM access, state in (ScModel[]) → SVG string out, same
// contract as eeg-trace.ts. app.ts owns the overlay + the toggle wiring.
//
// HONESTY (bible §5.8h invariant 3): X = effective €/Mtok (the EEG number);
// Y = AA index; effort COST mults = EEG_EFFORT_MULT (documented).
//
// FORK 2026-08-27 (the architect: "you flattened the graphs"). AA DOES publish per-effort
// Intelligence Index rows — Opus 5 low 52.46 / medium 58.64 / high 61.48 /
// xhigh 62.52 / max 63.05, live scrape 2026-08-27. The 2026-08-25 flattening was
// the right answer to an invented 0.9…1.12 curve, and the wrong answer once a
// real table existed. A stop is now plotted only when BOTH are true: the vendor
// documents that effort, AND AA published a number for it. Missing AA → the stop
// is omitted, never filled with the model's headline index. That is the rule
// the architect wrote: "If you did not find the intelligence index of a particular
// model-effort level do not approximate."
//
// TOKENS-PER-TASK: Opus 5 and Kimi K3 are benchmark-anchored (OckBench,
// arXiv:2511.05722); everything else is a labelled estimate from family
// anchors. The footer says so in the UI; the table below says so per row.

import { resolveProviderEffortLadder } from "../../../src/shared/provider-effort-ladders.js";
import type { EffortLadderKind } from "../../../src/shared/provider-effort-ladders.js";
import { aaScoreAt } from "./aa-effort-index.js";
import { EEG_EFFORT_MULT } from "./eeg-trace.js";
import { getRoutedLogoSvg } from "./provider-logos.js";

export interface ScModel {
  /** Full model ref ("openrouter/qwen/qwen3.8-max"). */
  id: string;
  /** Short display name ("Qwen 3.8 Max"). */
  name: string;
  provider: string;
  /** AA Intelligence Index at standard effort (panel sort key). */
  index: number;
  /** Effective €/Mtok output at medium effort (eegRelCost). */
  relCost: number;
  /** Context window in tokens. */
  ctx: number;
  /** Trace colour — rainbow already resolved to a solid by the caller. */
  color: string;
  /** Legend/highlight grouping key. The chart only ECHOES this into data-vendor
   *  so app.ts can dim by provider; app.ts resolves it with the SAME rule the
   *  dot colour uses (vendorOfModel(provider+" "+id) ?? provider), because
   *  `provider` alone puts Kimi, GLM, Qwen and DeepSeek — four different colours
   *  on the chart — under one grey "openrouter" bucket. Defaults to provider. */
  vendorKey?: string;
  /** Render a text label at the max-effort point. Defaults to ON — every
   *  plotted model gets its name (the architect 2026-08-06 #11: "there are a lot of
   *  model names missing"). Set false to leave one tooltip-only. */
  labeled?: boolean;
}

// ─── Multi-vendor TWINS (the architect 2026-08-24) ───
// REVERSES the 2026-08-06 #10 fold. That rule dropped every Copilot re-sell and
// left a pink "(copilot)" note on the vendor's dot, on the theory that the two
// were "the same brain at the same index" and so the same POINT. Half of that is
// true and the half that is false is the expensive half: same brain, same index —
// but NOT the same price. Copilot bills its own published rate, so folding it
// into the vendor's dot silently showed the CHEAPER of two routes and answered
// "what does this model cost?" with a number the architect cannot actually pay on that
// route. Measured over the live catalog: 16 of 19 twin groups differ, by up to
// 94x (claude-sonnet-4.6 — 0.0893 on our Anthropic plan, 8.36 through Copilot).
//
// So every route now keeps its OWN dot at its OWN price, and the routes to one
// brain are tied together by a dashed connector. What was one dot with a
// footnote is now a measured horizontal gap you can read as money.
//
// WHY THE GAP IS NOT A MARKUP (eeg-trace.ts:267-274, verified 2026-08-15):
// GitHub charges its models' own vendor list prices — 13 of 14 price triples
// identical. Copilot rows sit far right because OUR baseline is a far deeper
// discount (Anthropic Max 20x returns ~30x its fee in list value, Copilot Pro+
// ~1.79x). The chart footer says this out loud; the connector must never be
// read as "GitHub overcharges".
export const SC_COPILOT_PROVIDERS = new Set(["github-copilot", "copilot", "copilot-proxy"]);
/** Pink, per the architect — the one non-identity colour on the chart. Now marks the
 *  Copilot ROUTE TAG on Copilot's own label, not a note on the vendor's. */
export const SC_COPILOT_PINK = "#ff7ac6";

/** Vendor-neutral identity for a model ref: the last path segment, with the
 *  punctuation that differs between routes removed — "claude-code/claude-opus-4-7"
 *  and "github-copilot/claude-opus-4.7" are the same model. */
export function scModelKey(id: string): string {
  return (id.split("/").pop() ?? id).toLowerCase().replace(/[.\-_\s]/g, "");
}

export function scIsCopilot(m: { id: string; provider: string }): boolean {
  return SC_COPILOT_PROVIDERS.has(m.provider) || SC_COPILOT_PROVIDERS.has(m.id.split("/")[0]);
}

/** Short route tag for a twin's label — which vendor sells THIS dot. Only ever
 *  printed for models that actually have a twin; a single-route model is just
 *  its name. */
export function scRouteTag(m: { id: string; provider: string }): string {
  if (scIsCopilot(m)) return "copilot";
  const p = m.provider || m.id.split("/")[0] || "";
  // "openrouter/z-ai/glm-5.2" — the middle segment is the real seller.
  const seg = m.id.split("/");
  if (p === "openrouter" && seg.length >= 3) return `openrouter·${seg[1]}`;
  return p;
}

/** Twin metadata attached to a model that shares its brain with another route. */
export interface ScTwinInfo {
  /** scModelKey shared by every route to this brain. Absent when single-route. */
  twinKey?: string;
  /** How many routes reach it (>= 2 when set). */
  twinN?: number;
  /** TRUE when the routes actually differ in price. FALSE means every route
   *  costs the same, so the dots land on top of each other and NO connector is
   *  drawn — a 0px dash would imply a price difference that does not exist. */
  twinSpread?: boolean;
}

/**
 * Group every plotted model by vendor-neutral identity. PURE: nothing is
 * dropped, nothing is re-priced — each route keeps its own relCost and its own
 * dot. The group is metadata the renderer uses for the dashed connectors and
 * that app.ts uses to light up twins on hover.
 *
 * The zero-spread case is deliberate and load-bearing. gpt-5.6-sol is reachable
 * via openai, openai-codex and codex at the IDENTICAL 0.2679, so its three dots
 * coincide exactly; drawing a "connector" there would be a 0px dash asserting a
 * difference that is not in the data. Those groups are marked twinSpread:false
 * and the renderer draws no line — the label's route tags still say all three
 * routes exist.
 */
export function scAssignTwins<T extends ScModel>(models: T[]): (T & ScTwinInfo)[] {
  const byKey = new Map<string, T[]>();
  for (const m of models) {
    const k = scModelKey(m.id);
    const g = byKey.get(k);
    if (g) g.push(m);
    else byKey.set(k, [m]);
  }
  return models.map((m) => {
    const group = byKey.get(scModelKey(m.id))!;
    if (group.length < 2) return m;
    return {
      ...m,
      twinKey: scModelKey(m.id),
      twinN: group.length,
      twinSpread: new Set(group.map((x) => x.relCost)).size > 1,
    };
  });
}

/**
 * Copilot is not in models.providers, so catalog Copilot rows used to take
 * scDefaultCtx (Claude = 200k) while the native twin sat at its configured
 * window (Opus 5 / Sonnet 4.6 = 1M). Bubble area ∝ context, so Copilot looked
 * like a smaller brain. GitHub does not publish a smaller Claude window — it
 * lists the same models, with long-context *price tiers* on GPT/Gemini/Grok,
 * not a truncated cap. Inherit the largest native-twin ctx onto Copilot.
 * Price is untouched.
 */
export function scSyncTwinContext<T extends ScModel>(models: T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const m of models) {
    const k = scModelKey(m.id);
    const g = byKey.get(k);
    if (g) g.push(m);
    else byKey.set(k, [m]);
  }
  const nativeMax = new Map<string, number>();
  for (const [k, group] of byKey) {
    const natives = group.filter((m) => !scIsCopilot(m));
    if (!natives.length) continue;
    nativeMax.set(k, Math.max(...natives.map((m) => m.ctx)));
  }
  return models.map((m) => {
    if (!scIsCopilot(m)) return m;
    const mx = nativeMax.get(scModelKey(m.id));
    if (mx === undefined || mx === m.ctx) return m;
    return { ...m, ctx: mx };
  });
}

// ─── Effort stops (the architect 2026-08-27) ───
// Two independent facts, never mixed:
//   · WHICH stops a model has comes from the vendor page via
//     resolveProviderEffortLadder (updated 2026-08-27 from Anthropic / OpenAI /
//     xAI / Z.AI / Moonshot docs — the in-tree plugins lag those pages).
//   · HOW SMART each stop is comes from AA_EFFORT_INDEX, a scrape of named
//     per-effort rows on artificialanalysis.ai (2026-08-27). A vendor stop with
//     no AA number is dropped, not filled. A model with no named AA rows at all
//     stays a single dot at its headline index — that number is measured, the
//     per-effort ones are not.
export type { EffortLadderKind };

export interface ScEffortStop {
  lvl: string;
  label: string;
  costMult: number;
  /** AA Intelligence Index at THIS effort, or the model's headline index when
   *  AA published no per-effort row for the family. Never an estimate. */
  smart: number;
  /** True when `smart` is AA's named per-effort measurement, not the headline. */
  measured: boolean;
  /** The stop carrying the model's published (unmultiplied) price — drawn at
   *  full STROKE strength (never at a different size: see SC_NONANCHOR_STROKE),
   *  and the attach point for twin connectors. */
  anchor: boolean;
}

export interface ScEffortLadder {
  kind: EffortLadderKind;
  note: string;
  stops: ScEffortStop[];
}

const SC_EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

/** The single stop drawn when we have a headline index and no honest per-effort
 *  spread — unknown ladder, binary switch, or a graded ladder AA has not scored. */
function scSoleStop(label: string, smart: number): ScEffortStop {
  return { lvl: "", label, costMult: 1, smart, measured: false, anchor: true };
}

function scAnchorStops(stops: ScEffortStop[]): void {
  if (!stops.length) return;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i].costMult - 1) < Math.abs(stops[best].costMult - 1)) best = i;
  }
  for (const s of stops) s.anchor = false;
  stops[best].anchor = true;
}

/**
 * The effort stops to plot for one model.
 *
 * Intersection, not union: the vendor ladder says which stops EXIST; AA says
 * which of those we may place on Y. A vendor stop with no AA number is dropped.
 * A model whose ladder is binary/none/unknown, or whose family AA has not split
 * by effort, stays a single headline-index dot — that number is measured, the
 * missing per-effort ones are not, and we do not invent them.
 */
export function scEffortsFor(m: { id: string; provider: string; index: number }): ScEffortLadder {
  const ladder = resolveProviderEffortLadder(m.provider, m.id);
  if (ladder.kind !== "graded" || ladder.levels.length === 0) {
    const label =
      ladder.kind === "binary"
        ? "Thinking on/off"
        : ladder.kind === "none"
          ? "No effort control"
          : "Effort ladder unknown";
    return { kind: ladder.kind, note: ladder.note, stops: [scSoleStop(label, m.index)] };
  }
  const measured: ScEffortStop[] = [];
  for (const lvl of ladder.levels) {
    const smart = aaScoreAt(m.id, lvl);
    if (smart === undefined) continue;
    measured.push({
      lvl,
      label: SC_EFFORT_LABELS[lvl] ?? lvl,
      costMult: EEG_EFFORT_MULT[lvl] ?? 1,
      smart,
      measured: true,
      anchor: false,
    });
  }
  if (measured.length === 0) {
    return {
      kind: ladder.kind,
      note: `${ladder.note} · AA published no per-effort score, so one headline-index dot`,
      // Label is Headline, not the last ladder name: attaching "Max" to a number AA
      // did not publish for Max is the approximation this function exists to refuse.
      stops: [scSoleStop("Headline", m.index)],
    };
  }
  scAnchorStops(measured);
  const dropped = ladder.levels.filter((l) => !measured.some((s) => s.lvl === l));
  const note =
    dropped.length === 0
      ? ladder.note
      : `${ladder.note} · AA has no score for ${dropped.join(", ")} — omitted, not guessed`;
  return { kind: ladder.kind, note, stops: measured };
}

// ─── Tokens per average task ───
// Base = average OUTPUT tokens (thinking + visible) to complete one reasoning
// task at MEDIUM effort. Per-effort value = base × EEG_EFFORT_MULT — the same
// documented burn ladder the cost axis uses, because tokens ARE the cost.
//
// PROVENANCE PER ROW:
//   claude-opus-5     MEASURED — OckBench: high=6,745 · xhigh=1.44× · max=1.95×
//                     of high (200 tasks, math+coding+science). 4,497 = 6,745/1.5.
//   kimi-k3           BENCHMARK-ANCHORED — OckBench: high=12,250 (1.8× Opus 5
//                     high, rank-13 first open-weight entry). 8,167 = 12,250/1.5.
//   claude-opus-4-8   ANCHORED ESTIMATE — Anthropic: "Opus 5 generates 26%
//                     fewer tokens than Opus 4.8 at max reasoning" → 4.8 ≈
//                     Opus5 ÷ 0.74 ≈ 1.35×.
//   claude-*          ESTIMATES from the Opus 5 anchor + class (flagship bigger,
//                     sonnet leaner, haiku pays the Overthinking Tax — OckBench:
//                     small models over-generate to compensate for capacity).
//   deepseek-v4-flash ANCHORED ESTIMATE — OckBench puts DeepSeek-V4-PRO at
//                     ≈3.6× Kimi (~29k medium); FLASH is the efficiency-tuned
//                     sibling → ~0.4× of Pro.
//   qwen / glm        ESTIMATES — OckBench's Qwen3.5 flagship ran ~17.6k medium
//                     at 67.5% accuracy; newer/smarter flagships are leaner,
//                     open-weight reasoning stays verbose (open-vs-closed gap up
//                     to 26× on OckBench, 1.8× at the frontier).
//   grok-4.5          ESTIMATE — proprietary frontier class, no public per-task
//                     measurement found.
export const SC_TOKEN_RULES: { match: RegExp; base: number }[] = [
  { match: /claude-opus-5|opus-5/i, base: 4497 },
  { match: /claude-fable/i, base: 5900 },
  { match: /claude-opus-4-8|opus-4\.8/i, base: 6071 },
  { match: /claude-opus-4-7|opus-4\.7/i, base: 5500 },
  { match: /claude-sonnet/i, base: 3500 },
  { match: /claude-haiku/i, base: 2200 },
  { match: /kimi/i, base: 8167 },
  { match: /deepseek.*flash/i, base: 11600 },
  { match: /deepseek/i, base: 29300 },
  { match: /qwen3\.8/i, base: 13400 },
  { match: /qwen/i, base: 14700 },
  { match: /glm/i, base: 12000 },
  { match: /grok/i, base: 4800 },
];
const SC_TOKEN_DEFAULT = 8000;

/**
 * The normalization anchor the architect chose: Opus 5 at its HIGHEST REAL effort.
 *
 * Kept at `high` — Anthropic's documented DEFAULT for Opus 5 (effort.md,
 * 2026-08-27), not the top of the ladder. `max` is real on this model now; it is
 * just not the operating point the €/task view is pinned to. Changing this
 * would slide every task-mode dot.
 */
export const SC_REFERENCE = { match: /claude-opus-5|opus-5/i, effort: "high" };

// Context windows for models that are NOT in openclaw.json (the chart shows the
// whole reachable catalog, not only configured models). Family defaults from
// public model specs; CONFIGURED models always win with their config value.
export const SC_CTX_RULES: { match: RegExp; ctx: number }[] = [
  // FORK 2026-08-30 — the 2026-08-30 arrivals, context windows read off the live
  // OpenRouter catalog. These sit ABOVE the family rules because first match wins:
  // `claude-opus-5-fast` would otherwise take the generic /claude/i 200k when the
  // route actually serves 1M, and circle AREA is proportional to context window, so
  // a wrong ctx draws a visibly wrong dot.
  { match: /claude-opus-5-fast/i, ctx: 1_000_000 },
  { match: /longcat-2\.0/i, ctx: 1_048_756 },
  { match: /nemotron-3\.5-lightning|ling-3\.0-flash/i, ctx: 262_144 },
  { match: /gemini/i, ctx: 1_000_000 }, // Gemini 2.x+ ship 1M windows
  { match: /gpt-5/i, ctx: 272_000 }, // GPT-5 generation incl. 5.6 tiers + codex variants
  { match: /\bo3\b/i, ctx: 200_000 },
  { match: /gpt-4/i, ctx: 128_000 }, // GPT-4 generation
  { match: /claude/i, ctx: 200_000 }, // Claude default when not configured
  { match: /grok/i, ctx: 256_000 },
];
const SC_CTX_DEFAULT = 200_000;

export function scDefaultCtx(modelId: string): number {
  for (const row of SC_CTX_RULES) {
    if (row.match.test(modelId)) return row.ctx;
  }
  return SC_CTX_DEFAULT;
}

export function scBaseTokens(modelId: string): number {
  for (const row of SC_TOKEN_RULES) {
    if (row.match.test(modelId)) return row.base;
  }
  return SC_TOKEN_DEFAULT;
}

/** Average tokens to complete one task at the given effort level. */
export function scTokensPerTask(modelId: string, effortLvl: string): number {
  return scBaseTokens(modelId) * (EEG_EFFORT_MULT[effortLvl] ?? 1);
}

/** Horizontal SHIFT in decades for per-task mode: log10 of the dot's
 *  tokens-per-task relative to the reference. The reference is 0 by
 *  construction; positive = burns more tokens per task than Opus@max. */
export function scTaskShiftDecades(modelId: string, effortLvl: string): number {
  const ref = scTokensPerTask("claude-code/claude-opus-5", SC_REFERENCE.effort);
  return Math.log10(scTokensPerTask(modelId, effortLvl) / ref);
}

// ─── OFFICIAL API LIST PRICE (the architect 2026-08-27) ───
// WHY THIS EXISTS. The x axis plots `relCost` — the EFFECTIVE price on the plan we
// actually hold. For every metered route (OpenRouter, Google, the Chinese labs) that
// IS the published price, so one number answers both questions. For the four
// Anthropic families, the OpenAI prepaid rows, Grok and the Copilot re-sells it is
// NOT: those carry a subscription divisor (Anthropic Max 20x amortises Opus 5's $25
// sticker down to €0.2232 — a factor of 112).
//
// That single fact is the whole reconciliation the architect asked for. Comparing an
// amortised Anthropic dot against a metered Kimi dot makes Claude look ~67x cheaper
// than Kimi when at LIST PRICE Kimi ($15) is 1.67x CHEAPER than Opus 5 ($25). The
// cost table already warns about this in prose ("never compare them to a metered row
// without saying which is which") — but the chart drew them in one column anyway,
// and the drawing is what gets believed. Now both are on screen at once.
//
// PROVENANCE: every figure here is the vendor's own published OUTPUT price per Mtok,
// taken from the SAME sources EEG_COST_TABLE cites (the sticker values recorded in
// its per-row comments; Anthropic's $5/$25 for Opus 5 re-verified against
// artificialanalysis.ai/models/claude-opus-5 on 2026-08-27). Nothing here is
// measured by us and nothing here is estimated — it is list price or it is absent.
//
// UNITS, SAID OUT LOUD: the axis is labelled €/Mtok, the Anthropic rows are genuinely
// € (derived from a €200/mo fee) and every metered row is the vendor's $ figure
// carried across unchanged. That $/€ smear is PRE-EXISTING in EEG_COST_TABLE; this
// table deliberately does not fix it, because a triangle on a different unit basis
// than the circle it is bridged to would be a new lie on top of an old one. Both
// marks sit on the same nominal scale; the ~8% FX gap is smaller than the weekly
// drift already seen in the OpenRouter rows.
//
// ABSENT ON PURPOSE: a model with no row here gets NO triangle. That is the honest
// outcome for two different cases — (a) a metered model, whose circle already IS its
// list price, and (b) a model whose list price we have not verified (gpt-5.4-nano).
// Inventing a sticker to complete the picture is the exact failure this chart spent
// 2026-08-25 removing from its Y axis.
export const SC_API_PRICE: { match: RegExp; out: number }[] = [
  // Anthropic — anthropic.com/pricing. Opus 5 re-verified on AA 2026-08-27 ($5/$25).
  { match: /fable/i, out: 50 },
  // FORK 2026-08-30: fast mode is sold METERED at $50 out, so its list price IS
  // what the dot already plots and it correctly gets NO triangle. Without this row
  // the generic /opus/i below would hand it Opus 5's $25 and draw a triangle to the
  // LEFT of its own circle — rendering a 2x SURCHARGE as a 50% discount.
  { match: /claude-opus-5-fast/i, out: 50 },
  { match: /opus/i, out: 25 },
  { match: /sonnet-5(?![.\d])/i, out: 10 }, // Sonnet 5 $2/$10
  { match: /sonnet/i, out: 15 }, // Sonnet 4.5/4.6 $3/$15
  { match: /haiku/i, out: 5 },
  // OpenAI — developers.openai.com/api/docs/pricing. Specific before generic.
  // All three gpt-5.6 rows carry OpenAI's SHORT-context standard rate. Sol read $30
  // until 2026-08-30 — the LONG-context rate — while Terra and Luna read short, so
  // one family sat on two bases (developers.openai.com/api/docs/pricing, re-read
  // 2026-08-30). Long context doubles: $30 / $18 / $1.80. A promo currently bills
  // Sol at $10 on OpenRouter and Copilot; this axis ranks by STANDARD list, so the
  // promo is reported to the architect rather than baked into a literal that outlives it.
  { match: /5\.6-sol/i, out: 20 },
  { match: /5\.6-terra/i, out: 12 },
  { match: /5\.6-luna/i, out: 1.2 },
  { match: /gpt-5\.5/i, out: 30 },
  { match: /gpt-5\.4-mini/i, out: 4.5 },
  { match: /gpt-5\.4(?!-mini|-nano)/i, out: 15 },
  { match: /gpt-5\.3-codex/i, out: 14 },
  { match: /gpt-5\.2/i, out: 14 },
  { match: /gpt-5\.1/i, out: 10 },
  { match: /gpt-5-mini/i, out: 2 },
  { match: /gpt-5(?![.\d])/i, out: 10 },
  { match: /gpt-4\.1/i, out: 8 },
  { match: /gpt-4o/i, out: 10 },
  // xAI — $6 out below 200k ctx (doubles above; a scalar cannot say so, same
  // caveat the EEG_COST_TABLE grok row carries).
  { match: /grok/i, out: 6 },
  // Google — ai.google.dev/gemini-api/docs/pricing. 3.7/3.6 flash rate is
  // promotional through 2026-12-31.
  { match: /gemini.*pro/i, out: 12 },
  { match: /gemini-3\.[67].*flash/i, out: 3.75 },
  { match: /gemini.*flash/i, out: 9 },
];

/** The vendor's published output $/Mtok, or undefined when we have not verified one. */
export function scApiPrice(modelId: string): number | undefined {
  for (const row of SC_API_PRICE) {
    if (row.match.test(modelId)) return row.out;
  }
  return undefined;
}

/** Below this relative gap the two prices are the SAME number and the model gets no
 *  triangle — a coincident mark plus a 0px dashed bridge would assert a discount
 *  that does not exist, the same defect `twinSpread:false` exists to prevent. */
const SC_API_GAP_EPS = 0.01;

/**
 * The API-price twin of `scPointsFor`: the same effort ladder, the same measured
 * index, positioned at the model's LIST price instead of its effective one.
 *
 * Returns [] when there is nothing to say — no verified list price, or a list price
 * the plan does not discount (every metered route). An empty array means "this dot
 * is already at sticker", which is why the footer states it rather than the chart
 * drawing a second mark on top of the first.
 */
export function scApiPointsFor(m: ScModel): {
  lvl: string;
  label: string;
  cost: number;
  smart: number;
  measured: boolean;
  anchor: boolean;
}[] {
  const list = scApiPrice(m.id);
  if (list === undefined) return [];
  if (Math.abs(list - m.relCost) / Math.max(list, m.relCost) < SC_API_GAP_EPS) return [];
  return scEffortsFor(m).stops.map((e) => ({
    lvl: e.lvl,
    label: e.label,
    cost: list * e.costMult,
    smart: e.smart,
    measured: e.measured,
    anchor: e.anchor,
  }));
}

/** How many times dearer the list price is than what this plan actually pays.
 *  Undefined when the model has no triangle (see scApiPointsFor). */
export function scApiMultiple(m: ScModel): number | undefined {
  const list = scApiPrice(m.id);
  if (list === undefined || m.relCost <= 0) return undefined;
  if (Math.abs(list - m.relCost) / Math.max(list, m.relCost) < SC_API_GAP_EPS) return undefined;
  return list / m.relCost;
}

// ─── geometry ───
const W = 900;
const H = 600;
const ML = 64; // left margin
const MR = 36;
const MT = 30;
const MB = 66;
const PW = W - ML - MR;
const PH = H - MT - MB;

const R_MAX = 12; // largest context window → this radius; all others ∝ √ctx
// Task mode shifts dots by up to ~0.5 decades; the domain grows so nothing
// lands outside the plot.
const TASK_PAD = 0.55;

export type ScXScale = "log" | "linear";

export interface ScScales {
  xScale: ScXScale;
  x0: number; // log10 domain (already grown for task-mode shifts)
  x1: number;
  c0: number; // raw-cost domain for LINEAR mode
  c1: number;
  y0: number; // index domain
  y1: number;
  sqrtCtxMax: number;
}

// FORK 2026-08-06 #4 (the architect: linear ↔ log toggle). The domain now spans the
// TASK-shifted costs too (cost × token-ratio), so dots land inside the plot in
// BOTH toggle states of BOTH axes — no edge clipping in any of the four views.
export function scComputeScales(models: ScModel[], xScale: ScXScale = "log"): ScScales {
  let minCost = Infinity;
  let maxCost = -Infinity;
  let maxTaskCost = -Infinity;
  let minIdx = Infinity;
  let maxIdx = -Infinity;
  let maxCtx = -Infinity;
  const refTokens = scTokensPerTask("claude-code/claude-opus-5", SC_REFERENCE.effort);
  for (const m of models) {
    for (const e of scEffortsFor(m).stops) {
      const cost = m.relCost * e.costMult;
      minCost = Math.min(minCost, cost);
      maxCost = Math.max(maxCost, cost);
      maxTaskCost = Math.max(maxTaskCost, cost * (scTokensPerTask(m.id, e.lvl) / refTokens));
    }
    // FORK 2026-08-27 (the architect): the API-price triangles are real marks and must be
    // inside the plot on BOTH axes. Opus 5's list price is 112x its plan price, so
    // omitting them here would push every triangle past the right edge, where
    // scCostX clamps — a pile of marks on the boundary reading as one price.
    // maxCost feeds the LINEAR c1 too, so the linear axis grows to the dearest
    // number actually drawn, which is what "span to the maximum priced model" means
    // once list prices are on the chart.
    for (const p of scApiPointsFor(m)) {
      maxCost = Math.max(maxCost, p.cost);
      minCost = Math.min(minCost, p.cost);
      maxTaskCost = Math.max(maxTaskCost, p.cost * (scTokensPerTask(m.id, p.lvl) / refTokens));
    }
    // The y domain is the MEASURED index range, padded by a flat 2 points. It
    // used to be padded by ×0.9 and ×1.12 — the same invented smartness curve
    // the dots were drawn with, so the axis inherited the fiction.
    for (const e of scEffortsFor(m).stops) {
      minIdx = Math.min(minIdx, e.smart);
      maxIdx = Math.max(maxIdx, e.smart);
    }
    maxCtx = Math.max(maxCtx, m.ctx);
  }
  if (!models.length) {
    return { xScale, x0: -1, x1: 2, c0: 0, c1: 10, y0: 0, y1: 70, sqrtCtxMax: 1 };
  }
  return {
    xScale,
    x0: Math.log10(minCost) - 0.09 - TASK_PAD,
    x1: Math.log10(maxTaskCost) + 0.09 + TASK_PAD,
    c0: 0,
    // FORK 2026-08-06 #8 (the architect: "when I turn into linear scale, the right of the
    // graph should not be empty, the cost scale should span from 0 to the maximum
    // priced model, and no more"). This was maxTaskCost — the €/TASK maximum, which
    // is cost x a verbosity ratio and can sit far right of any real price, leaving
    // the whole right half of a LINEAR axis blank. The linear axis now ends just
    // past the dearest model's actual €/Mtok. Task-mode dots clamp at the edge
    // (scCostX already clamps), which is the honest trade: the axis says €/Mtok and
    // now shows exactly that range.
    c1: maxCost * 1.02,
    y0: minIdx - 2.5,
    y1: maxIdx + 2,
    sqrtCtxMax: Math.sqrt(maxCtx),
  };
}

// ─── pan / zoom view box ───
// FORK 2026-08-06 #8 (the architect: pan by drag, zoom by wheel, "don't let the graph zoom
// out more when all the models are already visible"). The CLAMP lives here, not in
// app.ts, because it is the only part that can be silently wrong — the event
// plumbing fails loudly, an off-by-one in the bounds just quietly lets the chart
// drift off-screen. Pure in, pure out, unit-tested.
export interface ScView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Full drawing extent — the zoom-OUT floor: never show more than this. */
export const SC_VIEW_FULL: ScView = { x: 0, y: 0, w: W, h: H };
/** Deepest zoom-in. */
export const SC_VIEW_MIN_W = W / 10;

/**
 * Constrain a candidate view: width within [SC_VIEW_MIN_W, W], height locked to
 * the drawing's aspect (no skew), and the origin pinned so the view never leaves
 * the drawing — which is what makes "everything visible" the hard outer limit.
 */
export function scClampView(v: ScView): ScView {
  const w = Math.min(W, Math.max(SC_VIEW_MIN_W, v.w));
  const h = w * (H / W);
  return {
    w,
    h,
    x: Math.min(W - w, Math.max(0, v.x)),
    y: Math.min(H - h, Math.max(0, v.y)),
  };
}

/** Scale-aware cost → x. Log is the historic axis; linear starts at €0. */
export function scCostX(cost: number, s: ScScales): number {
  if (s.xScale === "linear") {
    const t = (cost - s.c0) / (s.c1 - s.c0);
    return ML + Math.max(0, Math.min(1, t)) * PW;
  }
  const t = (Math.log10(cost) - s.x0) / (s.x1 - s.x0);
  return ML + t * PW;
}

/** Inverse of scCostX — used while sliding a prepaid circle along the plan→API span. */
export function scCostFromX(x: number, s: ScScales): number {
  const t = Math.max(0, Math.min(1, (x - ML) / PW));
  if (s.xScale === "linear") return s.c0 + t * (s.c1 - s.c0);
  return Math.pow(10, s.x0 + t * (s.x1 - s.x0));
}

function scCtxLegendSvg(s: ScScales): string {
  const fx = (n: number) => Number(n.toFixed(2));
  const x0 = ML + 16;
  const y0 = MT + PH - 14;
  let x = x0 + 38;
  let marks = "";
  for (const ctx of SC_CTX_LEGEND) {
    const r = fx(scRadius(ctx, s));
    marks +=
      `<g transform="translate(${fx(x)}, ${fx(y0 - r)})">` +
      `<circle r="${r}" fill="none" stroke="#f0e6d8" stroke-opacity="0.55" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<text y="${fx(r + 9)}" text-anchor="middle" font-size="7.5" fill="#f0e6d8" fill-opacity="0.55"` +
      ` font-family="'SF Mono',ui-monospace,monospace">${esc(scFmtCtx(ctx))}</text></g>`;
    x += r * 2 + 22;
  }
  return (
    `<g class="sc-ctxleg" pointer-events="none">` +
    `<text x="${x0}" y="${fx(y0 - 22)}" font-size="7.5" letter-spacing="1.4" fill="#f0e6d8" fill-opacity="0.5"` +
    ` font-family="'SF Mono',ui-monospace,monospace">SIZE ∝ CONTEXT</text>` +
    `${marks}</g>`
  );
}

export function scX(cost: number, s: ScScales): number {
  const t = (Math.log10(cost) - s.x0) / (s.x1 - s.x0);
  return ML + t * PW;
}
export function scY(index: number, s: ScScales): number {
  const t = (index - s.y0) / (s.y1 - s.y0);
  return MT + (1 - t) * PH;
}
/** Radius: strictly ∝ √ctx through the origin, so AREA ∝ context window —
 *  the architect's "size proportional to context window" taken literally, no offset.
 *
 *  INVARIANT — never scale this at a call site. Until 2026-08-30 both emission
 *  sites multiplied it by `(anchor ? 1 : 0.82)`, so a model with ONE context
 *  window drew at TWO radii (the architect: "opus 5 seems to have different sizes in the
 *  same model, impossible, must be a bug"). Size then meant context window AND
 *  anchor-ness at once — and the on-plot SIZE ∝ CONTEXT legend, which calls this
 *  UNSCALED (scCtxLegendSvg), was therefore a lie for every non-anchor mark.
 *  Anything a mark needs to say beyond its context window goes on the stroke,
 *  never on the size, and never on colour — colour is model identity on this
 *  chart. See SC_NONANCHOR_STROKE below. */
export function scRadius(ctxTokens: number, s: ScScales): number {
  if (s.sqrtCtxMax <= 0) return R_MAX / 2;
  return Math.max(2, R_MAX * (Math.sqrt(ctxTokens) / s.sqrtCtxMax));
}

/** Fraction of its mark's resting stroke-opacity that a NON-anchor effort stop
 *  keeps. The anchor — the stop the published price is quoted at, where the twin
 *  connectors and the dashed API bridge attach — draws at full strength and the
 *  stops derived from it recede. This is the ENTIRE anchor channel now: every
 *  stop of a model is the same size, because size is spoken for (area ∝ context
 *  window, scRadius above).
 *
 *  Why stroke-OPACITY, and not stroke-width or fill-opacity: base.css owns both
 *  of those on these two classes as the hover/focus "light up gently" channel,
 *  and it writes FLAT values — `.sc-focus .sc-hl .sc-ring` → stroke-width 2.1 /
 *  fill-opacity 0.2, `.sc-focus .sc-hl .sc-tri` → 1.9 / 0.22, plus the two :hover
 *  rules. An anchor encoded there would vanish the instant you focused the model,
 *  which is precisely when "which of these five is the published price?" is the
 *  question being asked. `opacity` is taken too, by the dim/glow state machine on
 *  .sc-dotpos. No CSS rule writes stroke-opacity on .sc-ring or .sc-tri, so it is
 *  the one free channel.
 *
 *  Why 0.6 and not a half: the API layer already rests at opacity 0.55, so a
 *  non-anchor triangle lands at 0.5 × 0.6 × 0.55 ≈ 0.165 of ink — just above the
 *  0.16 of the dashed bridge that connects it. At 0.5 it would sit UNDER its own
 *  connector, inverting the layer order this chart is built on. If the derived
 *  stops ever read too faint, this is the single knob: it moves the circles and
 *  the triangles together by construction. */
export const SC_NONANCHOR_STROKE = 0.6;

/** The accounting utilisation the prepaid circle is drawn at (the architect 2026-08-13).
 *  Max 20x / SuperGrok / ChatGPT Business are not token-metered; 75% is the
 *  quota-ceiling convention the €/Mtok number was derived from. */
export const SC_PLAN_UTIL = 0.75;

/** Sample windows for the on-plot size legend. Area ∝ ctx, so these three
 *  sizes are the visual dictionary for every circle on the chart. */
export const SC_CTX_LEGEND = [128_000, 256_000, 1_000_000] as const;

/** Prepaid seats whose circle is an amortised plan price and whose triangle is
 *  list. Copilot is excluded: its factor is 0.5571 credits, not 75% quota. */
export function scIsUtilDrag(m: { id: string; provider: string }): boolean {
  if (scIsCopilot(m)) return false;
  if (scApiPrice(m.id) === undefined) return false;
  const p = (m.provider || m.id.split("/")[0] || "").toLowerCase();
  if (p === "claude-code" || p === "anthropic") return true;
  if (p === "xai") return true;
  if (p === "openai" || p === "openai-codex" || p === "codex") return true;
  return false;
}

/** €/Mtok at utilisation U (0–1] given the 75%-quota home cost. */
export function scCostAtUtil(homeCost: number, util: number): number {
  const u = Math.max(0.01, Math.min(1, util));
  return (homeCost * SC_PLAN_UTIL) / u;
}

/** Utilisation (0–1) implied by a cost on the home→list span. */
export function scUtilAtCost(homeCost: number, cost: number): number {
  if (homeCost <= 0 || cost <= 0) return SC_PLAN_UTIL;
  return Math.max(0.01, Math.min(1, (homeCost * SC_PLAN_UTIL) / cost));
}

/** Pixel shift for a dot's task-mode position (decades → px on the log axis). */
export function scTaskShiftPx(shiftDecades: number, s: ScScales): number {
  return (shiftDecades / (s.x1 - s.x0)) * PW;
}

/** Tokens-per-task relative to the Opus 5 @ max reference (>1 = more verbose). */
export function scTokenRatio(modelId: string, effortLvl: string): number {
  const ref = scTokensPerTask("claude-code/claude-opus-5", SC_REFERENCE.effort);
  return scTokensPerTask(modelId, effortLvl) / ref;
}

const fmt = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
export function scFmtCtx(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M`
    : `${Math.round(tokens / 1000)}k`;
}
export function scFmtTokens(tokens: number): string {
  return tokens >= 1000
    ? `${Number((tokens / 1000).toFixed(1))}k tok`
    : `${Math.round(tokens)} tok`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const X_TICKS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

/** Nice round tick values for the LINEAR axis: ~6 steps of 1/2/5 × 10^n. */
export function scLinearTicks(c1: number): number[] {
  const raw = Math.max(c1, 1) / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= c1 + step * 0.5; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

/**
 * One model's points: vendor-documented effort stops that AA actually scored.
 * `smart` is AA's number at THAT effort, or the headline index on a sole stop
 * when AA published no per-effort split. Never an interpolation.
 */
export function scPointsFor(m: ScModel): {
  lvl: string;
  label: string;
  cost: number;
  smart: number;
  measured: boolean;
  anchor: boolean;
}[] {
  return scEffortsFor(m).stops.map((e) => ({
    lvl: e.lvl,
    label: e.label,
    cost: m.relCost * e.costMult,
    smart: e.smart,
    measured: e.measured,
    anchor: e.anchor,
  }));
}

/**
 * Freeze a mark: strip its SMIL animation elements.
 *
 * FORK 2026-08-06 #10 (the architect: "why is gemini flash pulsating? It should not").
 * The GOOGLE provider mark carries an `<animate>` that cycles its ring stroke
 * through the four Google colours on a 4s loop — so every Gemini dot (no vendor
 * mark of its own, so it falls back to the provider logo) shimmered. Two reasons
 * that is wrong HERE and nowhere else: this is a static reference chart, where a
 * moving dot reads as "live/active" and means nothing; and the mark is inlined
 * once per effort level per model, so the catalog view was running ~100 SMIL
 * timelines behind a chart we just spent a commit making cheaper to zoom.
 * The panels that show ONE logo keep their animation — this only freezes the
 * copies the chart makes.
 */
function scStill(mark: string): string {
  return mark.replace(/<\/?(animate|animateTransform|animateMotion|set)\b[^>]*>/g, "");
}

/**
 * Make a provider mark safe to nest INSIDE an <svg>.
 *
 * FORK 2026-08-06 #7 — THE ACTUAL CAUSE of "logos under the graph at the left,
 * circle outlines not visible" (the architect, three reports). The comment this replaces
 * claimed "Both are complete <svg> elements". They are not: the GitHub Copilot
 * mark is an <img>, and `<img>` sits on the HTML parser's FOREIGN-CONTENT
 * BREAKOUT LIST. When the app does `body.innerHTML = "<svg>…<img>…</svg>"` the
 * fragment parser TERMINATES the <svg> at that img — verified in the parsed DOM:
 *
 *   …</g></g></svg><img src="/tinker/copilot-logo.svg"><circle r="8.3">…
 *
 * Everything after the logo becomes HTML, so those <circle>/<g> are unknown
 * elements that render nothing (no outlines) and the <img> logos flow as normal
 * HTML below the chart, left-aligned. Exactly the reported symptom.
 *
 * Why three fixes missed it: parsing the SAME markup from a FILE does not break
 * out (132 of 132 rings survive), and every verification — mine included — was a
 * file render. Only `innerHTML`, the path the app actually uses, reproduces it.
 *
 * So: any mark that is not already an <svg> root is wrapped in one, with an <img>
 * rewritten to SVG's own <image>. Wrapping (rather than returning the <image>
 * bare) keeps the caller's `^<svg ` positioning replace working unchanged.
 */
function scSvgSafeMark(mark: string): string {
  if (/^<svg[\s>]/.test(mark)) {
    return scStill(mark);
  }
  const src = /\bsrc="([^"]+)"/.exec(mark)?.[1] ?? "";
  if (!src) {
    // Unknown, non-svg mark with nothing to point at — draw nothing rather than
    // risk another breakout tag silently truncating the chart.
    return `<svg viewBox="0 0 14 14"></svg>`;
  }
  return `<svg viewBox="0 0 14 14"><image href="${esc(src)}" x="0" y="0" width="14" height="14"/></svg>`;
}

/** The dot's logo: the vendor mark when the model id carries one, else the
 *  provider logo — normalised so it can never break the enclosing <svg>. */
function scLogoFor(m: ScModel): string {
  // FORK 2026-08-30 (the architect: "openrouter bubbles have the wrong icon"). This read
  // `getModelLogoSvg(m.id) ?? getProviderLogoSvg(m.provider)`, and the fallback
  // returned Anthropic's sparkle for any provider it did not know — `openrouter`
  // among them. 15 of 99 plotted models were branded as Claude, including NVIDIA,
  // Meta, Tencent, MiniMax and Xiaomi. getRoutedLogoSvg also reads the vendor out
  // of the id's middle segment, which is what recovers the Google, OpenAI and
  // Anthropic models we reach THROUGH OpenRouter.
  return scSvgSafeMark(getRoutedLogoSvg(m.id, m.provider));
}

export function renderSmartCostChart(
  models: (ScModel & ScTwinInfo)[],
  opts?: { xScale?: ScXScale },
): string {
  const xScale: ScXScale = opts?.xScale ?? "log";
  const s = scComputeScales(models, xScale);
  const fx = (n: number) => Number(n.toFixed(2));

  let defs =
    `<defs>` +
    // deep-space backdrop with a faint warm vignette (the Tinker paper, darkened)
    `<radialGradient id="sc-bg" cx="50%" cy="42%" r="75%">` +
    `<stop offset="0%" stop-color="#221b13"/><stop offset="60%" stop-color="#191410"/>` +
    `<stop offset="100%" stop-color="#120e0b"/></radialGradient>` +
    // soft neon bloom for the circles
    `<filter id="sc-glow" x="-80%" y="-80%" width="260%" height="260%">` +
    `<feGaussianBlur stdDeviation="2.2" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>` +
    // axis fade
    `<linearGradient id="sc-axis" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="#f0e6d8" stop-opacity="0.0"/>` +
    `<stop offset="12%" stop-color="#f0e6d8" stop-opacity="0.5"/>` +
    `<stop offset="100%" stop-color="#f0e6d8" stop-opacity="0.5"/></linearGradient>` +
    `</defs>`;

  const bg =
    `<rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="url(#sc-bg)"/>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#f0e6d8" stroke-opacity="0.10"/>`;

  // grid — vertical cost lines (log decades OR linear nice-steps) + horizontal
  // index lines, both whisper-quiet
  let grid = "";
  const xTicks: number[] =
    xScale === "log"
      ? X_TICKS.filter((t) => Math.log10(t) >= s.x0 && Math.log10(t) <= s.x1)
      : scLinearTicks(s.c1);
  for (const t of xTicks) {
    const x = fx(scCostX(t, s));
    grid += `<line x1="${x}" y1="${MT}" x2="${x}" y2="${MT + PH}" stroke="#f0e6d8" stroke-opacity="0.06"/>`;
    grid +=
      `<text x="${x}" y="${MT + PH + 16}" text-anchor="middle" font-size="8.5" fill="#f0e6d8" fill-opacity="0.5"` +
      ` font-family="'SF Mono',ui-monospace,monospace">€${fmt(t)}</text>`;
  }
  const yStart = Math.ceil(s.y0 / 5) * 5;
  for (let v = yStart; v <= s.y1; v += 5) {
    const y = fx(scY(v, s));
    grid += `<line x1="${ML}" y1="${y}" x2="${ML + PW}" y2="${y}" stroke="#f0e6d8" stroke-opacity="0.055"/>`;
    grid +=
      `<text x="${ML - 8}" y="${y + 2.5}" text-anchor="end" font-size="8.5" fill="#f0e6d8" fill-opacity="0.5"` +
      ` font-family="'SF Mono',ui-monospace,monospace">${v}</text>`;
  }

  // axes + HUD corner brackets + BOTH axis captions (CSS cross-fades them)
  const axes =
    `<line x1="${ML}" y1="${MT + PH}" x2="${ML + PW}" y2="${MT + PH}" stroke="url(#sc-axis)" stroke-width="1"/>` +
    `<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + PH}" stroke="#f0e6d8" stroke-opacity="0.4"/>` +
    `<text class="sc-xcap-cost" x="${ML + PW / 2}" y="${H - 24}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0.62"` +
    ` font-family="'SF Mono',ui-monospace,monospace">EFFECTIVE COST · €/Mtok OUTPUT · ${xScale}</text>` +
    `<text class="sc-xcap-task" x="${ML + PW / 2}" y="${H - 24}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0"` +
    ` font-family="'SF Mono',ui-monospace,monospace">EFFECTIVE COST PER AVERAGE TASK · €/task · ${xScale}</text>` +
    `<text x="16" y="${MT + PH / 2}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0.62"` +
    ` font-family="'SF Mono',ui-monospace,monospace" transform="rotate(-90 16 ${MT + PH / 2})">AA INTELLIGENCE INDEX</text>` +
    // corner brackets — the futuristic frame
    [
      `M ${ML + 10} ${MT} h -10 v 10`,
      `M ${ML + PW - 10} ${MT} h 10 v 10`,
      `M ${ML} ${MT + PH - 10} v 10 h 10`,
      `M ${ML + PW} ${MT + PH - 10} v 10 h -10`,
    ]
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="#f0e6d8" stroke-opacity="0.3" stroke-width="1"/>`,
      )
      .join("") +
    scCtxLegendSvg(s);

  // constellations: BOTH polylines per model (cost view + task view), CSS
  // cross-fades them in lockstep with the dot movement. Ghost target rings
  // mark where each dot lands — faint, dashed, "targeting reticle" style.
  let linesCost = "";
  let linesTask = "";
  let ghosts = "";
  let dots = "";
  // FORK 2026-08-27 (the architect): the API-price layer. `apiMarks` holds the triangles and
  // their two constellation polylines; `bridges` holds the dashed circle↔triangle
  // connectors. Kept in their own strings so the layer can sit UNDER the dots — the
  // circles are what this plan actually pays and must never be occluded by the
  // hypothetical price.
  let apiMarks = "";
  let bridges = "";
  // One entry per ROUTE of a price-spread twin group; joined into dashed
  // connectors after the loop, once every member's position is known.
  const twinAnchors: { key: string; x: number; y: number; dx: number; color: string }[] = [];
  // FORK 2026-08-06 #3: stagger is ADAPTIVE — capped so the whole wave stays
  // ~1.1s whether there are 12 models or 64. A fixed 55ms × model made the
  // full-catalog wave run 3.5s, so late models looked stuck on toggle.
  const stagger = Math.min(0.055, 1.1 / Math.max(1, models.length));
  models.forEach((m, mi) => {
    const pts = scPointsFor(m);
    // FORK 2026-08-06 #4: positions come from the SCALE-AWARE scCostX, and the
    // task-mode delta is the difference between two absolute positions — so the
    // same markup glides correctly on BOTH the log and the linear axis.
    const coords = pts.map((p) => {
      const xCost = scCostX(p.cost, s);
      const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
      return { x: fx(xCost), y: fx(scY(p.smart, s)), dx: fx(xTask - xCost), p };
    });
    const delay = `${(mi * stagger).toFixed(2)}s`;
    // Highlight hooks. data-vendor drives the provider legend's dim/glow;
    // data-twin drives "hover one route, light every route to the same brain".
    const vAttr = ` data-vendor="${esc(m.vendorKey ?? m.provider)}"`;
    const tAttr = m.twinKey ? ` data-twin="${esc(m.twinKey)}"` : "";
    // data-model is per ROUTE, not per brain: it is what ties THIS model's circles
    // to THIS model's triangles so hovering either lights both (the architect 2026-08-27).
    // Deliberately NOT data-twin — that one means "other sellers of the same brain",
    // a different question, and folding the two would light half the chart.
    const mAttr = ` data-model="${esc(m.id)}"`;
    // The anchor is the published-price stop — found per model, not assumed to
    // be index 2, because ladders now vary in length (Grok has ONE stop, so
    // coords[2] would be undefined and the connector would crash).
    const anchorC = coords.find((c) => c.p.anchor) ?? coords[0];
    if (m.twinKey && m.twinSpread) {
      twinAnchors.push({
        key: m.twinKey,
        x: anchorC.x,
        y: anchorC.y,
        dx: anchorC.dx,
        color: m.color,
      });
    }
    linesCost +=
      `<polyline class="sc-line-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${coords.map((c) => `${c.x},${c.y}`).join(" ")}"` +
      ` fill="none" stroke="${m.color}" stroke-opacity="0.34" stroke-width="1.1"/>`;
    linesTask +=
      `<polyline class="sc-line-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${coords.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
      ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="1.1"/>`;

    // ─── API-PRICE CONSTELLATION (the architect 2026-08-27) ───
    // "draw a bunch of triangles connected by lines to describe the same model but
    // at API cost (its official price), slightly shaded, triangles defining the
    // different thinking efforts connected by dashed lines to their corresponding
    // circles of the same model in 20x subscription."
    //
    // Each triangle sits at the SAME y as the circle of the SAME effort — buying the
    // same brain through another door does not change how smart that effort is. The
    // dashed bridge is therefore horizontal by data. Across efforts the constellation
    // now climbs, because AA scored them separately.
    //
    // Only models whose plan price differs from list get a row (scApiPointsFor
    // returns [] otherwise), so the ~100 metered dots stay single marks and the
    // chart does not double in density to say nothing.
    const apiPts = scApiPointsFor(m);
    if (apiPts.length) {
      const aCoords = apiPts.map((p) => {
        const xCost = scCostX(p.cost, s);
        const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
        return { x: fx(xCost), y: fx(scY(p.smart, s)), dx: fx(xTask - xCost), p };
      });
      apiMarks +=
        `<polyline class="sc-line-api-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}"` +
        ` points="${aCoords.map((c) => `${c.x},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.22" stroke-width="1"/>` +
        `<polyline class="sc-line-api-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}"` +
        ` points="${aCoords.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="1"/>`;
      const mult = scApiMultiple(m);
      for (let i = 0; i < aCoords.length; i++) {
        const c = aCoords[i];
        // ONE MODEL, ONE MARK SIZE. This was `* (c.p.anchor ? 1 : 0.82)`, which made
        // the radius encode context window AND anchor-ness at once — see scRadius.
        const r = fx(scRadius(m.ctx, s));
        // Anchor-ness rides the stroke instead: 0.5 at the published-price stop, 0.3
        // at the stops derived from it. One channel, one meaning (SC_NONANCHOR_STROKE).
        const triSo = fx(0.5 * (c.p.anchor ? 1 : SC_NONANCHOR_STROKE));
        // Equilateral, point-up, centred on the price. Area tracks the circle's so a
        // triangle and its circle read as the same model at the same context window.
        const tri = `${fx(0)},${fx(-r)} ${fx(r * 0.87)},${fx(r * 0.5)} ${fx(-r * 0.87)},${fx(r * 0.5)}`;
        const apiTip =
          `${m.name} · ${c.p.label} — API list €${fmt(c.p.cost)}/Mtok` +
          (mult
            ? ` · ${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}x what this plan pays`
            : "") +
          ` · idx ${c.p.smart.toFixed(1)}${c.p.measured ? ` at ${c.p.label}` : " (headline — AA published no per-effort split)"}` +
          ` · official published price, not our effective cost`;
        apiMarks +=
          `<g class="sc-apipos" transform="translate(${c.x}, ${c.y})"${vAttr}${tAttr}${mAttr}>` +
          `<g class="sc-apig" style="--sc-dx:${c.dx}px;transition-delay:${delay}">` +
          `<polygon class="sc-tri" points="${tri}" fill="${m.color}" fill-opacity="0.1"` +
          ` stroke="${m.color}" stroke-opacity="${triSo}" stroke-width="1.1"` +
          ` vector-effect="non-scaling-stroke"/>` +
          `<circle r="${fx(r + 4)}" fill="transparent"><title>${esc(apiTip)}</title></circle>` +
          `</g></g>`;
        // One dashed bridge per effort stop, joining a triangle to the circle it
        // belongs to. Both ends share a y, so the bridge comes out horizontal from
        // the data rather than by being forced flat — the same property the twin
        // connectors rely on. Cream, like the twin connector: the line is a
        // RELATIONSHIP (two prices for one token), not either price's identity.
        const cc = coords[i] ?? anchorC;
        bridges +=
          `<line class="sc-bridge-cost"${vAttr}${tAttr}${mAttr} x1="${cc.x}" y1="${cc.y}"` +
          ` x2="${c.x}" y2="${c.y}" stroke="#f0e6d8" stroke-opacity="0.16" stroke-width="0.8"` +
          ` stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` +
          `<line class="sc-bridge-task"${vAttr}${tAttr}${mAttr} x1="${fx(cc.x + cc.dx)}" y1="${cc.y}"` +
          ` x2="${fx(c.x + c.dx)}" y2="${c.y}" stroke="#f0e6d8" stroke-opacity="0" stroke-width="0.8"` +
          ` stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`;
      }
    }
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      // ONE MODEL, ONE CIRCLE SIZE (the architect 2026-08-30: "opus 5 seems to have different
      // sizes in the same model, impossible, must be a bug"). He was right: this used
      // to multiply the radius by 0.82 on every non-anchor stop, so Opus 5 — one
      // model, one context window, five effort rungs — rendered at two radii. Radius
      // now means only what scRadius says it means: area ∝ context window.
      const r = fx(scRadius(m.ctx, s));
      // The published-price stop is told apart by ring WEIGHT, not by being bigger:
      // 0.95 at the anchor, 0.57 at the derived stops (SC_NONANCHOR_STROKE).
      const ringSo = fx(0.95 * (c.p.anchor ? 1 : SC_NONANCHOR_STROKE));
      // ghost at the landing spot — visible only in task mode (CSS)
      ghosts +=
        `<g class="sc-ghostpos"${vAttr}${tAttr}${mAttr} transform="translate(${fx(c.x + c.dx)}, ${c.y})">` +
        `<circle class="sc-ghost" style="transition-delay:${delay}" r="${r}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.3" stroke-width="0.8"` +
        ` stroke-dasharray="2.4 2.2" vector-effect="non-scaling-stroke"/></g>`;
      // the dot: an OUTLINE circle carrying the model logo (the architect 2026-08-06 #2),
      // positioned by CSS custom properties so the task-mode toggle can glide it.
      const tokens = scTokensPerTask(m.id, c.p.lvl);
      const tip =
        `${m.name} · ${c.p.label} — €${fmt(c.p.cost)}/Mtok` +
        ` · ~${scFmtTokens(tokens)}/task · ${scFmtCtx(m.ctx)} ctx` +
        ` · idx ${c.p.smart.toFixed(1)}${c.p.measured ? ` at ${c.p.label} (AA)` : " (headline — AA published no per-effort split)"}` +
        // Two dots with the same name are two SELLERS of one brain — say which
        // this is, and whether the other routes cost the same.
        (m.twinN
          ? ` · via ${scRouteTag(m)} · ${m.twinN} routes${m.twinSpread ? "" : ", same price"}`
          : "") +
        // The plan-vs-list gap, stated on the circle itself. Without it the only way
        // to read the discount is to eyeball the dashed bridge, and a 112x gap on a
        // log axis is easy to under-read by an order of magnitude.
        (() => {
          const list = scApiPrice(m.id);
          if (list === undefined) return "";
          const mult = scApiMultiple(m);
          if (mult === undefined) return " · this IS the API list price";
          const listAtEffort = list * (EEG_EFFORT_MULT[c.p.lvl] ?? 1);
          return ` · API list €${fmt(listAtEffort)}/Mtok = ${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}x this plan`;
        })() +
        (scIsUtilDrag(m)
          ? ` · drawn at ${Math.round(SC_PLAN_UTIL * 100)}% of the quota ceiling (the average we use to turn a flat fee into €/Mtok) · drag toward the triangle to see other utilisation`
          : "");

      const logoSize = fx(Math.max(5, r * 1.25));
      // Logo is placed at the GROUP ORIGIN (the group is translated to its
      // chart position via CSS), so ring + logo + hit-area glide as one body.
      const logo = scLogoFor(m).replace(
        /^<svg /,
        `<svg x="${fx(-logoSize / 2)}" y="${fx(-logoSize / 2)}" width="${logoSize}" height="${logoSize}" `,
      );
      // FORK 2026-08-06 #6 (the architect: "logos are not in the right place, I see a
      // few out of the graph top-left. Also I don't see the circle outlines"):
      // the base position now lives in an SVG TRANSFORM ATTRIBUTE on an outer
      // <g class="sc-dotpos"> — always applied, always in user space, scales
      // with the viewBox. The old CSS transform(var(--sc-x),var(--sc-y)) for
      // the BASE position silently collapsed dots to the SVG origin in the architect's
      // browser (logos top-left, rings invisible). CSS now carries ONLY the
      // task-mode glide delta. Ring stroke widened so the outline reads clearly.
      const utilDrag = scIsUtilDrag(m);
      const listHere = scApiPrice(m.id);
      const listAtEffort =
        listHere === undefined ? undefined : listHere * (EEG_EFFORT_MULT[c.p.lvl] ?? 1);
      const dragAttr =
        utilDrag && listAtEffort !== undefined
          ? ` data-util-drag="1" data-home-x="${c.x}" data-home-y="${c.y}" data-home-cost="${c.p.cost}" data-list-cost="${listAtEffort}" data-list-x="${fx(scCostX(listAtEffort, s))}"`
          : "";
      dots +=
        `<g class="sc-dotpos" transform="translate(${c.x}, ${c.y})"${vAttr}${tAttr}${mAttr}${dragAttr}>` +
        `<g class="sc-dotg" style="--sc-x:${c.x}px;--sc-y:${c.y}px;--sc-dx:${c.dx}px;transition-delay:${delay}">` +
        `<circle class="sc-ring" r="${r}" fill="${m.color}" fill-opacity="0.07" stroke="${m.color}"` +
        ` stroke-opacity="${ringSo}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
        `<g class="sc-logo" pointer-events="none">${logo}</g>` +
        `<circle r="${fx(r + 4)}" fill="transparent"><title>${esc(tip)}</title></circle>` +
        (utilDrag
          ? `<text class="sc-util-pct" y="${fx(-(r + 10))}" text-anchor="middle" dominant-baseline="alphabetic"` +
            ` font-family="'SF Mono',ui-monospace,monospace" fill="#f0e6d8" fill-opacity="0.95"` +
            ` pointer-events="none">${Math.round(SC_PLAN_UTIL * 100)}%</text>`
          : "") +
        `</g></g>`;
    }
  });

  // ─── twin connectors ───
  // One dashed segment per ADJACENT pair of routes to the same brain, drawn
  // between their medium-effort anchors. Twins share an AA index, so the two
  // anchors share a y and the segment comes out horizontal on its own — the
  // "obviously horizontal" the architect asked for is a property of the data, not a
  // constraint imposed on the drawing. Should a route ever carry a different
  // index, the segment tilts and says so rather than lying flat.
  //
  // Cream, not either vendor's colour: the line is the RELATIONSHIP between two
  // sellers, and painting it one seller's identity would claim it belongs to
  // that seller. Same cost/task crossfade as the constellation polylines.
  //
  // Groups whose routes cost the SAME never reach here (twinSpread === false),
  // so this layer cannot emit a zero-length dash implying a price gap that the
  // data does not contain.
  let twins = "";
  const byTwin = new Map<string, typeof twinAnchors>();
  for (const a of twinAnchors) {
    const g = byTwin.get(a.key);
    if (g) g.push(a);
    else byTwin.set(a.key, [a]);
  }
  for (const group of byTwin.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((p, q) => p.x - q.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const key = esc(a.key);
      twins +=
        `<line class="sc-twin-cost" data-twin="${key}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"` +
        ` stroke="#f0e6d8" stroke-opacity="0.26" stroke-width="0.9" stroke-dasharray="3.5 3"` +
        ` vector-effect="non-scaling-stroke"/>` +
        `<line class="sc-twin-task" data-twin="${key}" x1="${fx(a.x + a.dx)}" y1="${a.y}"` +
        ` x2="${fx(b.x + b.dx)}" y2="${b.y}"` +
        ` stroke="#f0e6d8" stroke-opacity="0" stroke-width="0.9" stroke-dasharray="3.5 3"` +
        ` vector-effect="non-scaling-stroke"/>`;
    }
  }

  // labels at the MAX-effort point, de-collided greedily by y; labels glide
  // with their constellation (same --sc-dx as the dots). ONLY labelled models
  // get text — the rest live in their tooltips.
  //
  // FORK 2026-08-06 #11 (the architect: "the model names need to be exactly at the same
  // height than its highest effort bubble"). The greedy y de-collision that used
  // to nudge crowded names apart is GONE: a name a few px off its own dot is a
  // name pointing at the wrong model, which is worse than two names overlapping —
  // and overlap resolves itself the moment you zoom, because the dots spread while
  // the names keep their size. dominant-baseline="central" puts the text's middle
  // on the dot's centre, so "same height" is exact, not approximated by a baseline
  // nudge.
  //
  // FORK 2026-08-06 #10 (the architect: "the model names should be to the right of its
  // most effort bubble, and should approach the circle as I zoom in, otherwise
  // it renders out of view"). Two changes, one cause. The label used to carry
  // its final position in its x/y ATTRIBUTES — chart units — so its distance
  // from the dot was fixed in CHART space and therefore grew on screen with
  // every zoom step, until the name sat off-screen while its dot was centred.
  // Now the label is anchored ON the dot (a translate on an outer <g>) and the
  // gap + the de-collision offset ride --sc-k, the same inverse-zoom the markers
  // counter-scale by: constant on-screen distance, so the name closes in on its
  // circle as you zoom. The right/left flip is gone — always right of the
  // max-effort bubble, as asked.
  // SAME-PRICED routes share one label (the architect 2026-08-24, caught in the render).
  // A price-spread twin puts its two names at two different x, so they read fine
  // and each needs its own. A ZERO-spread group is the opposite: openai,
  // openai-codex and codex all sell gpt-5.6-sol at 0.2679, so the three dots sit
  // on EXACTLY the same coordinates and three labels print on top of each other.
  // Crowding elsewhere resolves when you zoom — this one never can, because the
  // points are identical at every scale. So the group prints ONCE, listing every
  // route: "gpt-5.6-sol (openai · openai-codex · codex)". Nothing is hidden; the
  // one label says strictly more than the three unreadable ones did.
  const sameCostRoutes = new Map<string, string[]>();
  for (const m of models) {
    if (!m.twinKey || m.twinSpread !== false) continue;
    const acc = sameCostRoutes.get(m.twinKey);
    if (acc) acc.push(scRouteTag(m));
    else sameCostRoutes.set(m.twinKey, [scRouteTag(m)]);
  }
  const labelledSameCost = new Set<string>();
  const labelCands = models
    .filter((m) => {
      if (m.labeled === false) return false;
      if (!m.twinKey || m.twinSpread !== false) return true;
      // first member of a same-priced group carries the label for all of them
      if (labelledSameCost.has(m.twinKey)) return false;
      labelledSameCost.add(m.twinKey);
      return true;
    })
    .map((m, mi) => {
      // The label hangs off the model's DEAREST stop — which is its own last
      // one, not a fixed "max" that most models never had.
      const pts = scPointsFor(m);
      const p = pts[pts.length - 1];
      const xCost = scCostX(p.cost, s);
      const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
      return {
        name: m.name,
        id: m.id,
        // A twin prints WHICH route this dot is. Without it the chart shows
        // "gpt-5.5" twice, 62x apart, with no way to tell which one you can buy
        // at which price — the whole point of un-folding them.
        route: m.twinN ? (sameCostRoutes.get(m.twinKey ?? "")?.join(" · ") ?? scRouteTag(m)) : "",
        isCopilot: scIsCopilot(m),
        vendor: m.vendorKey ?? m.provider,
        twin: m.twinKey ?? "",
        color: m.color,
        x: xCost,
        y: scY(p.smart, s),
        // Horizontal air between the mark and the first glyph (base.css translates
        // .sc-label by --sc-gap). It has to clear the ring the name hangs off — the
        // model's DEAREST stop, picked just above — and every stop now draws at the
        // model's full context radius, so that ring is exactly scRadius(ctx) wide and
        // +5 is the air itself. Was `* 0.82 + 5`, sized for a shrunken non-anchor ring
        // that no longer exists: against a full-size one it leaves 5 − 0.18·r of air,
        // i.e. ~2.8px at R_MAX, and the name crowds the circle it is naming.
        gap: scRadius(m.ctx, s) + 5,
        dx: xTask - xCost,
        delay: `${(mi * stagger).toFixed(2)}s`,
      };
    });
  let labels = "";
  for (const l of labelCands) {
    labels +=
      // transform stays IMMEDIATELY after the class — the label-position tests
      // (and the anchor regexes they use) read the two as adjacent.
      `<g class="sc-labelpos" transform="translate(${fx(l.x)}, ${fx(l.y)})"` +
      ` data-vendor="${esc(l.vendor)}"${l.twin ? ` data-twin="${esc(l.twin)}"` : ""}` +
      ` data-model="${esc(l.id)}">` +
      `<text class="sc-label" style="--sc-dx:${fx(l.dx)}px;--sc-gap:${fx(l.gap)}px;` +
      `transition-delay:${l.delay}"` +
      ` x="0" y="0" text-anchor="start" dominant-baseline="central"` +
      ` font-family="'SF Mono',ui-monospace,monospace" fill="${l.color}" fill-opacity="0.85">${esc(l.name)}` +
      // Copilot keeps the pink it has always had; other routes tag in cream so
      // the tag never competes with the model's own identity colour.
      (l.route
        ? `<tspan class="sc-route-note" fill="${l.isCopilot ? SC_COPILOT_PINK : "#f0e6d8"}"` +
          ` fill-opacity="${l.isCopilot ? "0.95" : "0.55"}"> (${esc(l.route)})</tspan>`
        : "") +
      `</text></g>`;
  }

  return (
    // FORK 2026-08-06 #5: no fixed width/height attributes — the chart fills its
    // container via CSS (.sc-svg { width:100%;height:100% }) and the viewBox +
    // preserveAspectRatio scale the 900x600 drawing to fit, centered, ratio kept.
    // Fixed attributes fought the CSS and let dots overflow the window.
    `<svg class="sc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">` +
    // The twin layer sits UNDER the constellations and dots: it is the
    // relationship between two sellers, so it must never draw over the things
    // it relates. (It was assembled but never emitted until 2026-08-24 — the
    // connectors existed in the string and rendered nowhere.)
    // The API layer sits UNDER the twin connectors and the dots: it is the price we
    // are NOT paying, so it must never draw over the price we are. The bridges go
    // below the triangles for the same reason a twin connector goes below its dots.
    `${defs}${bg}${grid}${axes}<g class="sc-bridgelayer">${bridges}</g>` +
    `<g class="sc-apilayer">${apiMarks}</g>` +
    `<g class="sc-twinlayer">${twins}</g>${linesTask}${linesCost}${ghosts}` +
    // FORK 2026-08-06 #9 (the architect: "make the load and the zoom faster"): the neon
    // bloom was `filter="url(#sc-glow)"` on EVERY ring — 132 separate Gaussian
    // blur passes, re-run on each viewBox change, which is what made zooming
    // crawl. One filter on the dot LAYER renders the same bloom in a single pass.
    `<g class="sc-dotlayer" filter="url(#sc-glow)">${dots}</g>${labels}</svg>`
  );
}
