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
// and no "forced" dashing: the EEG shows what happened (the architect 2026-06-18).

import { EFFORT_COST_MULT } from "../../../src/shared/effort-cost-mult.js";
import { DEFAULT_REL_COST, REL_COST_TABLE } from "../../../src/shared/rel-cost-table.js";
import { buildEegSpendClock, EEG_LIVE_GRACE_MS } from "./eeg-spend-clock.js";
import { vendorOfModel } from "./vendor-marks.js";

// ─── Stops (MUST mirror app.ts THINK_STOPS order exactly) ───
// `short` = the compact tick label printed under the slider AND above the
// seismograph column (full labels collide at 8 stops in a ~280px panel).
export const EEG_STOPS: { lvl: string; label: string; short: string }[] = [
  // lvl "" = the uncapped/"Auto" column. Auto is NOT an effort (the architect 2026-06-25)
  // — so its tick text is blank. The COLUMN stays: it reserves the left-hand space
  // that overflow `minimal` strands fan into (min→auto) when many run concurrently.
  { lvl: "", label: "Auto", short: "" },
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
  // FORK 2026-06-25 (the architect scope C): a TOOL CALL (not an LLM run) — drawn as a
  // branch off the trunk like a subagent, but colored/weighted by the PROVIDER it
  // drives (eegToolIdentity). nano-banana → gemini rainbow; grep/read → thin gray.
  // The point is to SEE a turn branch into providers + thicknesses, not to meter
  // cost precisely (the architect: €/token is already orientative). Excluded from `mains`
  // (never a trunk segment) and from the subagent ×N gauge (tools aren't fan-out).
  tool?: boolean;
  parentRunId?: string;
  /** Subagent task text ("what this run is doing"), shown in the branch hover
   *  tooltip alongside the model. Falls back to the model name when absent. */
  label?: string;
  thinkingChars?: number; // measured thinking CHARACTERS (never tokens); fallback effort column when no executed level is echoed
  inputTokens?: number; // billed prompt tokens (summed across the run's rounds)
  outputTokens?: number; // generated tokens (run total)
  startedAt: number; // epoch ms
  endedAt?: number; // epoch ms (absent = still running)
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

// ─── Provider brand palette (bible §5.8h, the architect's q6 full-palette pick) ───
// google is NOT here — it is special-cased as the rainbow gradient below.
export const EEG_PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#E8702A",
  openai: "#10A37F",
  // FORK 2026-08-04 (the architect): Copilot EEG = pink. Exact value from the OKLab
  // farthest-point sampler (scripts/pick-trace-colors.mjs) — h=337, separation
  // 0.255 from every other point on the paper including the #2a2318 background.
  "github-copilot": "#BF09A3",
  deepseek: "#4D6BFE",
  // FORK 2026-08-04 (the architect): the OpenRouter vendors. Values are NOT the brand
  // colours — Kimi #1783FF, GLM #3859FF, Qwen #6336E7 and DeepSeek #4D6BFE are
  // four blue-indigo brands that would paint four indistinguishable traces. See
  // ./vendor-marks.ts and scripts/pick-trace-colors.mjs.
  kimi: "#07B2FE",
  qwen: "#C382FB",
  glm: "#80EE24",
  mistral: "#FA520F",
  meta: "#0668E1",
  xai: "#B7BBC2", // FORK 2026-07-21 (the architect): Grok = light gray (black brand is invisible on the #2a2318 paper; gray keeps the trace legible + distinct from the neutral `unknown` gray).
  unknown: "#8A8F98", // local / anything unrecognized = neutral gray
};

// FORK 2026-06-13 (eeg): infer the brand from EITHER a provider string OR a bare
// MODEL name — the live trace gets the cc-bridge model id ("claude-fable-5", no
// "claude-code/" prefix), so providerOf() returns the bare name and a plain
// provider-key lookup missed → gray. Matching model-name patterns keeps the trace
// branded (the architect 2026-06-13: "why am I still seeing gray instead of orange").
// FORK 2026-08-04 #2 (the architect: "The chinese models still have no visible color yet").
// The vendor branch added earlier this day could NEVER fire: every caller passes
// the PROVIDER string, and for these models that string is the literal
// "openrouter" — which carries no vendor token at all. Adding the optional
// `model` argument is the actual fix; the branch below was correct and unreachable.
// Callers that hold a model id should pass it.
export function eegProviderPaint(
  provider: string,
  model?: string,
): { stroke: string; isRainbow: boolean } {
  const p = (provider || "").toLowerCase();
  // Vendor resolution looks at provider AND model together, because the vendor
  // token can live in either one depending on the surface.
  const vendorKey = `${p} ${(model || "").toLowerCase()}`;
  if (p === "google" || p.startsWith("google") || /gemini|gemma|bison/.test(p)) {
    return { stroke: "url(#eeg-google)", isRainbow: true };
  }
  // FORK 2026-07-30 (the architect): GitHub Copilot BEFORE the claude/gpt regexes — otherwise
  // a full "github-copilot/claude-…" id would paint Anthropic orange, and gpt twins
  // would paint OpenAI green. Copilot is its own Windows-blue lane.
  if (
    p === "github-copilot" ||
    p === "copilot" ||
    p.startsWith("github-copilot") ||
    p.includes("github-copilot/")
  ) {
    return { stroke: EEG_PROVIDER_COLORS["github-copilot"], isRainbow: false };
  }
  // FORK 2026-08-04 (the architect): the OpenRouter vendors resolve by MODEL id, not by
  // provider — every one of them reports provider "openrouter", so a provider-key
  // lookup painted them all the neutral gray. Must sit ABOVE the generic branches:
  // 'glm' would otherwise never be reached, and a bare 'qwen3.8-max' has no other
  // branch that claims it. deepseek keeps its own existing branch below.
  {
    const vendor = vendorOfModel(vendorKey);
    if (vendor && EEG_PROVIDER_COLORS[vendor]) {
      return { stroke: EEG_PROVIDER_COLORS[vendor], isRainbow: false };
    }
  }
  // FORK 2026-09-02 (the architect: "the color of the trace of fable 5.1 should be the one
  // assigned to claude, the orange one"). These branches tested `p` — the PROVIDER
  // string — while the vendor branch above tests provider AND model. For a model we
  // reach THROUGH a router the brand lives in the model id's middle segment, so
  // `openrouter/anthropic/claude-fable-5.1` arrived with p="openrouter", matched
  // nothing, and fell to the neutral gray at the bottom. The class is wider than
  // Fable: every openrouter/{anthropic,openai,x-ai,meta,mistral}/* route painted gray.
  // They now test `vendorKey` (provider + model), the same haystack the vendor branch
  // uses. Copilot still resolves FIRST above, so a github-copilot/claude-* id keeps
  // its own blue lane and does not leak into the orange one.
  if (
    p === "claude-code" ||
    p === "anthropic" ||
    /claude|fable|opus|sonnet|haiku/.test(vendorKey)
  ) {
    return { stroke: EEG_PROVIDER_COLORS.anthropic, isRainbow: false };
  }
  if (p === "openai" || /gpt|codex|(^|[^a-z])o\d/.test(vendorKey)) {
    return { stroke: EEG_PROVIDER_COLORS.openai, isRainbow: false };
  }
  if (/grok|xai|x-ai/.test(vendorKey)) return { stroke: EEG_PROVIDER_COLORS.xai, isRainbow: false };
  if (/deepseek/.test(vendorKey)) return { stroke: EEG_PROVIDER_COLORS.deepseek, isRainbow: false };
  if (/mistral|mixtral/.test(vendorKey))
    return { stroke: EEG_PROVIDER_COLORS.mistral, isRainbow: false };
  if (/llama|meta/.test(vendorKey)) return { stroke: EEG_PROVIDER_COLORS.meta, isRainbow: false };
  return { stroke: EEG_PROVIDER_COLORS[p] ?? EEG_PROVIDER_COLORS.unknown, isRainbow: false };
}

// FORK 2026-06-25 (the architect scope C): a tool call branches off the trunk colored +
// weighted by the PROVIDER it drives. Most skills shell out to a CLI/script, so we
// infer the provider from the tool name + (for Bash) the command string. A call that
// drives an EXTERNAL model (nano-banana → Gemini image, codex → OpenAI) gets that
// provider's brand color + a real width; plain local housekeeping (grep/read/edit/
// write/plain bash) gets the neutral "tool" identity → gray + the thin `tool:local`
// cost floor, so it is PRESENT ("any and all tool calls") without out-shouting a
// provider call. The synthetic `model` flows through eegProviderPaint + eegRelCost
// unchanged, so color/width need no special-casing downstream.
export interface EegToolIdentity {
  provider: string;
  model: string;
}
export function eegToolIdentity(toolName: string, command?: string): EegToolIdentity {
  const hay = `${(toolName || "").toLowerCase()} ${(command || "").toLowerCase()}`;
  // Gemini-backed skills: image gen (nano-banana), nano-pdf, napkin, gemini CLI, summarize.
  if (/nano-banana|generate_image|nano-pdf|napkin|\bgemini\b|gemma/.test(hay)) {
    return { provider: "google", model: "gemini-3-pro-image" };
  }
  // OpenAI-backed: codex, whisper-api, openai image gen, explicit gpt models.
  if (/\bcodex\b|openai|whisper-api|\bgpt-/.test(hay)) {
    return { provider: "openai", model: "gpt-5" };
  }
  // Anthropic-backed: oracle / coding-agent / a nested claude CLI.
  if (/\boracle\b|coding-agent|claude-code|\bclaude\b/.test(hay)) {
    return { provider: "anthropic", model: "claude-opus-5" };
  }
  // Everything else = local housekeeping (grep/read/edit/write/webfetch/plain bash).
  return { provider: "tool", model: "tool:local" };
}

// ─── Cost model: thickness = the architect's REAL per-use cost (€/Mtok output) ───
// relCost values ARE effective €/Mtok-output under the architect's actual billing,
// NOT API sticker.
//
// FORK 2026-07-22 15:48 (the architect, REAL INVOICES — supersedes the same-day 50%
// blanket model): effective €/Mtok per model from the four actual bills:
//   · Anthropic: Max 20x €217.80/mo + €46.28 metered OVERAGE (the architect pays) = €264.08.
//     FORK 2026-08-11 (the architect, after a $146 OpenRouter bill that this table argued
//     FOR): the denominator was the ASSUMED ~124 Mtok-sonnet-eq × 1.21 ≈ 150, giving
//     €1.76 per sonnet-eq Mtok. That constant only ages one way — a flat fee's
//     per-token cost DIVIDES by usage — and burn has grown ~20× since it was written
//     (147 Mtok raw in 2026-06 → 6,258 Mtok in the trailing 30d). It is now MEASURED
//     from anatomy_events, weighted with the SAME blend the renderer uses
//     (output + 0.2·input), so Σ eegSampleEuros over a month ≈ the actual invoice:
//       trailing 30d (to 2026-08-11): fable 78.9 + opus 1,129.7 + sonnet 69.9 +
//       haiku 0.3 Mtok weighted, × burn weights .3/1/5/10 = 6,507 Mtok-sonnet-eq.
//       unit = €264.08 / 6,507 = €0.0406 per sonnet-eq Mtok — the old 1.76 was 43×
//       high. (Cross-check, July 2026 complete month: 4,164 eq → €0.0634. Same
//       order; the trailing window is the basis because the fee is monthly.)
//     CONSEQUENCE, stated so nobody "fixes" it back: at the true rate every
//     Anthropic model lands BELOW EEG_COST_PX_FLOOR and draws as the same hairline.
//     That is not a regression — a prepaid token is not cash leaving the account,
//     which is precisely what this column was built to show (see the OpenRouter
//     note below). Model identity lives in the COLOR/label channel, not this one.
//     RE-DERIVE when the plan price changes or burn moves an order of magnitude;
//     bug-log 2026-08-11 [panels] carries the query and the log-axis proposal.
//   · OpenAI: ChatGPT BUSINESS ×5 seats €130.01/mo (employer pays) → €26/seat, which
//     the architect states as **€25/mo** (2026-08-12); the 4% gap is immaterial next
//     to the denominator problem documented at the gpt-5.6 rows below. Our
//     path burns one seat. No token data → uniform 9.3× price→API-value quota
//     at 50% use = API output price ÷ 4.65 (Sol $30 / Terra $15 / Luna $6).
//   · Google: the architect ATTRIBUTES his €21.99/mo Google One AI to Gemini (his call
//     2026-07-22 16:17, though the CLI tokens come from the free Code Assist
//     tier) → same uniform amortization: API output ÷ 4.65 (3.1-pro $12 →
//     2.58; flash $9 → 1.94).
//   · xAI: SuperGrok (company seat, $9.90 promo → $30 steady-state; widths use $30):
//     grok-4.5 $6 ÷ 4.65.
//   · GitHub Copilot Pro+ (the architect 2026-07-30): $39/mo → 7,000 AI credits
//     (1 credit = $0.01 ⇒ $70 included). Token burn is metered at GitHub's
//     sticker rates (docs.github.com/copilot models-and-pricing). Amortize
//     like other subscriptions: API output $/Mtok ÷ 4.65. Copilot-path models
//     are matched FIRST (provider prefix) so openai/* twins keep their own bill.
//   Anchor: cheapest slider model = HAIKU ≈ €0.53/Mtok = 1.0px (eegCostWidthPx).
// ESTIMATES except the Anthropic spend (real invoice); measured halo corrects
// later. Never present as measured (bible §5.8h invariant 3).
//
// FORK 2026-08-12 (the architect: "draw it from public websites and then refute it with our
// data"). Copilot is NO LONGER a ÷4.65 subscription row. Since 2026-06-01 Copilot
// bills tokens at vendor sticker and publishes the rates itself
// (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing, read
// 2026-08-12): Opus 4.7/4.8 $5/$25 · Sonnet 5 $2/$10 · Sonnet 4.5/4.6 $3/$15 ·
// GPT-5.4 $2.50/$15 · GPT-5.5 $5/$30 · Gemini 3.5 Flash $1.50/$9. Dividing those by
// 4.65 understated every Copilot row 4.65×, so they now carry the RAW output price
// like the OpenRouter block — a Copilot token is cash, not prepaid quota.
// ══ 2026-09-23 — THE DUPLICATE IS GONE. This file kept its own copy of the cost table
// after src/shared/rel-cost-table.ts became "the SINGLE source", and the two drifted:
// on the day of the collapse 24 rows disagreed — the Anthropic block sat on a 0.0294
// unit here against 0.0893 there, and `openai-codex/gpt-6-sol` / `gpt-6-luna` had NO
// row here at all, so the MODELS panel and the smartness×cost chart (which read THIS
// table) drew both at the 2.58 unknown-metered default, far right of where the seat
// puts them. the architect caught it as "the cost of the tokens of the different openai models
// are not calculated properly". Every surface now reads the shared table; the prose
// basis block above is HISTORY — the live derivation (measured seats, one method) is
// the SUBSCRIPTION SEATS block at the top of src/shared/rel-cost-table.ts.
export const EEG_COST_TABLE: { modelMatch: RegExp; relCost: number }[] = REL_COST_TABLE;
const EEG_DEFAULT_REL_COST = DEFAULT_REL_COST;

// Effort multiplier per stop. Auto ("") = UNCAPPED — the model picks its own
// budget, so it costs more than medium on average (§5.8g: Auto is never tier 0).
// MOVED 2026-09-02 to src/shared/effort-cost-mult.ts (the THALAMUS router prices effort
// rungs from the same table). Re-exported under the panel's historical name.
export const EEG_EFFORT_MULT: Record<string, number> = EFFORT_COST_MULT;

// FORK 2026-06-20 (the architect): the model's effective €/Mtok-output (EEG_COST_TABLE
// value, or the default for an unrecognized model). Shared by BOTH the stroke
// WIDTH (cost-per-token identity) and the segment LENGTH (euro cost = the §1 grid).
// Pass FULL model refs when available ("github-copilot/gpt-5.5") so Pro+ pricing
// applies; bare names fall through to native/subscription rows.
/** Prefer full "provider/model" refs so Copilot Pro+ rows fire. */
export function eegCostKey(model: string, provider?: string): string {
  const m = (model || "").trim();
  if (!m) return m;
  if (m.includes("/")) return m;
  const p = (provider || "").trim();
  return p ? `${p}/${m}` : m;
}

export function eegRelCost(model: string, provider?: string): number {
  const key = eegCostKey(model, provider);
  for (const row of EEG_COST_TABLE) {
    if (row.modelMatch.test(key)) return row.relCost;
  }
  return EEG_DEFAULT_REL_COST;
}

// Pixel + comparison unit are BOTH Luna (the architect 2026-07-30 20:56:
// "using Luna as reference, with one pixel wide"). Sol=5px, Terra=2.5px, Luna=1px.
//
// SINGLE SOURCE for all three surfaces (FORK 2026-08-28: two SCALES, still one file
// and one entry point — resolveEegPaint returns both and each surface picks the one
// its geometry can draw honestly; see the LOG block below for why):
//   · MODELS panel cost column  → app.ts renderCostCol   → paint.width    (LINEAR)
//   · model selector buttons    → app.ts renderModelChip → paint.logWidth (LOG)
//   · EEG seismograph paper     → eeg-trace renderSvg    → paint.logWidth (LOG)
// Do not invent a second thickness formula in app.ts.
// FORK 2026-08-13 — LUNA IS NO LONGER THE UNIT, and this is a consequence worth
// stating plainly because Luna = 1.5px was the architect's own constant (2026-08-04).
// Removing the ÷4.65 blanket moved Luna's relCost from 0.258 to **0.0107** (a 24×
// re-basing), so "one Luna = 1.5px" became arithmetically false — Luna now floors.
// The PIXEL SCALE is unchanged (1.5 ÷ 0.258 = 5.814 px per unit of relCost), so no
// stroke on the panel moves because of this rename; only the label does.
// The comparison unit becomes **Sonnet 5**, which is already the denominator of the
// sticker-ratio scheme every prepaid row is built on — so "×sonnet" is now a ratio
// against the same reference the numbers are derived from, instead of against a model
// whose own basis just changed underneath it.
export const EEG_COST_PX_PER_REL = 5.814; // px per 1.0 of relCost (€/Mtok-output)
// FORK 2026-08-30 (the architect: "since grok is cheaper than sonnet, let's make the whole
// models panel onhover references change now to grok"). SUPERSEDES the 2026-08-13
// switch to Sonnet 5 described immediately above.
//
// Two reasons, and the second is the one that generalises. (a) Grok is CHEAPER than
// Sonnet — 0.0536 against 0.0893 — so fewer rows land below 1× and the multiple reads
// as "how many Groks" rather than as a fraction. (b) It is the unit the model PICKER
// already uses, and it was chosen there because Grok is RENDERED IN THAT CONTROL as the
// thinnest bar: "5× Grok" is checkable against something on screen. Sonnet is a real
// model but is not guaranteed to be drawn anywhere the reader is looking, so its
// multiple was unanchored. One unit across both surfaces, so a number carried from the
// panel to the picker means the same thing.
//
// DERIVED, never transcribed. The old 0.0893 was a hand-copied duplicate of the sonnet
// row; this file has lost three separate battles to hand-copied numbers (the stroke
// ladder rotted three times), so the unit now reads its own value out of the table it
// is a unit FOR. Re-pricing Grok re-bases every multiple automatically instead of
// silently making them all wrong.
//
// FORK 2026-08-30 (the architect: "when I said Grok, I meant v4.6") — REF bumped
// 4.5 → 4.6. PRICES CHECKED 2026-08-30 on Artificial Analysis: both versions publish
// the IDENTICAL $2.00 in / $6.00 out sticker. Read off the PER-MODEL pages
// (artificialanalysis.ai/models/grok-4-5 and .../models/grok-4-6). NOT off the
// leaderboard index at https://artificialanalysis.ai/leaderboards/models, which is the
// obvious place to look and is the WRONG one: it quotes an aggregate "cost per task"
// ($0.43 for 4.5 high, $1.23 for 4.6 xhigh — different effort tiers, so not even
// comparable to each other), which is not a per-token price and must never be used to
// re-base this unit.
//
// The rename is therefore numerically INERT, and that is verified in the CODE, not
// inferred from the sticker: the xAI row in EEG_COST_TABLE (`/grok|xai/i`, relCost
// 0.0536, just below the gpt-5 rows) is a single catch-all, NOT split by version, so
// eegRelCost("xai/grok-4.5") and eegRelCost("xai/grok-4.6") select the SAME row and
// both return 0.0536. EEG_COST_COMPARE_REL is bit-identical across the bump, so every
// "N× Grok" figure app.ts renders off it — the MODELS panel cost-column hover and the
// picker's modelCostHint() — is unchanged. eeg-trace.test.ts: 86/86 green either side.
//
// THE TRAP, for whoever prices 4.5 and 4.6 apart later: SPLITTING that catch-all into
// per-version rows would silently RE-BASE every "N× Grok" figure on BOTH surfaces,
// because EEG_COST_COMPARE_REL (next line) derives this unit from that very table —
// nothing would fail, the multiples would just quietly mean something else. The split
// and this reference must move TOGETHER, in one change; never split the row and leave
// EEG_COST_COMPARE_REF pointing at whichever version used to be the catch-all.
export const EEG_COST_COMPARE_REF = "xai/grok-4.6";
export const EEG_COST_COMPARE_REL = eegRelCost(EEG_COST_COMPARE_REF, "xai");
export const EEG_COST_COMPARE_LABEL = "Grok";

// FORK 2026-08-04 (the architect: "Let's set up Luna at 1.5 pixels and resize the rest of
// the stroke widths accordingly"). Luna stays the unit; only its pixel value moves,
// so every other width rescales linearly and no relative relationship changes.
//
// FORK 2026-08-12 (the architect: "I would like to keep the linear axis") — a log axis was
// shipped earlier the same day and is REVERTED here. Linear is the architect's call
// and it buys a real property that log destroys: the drawn ratio IS the cost ratio.
// qwen3.8 renders 29.9× thicker than opus for 29.9× the cash. Under log the same
// pair read 2.5×, which is honest about ORDER but silent about MAGNITUDE — and
// magnitude is the thing that was missed on 2026-08-06.
//
// The price of that property, stated so nobody re-discovers it as a bug: with every
// prepaid seat on one measured basis the honest spread is ~4700:1 (luna 0.0107 →
// copilot-fable 50). FORK 2026-08-15: that spread is now drawn IN FULL — the top is
// uncapped, so kimi-k3 renders at ~53px (Sail Research $9.043, 2026-09-26) and a hypothetical copilot-fable at 162px.
// Only the bottom clips, at the 0.35px FLOOR (luna, mini, grok, haiku, tool:local),
// and that clamp only ever makes a stroke MORE visible. `EEG_COST_PX_PER_REL` is the
// single density knob if the widest strokes ever need to fit a narrower rail.

// Exported so the tests assert the CODE's clamp rather than a copy of it. The old
// assertions hardcoded [0.5, 11] — a scale two rescales out of date — and had been
// failing silently ever since, which is how the tool:local bug above survived.
/**
 * The documented stroke ladder, MACHINE-CHECKED (added 2026-08-16 after the prose copy
 * rotted for the third time). Each entry is [model ref, expected px at the default tier].
 * `eeg-trace.test.ts` recomputes every row with `eegCostWidthPx` and fails on any drift,
 * so a reprice can no longer leave a lying ladder behind: it breaks the build instead.
 * When a price legitimately changes, update the number here — that is the whole ritual.
 */
export const EEG_COST_LADDER_DOC: readonly (readonly [string, number])[] = [
  ["codex/gpt-5.6-luna", 0.48], // off the floor since the 2026-09-23 measured-seat re-base
  ["claude-haiku-4-5", 0.66], // off the floor since the 2026-09-23 measured-seat re-base
  ["deepseek/deepseek-v4-flash-0731", 0.77], // 0.132 — re-checked 2026-09-26 live (StreamLake still cheapest, −17%)
  ["xai/grok-4.5", 0.79], // off the floor since the 2026-09-23 measured-seat re-base
  ["claude-sonnet-5", 1.32], // 2026-09-23 measured-seat re-base
  ["z-ai/glm-5.3-flash", 1.45], // 0.25 (DeepInfra, +79%) — re-checked 2026-10-01 live endpoints
  ["deepseek/deepseek-v4.1-flash", 2.33], // 0.40 (Sail Research, +3%) — re-checked 2026-10-01 live endpoints
  ["z-ai/glm-5.2", 2.58], // 0.444 (Baidu, −19%) — re-checked 2026-10-02 live endpoints
  ["z-ai/glm-5.3", 2.84], // 0.4884 (Baidu, −57%) — re-checked 2026-10-01 live endpoints
  ["tencent/hy3", 3.07], // 0.528 — re-checked 2026-09-19 live (Tencent took cheapest back; DeepInfra $0.435 gone)
  ["claude-opus-4-8", 3.31], // 2026-09-23 measured-seat re-base
  ["deepseek/deepseek-v4-flash-vision-exp", 3.76], // 0.66 — re-checked 2026-09-02 live (−50%; Fireworks cheapest, DeepSeek still 1.32) · 2026-09-23: now read from the shared table (the eeg copy had drifted)
  ["codex/gpt-5.6-terra", 4.77], // 2026-09-23 measured-seat re-base
  ["xiaomi/mimo-v2.6-pro", 4.81], // 0.8265 (GMICloud, −5%) — re-checked 2026-10-01 live endpoints
  ["minimax/minimax-m3", 5.58], // 0.96 (CoreWeave, −20% vs the OR list the table carried) — re-checked 2026-10-01 live endpoints
  ["claude-fable-5", 6.62], // 2026-09-23 measured-seat re-base
  ["qwen/qwen3.8-27b", 8.66], // 1.49 (Cerebras, −16%) — re-checked 2026-10-02 live endpoints
  ["moonshotai/kimi-k2.6", 10.63], // 1.828 — re-checked 2026-09-26 live (Baidu still cheapest, −4%)
  ["deepseek/deepseek-v4-pro-0813", 11.51], // 1.98 (StreamLake and DeepSeek; Baidu seat gone, Ionstream $1.48 is status -2 down) — re-checked 2026-10-03 live endpoints
  ["openai-codex/gpt-5.5", 11.93], // 2026-09-23 measured-seat re-base
  ["google/gemini-3.8-flash", 21.8], // $3.75 promo, same as 3.7
  ["google/gemini-3.7-flash", 21.8],
  ["qwen/qwen3.7-max", 25.73],
  ["qwen/qwen3.8-max", 34.88],
  ["github-copilot/gpt-5.4", 48.61],
  ["google/gemini-3.5-flash", 52.33],
  ["moonshotai/kimi-k3", 65.41], // 11.25 (Phala, +0.4%; Relace gone) — re-checked 2026-10-03 live endpoints
  ["github-copilot/claude-opus-4.7", 80.99],
  ["github-copilot/gpt-5.5", 97.15],
] as const;

export const EEG_COST_PX_FLOOR = 0.35; // tool:local hairline
// FORK 2026-08-15 (the architect: "Do not cap pixel width of EEG traces, the thickness
// comparison is the main objective of all of it in the first place"). EEG_COST_PX_CAP
// = 40 is DELETED, not merely raised. It was introduced as "a runaway backstop, not a
// design value" and had quietly become a design value: six rows sat on it, so kimi-k3
// ($15/Mtok) and Copilot's Fable ($50) rendered as the same slab — a 3.3x price
// difference erased by the very channel built to show price differences. A cap on a
// quantitative encoding is not a safety rail; it is a silent lie at the top of the
// range, and it defeats the one property the linear axis exists to preserve.
// The FLOOR stays: it makes sub-pixel strokes visible rather than invisible, which
// ADDS information at the bottom instead of destroying it at the top.

export function eegCostWidthPx(model: string, level: string, provider?: string): number {
  const rel = eegRelCost(model, provider);
  void level; // effort no longer scales thickness — it is the X column (below)
  // LINEAR width (the architect 2026-08-04, reaffirmed 2026-08-12): rel / luna(0.258) × 1.5.
  // The drawn ratio IS the cost ratio — that is the whole reason to stay linear.
  // The ladder USED to be pasted here as a comment. It rotted three times — the
  // 2026-08-13 copy still claimed luna 1.50 / terra 15.00 / sol 37.50 / grok-4.5 7.50 /
  // gemini-3.6 9.36 / gemini-3.5 11.28 while the code computed 0.35 / 0.62 / 1.56 /
  // 0.35 / 21.80 / 52.33 — six of sixteen entries wrong, one of them by 40×, and the
  // comment telling the reader "do not hand-edit these, print them" was itself the
  // hand-edited copy that had gone stale. A derived table transcribed by hand is a
  // second source of truth, and the second one always loses.
  // So the ladder now lives in EEG_COST_LADDER_DOC below and is MACHINE-CHECKED by
  // eeg-trace.test.ts against these very functions. To read current values, run the
  // test — it prints on failure — or call eegCostWidthPx directly.
  // UNCAPPED since 2026-08-15: kimi really is 33x fable and now draws 33x fable. The
  // only clamp left is the floor, and it only ever RAISES a stroke into visibility.
  //
  // KNOWN GAP (2026-08-13, verified against docs.github.com and docs.x.ai): several
  // vendors publish a **LONG-CONTEXT tier** at 1.2–1.5× the default output price —
  // GPT-5.4 $15→$22.50, GPT-5.5/Sol $30→$45, Terra $12→$18, Luna $1.20→$1.80,
  // Gemini 3.1 Pro $12→$18, Grok-4.5 $6→$12 (threshold 200k). `relCost` is a scalar
  // and holds only the DEFAULT tier, so any run past the threshold is UNDER-drawn —
  // and our Tinker contexts ran 300–540k on 2026-08-06. Making this honest needs a
  // piecewise rate keyed on context size, not another constant.
  const w = rel * EEG_COST_PX_PER_REL;
  return Math.max(EEG_COST_PX_FLOOR, w);
}

// ─── LOG scale — the BOUNDED surfaces (model selector · EEG paper) ───
// FORK 2026-08-28 (the architect: "inside the models panel, when expanded, it shows a trace
// thickness linearly proportional to the model's cost. However, in the model selector,
// the big spenders are capped and the cheap ones are very thin. Turn those last ones
// only into log-scale thickness, which will be also used in turn by the EEG.").
//
// TWO SCALES from here on, and which surface gets which is a property of the SURFACE,
// not a matter of taste:
//   · MODELS panel (expanded) → LINEAR. Its row HEIGHT is computed FROM the stroke
//     (renderCostCol: H = max(ceil(w)+4, 10)), so a 162px stroke is drawn at 162px and
//     the drawn ratio IS the cost ratio. Nothing is being squeezed, so nothing needs
//     compressing. The 2026-08-12 "I would like to keep the linear axis" ruling governs
//     this surface and KEEPS it — do not "unify" the panel onto the log scale.
//   · model selector + EEG paper → LOG. Both draw into a box they do not control: the
//     selector chip sits in a two-row button grid whose SVG height app.ts DERIVES
//     from the widest stroke (modelChipBoxHeight = max(ceil(widest)+10, 26) — 26 is a
//     FLOOR, never a cap; it lands at 35px at these constants), and the paper
//     shares its width with effort columns, subagent lanes and depth-shaded strand
//     stacks. On the honest ~4700:1 linear spread that box was doing two dishonest
//     things at once:
//       (a) every stroke past ~26px CLIPPED to the same slab — the top of the range
//           silently flat. That is exactly the lie the 2026-08-15 cap removal set out
//           to kill, reintroduced by SVG geometry instead of by a constant. Deleting
//           EEG_COST_PX_CAP never reached the selector, because the selector's cap was
//           never a constant to delete.
//       (b) the whole prepaid Anthropic block plus luna/grok/mini/tool sat ON the
//           0.35px floor as one indistinguishable hairline — the bottom of the range
//           silently flat too.
//     Log fixes both ends of the same box: the ~3.15 drawable decades (luna →
//     kimi-k3) map onto 1px → 25px, so no stroke clips and no stroke vanishes.
//
// WHAT IS TRADED, stated plainly so nobody re-discovers it as a bug: on these two
// surfaces the drawn ratio is NO LONGER the cost ratio. kimi-k3 is 1400× luna and now
// draws 25× it. The selector and the paper answer "which ORDER of cost is this?",
// which is the only question a chip-sized box can answer without lying; the panel still
// answers "how much MORE?" at full magnitude. Two questions, two scales, one hover
// (renderCostCol's tooltip carries the euro figure on every surface's shared table).
//
// The reference is LUNA, the cheapest ROUTABLE model — not tool:local (rel 0.001),
// which is synthetic local housekeeping and would spend a whole decade of the ramp on
// something that is not a model at all. tool:local lands below the reference and
// therefore on the log FLOOR, staying the thinnest thing on the paper by construction.
// FORK 2026-08-29 (the architect: "luna 1 px and let's set the maximum at 25 px"). Both ends
// are the architect's pixels; the decade slope is DERIVED, not chosen. MAXREL = 15.0
// (openrouter kimi-k3, the largest relCost among models either surface can actually
// draw — Copilot rows go higher, but app.ts filters Copilot ids off the chip and the
// paper cannot route one). log10(15 / 0.0107) = 3.1467074814 decades, so
// P = (25 - 1) / 3.1467074814 = 7.6270197157; ship 7.627, which puts the max at
// 24.9999 → 25.00 at the ladder's 2dp. Do NOT round to 7.63 — that yields 25.01,
// pushing ceil() to 26 and the derived chip box to 36px instead of 35. The floor
// moves with the base: 0.75/2.0 was 37.5% of the reference stroke, and 0.375/1.0
// preserves that ratio, so tool:local still reads as a hairline instead of 75% of a
// real model.
// 2026-09-23: 0.0107 WAS gpt-5.6-luna's relCost; the measured-seat re-base moved Luna
// to 0.082. The constant is KEPT as a fixed px anchor on purpose — re-normalising it
// to the new Luna would scale the correction away; the prepaid strokes thicken instead.
export const EEG_COST_LOG_REF_REL = 0.0107; // fixed 1px anchor (was gpt-5.6-luna)
export const EEG_COST_LOG_BASE_PX = 1.0; // px drawn AT the reference
export const EEG_COST_LOG_PX_PER_DECADE = 7.627; // px added per 10× of €/Mtok (derived above)
export const EEG_COST_LOG_PX_FLOOR = 0.375; // tool:local + anything under the reference

/**
 * The LOG stroke ladder, MACHINE-CHECKED the same way `EEG_COST_LADDER_DOC` is — the
 * linear ladder's prose copy rotted three times before it was moved into code, and a
 * second scale is a second chance to rot. `eeg-trace.test.ts` recomputes every row with
 * `eegCostWidthLogPx` and fails on drift, so a reprice breaks the build instead of
 * leaving a lying comment behind. github-copilot/gpt-5.5 is DELIBERATELY absent since
 * 2026-08-29: it computes to 25.36px — past the architect's 25px ceiling — and neither
 * surface can paint a Copilot id (app.ts filters Copilot off the chip, and the paper
 * cannot route one). The LINEAR ladder keeps its Copilot rows: the MODELS panel plots
 * them on purpose, under the 2026-08-12 "keep the linear axis" ruling.
 */
export const EEG_COST_LOG_LADDER_DOC: readonly (readonly [string, number])[] = [
  ["tool:local", 0.38],
  ["codex/gpt-5.6-luna", 7.75], // 2026-09-23 measured-seat re-base
  ["claude-haiku-4-5", 8.83], // 2026-09-23 measured-seat re-base
  ["deepseek/deepseek-v4-flash-0731", 9.32], // 0.132 — re-checked 2026-09-26 live (StreamLake still cheapest, −17%)
  ["xai/grok-4.5", 9.44], // 2026-09-23 measured-seat re-base
  ["claude-sonnet-5", 11.13], // 2026-09-23 measured-seat re-base
  ["z-ai/glm-5.3-flash", 11.44], // 0.25 (DeepInfra, +79%) — re-checked 2026-10-01 live endpoints
  ["deepseek/deepseek-v4.1-flash", 12.99], // 0.40 (Sail Research, +3%) — re-checked 2026-10-01 live endpoints
  ["z-ai/glm-5.2", 13.34], // 0.444 (Baidu, −19%) — re-checked 2026-10-02 live endpoints
  ["z-ai/glm-5.3", 13.66], // 0.4884 (Baidu, −57%) — re-checked 2026-10-01 live endpoints
  ["tencent/hy3", 13.91], // 0.528 — re-checked 2026-09-19 live (Tencent took cheapest back; DeepInfra $0.435 gone)
  ["claude-opus-4-8", 14.16], // 2026-09-23 measured-seat re-base
  ["deepseek/deepseek-v4-flash-vision-exp", 14.59], // 0.66 — re-checked 2026-09-02 live (−50%; Fireworks cheapest) · 2026-09-23: now read from the shared table (the eeg copy had drifted)
  ["codex/gpt-5.6-terra", 15.38], // 2026-09-23 measured-seat re-base
  ["xiaomi/mimo-v2.6-pro", 15.4], // 0.8265 (GMICloud, −5%) — re-checked 2026-10-01 live endpoints
  ["deepseek/deepseek-v4-pro", 15.44], // 0.8376 — re-checked 2026-09-26 live (StreamLake took cheapest from Baidu $1.6292, −49% out)
  ["minimax/minimax-m3", 15.89], // 0.96 (CoreWeave, −20% vs the OR list the table carried) — re-checked 2026-10-01 live endpoints
  ["claude-fable-5", 16.46], // 2026-09-23 measured-seat re-base
  ["qwen/qwen3.8-27b", 17.35], // 1.49 (Cerebras, −16%) — re-checked 2026-10-02 live endpoints
  ["moonshotai/kimi-k2.6", 18.03], // 1.828 — re-checked 2026-09-26 live (Baidu still cheapest, −4%)
  ["deepseek/deepseek-v4-pro-0813", 18.29], // 1.98 (StreamLake and DeepSeek; Baidu seat gone, Ionstream $1.48 is status -2 down) — re-checked 2026-10-03 live endpoints
  ["openai-codex/gpt-5.5", 18.41], // 2026-09-23 measured-seat re-base
  ["moonshotai/kimi-k2.7-code", 19.67], // 3.0 (StreamLake, was the $3.50 list) — re-checked 2026-10-01 live endpoints
  ["z-ai/glm-5.1", 19.71], // 3.036 — re-checked 2026-09-10 live (StreamLake still cheapest)
  ["google/gemini-3.8-flash", 20.41], // $3.75 promo, same as 3.7
  ["google/gemini-3.7-flash", 20.41],
  ["meta/muse-spark-1.2", 20.82],
  ["qwen/qwen3.7-max", 20.96],
  ["qwen/qwen3.8-2.4t-a95b", 21.96],
  ["qwen/qwen3.8-max", 21.96],
  ["google/gemini-3.5-flash", 23.31],
  ["moonshotai/kimi-k3", 24.05], // 11.25 (Phala, +0.4%; Relace gone) — re-checked 2026-10-03 live endpoints
] as const;

/**
 * Stroke width for the surfaces that draw into a FIXED box (model selector chip, EEG
 * paper). Same relCost table as the linear scale — only the mapping differs.
 */
export function eegCostWidthLogPx(model: string, level: string, provider?: string): number {
  const rel = eegRelCost(model, provider);
  void level; // effort is the X column, never the width — same rule as the linear scale
  if (!(rel > 0)) {
    return EEG_COST_LOG_PX_FLOOR;
  }
  const w =
    EEG_COST_LOG_BASE_PX + EEG_COST_LOG_PX_PER_DECADE * Math.log10(rel / EEG_COST_LOG_REF_REL);
  return Math.max(EEG_COST_LOG_PX_FLOOR, w);
}

/** Human comparison multiple vs Luna (Sol≈5×, Terra≈2.5×, Luna=1×). */
export function eegCostLunaMult(model: string, provider?: string): number {
  return eegRelCost(model, provider) / EEG_COST_COMPARE_REL;
}

// ─── THE central paint resolution (the architect 2026-08-06) ───
// FORK 2026-08-06 (the architect: "There should be a central point where the color and
// thickness of the EEG lines are defined, and the rest of the pieces of code
// that need them should go there to look. Also, the information about which
// model at which effort is running should be a json object passed around.").
//
// Before this, four surfaces each assembled their own (provider, model) argument
// pair for eegProviderPaint + eegCostWidthPx — and three separate bugs came out
// of that assembly drift (2026-08-04 unreachable vendor branch, 2026-08-05
// selector/panel divergence, 2026-08-06 Qwen-3.8 gray-trace report). The fix is
// structural: ONE run descriptor object, ONE resolution entry point. Every
// surface that paints an EEG line — paper trunk, paper branches, MODELS cost
// column, model-selector chips — calls resolveEegPaint and nothing else.
// eegProviderPaint / eegCostWidthPx remain exported for the existing test suite
// but are INTERNALS of this function; production call sites must not call them
// directly (grep `eegProviderPaint(` outside this file = a regression).

/** The JSON object describing "which model at which effort is running". This is
 *  the single thing passed around; EegSample maps onto it at the boundary. */
export interface EegRun {
  /** Model id — bare ("qwen/qwen3.8-max"), full ref, or alias. */
  model: string;
  /** Provider id ("openrouter", "claude-code", …); optional, the model id
   *  carries vendor tokens when the provider is generic. */
  provider?: string;
  /** Thinking/effort level (EEG_STOPS lvl, "" = Auto). Effort is the X column,
   *  not the width — but it travels with the run so callers never re-derive it. */
  effort?: string;
}

export interface EegPaint {
  stroke: string; // hex, or "url(#eeg-google)" when isRainbow
  isRainbow: boolean;
  /** LINEAR px — the drawn ratio IS the cost ratio. Only the MODELS panel, whose row
   *  height grows to the stroke, has room to draw this honestly. */
  width: number;
  /** LOG px — for surfaces drawing into a fixed box (model selector chip, EEG paper),
   *  where linear both clips at the top and floors at the bottom. See the FORK
   *  2026-08-28 block above eegCostWidthLogPx. */
  logWidth: number;
}

/** THE central point: run descriptor → EEG color + thickness (both scales). */
export function resolveEegPaint(run: EegRun): EegPaint {
  const paint = eegProviderPaint(run.provider ?? "", run.model);
  const width = eegCostWidthPx(run.model, run.effort ?? "", run.provider);
  const logWidth = eegCostWidthLogPx(run.model, run.effort ?? "", run.provider);
  return { stroke: paint.stroke, isRainbow: paint.isRainbow, width, logWidth };
}

// FORK 2026-08-06 #2 (the architect: "We have multiple places where it shows thinking
// progress, chat, tab title, model panel, recipes panel... The color of the
// glows should be representative of the model running. Use the same strategy
// you have used with the EEG trace color and unify all these thinking
// indicators"). Every thinking/live glow — chat indicator, tab glow, model-row
// glow, session-row glow, RECIPES panel node — resolves its color HERE, so a
// model glows with exactly the color its EEG trace draws. The rainbow trace has
// no single CSS color, so google gets a solid brand-blue fallback.
export const EEG_GOOGLE_GLOW = "#4285F4";

/** CSS-usable glow color for a run: the EEG trace color, rainbow → solid blue. */
export function resolveEegGlowColor(run: EegRun): string {
  const paint = resolveEegPaint(run);
  return paint.isRainbow ? EEG_GOOGLE_GLOW : paint.stroke;
}

// FORK 2026-06-14 (fluid-model-effort Drop 1, bible §5.84 amends §5.8h:501):
// concurrent same-(model,effort) subagents render as a DEPTH-SHADED STACK — up to
// 5 strands tightly overlapping at the column, the BOTTOM (drawn first, behind)
// darkest and each higher strand lighter, conveying count by depth; >5 adds an ×N
// badge. Replaces the old wide lateral fan. `step` is small so the band reads as a
// stack, not separate lanes.
export const EEG_STRAND_DEPTH_STEP = 1.4;
// FORK 2026-06-25 (the architect): lateral gap between distinct (model,effort) LANES that
// share one effort column. Different models at the same effort stand side by side,
// each keeping its own brand color; whitening only stacks WITHIN one model's lane.
export const EEG_LANE_GAP = 6;

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

// idx 0 = bottom/back of the pile (WHITEST), idx n-1 = top/front (full brand
// color). When runs overlap they pile up; the buried tracks whiten toward
// white so each track's edge stays identifiable under the stack, while the
// front (latest, drawn on top) keeps the pure provider color (the architect
// 2026-07-20, bible §5.8h — INVERTED from the original front-lightest ramp).
// The rainbow gradient can't be tinted, so it fades by opacity instead
// (bottom faintest).
export function eegStrandShade(
  paint: { stroke: string; isRainbow: boolean },
  idx: number,
  n: number,
): { stroke: string; opacity: number } {
  // buried: 1 at the bottom of a real pile, 0 at the front — and 0 for a solo
  // strand (n<=1), which must keep the pure brand color (no whitening of lone
  // tracks; the June-25 real-overlap rule).
  const buried = n <= 1 ? 0 : 1 - idx / (n - 1);
  if (paint.isRainbow) return { stroke: paint.stroke, opacity: 1 - 0.5 * buried };
  return { stroke: eegLightenHex(paint.stroke, 0.55 * buried), opacity: 1 };
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

// FORK 2026-06-26 (the architect): thinkingChars→effort-bucket was REMOVED. The EEG column
// is now the allocator's REQUESTED level (eegEffectiveLevel below), never a bucket
// derived from observed reasoning length — char-bucketing produced the bogus weave.
// thinkingChars stays on EegSample (for future tooltip/measured-reality use) but no
// longer drives any column position.

// FORK 2026-06-26 (the architect): the EEG is the oscilloscope for AUEFALAL (the automatic
// effort allocator) — so the effort COLUMN is the level the allocator REQUESTED for
// this call (s.chosenLevel), graphed DIRECTLY. It is NEVER re-derived from
// thinkingChars: that char-bucketing was the bogus minimal↔medium "weave" (it
// measured how much the model reasoned — output — instead of what was asked — input).
// The bridge now self-reports the worker's actually-pinned level (stream.ts emitEffort),
// so chosenLevel carries the real allocated level (e.g. "medium"). A genuinely
// level-less call ("off"/""/"auto" — e.g. an explicit /think off) floors to "minimal",
// the lowest REAL stop — honest (off = no thinking budget) and never the rejected Auto
// gutter. thinkingChars now feeds only the hover tooltip, not the column position.
function eegEffectiveLevel(s: EegSample): string {
  const lv = s.chosenLevel;
  if (!lv || lv === "off" || lv === "auto") {
    return "minimal";
  }
  return lv;
}

// ─── Render constants ───
// PERMANENT retention (the architect 2026-06-13): keep the WHOLE session so all activity
// is visible by scrolling — no drop-oldest. The high guard only backstops a
// pathological runaway; a normal session never reaches it.
const EEG_MAX_SAMPLES = 100000;
const ROW_H = 24; // px per EMPTY-paper placeholder row (real rows are token-sized)
// FORK 2026-06-22 (the architect): the per-prompt boundary rule color. YELLOW (was blue #4DA3FF,
// originally faint gray #C9CDD4) — single source so the populated AND empty-paper render
// paths can never disagree.
export const EEG_TURN_COLOR = "#FFD23F";
const TOP_PAD = 26; // room for the stop labels above the paper
const BOTTOM_PAD = 14;
const ARC_HALF = 7; // bezier vertical half-span → ~14px of curve per column hop
// FORK 2026-06-19: half-gap each side of a prompt rule so the trunk visibly FINISHES
// then RESTARTS across the boundary, the two ends nearly touching (the architect).
const EEG_TURN_GAP = 5;
// FORK 2026-06-20: half-gap each side of EVERY LLM call so consecutive calls read as
// DISTINCT segments, never one continuous spline (the architect: "I don't see a clear
// separation between calls"). Smaller than EEG_TURN_GAP so the per-prompt break stays
// the stronger, dominant separation (call = small gap, prompt = big gap).
const EEG_CALL_GAP = 2;
const STRAND_CAP = 10; // bible §5.8h invariant 4: cap rendered strands per group; the dynamic ×N carries the true count (the architect 2026-06-19: 10, was 5)

// ─── Segment LENGTH model: LENGTH = EURO COST → each €1 = one grid line ───
// FORK 2026-06-20 (the architect): "make the horizontal lines mean one euro — the thinking
// should scale to the grid so we understand how much we spend on every prompt."
// LENGTH now directly encodes the segment's EURO cost: a prompt's trace HEIGHT,
// measured against the §1 horizontal grid (EEG_PX_PER_EURO px = €1, drawn in
// renderSvg), reads as how many euros that prompt cost. width still = the model's
// cost-PER-token identity (thick = an expensive model), so a thin-but-tall line =
// a cheap model that ran a LOT and still cost real money — exactly the signal the architect
// wants. euros = relCost(€/Mtok-output) × weightedMtok, where the weighted token
// blend counts output ~5× input (the typical price ratio): weighted = output + 0.2·input.
// MIN floor keeps tiny (sub-€0.2) turns clickable + fits the column-hop bezier
// (≥ 2·ARC_HALF) — so the floor slightly over-draws the cheapest turns; the grid
// reading is exact for anything above it. MAX backstops a pathological single turn.
// The whole axis (and the grid pitch) rescales together with the wheel zoom.
export const EEG_PX_PER_EURO = 90; // FALLBACK pitch only — see eegPxPerEuro (adaptive, 2026-10-01)
const EEG_INPUT_COST_RATIO = 0.2; // input price ÷ output price (typical 5:1)
const EEG_MIN_LEN = 16; // ≥ 2·ARC_HALF so the column-hop bezier always fits

// FORK 2026-10-01 (finding 12) — THE INPUT TERM IS CURRENTLY ALWAYS ZERO, by omission upstream.
// `inputTokens` has no producer: it was summed from the per-round lifecycle pair, which never
// fired, and the 2026-09-24 telemetry swap deleted that consumer rather than re-feeding it. So
// every euro figure on this paper is output-only and therefore an UNDER-estimate.
//
// The data does exist elsewhere in this UI: panels/call-timeline.ts carries a per-call `input`,
// `cacheRead` and `cacheWrite` (its CallFrame, "billed prompt of THIS call"). That is the future
// source, and wiring it is a PRICING DECISION, not a plumbing one — a call's prompt is mostly
// cache reads, which this blend would charge at the full input rate. Deliberately left alone:
// inventing a number here would be the same class of error as the floor that was just removed.
function eegWeightedTokens(s: EegSample): number {
  return (s.outputTokens ?? 0) + EEG_INPUT_COST_RATIO * (s.inputTokens ?? 0);
}
// FORK 2026-06-20 (the architect): estimated euro cost of one sample. relCost is €/Mtok-output
// (subscription-amortized for Anthropic, metered for API providers — see EEG_COST_TABLE).
export function eegSampleEuros(s: EegSample): number {
  return (eegRelCost(s.model, s.provider) * eegWeightedTokens(s)) / 1_000_000;
}
// ─── THE SCALE ADAPTS TO THE TAB (FORK 2026-10-01, the architect) ───
//
// `eegClampEuros` lived here and was fed to the SPEND CLOCK, flooring every sample at
// EEG_MIN_LEN / EEG_PX_PER_EURO = €0.1778 before the ledger summed it. The review measured the
// consequence at 1874x: 200 tool calls (cost €0) plus 40 sonnet turns drew 43 "€N" gridlines over
// 2.3 cents of real spend, because the axis was a sample count wearing a euro label. That is
// exactly the architect's report — "parts of the graph that are empty, and yet the grid shows it has cost".
//
// So the floor is gone from the ledger and survives only as a DRAWN-LENGTH minimum at the render
// site. The reason the floor existed at all was that 90px/€ was calibrated when the cost constants
// were ~43x high: at honest subscription-amortised rates one turn is worth ~€0.005 and the whole
// paper collapsed to a flat mat, which is what made a floor feel necessary. Fix the pitch instead.
//
// THE PITCH IS DERIVED FROM THE TAB'S OWN SPEND: a typical (median) turn draws about
// EEG_TARGET_TURN_PX. A tab of cheap prepaid turns and a tab of expensive metered ones are both
// legible, each on its own scale, which is the whole point of a PER-TAB instrument. The cost is
// that heights are no longer comparable ACROSS papers — but they never meaningfully were, and
// "length = euro cost" was always a within-one-paper property.
//
// The median, not the mean: one pathological turn must not flatten the other ninety-nine.
export const EEG_TARGET_TURN_PX = 60;
// A backstop, not a design target. Without it a tab holding one near-free sample and one real one
// would set the pitch from a near-zero median and ask the browser for an SVG billions of px tall.
// It is set well above any honest paper so it only ever bites on a spend spread over several orders
// of magnitude — and when it does bite, the expensive turn rightly keeps most of the paper.
export const EEG_MAX_PAPER_PX = 200_000;
// Gridlines aim for this spacing before snapping to the 1-2-5 series; see eegGridStepEuros.
export const EEG_GRID_TARGET_PX = 65;

/** Unzoomed px per €1 for this paper, derived from the tab's own sample costs. */
export function eegPxPerEuro(sampleEuros: number[]): number {
  const positive = sampleEuros.filter((e) => Number.isFinite(e) && e > 0).sort((a, b) => a - b);
  if (positive.length === 0) return EEG_PX_PER_EURO;
  const median = positive[(positive.length - 1) >> 1];
  if (!(median > 0)) return EEG_PX_PER_EURO;
  const total = positive.reduce((a, b) => a + b, 0);
  let px = EEG_TARGET_TURN_PX / median;
  if (total > 0) px = Math.min(px, EEG_MAX_PAPER_PX / total);
  return Number.isFinite(px) && px > 0 ? px : EEG_PX_PER_EURO;
}

/**
 * The euro step between gridlines: a 1-2-5-per-decade value whose pixel spacing lands nearest
 * EEG_GRID_TARGET_PX. Snapping to the NEAREST rather than rounding up keeps spacing inside roughly
 * 40-100px (the worst ratio between neighbouring 1-2-5 steps is 2.5, so the error is at most its
 * square root either way), and it is what keeps every label a round euro amount a human reads at a
 * glance instead of an arbitrary fraction of the paper.
 */
export function eegGridStepEuros(pxPerEuro: number, total = Infinity): number {
  if (!Number.isFinite(pxPerEuro) || pxPerEuro <= 0) return 1;
  const target = EEG_GRID_TARGET_PX / pxPerEuro;
  if (!Number.isFinite(target) || target <= 0) return 1;
  const decade = Math.pow(10, Math.floor(Math.log10(target)));
  let best = decade;
  let bestErr = Infinity;
  for (const m of [1, 2, 5, 10]) {
    const step = m * decade;
    const err = Math.abs(Math.log(step) - Math.log(target));
    if (err < bestErr) {
      bestErr = err;
      best = step;
    }
  }
  // A paper holding one or two calls would otherwise get a step larger than the whole ledger and
  // so no rule at all — the spend is real and deserves at least one reference line. Walk DOWN the
  // same 1-2-5 ladder until the step fits, which keeps the labels round even when the spacing is
  // tighter than the target.
  if (Number.isFinite(total) && total > 0) {
    while (best > total) {
      const d = Math.pow(10, Math.floor(Math.log10(best) + 1e-9));
      const m = best / d;
      best = m > 5.5 ? 5 * d : m > 2.5 ? 2 * d : m > 1.5 ? 1 * d : 5 * (d / 10);
      if (!Number.isFinite(best) || best <= 0) return 1;
    }
  }
  return best;
}

/** A gridline's label: a REAL euro amount of this tab, at the precision its step deserves. */
export function eegEuroLabel(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))));
  return `€${value.toFixed(decimals)}`;
}

// ─── LANES: lateral offset must encode REAL simultaneity ───
// FORK 2026-07-28 (the architect "lines dancing laterally within Min"): the original lane
// allocator handed every distinct (T/S,model,effort) group its OWN permanent lane,
// numbered per RAW `chosenLevel`. Two defects, exactly inverted from the intent:
//   1. SEQUENTIAL groups still got different lanes → strands that never once ran at
//      the same time drew 6/12/18px apart, so the trace wobbled laterally inside one
//      effort column with a true concurrency of 1. That is the "dance".
//   2. Lane numbering keyed the RAW level while placement keys the EFFECTIVE one
//      (eegEffectiveLevel folds ""/"off"/"auto" → minimal, and EVERY tool call is
//      recorded chosenLevel:"" → the Min column is where all tool branches land).
//      So genuinely CONCURRENT strands from different raw buckets each got lane 0 and
//      COLLIDED in Min — the exact opposite of "side by side".
// Fix: greedy interval-colour the groups PER EFFECTIVE COLUMN. A lane is reusable the
// moment its previous occupant finished, so a lane index > 0 now *means* "something
// else was genuinely running beside me here". Solo/sequential activity is lane 0 and
// therefore dead straight (bible §5.8h invariant 4).
export type EegInterval = [number, number]; // [start, end); end may be Infinity (live)

/** Sort + merge overlapping/touching intervals into a minimal ascending list. */
export function eegMergeIntervals(list: EegInterval[]): EegInterval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: EegInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Do two merged (ascending, non-overlapping) interval lists intersect? Two-pointer. */
function eegIntervalsOverlap(a: EegInterval[], b: EegInterval[]): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][0] < b[j][1] && b[j][0] < a[i][1]) return true;
    if (a[i][1] <= b[j][1]) i++;
    else j++;
  }
  return false;
}

/**
 * Assign each strand group a lane index within its effort column. Groups whose busy
 * intervals do not overlap SHARE a lane (lane 0 whenever nothing else is concurrent);
 * groups that truly overlap get distinct, side-by-side lanes. `level` MUST already be
 * the EFFECTIVE column (eegEffectiveLevel), not the raw chosenLevel.
 */
export function eegAssignLanes(
  groups: { key: string; level: string; intervals: EegInterval[] }[],
): Map<string, number> {
  const byLevel = new Map<string, typeof groups>();
  for (const g of groups) {
    const arr = byLevel.get(g.level);
    if (arr) arr.push(g);
    else byLevel.set(g.level, [g]);
  }
  const out = new Map<string, number>();
  for (const gs of byLevel.values()) {
    // earliest-start first (ties → key) so the group that started first keeps lane 0
    // and lane indices stay stable across re-renders.
    const ordered = [...gs].sort(
      (x, y) => (x.intervals[0]?.[0] ?? 0) - (y.intervals[0]?.[0] ?? 0) || (x.key < y.key ? -1 : 1),
    );
    const laneBusy: EegInterval[][] = [];
    for (const g of ordered) {
      const busy = eegMergeIntervals(g.intervals);
      let lane = 0;
      while (lane < laneBusy.length && eegIntervalsOverlap(laneBusy[lane], busy)) lane++;
      if (lane === laneBusy.length) laneBusy.push([]);
      laneBusy[lane] = eegMergeIntervals([...laneBusy[lane], ...busy]);
      out.set(g.key, lane);
    }
  }
  return out;
}

/** Group key for strand bucketing: a tool strand never merges with a same-model subagent. */
function eegStrandGroupKey(s: EegSample): string {
  return `${s.tool ? "T" : "S"}|${s.model}|${s.chosenLevel}`;
}

/**
 * Which strands STRAND_CAP drops — FINDING 2 (review 2026-10-01).
 *
 * The cap exists "so a big fan-out doesn't overwhelm the paper" (the architect 2026-06-19), and a fan-out
 * is a CONCURRENT burst. It was being applied to a lifetime-wide bucket instead — every sample ever
 * recorded for one (tool/sub, model, effort) — sorted oldest-first and truncated at index 10. Two
 * defects followed. Forty strictly sequential tool calls, with a true concurrency of one, lost
 * thirty of themselves. And because the paper puts the newest at the TOP, the ten survivors were
 * the OLDEST: the region the architect looks at for what just happened was the emptiest part of the paper.
 *
 * So the rule is per-peer, not per-index: a strand is dropped only when STRAND_CAP or more of its
 * genuinely OVERLAPPING peers started after it. Sequential work is never touched, and what survives
 * a real burst is its newest end. The caller must also keep the dropped strands out of the spend
 * clock — undrawn work that still buys axis advance is exactly the empty-paper-with-cost symptom.
 */
export function eegCappedOut(subs: EegSample[], cap: number = STRAND_CAP): Set<string> {
  const out = new Set<string>();
  const byKey = new Map<string, EegSample[]>();
  for (const s of subs) {
    const k = eegStrandGroupKey(s);
    const arr = byKey.get(k);
    if (arr) arr.push(s);
    else byKey.set(k, [s]);
  }
  const endOf = (x: EegSample): number => (typeof x.endedAt === "number" ? x.endedAt : Infinity);
  for (const group of byKey.values()) {
    if (group.length <= cap) continue; // cannot have `cap` concurrent peers
    const items = [...group].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < items.length; i++) {
      const s = items[i];
      const sEnd = endOf(s);
      let newer = 0;
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        const o = items[j];
        if (!(o.startedAt < sEnd && s.startedAt < endOf(o))) continue; // no real overlap
        // the mirror of the renderer's depthIdx tie-break, so the two agree exactly
        if (o.startedAt > s.startedAt || (o.startedAt === s.startedAt && j > i)) newer++;
        if (newer >= cap) break;
      }
      if (newer >= cap) out.add(s.runId);
    }
  }
  return out;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fx = (v: number): string => (Math.round(v * 100) / 100).toString();

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

  // FORK 2026-06-19: close any still-running BRANCH whose run is no longer live (gone from
  // activeRuns, or silent past the caller's bound) — clears the "thinking forever" ghosts (dead
  // 30× fan-outs that never got an end event). Returns the closed runIds so the caller can also
  // drop their activeRuns entry. Main-session samples are NEVER swept (a main turn may
  // legitimately think long).
  //
  // FORK 2026-10-01 (finding 8): TOOL strands are swept too, not just subagents. A tool's end
  // stamp is written only while its own tab is being viewed, so switching tabs between a tool's
  // start and its result leaves it open forever; `s.subagent` is false for a tool, so this sweep
  // skipped exactly the one class that could not stamp itself.
  closeStaleRunning(isLive: (runId: string) => boolean, now: number): string[] {
    const closed: string[] = [];
    for (const [runId, s] of this.samples) {
      if ((s.subagent || s.tool) && s.endedAt === undefined && !isLive(runId)) {
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

  // ONE TAB, ONE PAPER (the architect 2026-10-01: "the toggle switch needs to go, and the EEG has to stay
  // specific for each tab"). There is no `overlay` option and no `dim` sample any more: the paper
  // draws THIS store — the viewed session plus its own subagents and its own tool calls — and
  // nothing else. The all-scope overlay made the same euro glyphs mean one tab's spend or the union
  // across tabs depending on a switch, and moved every strand when flipped; the axis could not be
  // read without knowing the toggle's history.
  renderSvg(opts: { width: number; zoom?: number }): string {
    // chronological, oldest first — row 0 of the chrono index sits at the BOTTOM.
    const everySample = [...this.samples.values()].sort((a, b) => a.startedAt - b.startedAt);
    // FINDING 2: decide the strand cap BEFORE the clock, so a capped strand buys no axis advance.
    // `allSubs` keeps the full population for the ×N gauge and the "N× parallel here" tip, which
    // must report the TRUE fan-out — reporting the true count while drawing a bounded stack is the
    // whole point of the cap.
    const allSubs = everySample.filter((s) => s.subagent || s.tool);
    const cappedOut = eegCappedOut(allSubs);
    const all = cappedOut.size ? everySample.filter((s) => !cappedOut.has(s.runId)) : everySample;

    const width = Math.max(120, opts.width || 320);
    // vertical SCALE (the architect 2026-06-13): the secondary-button wheel zooms the
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
    // FORK 2026-08-08 — POSITION COMES FROM THE SPEND CLOCK (spec:
    // docs/superpowers/specs/2026-08-08-eeg-all-scope-spend-clock-design.md).
    //
    // This block used to STACK rows: every sample got its own slot, `accTop += lengths[c]`. That is
    // correct for one session but does not compose — with several tabs, each session advanced its
    // OWN cumulative-euro axis, so equal heights meant "each spent the same since its own start",
    // never "these happened together". Concurrency simply had no representation on this axis.
    //
    // Now y = S(t), the total euros spent by every in-scope session up to real time t. A call
    // occupies [S(start), S(end)]. Alone, S advances only by its own euros, so its height still IS
    // its cost and it has nobody else on it; overlapping, it spans a taller interval because real
    // money was being spent alongside. Idle advances nothing, so the paper still stops and resumes.
    // With one session and no concurrency this is arithmetically identical to the old stacking —
    // pinned by eeg-spend-clock.test.ts "reproduces plain cumulative stacking".
    // THE LEDGER IS EXACT (FORK 2026-10-01, the architect). The clock is fed eegSampleEuros, never a floor:
    // the grid therefore reads real euros of this tab. The legibility floor survives below, on the
    // DRAWN length only. That does desynchronise length from position for a sub-floor strand — two
    // near-free calls sit ~1px apart on the exact ledger yet each draw 16px, so they overlap — and
    // that is the trade taken deliberately: an overlapping hairline is a cosmetic cost, a 1874x
    // wrong money axis is not. The adaptive pitch below makes it rare, because a typical turn is
    // now ~60px rather than under the floor.
    const nowMs = Date.now();
    const sampleEuros = all.map((s) => eegSampleEuros(s));
    const clock = buildEegSpendClock(
      all.map((s, i) => ({
        key: s.runId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        euros: sampleEuros[i],
      })),
      nowMs,
    );
    // Per-tab pitch (eegPxPerEuro), times the wheel zoom exactly as before.
    const pxPerEuro = eegPxPerEuro(sampleEuros) * zoom;
    // Newest at TOP: the clock grows with time, so screen y counts DOWN from the total.
    const rowTopArr: number[] = new Array(n);
    const lengths: number[] = new Array(n);
    for (let c = 0; c < n; c++) {
      const span = clock.spans.get(all[c].runId);
      const yStart = span?.yStart ?? 0;
      const yEnd = span?.yEnd ?? yStart;
      rowTopArr[c] = TOP_PAD + (clock.total - yEnd) * pxPerEuro;
      // The legibility floor lives HERE and only here: keep a near-free call clickable and tall
      // enough for the column-hop bezier, without it ever reaching the ledger. There is no maximum:
      // capping a strand below its own span would leave euros of axis advance with no ink on them,
      // which is the emptiness the architect reported.
      lengths[c] = Math.max(2 * arc, EEG_MIN_LEN * Math.min(1, zoom), (yEnd - yStart) * pxPerEuro);
    }
    // The paper is as tall as the ledger, but never shorter than a floored strand sticking out.
    let contentLen = clock.total * pxPerEuro;
    for (let c = 0; c < n; c++) {
      contentLen = Math.max(contentLen, rowTopArr[c] - TOP_PAD + lengths[c]);
    }
    const height = TOP_PAD + (n > 0 ? contentLen : EMPTY_ROWS * ROW_H) + BOTTOM_PAD;

    const rowTop = (c: number): number => rowTopArr[c];
    const rowBot = (c: number): number => rowTopArr[c] + lengths[c];
    const rowOf = new Map<string, number>();
    all.forEach((s, c) => rowOf.set(s.runId, c));
    // time → y, now EXACT rather than snapped to the last row that started at/before t. This is
    // what lets prompt rules from different tabs interlace at their true positions instead of
    // collapsing onto a neighbouring row's edge.
    const timeToY = (t: number): number => TOP_PAD + (clock.total - clock.yOf(t)) * pxPerEuro;
    const colX = (lvl: string): number => eegStopX(lvl, width);
    // FORK 2026-06-19: which TURN a timestamp falls in (count of completed turns at/before
    // it). Used to break the trunk AND clamp branch joins on a turn-NUMBER change, robustly.
    const turnOf = (t: number): number => this.turnEnds.filter((e) => e.endedAt <= t).length;

    // FORK 2026-06-25 (scope C): tool samples are NEVER trunk segments — they branch
    // off it (added to `subs` below), so the trunk stays the LLM-call spine.
    const mains = all.filter((s) => !s.subagent && !s.tool);
    // parent main-line column at instant t (for branch split/join anchors)
    const mainColAt = (t: number): number => {
      let best: EegSample | undefined;
      for (const m of mains) {
        if (m.startedAt <= t) best = m;
        else break;
      }
      if (!best && mains.length > 0) best = mains[0];
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

    // ── horizontal €-grid: one rule per grid STEP of spend (the architect 2026-06-20, rescaled 2026-10-01).
    // Anchored at the bottom (oldest = session start) and counting UP, so a prompt's trace HEIGHT
    // reads as its euro cost and the gutter labels read as cumulative spend FOR THIS TAB. The step
    // is no longer hardcoded at €1: it comes from the tab's own pitch via the 1-2-5 series, so the
    // lines stay ~40-100px apart whether the tab spent cents or tens of euros, and every label is a
    // real euro amount this tab actually reached. A tab that spent nothing measurable gets no line
    // at all, which is the honest reading — the old fixed grid printed €1, €2, €3 over it.
    const euroStep = eegGridStepEuros(pxPerEuro, clock.total);
    const euroPitch = euroStep * pxPerEuro;
    const gridBottom = height - BOTTOM_PAD;
    let euroGrid = "";
    if (euroPitch >= 4 && clock.total > 0) {
      let e = 1;
      for (
        let gy = gridBottom - euroPitch;
        gy >= TOP_PAD && e * euroStep <= clock.total;
        gy -= euroPitch, e++
      ) {
        euroGrid +=
          `<line class="eeg-eurogrid" x1="0" y1="${fx(gy)}" x2="${width}" y2="${fx(gy)}"` +
          ` stroke="#8A8F98" stroke-opacity="0.16" stroke-width="1"/>`;
        euroGrid +=
          `<text class="eeg-eurolabel" x="${fx(width - 3)}" y="${fx(gy - 2)}" text-anchor="end"` +
          ` font-size="8" fill="#8A8F98">${eegEuroLabel(e * euroStep, euroStep)}</text>`;
      }
    }

    // ── empty paper: axis only + a hint, no trace strokes ──
    if (n === 0) {
      const hint =
        `<text class="eeg-empty-hint" x="${fx(width / 2)}"` +
        ` y="${fx(TOP_PAD + (EMPTY_ROWS * ROW_H) / 2)}" text-anchor="middle"` +
        ` font-size="9" fill="#8A8F98">waiting for model activity…</text>`;
      // FORK 2026-06-22 (the architect): even with NO samples yet, draw the prompt-boundary
      // rule(s) so a turn sent into a fresh session is delimited the instant it is sent
      // (was the no-line bug: the old early-return skipped ALL markers when n===0).
      // timeToY is NaN-unsafe here (empty arrays), so stack them at fixed y instead.
      let emptyMarkers = "";
      this.turnEnds.forEach((t, i) => {
        const y = TOP_PAD + 12 + i * 9;
        const idxAttr =
          typeof t.promptIndex === "number" ? ` data-eeg-prompt-index="${t.promptIndex}"` : "";
        const txtAttr = t.promptText ? ` data-eeg-prompt-text="${esc(t.promptText)}"` : "";
        const attrs =
          `class="eeg-marker" data-eeg-turn="${esc(String(t.turn))}" data-eeg-run="${esc(t.runId)}"${idxAttr}${txtAttr}` +
          ` style="cursor:pointer"`;
        const pTip = t.promptText ? `<title>${esc(t.promptText)}</title>` : "";
        emptyMarkers +=
          `<line ${attrs} x1="0" y1="${fx(y)}" x2="${width}" y2="${fx(y)}"` +
          ` stroke="${EEG_TURN_COLOR}" stroke-opacity="0.9" stroke-width="2"/>`;
        emptyMarkers += `<rect ${attrs} x="0" y="${fx(y - 6)}" width="${width}" height="12" fill="transparent">${pTip}</rect>`;
      });
      return (
        `<svg class="eeg-svg" width="${width}" height="${height}"` +
        ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
        `${defs}${grid}${euroGrid}${emptyMarkers}${hint}</svg>`
      );
    }

    // ── main-session trace: one continuous line, per-sample stroke style ──
    // Each sample's <path> = the incoming connector from the previous (older,
    // lower) main sample + its own vertical run; column hops are cubic beziers
    // spanning ~14px (ARC_HALF each side of the row boundary).
    // One session, so one continuous line: the per-session grouping the all-scope overlay needed
    // went with it (the architect 2026-10-01).
    let trace = "";
    {
      const group = mains;
      for (let m = 0; m < group.length; m++) {
        const s = group[m];
        const c = rowOf.get(s.runId)!;
        const x = colX(eegEffectiveLevel(s));
        const yT = rowTop(c);
        const yB = rowBot(c);
        // FORK 2026-08-06: central resolution — one run object in, one paint out.
        const paint = resolveEegPaint({
          model: s.model,
          provider: s.provider,
          effort: s.chosenLevel,
        });
        // LOG width (FORK 2026-08-28): the paper shares its width with effort columns,
        // lanes and strand stacks, so the linear spread clipped at the top and floored
        // at the bottom. The MODELS panel keeps the linear scale.
        const w = paint.logWidth;
        let d: string;
        const prev = m > 0 ? group[m - 1] : undefined;
        const next = m + 1 < group.length ? group[m + 1] : undefined;
        // FORK 2026-06-19: BREAK the trunk at each prompt boundary so the line
        // visibly FINISHES at a turn end and RESTARTS in the next turn, the two ends
        // nearly touching across the prompt rule (the architect). startsTurn = a boundary
        // sits just before this sample (begins a new turn) → start EEG_TURN_GAP above
        // its bottom; endsTurn = one sits just after (this sample ends a turn) → stop
        // EEG_TURN_GAP below the marker instead of leaving a connector arc. Only the
        // VIEWED trunk breaks (this.turnEnds is the viewed session's).
        // FORK 2026-06-20: EVERY CALL is its own segment — no connector spline between
        // calls (the architect: "the line is a continuous spline, I don't see a clear separation
        // between calls"). Each main sample draws a fresh VERTICAL run at its effort
        // column, inset by a small CALL gap at each end so consecutive calls visibly
        // finish + restart. A PROMPT boundary (turn change) uses the bigger TURN gap so
        // the per-prompt break stays the dominant separation (hierarchy: call < prompt).
        // This also means breaks no longer depend on turnEnds being recorded: even with
        // no turn boundaries the calls still separate, killing the continuous-spline look.
        const startsTurn =
          !!prev &&
          (turnOf(prev.startedAt) !== turnOf(s.startedAt) ||
            this.turnEnds.some((t) => t.endedAt > prev.startedAt && t.endedAt <= s.startedAt));
        const endsTurn =
          !!next &&
          (turnOf(s.startedAt) !== turnOf(next.startedAt) ||
            this.turnEnds.some((t) => t.endedAt > s.startedAt && t.endedAt <= next.startedAt));
        // gap below (toward the older neighbor) / above (toward the newer): TURN gap at a
        // prompt boundary, CALL gap between ordinary calls, none at the trace's open ends.
        const gapBelow = !prev ? 0 : startsTurn ? turnGap : callGap;
        const gapAbove = !next ? 0 : endsTurn ? turnGap : callGap;
        d = `M ${fx(x)} ${fx(yB - gapBelow)} L ${fx(x)} ${fx(yT + gapAbove)}`;
        // tag each trunk segment with the PROMPT (turn) it belongs to, so hovering the
        // line highlights the whole prompt + clicking it scrolls the chat (the architect 2026-06-19).
        const mainTurn = this.turnEnds.filter((t) => t.endedAt <= s.startedAt).length;
        const mainTE = this.turnEnds[mainTurn];
        const mainIdxAttr =
          mainTE && typeof mainTE.promptIndex === "number"
            ? ` data-eeg-prompt-index="${mainTE.promptIndex}"`
            : "";
        // FORK 2026-06-26 (the architect): every LLM-call trace must read its model/effort on
        // hover. The branches already carried a <title>; the main trunk did not — so a
        // mouse-over of a trunk call said nothing. Same tip shape as the branch path:
        // model · effort · tokens (effort falls back to "auto" when unpinned).
        const mainTip = esc(
          [
            s.label && s.label !== s.model ? s.label : null,
            s.model || null,
            s.chosenLevel || "auto",
            s.outputTokens ? `${s.outputTokens} tok` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        trace +=
          // FORK 2026-07-22 (the architect): FLAT start/finish, not round — a thick trace
          // (e.g. fable 33px) with a round cap bulges into a half-circle at each
          // end. `butt` squares the ends; `round` linejoin keeps the mid-path
          // effort bends smooth (joins are unaffected by the cap).
          `<path class="eeg-main" d="${d}" fill="none" stroke="${paint.stroke}"` +
          ` stroke-opacity="1" stroke-width="${fx(w)}" stroke-linecap="butt"` +
          ` stroke-linejoin="round" data-eeg-run="${esc(s.runId)}"${mainIdxAttr}><title>${mainTip}</title></path>`;
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
    // static badge.)
    // FORK 2026-06-25 (scope C): tool calls render through the SAME branch path as
    // subagents — split off the trunk, run up a strand column, join back — but keyed
    // separately ("T" vs "S") so a tool strand never merges with a same-model subagent.
    const subs = all.filter((s) => s.subagent || s.tool);
    const byKey = new Map<string, EegSample[]>();
    for (const s of subs) {
      const k = eegStrandGroupKey(s);
      const arr = byKey.get(k);
      if (arr) arr.push(s);
      else byKey.set(k, [s]);
    }
    // run interval of a strand; a still-running (un-ended) strand stays open.
    const endOf = (x: EegSample): number => (typeof x.endedAt === "number" ? x.endedAt : Infinity);
    // FORK 2026-06-25 (the architect): LANES. Distinct (T/S,model,effort) groups that land
    // on the SAME effort column must stand SIDE BY SIDE, not pile onto each other —
    // opus-low and sonnet-low at the same instant are two lanes, each its own brand
    // color; whitening (depth-shade) only ever stacks WITHIN one group.
    // FORK 2026-07-28 (the architect): …and groups that are merely SEQUENTIAL must SHARE lane 0
    // — a lane index is now earned by real temporal overlap, keyed on the EFFECTIVE
    // column the strand is actually drawn in. See eegAssignLanes for the two defects
    // this replaced ("lines dancing laterally within Min").
    const laneOf = eegAssignLanes(
      [...byKey].map(([key, items]) => ({
        key,
        level: eegEffectiveLevel(items[0]),
        intervals: items.map((x): EegInterval => [x.startedAt, endOf(x)]),
      })),
    );
    let branches = "";
    for (const [groupKey, items] of byKey) {
      items.sort((a, b) => a.startedAt - b.startedAt);
      const lane = laneOf.get(groupKey) ?? 0;
      // No index bound here any more (FINDING 2): STRAND_CAP was already applied, per concurrency
      // burst, by eegCappedOut above — and applied to the clock's input at the same time, so what
      // is not drawn is not billed. `items` therefore holds at most STRAND_CAP genuinely concurrent
      // peers, which is what makes the depth/shade arithmetic below bounded without clamping.
      for (let i = 0; i < items.length; i++) {
        const s = items[i];
        // TRUE temporal overlap within THIS (model,effort) group (the architect 2026-06-25:
        // "whiten only when threads ACTUALLY overlap"). depthIdx = overlapping peers
        // that started before s (its rank in the live stack); groupConcurrent =
        // overlapping peers + self. The OLD code counted `endedAt ?? Infinity`, so a
        // finished-but-unstamped sibling registered as forever-running and whitened a
        // sequence that never ran in parallel — that was the bug.
        const sStart = s.startedAt;
        const sEnd = endOf(s);
        let depthIdx = 0;
        let groupConcurrent = 1;
        for (let j = 0; j < items.length; j++) {
          if (j === i) continue;
          const o = items[j];
          if (!(o.startedAt < sEnd && sStart < endOf(o))) continue; // no real overlap
          groupConcurrent++;
          if (o.startedAt < sStart || (o.startedAt === sStart && j < i)) depthIdx++;
        }
        // FORK 2026-08-06: central resolution — same entry point as the trunk.
        const paint = resolveEegPaint({
          model: s.model,
          provider: s.provider,
          effort: s.chosenLevel,
        });
        const w = paint.logWidth; // LOG scale — same as the trunk (FORK 2026-08-28)
        // shade scaled to the REAL concurrency: a solo strand (groupConcurrent 1) →
        // base brand color (eegStrandShade returns no lift when n<=1), a 3-stack
        // grades its front to full depth. No more whitening of lone strands.
        const shade = eegStrandShade(paint, depthIdx, groupConcurrent);
        // FORK 2026-06-19/25: fan LEFT into the unused Auto columns — first by LANE
        // (model separation, side by side), then by depthIdx (the within-model
        // overlap stack). Clamp so strands never cross the left gutter (the architect).
        const col = Math.max(
          EEG_PAD_LEFT,
          colX(eegEffectiveLevel(s)) - lane * EEG_LANE_GAP - depthIdx * EEG_STRAND_DEPTH_STEP,
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
        // same trunk point → a CLOSED 1px teardrop (the architect's "weird max↔low loop").
        // Newest-at-top: the join (newer endedAt) sits ABOVE the split; force it at
        // least arc*3 above so the branch reads as a small out-and-back arch — but
        // never above the paper's top pad (a branch that is the very newest event has
        // no room and stays flat until the next sample lands).
        // FORK 2026-10-01 (finding 8): an UN-ENDED branch is clamped to the live grace window, not
        // to TOP_PAD. "No end stamp" used to mean "still running", so a strand orphaned six hours
        // ago drew one hairline from its split straight to the top — 91% of the paper, restored on
        // every reload. The spend clock already declines to believe such a sample (EEG_LIVE_GRACE_MS)
        // and collapses its euros to a step at its start, but that bounds the euro ACCRUAL and the
        // geometry here ignored it. Inside the grace window timeToY(now) is still the top, so a
        // genuinely live strand is unchanged; past it the branch shrinks to a stub at its own y.
        const liveEdge = Math.min(nowMs, s.startedAt + EEG_LIVE_GRACE_MS);
        const joinY = ended
          ? Math.max(TOP_PAD, Math.min(timeToY(s.endedAt as number), splitY - arc * 3))
          : Math.max(TOP_PAD, timeToY(liveEdge));
        // FORK 2026-06-19: if the subagent crossed a prompt boundary, merge back into ITS
        // OWN turn's trunk column (the first turnEnd after it started), NOT the later turn's
        // — so a helper from the previous prompt never draws a high→max line across the
        // prompt rule into the new turn's column (the architect's "previous call's high into max").
        let joinClampT = s.endedAt as number;
        if (ended && turnOf(joinClampT) !== turnOf(s.startedAt)) {
          joinClampT = this.turnEnds.find((t) => t.endedAt > s.startedAt)?.endedAt ?? joinClampT;
        }
        const joinX = ended ? mainColAt(joinClampT) : col;
        // FORK 2026-06-19: how many strands run in parallel at this spawn — shown on
        // hover so mousing over the bunch reads the multiplicity at that moment (the architect).
        // the TRUE multiplicity at this instant, counted over every strand including the ones the
        // cap declined to draw — the tip is the affordance that reports what the paper cannot show.
        const concurrentAtSpawn = allSubs.filter(
          (x) => x.startedAt <= s.startedAt && (x.endedAt ?? Infinity) > s.startedAt,
        ).length;
        // FORK 2026-06-25 (scope C): for a tool branch hide the synthetic `tool:local`
        // model + the meaningless "auto" effort — the label (tool name) carries it.
        const showModel = s.model && !(s.tool && s.model.startsWith("tool:"));
        const tip = esc(
          [
            s.label && s.label !== s.model ? s.label : null,
            showModel ? s.model : null,
            s.tool ? null : s.chosenLevel || "auto",
            s.outputTokens ? `${s.outputTokens} tok` : null,
            concurrentAtSpawn >= 2 ? `${concurrentAtSpawn}× parallel here` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        // FORK 2026-06-23 (the architect "weird max↔high loop stepping on the labels"): the
        // out-arc top (yOut) and its control point were UNCLAMPED, so a branch whose split
        // sits near the paper TOP punched above TOP_PAD into the column-label row — and,
        // splitting from the parent column (max) to the strand column (high) and back, drew
        // a tight max→high→max loop on top of the labels. Clamp every branch y to >= TOP_PAD
        // (here + joinY + yJoinIn below) so a near-top branch can never paint into the label
        // row; it still renders (just squished against the top) and relaxes into a full arch
        // as later samples push it down. NB: do NOT skip near-top branches — a fan-out that
        // is the newest activity must still show (it would otherwise vanish).
        const yOut = Math.max(TOP_PAD, splitY - arc * 2);
        const cpOut = Math.max(TOP_PAD, splitY - arc);
        let d =
          `M ${fx(splitX)} ${fx(splitY)}` +
          ` C ${fx(splitX)} ${fx(cpOut)} ${fx(col)} ${fx(cpOut)} ${fx(col)} ${fx(yOut)}`;
        // FORK 2026-06-20: never let a SHORT branch (a fast helper that finishes
        // before the next trunk call, so splitY≈joinY) pinch into a CLOSED teardrop —
        // force a small straight run at the strand column so it reads as a real
        // out-and-back arch, not a meaningless 1px loop (the architect: "weird max↔low loop").
        // Geometry stays honest: same split→strand-col→join columns/color/width.
        const yJoinInRaw = ended ? joinY + arc * 2 : joinY;
        const yJoinIn = ended ? Math.max(TOP_PAD, Math.min(yJoinInRaw, yOut - arc)) : yJoinInRaw;
        if (yJoinIn < yOut) d += ` L ${fx(col)} ${fx(yJoinIn)}`;
        if (ended) {
          d += ` C ${fx(col)} ${fx(joinY + arc)} ${fx(joinX)} ${fx(joinY + arc)} ${fx(joinX)} ${fx(joinY)}`;
        }
        const toolAttr = s.tool ? ` data-eeg-tool="1"` : "";
        branches +=
          `<path class="eeg-branch" d="${d}" fill="none" stroke="${shade.stroke}"` +
          ` stroke-opacity="${fx(shade.opacity)}" stroke-width="${fx(w)}"` +
          // FORK 2026-08-05 (the architect: "the style of EEG trace should ALWAYS be a line
          // that starts and ends abruptly, without the rounding effect embelishment
          // at the ends"). Round caps also LIE about duration: a cap adds half the
          // stroke width past each endpoint, so a 20px-thick Fable branch drew ~20px
          // longer than the time it actually spans — the thicker the model, the
          // bigger the overstatement, on the axis that means elapsed time.
          ` stroke-linecap="butt" data-eeg-run="${esc(s.runId)}"${toolAttr}><title>${tip}</title></path>`;
      }
    }
    // ── dynamic ×N: GLOBAL subagent concurrency over time. Sweep the [start,end]
    // intervals and emit a ×K label at each CHANGE (×6 → ×9 → …), at that
    // instant's y in the left gutter — a live multiplicity gauge (replaces the
    // single static cluster badge).
    {
      const evs: { t: number; d: number }[] = [];
      for (const s of allSubs) {
        if (s.tool) continue; // tools branch but are NOT fan-out — never inflate ×N (scope C)
        evs.push({ t: s.startedAt, d: 1 });
        if (typeof s.endedAt === "number") evs.push({ t: s.endedAt as number, d: -1 });
      }
      evs.sort((a, b) => a.t - b.t || b.d - a.d); // at a tie, starts (+1) before ends (-1)
      let count = 0;
      let lastShown = 0;
      const candidates: { y: number; n: number }[] = [];
      for (let i = 0; i < evs.length; i++) {
        count += evs[i].d;
        if (i + 1 < evs.length && evs[i + 1].t === evs[i].t) continue; // coalesce same instant
        if (count !== lastShown) {
          if (count >= 2) {
            candidates.push({ y: timeToY(evs[i].t), n: count });
          }
          lastShown = count;
        }
      }
      // FORK 2026-08-17 (the architect: "should show a few EEG traces side by side"): the gauge
      // coalesced only events at the SAME INSTANT, not at the same PIXEL. A real fan-out
      // ramps ×2→×10 within a couple of minutes, which on a multi-day paper is ~3px, so ten
      // 9px labels landed on top of each other and the one affordance that reports "ten ran
      // at once" rendered as an illegible smudge in the gutter. Cluster by rendered row and
      // keep the cluster's PEAK — never understates concurrency, and a slow ramp still gets
      // its running gauge every XN_MIN_GAP px.
      const XN_MIN_GAP = 10; // px — a 9px glyph needs its own row
      const shown: { y: number; n: number }[] = [];
      for (const c of candidates) {
        const last = shown[shown.length - 1];
        // Anchor stays on the cluster's first row, so a cluster can never chain-absorb the
        // whole paper: anything further than one row away starts a new label.
        if (last && Math.abs(last.y - c.y) < XN_MIN_GAP) {
          if (c.n > last.n) last.n = c.n;
          continue;
        }
        shown.push({ ...c });
      }
      for (const b of shown) {
        branches += `<text class="eeg-xn" x="3" y="${fx(b.y)}" font-size="9">×${b.n}</text>`;
      }
    }

    // ── PROMPT separators: a CLEAR solid rule per turn = one prompt (clickable →
    // app.ts scrolls the chat to that prompt + highlights it). The "t N" label is
    // dropped (the architect 2026-06-19: meaningless); the full-width transparent rect is the
    // generous hit target. Internal LLM-call boundaries get only a SUBTLE tick (below).
    let markers = "";
    for (const t of this.turnEnds) {
      const y = timeToY(t.endedAt);
      const idxAttr =
        typeof t.promptIndex === "number" ? ` data-eeg-prompt-index="${t.promptIndex}"` : "";
      // FORK 2026-06-22 (the architect): carry the prompt text as a data-attr so app.ts can
      // render its OWN styled hover overlay (the native <title> is slow + unstyleable);
      // the <title> stays as a no-JS fallback.
      const txtAttr = t.promptText ? ` data-eeg-prompt-text="${esc(t.promptText)}"` : "";
      const attrs =
        `class="eeg-marker" data-eeg-turn="${esc(String(t.turn))}" data-eeg-run="${esc(t.runId)}"${idxAttr}${txtAttr}` +
        ` style="cursor:pointer"`;
      const pTip = t.promptText ? `<title>${esc(t.promptText)}</title>` : "";
      // FORK 2026-06-22 (the architect): the prompt boundary is a clear YELLOW rule. CSS
      // .eeg-marker brightens it further on hover.
      markers +=
        `<line ${attrs} x1="0" y1="${fx(y)}" x2="${width}" y2="${fx(y)}"` +
        ` stroke="${EEG_TURN_COLOR}" stroke-opacity="0.9" stroke-width="2"/>`;
      // FORK 2026-09-06 (the architect: "the area of effect on the yellow line on-hover is too big …
      // it should just be on top of the actual line, and maybe a hair or two out from there").
      // Was a 12px band (y-6, h=12) around a 2px rule — six times the line's own width, which
      // swallowed hovers meant for the traces underneath. Now ±3px. The rule is full-width, so
      // there is always somewhere else along it to trigger the tip.
      markers += `<rect ${attrs} x="0" y="${fx(y - 3)}" width="${width}" height="6" fill="transparent">${pTip}</rect>`;
    }

    // ── SUBTLE internal LLM-call separators: a faint short tick at each viewed
    // main-sample (LLM-call) boundary — the within-a-prompt rhythm, distinct from the
    // bold prompt rules above (the architect 2026-06-19).
    let callTicks = "";
    for (const s of mains) {
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
      const zTxtAttr = te.promptText ? ` data-eeg-prompt-text="${esc(te.promptText)}"` : "";
      promptZones +=
        `<rect class="eeg-promptzone" data-eeg-prompt-index="${te.promptIndex}"${zTxtAttr}` +
        ` x="0" y="${fx(topY)}" width="${width}" height="${fx(botY - topY)}" fill="transparent">${zTip}</rect>`;
    }

    // FORK 2026-09-06 (the architect) — HIT PRECEDENCE REVERSED. The prompt hit-band used to paint
    // LAST, so a full-width rect spanning the whole turn's time-slice sat on top of every trace
    // and stole its hover: "when I mouseover an LLM thread, sometimes it does not show me info
    // about the model used". SVG hit-testing is paint order, so the fix is the order itself.
    // Now: zones (widest, lowest) → prompt rules → branches → trunk (narrowest, on top), i.e.
    // "the on-hover area of the traces should supersede the on-hover on yellow line behavior".
    // paint order: grid → €-grid → call-ticks → prompt hit-bands → prompt rules → branches → trunk (top)
    return (
      `<svg class="eeg-svg" width="${width}" height="${height}"` +
      ` viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      `${defs}${grid}${euroGrid}${callTicks}${promptZones}${markers}${branches}${trace}</svg>`
    );
  }
}
