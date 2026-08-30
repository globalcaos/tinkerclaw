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

import { buildEegSpendClock } from "./eeg-spend-clock.js";
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
  // anthropic — provider key OR a claude model name (cc-bridge = claude CLI)
  if (p === "claude-code" || p === "anthropic" || /claude|fable|opus|sonnet|haiku/.test(p)) {
    return { stroke: EEG_PROVIDER_COLORS.anthropic, isRainbow: false };
  }
  if (p === "openai" || /gpt|codex|(^|[^a-z])o\d/.test(p)) {
    return { stroke: EEG_PROVIDER_COLORS.openai, isRainbow: false };
  }
  if (/grok|xai/.test(p)) return { stroke: EEG_PROVIDER_COLORS.xai, isRainbow: false };
  if (/deepseek/.test(p)) return { stroke: EEG_PROVIDER_COLORS.deepseek, isRainbow: false };
  if (/mistral|mixtral/.test(p)) return { stroke: EEG_PROVIDER_COLORS.mistral, isRainbow: false };
  if (/llama|meta/.test(p)) return { stroke: EEG_PROVIDER_COLORS.meta, isRainbow: false };
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
//   · OpenAI: ChatGPT BUSINESS ×5 seats €130.01/mo (SERRA pays) → €26/seat, which
//     the architect states as **€25/mo** (2026-08-12); the 4% gap is immaterial next
//     to the denominator problem documented at the gpt-5.6 rows below. Our
//     path burns one seat. No token data → uniform 9.3× price→API-value quota
//     at 50% use = API output price ÷ 4.65 (Sol $30 / Terra $15 / Luna $6).
//   · Google: the architect ATTRIBUTES his €21.99/mo Google One AI to Gemini (his call
//     2026-07-22 16:17, though the CLI tokens come from the free Code Assist
//     tier) → same uniform amortization: API output ÷ 4.65 (3.1-pro $12 →
//     2.58; flash $9 → 1.94).
//   · xAI: SuperGrok (SERRA, $9.90 promo → $30 steady-state; widths use $30):
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
export const EEG_COST_TABLE: { modelMatch: RegExp; relCost: number }[] = [
  // ── GitHub Copilot Pro+ — PREPAID at a PUBLISHED allowance ──
  // FORK 2026-08-15 (the architect: "revise the models that have an EEG trace thicker than
  // fable"). On 2026-08-12 these rows were moved to RAW vendor sticker because Copilot
  // switched to token billing on 2026-06-01. That was half right: Copilot bills tokens,
  // but Pro+ is still a **subscription with an included allowance** — $39/mo carrying
  // **$70 of AI credits** (7,000 credits at $0.01; docs.github.com plans + billing).
  // Treating it as pure cash put the whole block at the 40px cap, implying Copilot was
  // the dearest thing we can run. It is not: inside the allowance you pay $39 for $70
  // of sticker value, an officially-stated conversion of **39/70 = 0.5571×**.
  // So: relCost = published sticker × 0.5571. No measurement, no invention — both
  // numbers come off GitHub's own pages. (Past the allowance you pay list; our Copilot
  // burn is ~3 turns in 30 days, i.e. deep inside it, so 0.5571 is the live factor.)
  //
  // ⚠ PROSPECTIVE ROWS — the architect 2026-08-15: **we do not hold a Copilot Pro+
  // subscription.** These models are on the panel to show management what buying one
  // would get us and whether it is worth it. So the number to draw is what a token
  // WOULD cost if we bought the plan (sticker × 0.5571), which is what these are — but
  // nothing here is live spend, and the EEG will never paint one of these traces
  // because the models are not routable today.
  //
  // AND THE THING MANAGEMENT WILL ASK: GitHub applies **NO MARKUP**. Its per-token
  // prices are IDENTICAL to each model's own vendor — verified 13 of 14 price triples
  // (input / cache-read / output) against Anthropic, OpenAI, Google and xAI on
  // 2026-08-15; the sole exception is Grok-4.5's cache-read, $0.50 on Copilot against
  // xAI's $0.30. Copilot rows draw thick NOT because GitHub overcharges but because our
  // baseline is a far deeper discount: Pro+ returns ~1.79x its fee in list value,
  // Anthropic Max 20x returns ~30x — an **18x gap in value-per-euro**. Same tokens,
  // same list price, very different plan.
  { modelMatch: /github-copilot\/.*fable/i, relCost: 27.86 }, // $50
  { modelMatch: /github-copilot\/.*opus/i, relCost: 13.93 }, // $25
  { modelMatch: /github-copilot\/.*5\.6-sol/i, relCost: 5.57 }, // $10 promo through 2026-09-03 (GitHub docs 2026-08-28; was $30 / 16.71)
  { modelMatch: /github-copilot\/.*gpt-5\.5/i, relCost: 16.71 }, // $30
  { modelMatch: /github-copilot\/.*5\.6-terra/i, relCost: 6.69 }, // $12
  { modelMatch: /github-copilot\/.*gpt-5\.4(?!-mini|-nano)/i, relCost: 8.36 }, // $15
  { modelMatch: /github-copilot\/.*sonnet-5(?!\.)/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*sonnet/i, relCost: 8.36 }, // $15
  { modelMatch: /github-copilot\/.*5\.6-luna/i, relCost: 0.67 }, // $1.20
  { modelMatch: /github-copilot\/.*gemini.*pro/i, relCost: 6.69 }, // $12
  // GitHub docs 2026-08-28: 3.6/3.7 Flash promo $0.75/$3.75 through 2026-12-31.
  // The $7.50 / $9 rows were last year's stickers. 3.75 × 0.5571 = 2.09.
  { modelMatch: /github-copilot\/.*gemini-3\.[67].*flash/i, relCost: 2.09 }, // $3.75 promo
  { modelMatch: /github-copilot\/.*gemini.*flash/i, relCost: 5.01 }, // 3.5 Flash $9
  { modelMatch: /github-copilot\/.*haiku/i, relCost: 2.79 }, // $5
  { modelMatch: /github-copilot\/.*gpt-5\.4-mini/i, relCost: 2.51 }, // $4.50
  { modelMatch: /github-copilot\/.*gpt-5-mini/i, relCost: 1.11 }, // $2
  { modelMatch: /github-copilot\/.*gpt-5\.3-codex/i, relCost: 7.8 }, // $14
  { modelMatch: /github-copilot\/.*gpt-5\.2/i, relCost: 7.8 }, // $14
  { modelMatch: /github-copilot\/.*gpt-5\.1/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*gpt-5(?!\.)/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*gpt-4\.1/i, relCost: 4.46 }, // $8
  { modelMatch: /github-copilot\/.*gpt-4o/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*grok/i, relCost: 3.34 }, // $6
  { modelMatch: /github-copilot\//i, relCost: 6.69 }, // unknown copilot model ($12-class)

  // ── OpenRouter, METERED (the architect 2026-08-04) ──
  // These are the only models on the panel billed in REAL CASH per token — there
  // is no subscription to amortize, so relCost is the sticker output $/Mtok
  // verified against the live /v1/models endpoint on 2026-08-04, with NO ÷4.65.
  // That is why Kimi K3 draws THICKER than Opus: an Opus token is prepaid inside
  // the Max 20x plan, a Kimi token is money leaving the account. The widths are
  // telling the truth about spend, which is the whole point of the column.
  // Must precede the bare-family rules below so nothing generic claims them.
  // Prices re-read from the vendors' own pages 2026-08-12 (NOT from our telemetry).
  // FORK 2026-08-13 — RE-VERIFIED against the OpenRouter **API** (`/api/v1/models`),
  // not its web pages or a search summary. Three of five were wrong, including one I
  // introduced the day before by pricing a brokered model from the LAB's page:
  //   kimi-k3   14   → 15     (OR charges $3/$15, identical to Moonshot first-party;
  //                            the "$2.80/$14" read off the model page was not the
  //                            price actually billed)
  //   glm-5.2   4.4  → 1.98   (4.4 was Z.ai's OWN $1.40/$4.40 — we route through
  //                            OpenRouter, which charges $0.63/$1.98. 2.22× overstated)
  //   deepseek  0.144→ 0.18   (OR charges $0.08/$0.18, not the $0.072/$0.144 listed)
  // qwen3.8 and qwen3.7 verified EXACT. Re-verify with:
  //   curl -s https://openrouter.ai/api/v1/models | jq '.data[]|select(.id=="z-ai/glm-5.2").pricing'
  // RE-CHECKED 2026-08-15 against the same API. **Two of five moved in 48 hours** —
  // these are live marketplace prices, not stable literals:
  //   glm-5.2      1.98 → 1.452  (-27%)
  //   deepseek     0.18 → 0.28   (+56% — the rise DeepSeek's own docs warned about;
  //                               it now matches their first-party $0.14/$0.28)
  // qwen3.8, qwen3.7 and kimi unchanged. Anything frozen here is wrong within days;
  // re-run the curl above before trusting these.
  // RE-CHECKED 2026-08-17 → glm-5.2 1.452 → 2.42, deepseek-v4-pro 0.87 → 3.96.
  // RE-CHECKED 2026-08-18 → glm-5.2 2.42 → 3.15 (+30% out, while INPUT fell 0.76 →
  //   0.50). Three moves in four days on one model, in both directions: GLM's routed
  //   price is the most volatile figure on this panel. Everything else held exactly.
  // RE-CHECKED 2026-08-19 → glm-5.2 3.15 → 3.036 (−3.6% out; input 0.50 → 0.966).
  // ── OpenRouter catalog rows (FORK 2026-08-15, the architect: "add all of them ... which
  //    will tell us how good we are doing"). Metered $/Mtok-OUTPUT, every figure
  //    read off the live /api/v1/models endpoint, never off a price page.
  //    SPECIFIC ROWS MUST STAY ABOVE the generic /kimi/, /glm/, /deepseek.*flash/
  //    rows below — regex order decides, and the generic rows misprice these by up
  //    to 6× (a K2.6 dot priced as a K3 dot is a lie the chart cannot walk back).
  { modelMatch: /qwen3\.8-2\.4t/i, relCost: 6.0 }, // $2.000/$6.000
  // FORK 2026-08-18: added with the model itself. No generic /qwen/ row exists, so
  // without this the 27B would have fallen through to EEG_DEFAULT_REL_COST (2.58)
  // and drawn 19% thin — the "dot with no cost row" failure the block above warns of.
  { modelMatch: /qwen3\.8-27b/i, relCost: 2.55 }, // $0.425/$2.550 — re-checked 2026-08-25 (was 3.0; -15%)
  { modelMatch: /deepseek-v4-pro-0813/i, relCost: 1.98 }, // $0.660/$1.980 — re-checked 2026-08-29 live endpoints (-41%; DeepSeek direct cheapest, was DeepInfra $1.122/$3.366)
  { modelMatch: /deepseek.*v4-pro/i, relCost: 1.3993 }, // $0.6997/$1.3993 — re-checked 2026-08-29 live endpoints (undated slug; was 1.74; -20%)
  { modelMatch: /minimax/i, relCost: 1.2 }, // $0.300/$1.200
  { modelMatch: /muse-spark/i, relCost: 4.25 }, // $1.250/$4.250
  // PROVIDER-SCOPED ON PURPOSE. The native `google/*` rows further down sit on an
  // AMORTIZED scale (3.5 Flash = 0.0804 for a $9 sticker, i.e. ÷112), left over from
  // when Gemini was reachable on a free CLI tier. An unscoped /gemini-3.7.*flash/ here
  // would win by regex order and price a NATIVE google dot at raw metered rate — two
  // scales in one column, which is exactly the 43× lie of [eeg-cost-table-amortized].
  // Only the metered OpenRouter route gets the raw number.
  { modelMatch: /openrouter\/.*gemini-3\.7.*flash/i, relCost: 1.875 }, // $0.375/$1.875 OR
  { modelMatch: /mimo/i, relCost: 0.87 }, // $0.435/$0.870
  { modelMatch: /inkling-small/i, relCost: 1.2 }, // $0.450/$1.200
  { modelMatch: /inkling/i, relCost: 4.05 }, // $0.950/$4.050
  { modelMatch: /tencent|hy3/i, relCost: 0.528 }, // $0.132/$0.528
  // FORK 2026-08-15 (regex-leak audit): `/nex-n2/i` also claimed `nex-n2-mini`
  // ($0.100), drawing it 10× too thick. Specific row first.
  { modelMatch: /nex-n2-mini/i, relCost: 0.1 }, // $0.025/$0.100
  { modelMatch: /nex-n2/i, relCost: 1.0 }, // nex-n2-pro $0.250/$1.000
  { modelMatch: /solar-pro/i, relCost: 0.12 }, // $0.030/$0.120
  { modelMatch: /glm-5\.3-flash/i, relCost: 0.25 }, // $0.075/$0.250 — re-checked 2026-08-29 live (Relace, unchanged; was Z.AI)
  { modelMatch: /glm-5\.3/i, relCost: 4.0 }, // $1.200/$4.000 — re-checked 2026-08-30 live (+1%; DeepInfra now cheapest, AtlasCloud raised $3.96→$4.40)
  { modelMatch: /glm-5\.1/i, relCost: 2.856 }, // $0.9086/$2.8556 — re-checked 2026-08-29 live (-28%; Baidu cheapest, was GMICloud $1.260/$3.960)
  { modelMatch: /glm-5\.2/i, relCost: 1.0296 }, // $0.3276/$1.0296 — re-checked 2026-08-30 live (-8.6%; StreamLake still cheapest)
  // FORK 2026-08-15: `/glm-5(?![.\d])/i` blocks a following digit or dot, but NOT a
  // letter or hyphen — so it also claimed `glm-5-turbo` and `glm-5v-turbo`, both
  // $4.000, and drew them at 1.92 (2.1× too thin). Both turbos get their own row.
  { modelMatch: /glm-5v?-turbo/i, relCost: 4.0 }, // $1.200/$4.000
  { modelMatch: /glm-5(?![.\d])/i, relCost: 1.92 }, // $0.600/$1.920
  { modelMatch: /kimi-k2\.6/i, relCost: 2.228 }, // $0.5292/$2.228 — re-checked 2026-08-29 live (-44%; Baidu cheapest, was StreamLake $0.950/$4.000)
  { modelMatch: /kimi-k2\.7/i, relCost: 3.4 }, // $0.670/$3.400 — re-checked 2026-08-22 (was 3.5)
  { modelMatch: /qwen3\.6-max-preview/i, relCost: 6.162 }, // $1.027/$6.162 — added 2026-08-22
  { modelMatch: /qwen3\.6-plus/i, relCost: 1.95 }, // $0.325/$1.950
  // RE-CHECKED 2026-08-29 live endpoints: DeepSeek now serves deepseek-v4-flash-vision-exp-20260821
  // at $0.220/$0.660 — confirmed via /api/v1/models/deepseek/deepseek-v4-flash-vision-exp/endpoints.
  // The 2026-08-27 "correction" to $1.32 was wrong; the $0.66 this pass wrote is real.
  { modelMatch: /deepseek-v4-flash-vision/i, relCost: 0.66 }, // $0.220/$0.660 — re-checked 2026-08-29 live (-50% vs $1.320; new model ID with date suffix)
  { modelMatch: /deepseek-v4-flash-0731/i, relCost: 0.0899 }, // $0.0449/$0.0899 — re-checked 2026-08-29 live (-25%; Baidu cheapest, was OpenInference $0.060/$0.120)
  { modelMatch: /deepseek-v4-flash(?!-)/i, relCost: 0.168 }, // $0.0679/$0.168 — re-checked 2026-08-29 live (undated slug, DigitalOcean cheapest; was 0.159)
  // FORK 2026-08-23: openrouter/openai/gpt-5.3-codex is metered at $1.75/$14.00.
  // Without this row the generic /gpt-5/i catch-all (0.0893) would underprice it by
  // 157× against the actual metered rate. Must be scoped to the openrouter/ prefix so
  // the github-copilot/gpt-5.3-codex row above keeps its Copilot-adjusted price.
  { modelMatch: /openrouter\/openai\/gpt-5\.3-codex/i, relCost: 14.0 }, // $1.75/$14.00
  { modelMatch: /kimi/i, relCost: 15 }, // $3/$15, cache read $0.30
  { modelMatch: /qwen3\.8-max/i, relCost: 6.0 }, // $2/$6, cache read $0.25
  { modelMatch: /qwen3\.7-max/i, relCost: 4.425 }, // $1.475/$4.425, cache read $0.295
  { modelMatch: /glm/i, relCost: 3.036 }, // GLM generic fallback (glm-5.1/5.2/5.3 have specific rows above)
  { modelMatch: /deepseek.*flash/i, relCost: 0.168 }, // $0.0679/$0.168 — generic fallback (re-checked 2026-08-29; was 0.159)

  // ── FORK 2026-08-30 (the architect: "update it with the newest models in the market") ──
  // Every figure below read off the LIVE OpenRouter catalog this pass (http=200,
  // 396 models, 655,423 bytes) — id, price AND context window from /api/v1/models,
  // never a price page. That is the rule the Kimi K3 miss bought ($2.90/$14 on
  // every price page, $3.00/$15 actually billed).
  //
  // claude-opus-5-fast MUST STAY IN THIS BLOCK, above the native `/opus/i` row.
  // Anthropic's fast mode is sold METERED at $10/$50 — 2x regular Opus 5, per
  // OpenRouter's own description ("identical capabilities with higher output speed
  // at 2x pricing"). The native row prices an Opus token at the Max 20x amortized
  // €0.2232, so if `/opus/i` won here a CASH route would draw at a subscription
  // rate and understate it by 224x — the same regex-order failure class as the
  // glm-5-turbo and nex-n2-mini leaks above.
  { modelMatch: /claude-opus-5-fast/i, relCost: 50.0 }, // $10.000/$50.000 OR, ctx 1M
  { modelMatch: /nemotron-3\.5-lightning/i, relCost: 0.2 }, // $0.080/$0.200 OR, ctx 262k
  { modelMatch: /ling-3\.0-flash/i, relCost: 0.063 }, // $0.021/$0.063 OR, ctx 262k
  { modelMatch: /longcat-2\.0/i, relCost: 1.2 }, // $0.300/$1.200 OR, ctx 1.05M

  // ── Native / non-Copilot paths — SUBSCRIPTION, so relCost is amortized ──
  // Anthropic: Max 20x ÷ MEASURED trailing-30d burn, weighted with the renderer's own
  // blend (output + 0.2·input), then split by the PUBLIC sticker ratios (Haiku $5 /
  // Sonnet 5 $10 / Opus 5 $25 / Fable $50 → 0.5 / 1 / 2.5 / 5) — NOT the .3/1/5/10
  // frozen at the Opus-4.1 era ($75 out).
  //   measured 2026-08-12, trailing 30d: 6,291 Mtok in + 34.2 Mtok out over 23,354
  //   turns → 1,292 Mtok weighted → 3,323 Mtok-sonnet-eq.
  // FORK 2026-08-13 (the architect: "consider an average of 75% usage"). The denominator is
  // no longer raw measured burn but the QUOTA CEILING × his stated utilisation, which
  // is the number he actually reasons with. Derived end to end from live data:
  //   · live `budget.usage` 2026-08-12 16:36 UTC: seven_day = **70%**, window opened
  //     2026-08-06 15:59 UTC.
  //   · our burn inside exactly that window, in the RENDERER's own blend
  //     (output + 0.2·input), split by public sticker ratios (.5/1/2.5/5):
  //     opus 204.6 + sonnet 11.2 = **522.7 Mtok-sonnet-eq** — which IS that 70%.
  //   · ceiling = 522.7 / 0.70 = 746.7 eq-Mtok/week; at 75% usage = 560.0 consumed.
  //   · €50/week (€200/mo ÷ ~4 weeks) / 560.0 = **€0.0893 per sonnet-eq Mtok**.
  // Every Anthropic row moves ×1.48 against the 2026-08-12 values, and sonnet comes
  // back OFF the floor (0.35 → 0.52px). Opus 1.30px against qwen3.8's 34.88px: 27×
  // the width for 27× the cash, which is the linear axis doing its job.
  //
  // READ THIS BEFORE TRUSTING THE NUMBER: it is an AVERAGE, not a MARGINAL price.
  // At 75% usage there is headroom, so the true cost of the next Anthropic token is
  // €0 until the cap. Dividing a flat fee by usage measures how well a seat is used,
  // not what a model costs — see the OpenAI rows below, where the same arithmetic
  // makes Sol look 48× Opus purely because that seat sits idle.
  { modelMatch: /fable/i, relCost: 0.4464 },
  { modelMatch: /opus/i, relCost: 0.2232 },
  { modelMatch: /sonnet/i, relCost: 0.0893 },
  { modelMatch: /haiku/i, relCost: 0.0446 },
  // OpenAI gpt-5.6 trio (ChatGPT Business seat, codex provider) — sticker out ÷ 4.65.
  // FORK 2026-08-12: Terra is $12 out (not $15) and Luna is $1.20 (not $6) per
  // developers.openai.com/api/docs/pricing. Luna being 5× wrong mattered most —
  // it was the pixel anchor for the whole scale.
  //
  // WHY THESE STAY ON THE ÷4.65 BLANKET WHILE ANTHROPIC IS MEASURED — the architect
  // asked why Sol draws so much dearer than Opus when the two feel comparable in use.
  // He is right about the models: at PUBLIC sticker Sol is $30 out against Opus 5's
  // $25 — **1.2×**. The panel says 43×, and measuring the OpenAI seat the same way we
  // measure Anthropic says **48×**, so the blanket is not the culprit. The culprit is
  // UTILISATION: over the same 30 days the Anthropic seat did 3,323 sonnet-eq Mtok
  // and the OpenAI seat did **3.6** sol-eq Mtok — 924× less work for a comparable
  // fee. Amortising a flat fee over a nearly idle seat is also numerically unstable:
  // one more Sol session moves that rate ~12%. So the measured value (€7.23) is NOT
  // adopted here — it would be a more precise answer to the wrong question. This
  // column is meant to say "how much cash does this token cost", and for any seat
  // with headroom the answer is ~zero regardless of provider.
  // OPEN, for the architect: either (a) leave the blanket and accept that the
  // subscription block encodes assumed-utilisation, (b) measure every seat and accept
  // that idle seats draw thick, or (c) split the channel so width = metered cash only
  // and prepaid models share one thin band ordered by sticker. Costed in bug-log
  // 2026-08-12 [panels]. Do NOT half-migrate this — mixing a measured Anthropic rate
  // with a blanket OpenAI one is exactly what produced the 43× the architect caught.
  //
  // AND THE FACT THAT UNDERMINES ANY per-token AMORTISATION HERE: **neither plan
  // meters tokens at all.** `memory/chatgpt-usage.json` (fetched 2026-08-12 10:01)
  // reports `limit_requests: 100` weekly with `limit_tokens: null` — a REQUEST quota,
  // and `utilization_pct: 2` with 98/100 remaining, i.e. the seat is close to idle.
  // `memory/claude-usage.json` reports five_hour / seven_day / seven_day_opus
  // UTILISATION WINDOWS, again no token quota (that file is stale — fetchedAt
  // 2026-04-03 — so it cannot confirm a current figure either). So "N% of my token
  // quota" is not a quantity either vendor defines; every per-token subscription rate
  // in this table divides by a denominator we invented. Treat these four values as an
  // ACCOUNTING CONVENTION, never as a price, and never compare them to a metered row
  // without saying which is which.
  // ══ FORK 2026-08-13 — THE ÷4.65 BLANKET IS GONE. the architect: "How can Sol cost so much
  // more than Fable? There must be a mistake here somewhere." There was, and it was
  // an INVERSION, not a magnitude error. Claude Fable 5 is the dearest model we can
  // reach ($50/Mtok out) and drew at 2.60px; gpt-5.6-sol ($30) drew at 37.50px —
  // Sol **14.4× thicker than a model 1.67× its price**, an end-to-end error of 24×.
  //
  // Neither number was wrong on its own terms. Fable sat on the MEASURED Anthropic
  // basis; Sol sat on the INVENTED `÷ 4.65` blanket ("9.3× price→API-value quota at
  // 50% use" — a July guess with no source). Two units in one column, which is the
  // same defect that made this panel recommend the model behind a $146 bill.
  //
  // THE FIX: one basis for EVERY prepaid seat. relCost = MEASURED_UNIT × (public
  // sticker output ÷ Sonnet 5's $10), where MEASURED_UNIT = **€0.0893 per sonnet-eq
  // Mtok** — the same figure the Anthropic rows use, derived from the live 70%
  // `seven_day` reading, our burn inside that exact window, and 75% average usage.
  // Every prepaid model is now ranked by its OFFICIAL price, on a unit measured from
  // the one seat we can actually meter. Fable 2.60px > Sol 1.56px, ratio 1.67× —
  // exactly the sticker ratio. The last invented number in this table is gone.
  //
  // WHAT THIS DELIBERATELY DOES NOT ENCODE: that the OpenAI seat is barely used
  // (2% utilisation, 2026-08-12). That is a real fact and a real waste, but it answers
  // "is this subscription worth it?", not "what does this model cost" — and mixing the
  // two is what produced the inversion above. Seat efficiency belongs in its own view.
  // FORK 2026-08-30 — BASIS CORRECTION, not a price move. OpenAI publishes TWO
  // rates per gpt-5.6 model (developers.openai.com/api/docs/pricing, read today):
  // short-context and long-context. Sol carried the LONG rate ($30) while Terra
  // ($12) and Luna ($1.20) carried the SHORT one — three rows of ONE family on two
  // different bases, the same defect that made this table recommend the model
  // behind a $146 bill. All three now on the SHORT/standard rate:
  // Sol $4/$20 · Terra $2/$12 · Luna $0.20/$1.20. Long context doubles
  // ($30/$18/$1.80); relCost is a scalar and cannot say so — same caveat as grok.
  // LIVE PROMO, deliberately NOT baked here: OpenRouter bills Sol at $2/$10 today
  // and GitHub quotes $10 through 2026-09-03, while OpenAI's page says the promo
  // runs "at least through 2026-11-21". This row tracks the STANDARD list because
  // that is what the column claims to rank by; the promo is reported, not encoded.
  { modelMatch: /5\.6-sol/i, relCost: 0.1786 }, // $20 out short-ctx = 0.0893 x (20/10)
  { modelMatch: /5\.6-terra/i, relCost: 0.1072 }, // $12 out
  { modelMatch: /5\.6-luna/i, relCost: 0.0107 }, // $1.20 out
  // Google (€21.99 Google One attributed, the architect 2026-07-22).
  // gemini rows BEFORE \bmini\b so "…e-mini…" never steals a gemini id.
  // 3.6-flash ($7.50 out) is cheaper than 3.5-flash ($9), so it needs its own row.
  // FORK 2026-08-15 — RE-BASED FROM AMORTIZED TO METERED, and this is a correction,
  // not a tuning. These three rows carried the ÷112 subscription divisor every other
  // native row uses (3.5 Flash read 0.0804 against a $9 sticker), because Gemini was
  // reachable on the free Gemini-CLI tier and a free seat genuinely amortizes to ~0.
  // That tier is GONE: `gemini -p` now returns IneligibleTierError ("no longer
  // supported for Gemini Code Assist for individuals"), and Google is reached with a
  // metered API key as of tonight. A metered model priced on a subscription divisor
  // understates its cost by two orders of magnitude — the same defect recorded in
  // [eeg-cost-table-amortized], pointing the other way.
  // Prices from ai.google.dev/gemini-api/docs/pricing, output $/Mtok. The 3.7/3.6
  // rate is promotional through 2026-12-31; re-check it in January.
  // 3.7 BEFORE 3.6 BEFORE the generic flash row — regex order decides.
  { modelMatch: /gemini.*pro/i, relCost: 12.0 }, // 3.1 Pro $12 out ≤200k (doubles above)
  { modelMatch: /gemini-3\.7.*flash/i, relCost: 3.75 }, // $0.75/$3.75 (promo → 2026-12-31)
  { modelMatch: /gemini-3\.6.*flash/i, relCost: 3.75 }, // $0.75/$3.75 (promo → 2026-12-31)
  { modelMatch: /gemini.*flash/i, relCost: 9.0 }, // 3.5 Flash $1.50/$9.00
  // Catch-all for an unrecognised "*-mini": assume the dearer current-generation
  // member (gpt-5.4-mini $4.50, not gpt-5-mini $2) so it is never under-drawn.
  { modelMatch: /\bmini\b/i, relCost: 0.0402 },
  { modelMatch: /gpt-5\.5/i, relCost: 0.2679 }, // $30 out
  { modelMatch: /gpt-5\.4(?!-mini|-nano)/i, relCost: 0.134 }, // $15 out
  { modelMatch: /gpt-5/i, relCost: 0.0893 }, // $10 out
  // xAI grok-4.5 (SuperGrok) — $6 out BELOW 200k context. Above 200k xAI doubles
  // every rate ($4/$12); relCost is a scalar and cannot say that, so this row
  // UNDERSTATES any run with a long context. See bug-log 2026-08-12 [panels].
  { modelMatch: /grok|xai/i, relCost: 0.0536 }, // $6 out
  // FORK 2026-06-25 (the architect scope C): local housekeeping tool calls (grep/read/edit/
  // plain bash) — effectively free, drawn as the thinnest possible gray hairline.
  // FORK 2026-08-04 (the architect, found while rescaling to Luna=1.5px): the anchor was
  // `^tool:local$`, but eegCostKey PREFIXES the provider — eegToolIdentity returns
  // {provider:"tool", model:"tool:local"}, so the key is "tool/tool:local" and the
  // anchored rule NEVER matched. Every grep/read/edit therefore fell through to
  // EEG_DEFAULT_REL_COST and drew as thick as a mid-tier model — the exact
  // "housekeeping out-shouts a provider call" failure the hairline exists to
  // prevent. Its test had been red since the rule was written. Allow the prefix.
  // FORK 2026-08-12: was 0.3, chosen to sit under everything on a LINEAR scale. Once
  // the Anthropic rows became honest (haiku 0.0401) that put local grep ABOVE opus,
  // and on the log axis it would have drawn thicker still. Local compute costs
  // nothing, so the value is now nominal-zero and it floors by arithmetic, not luck.
  { modelMatch: /(?:^|\/)tool:local$/i, relCost: 0.001 },
];
// Unknown model → assume it is METERED and mid-frontier (between glm-5.2's 1.98 and
// qwen3.7's 4.425). Since 2026-08-13 every PREPAID row sits below 0.45, so this value
// also guarantees an unrecognised model never masquerades as subscription-cheap.
const EEG_DEFAULT_REL_COST = 2.58;

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
// uncapped, so kimi-k3 renders at 87px and a hypothetical copilot-fable at 162px.
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
  ["claude-haiku-4-5", 0.35], // floor (raw 0.26)
  ["codex/gpt-5.6-luna", 0.35], // floor (raw 0.06)
  ["xai/grok-4.5", 0.35], // floor (raw 0.31)
  ["deepseek/deepseek-v4-flash-0731", 0.52], // 0.0899 × 5.814 — re-checked 2026-08-29 live (-25%; was 0.7)
  ["claude-sonnet-5", 0.52],
  ["codex/gpt-5.6-terra", 0.62],
  ["claude-opus-4-8", 1.3],
  ["z-ai/glm-5.3-flash", 1.45], // 0.25 × 5.814 — added 2026-08-27 OR catalog ($0.075/$0.250, ctx 1.31M)
  ["openai-codex/gpt-5.5", 1.56],
  ["claude-fable-5", 2.6],
  ["tencent/hy3", 3.07], // 0.528 × 5.814 — added 2026-08-25 ($0.132/$0.528 OR catalog)
  ["deepseek/deepseek-v4-flash-vision-exp", 3.84], // 0.66 × 5.814 — re-checked 2026-08-29 live (-50%; was 7.67)
  ["z-ai/glm-5.2", 5.99], // 1.0296 × 5.814 — re-checked 2026-08-30 live (-8.6%; was 6.55)
  ["minimax/minimax-m3", 6.98],
  ["deepseek/deepseek-v4-pro-0813", 11.51], // 1.98 × 5.814 — re-checked 2026-08-29 live (-41%; was 19.57)
  ["moonshotai/kimi-k2.6", 12.95], // 2.228 × 5.814 — re-checked 2026-08-29 live (-44%; was 23.26)
  ["qwen/qwen3.8-27b", 14.83], // 2.55 × 5.814 — re-checked 2026-08-25 OR catalog (was 17.44; -15%)
  ["google/gemini-3.7-flash", 21.8],
  ["z-ai/glm-5.3", 23.26], // 4.00 × 5.814 — re-checked 2026-08-30 live (+1%; DeepInfra took cheapest from AtlasCloud)
  ["qwen/qwen3.7-max", 25.73],
  ["qwen/qwen3.8-max", 34.88],
  ["github-copilot/gpt-5.4", 48.61],
  ["google/gemini-3.5-flash", 52.33],
  ["github-copilot/claude-opus-4.7", 80.99],
  ["moonshotai/kimi-k3", 87.21],
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
export const EEG_COST_LOG_REF_REL = 0.0107; // gpt-5.6-luna, the cheapest routable model
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
  ["codex/gpt-5.6-luna", 1.0],
  ["claude-haiku-4-5", 5.73],
  ["xai/grok-4.5", 6.34],
  ["claude-sonnet-5", 8.03],
  ["deepseek/deepseek-v4-flash-0731", 8.05],
  ["codex/gpt-5.6-terra", 8.63],
  ["claude-opus-4-8", 11.06],
  ["z-ai/glm-5.3-flash", 11.44],
  ["openai-codex/gpt-5.5", 11.67],
  ["claude-fable-5", 13.36],
  ["tencent/hy3", 13.91],
  ["deepseek/deepseek-v4-flash-vision-exp", 14.65],
  ["z-ai/glm-5.2", 16.13],
  ["minimax/minimax-m3", 16.63],
  ["deepseek/deepseek-v4-pro", 17.14],
  ["deepseek/deepseek-v4-pro-0813", 18.29],
  ["moonshotai/kimi-k2.6", 18.68],
  ["qwen/qwen3.8-27b", 19.13],
  ["z-ai/glm-5.1", 19.51],
  ["moonshotai/kimi-k2.7-code", 20.08],
  ["google/gemini-3.7-flash", 20.41],
  ["z-ai/glm-5.3", 20.62],
  ["meta/muse-spark-1.2", 20.82],
  ["qwen/qwen3.7-max", 20.96],
  ["qwen/qwen3.8-2.4t-a95b", 21.96],
  ["qwen/qwen3.8-max", 21.96],
  ["google/gemini-3.5-flash", 23.31],
  ["moonshotai/kimi-k3", 25.0],
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
export const EEG_PX_PER_EURO = 90; // vertical px per €1 of spend (the §1 grid pitch)
const EEG_INPUT_COST_RATIO = 0.2; // input price ÷ output price (typical 5:1)
const EEG_MIN_LEN = 16; // ≥ 2·ARC_HALF so the column-hop bezier always fits
const EEG_MAX_LEN = 600;

function eegWeightedTokens(s: EegSample): number {
  return (s.outputTokens ?? 0) + EEG_INPUT_COST_RATIO * (s.inputTokens ?? 0);
}
// FORK 2026-06-20 (the architect): estimated euro cost of one sample. relCost is €/Mtok-output
// (subscription-amortized for Anthropic, metered for API providers — see EEG_COST_TABLE).
export function eegSampleEuros(s: EegSample): number {
  return (eegRelCost(s.model, s.provider) * eegWeightedTokens(s)) / 1_000_000;
}
/**
 * FORK 2026-08-08: legibility clamp for a strand's drawn length, in UNZOOMED px.
 *
 * The SPEND CLOCK (eeg-spend-clock.ts) decides the true euro extent of every strand; this only
 * keeps sub-€0.2 turns clickable and tall enough for the column-hop bezier, and backstops a
 * pathological single turn. Kept as one named derivation so the render path never re-invents the
 * floor — and kept OUT of the clock, which must stay exact arithmetic so the conservation test
 * (Σ advance ≡ Σ euros) can be exact.
 *
 * Was `eegSampleLength(sample)`, which computed position and floor together; position now comes
 * from the clock, so only the floor remains.
 */
export function eegClampEuros(euros: number): number {
  const min = EEG_MIN_LEN / EEG_PX_PER_EURO;
  const max = EEG_MAX_LEN / EEG_PX_PER_EURO;
  return Math.min(max, Math.max(min, Number.isFinite(euros) && euros > 0 ? euros : 0));
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
    // THE FLOOR IS APPLIED TO THE CLOCK'S INPUT, NOT TO ITS OUTPUT. Clamping lengths afterwards
    // desynchronises them from their positions: two sub-€0.2 calls sit ~1px apart on the exact
    // ledger but each draw 16px tall, so they OVERLAP instead of showing the call gap. Feeding
    // clamped euros in keeps one coherent layout — and reproduces the pre-existing, documented
    // deviation exactly (the floor slightly over-draws the cheapest turns; the grid reading is
    // exact for anything above it). The clock module itself stays exact arithmetic, which is why
    // its conservation test can be exact.
    const nowMs = Date.now();
    const clock = buildEegSpendClock(
      all.map((s) => ({
        key: s.runId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        euros: eegClampEuros(eegSampleEuros(s)),
      })),
      nowMs,
    );
    const pxPerEuro = EEG_PX_PER_EURO * zoom;
    // Newest at TOP: the clock grows with time, so screen y counts DOWN from the total.
    const rowTopArr: number[] = new Array(n);
    const lengths: number[] = new Array(n);
    for (let c = 0; c < n; c++) {
      const span = clock.spans.get(all[c].runId);
      const yStart = span?.yStart ?? 0;
      const yEnd = span?.yEnd ?? yStart;
      rowTopArr[c] = TOP_PAD + (clock.total - yEnd) * pxPerEuro;
      // Euros were already clamped on the way IN, so length and position agree by construction.
      // The only floor left is the zoom-scaled bezier minimum, exactly as before.
      lengths[c] = Math.max(2 * arc, (yEnd - yStart) * pxPerEuro);
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

    // ── horizontal €-grid: one rule per €1 of trace length (the architect 2026-06-20). Each
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
        const op = s.dim ? 0.32 : 1; // other sessions (all-scope) draw semi-transparent
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
        // line highlights the whole prompt + clicking it scrolls the chat (the architect 2026-06-19).
        const mainTurn = s.dim ? -1 : this.turnEnds.filter((t) => t.endedAt <= s.startedAt).length;
        const mainTE = mainTurn >= 0 ? this.turnEnds[mainTurn] : undefined;
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
          ` stroke-opacity="${fx(op)}" stroke-width="${fx(w)}" stroke-linecap="butt"` +
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
    // static badge.) `dim` strands (other sessions in "all" scope) draw faint.
    // FORK 2026-06-25 (scope C): tool calls render through the SAME branch path as
    // subagents — split off the trunk, run up a strand column, join back — but keyed
    // separately ("T" vs "S") so a tool strand never merges with a same-model subagent.
    const subs = all.filter((s) => s.subagent || s.tool);
    const byKey = new Map<string, EegSample[]>();
    for (const s of subs) {
      const k = `${s.tool ? "T" : "S"}|${s.model}|${s.chosenLevel}`;
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
      // cap rendered strands per group so a big fan-out doesn't overwhelm the
      // paper — the dynamic ×N below still reports the true total (the architect 2026-06-19).
      for (let i = 0; i < items.length && i < STRAND_CAP; i++) {
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
        const joinY = ended
          ? Math.max(TOP_PAD, Math.min(timeToY(s.endedAt as number), splitY - arc * 3))
          : TOP_PAD;
        // FORK 2026-06-19: if the subagent crossed a prompt boundary, merge back into ITS
        // OWN turn's trunk column (the first turnEnd after it started), NOT the later turn's
        // — so a helper from the previous prompt never draws a high→max line across the
        // prompt rule into the new turn's column (the architect's "previous call's high into max").
        let joinClampT = s.endedAt as number;
        if (ended && turnOf(joinClampT) !== turnOf(s.startedAt)) {
          joinClampT = this.turnEnds.find((t) => t.endedAt > s.startedAt)?.endedAt ?? joinClampT;
        }
        const joinX = ended ? mainColAt(joinClampT) : col;
        const dimOp = s.dim ? 0.32 : 1;
        // FORK 2026-06-19: how many strands run in parallel at this spawn — shown on
        // hover so mousing over the bunch reads the multiplicity at that moment (the architect).
        const concurrentAtSpawn = subs.filter(
          (x) =>
            !!x.dim === !!s.dim &&
            x.startedAt <= s.startedAt &&
            (x.endedAt ?? Infinity) > s.startedAt,
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
          ` stroke-opacity="${fx(shade.opacity * dimOp)}" stroke-width="${fx(w)}"` +
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
      for (const s of subs) {
        if (s.dim) continue; // the ×N gauge counts the VIEWED session's fan-out only
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
      markers += `<rect ${attrs} x="0" y="${fx(y - 6)}" width="${width}" height="12" fill="transparent">${pTip}</rect>`;
    }

    // ── SUBTLE internal LLM-call separators: a faint short tick at each viewed
    // main-sample (LLM-call) boundary — the within-a-prompt rhythm, distinct from the
    // bold prompt rules above (the architect 2026-06-19).
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
      const zTxtAttr = te.promptText ? ` data-eeg-prompt-text="${esc(te.promptText)}"` : "";
      promptZones +=
        `<rect class="eeg-promptzone" data-eeg-prompt-index="${te.promptIndex}"${zTxtAttr}` +
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
