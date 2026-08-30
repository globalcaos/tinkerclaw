// tinker-ui/src/panels/provider-logos.ts
// FORK: Provider logo SVGs and color constants for Tinker UI panels.

import { VENDOR_MARKS, vendorOfModel } from "./vendor-marks.js";

const ASSET_BASE = import.meta.env.BASE_URL ?? "/";

const ANTHROPIC_LOGO_SVG = `<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="12,1 13.5,8.3 19.8,4.2 15.7,10.5 23,12 15.7,13.5 19.8,19.8 13.5,15.7 12,23 10.5,15.7 4.2,19.8 8.3,13.5 1,12 8.3,10.5 4.2,4.2 10.5,8.3" fill="#D97757"/></svg>`;

// FORK 2026-08-04 (the architect: "Copilot still has the blue logo, change it for its
// mostly-used colorful one"). The 2023 PNG was the blue/purple ribbon; this is the
// current multi-colour Copilot mark (17 colours, blue→magenta→amber). SVG rather
// than PNG so it stays crisp at 14px and needs no retina twin.
const COPILOT_LOGO_IMG = `<img src="${ASSET_BASE}copilot-logo.svg" width="14" height="14" alt="Copilot" style="display:block"/>`;

export const PROVIDER_LOGO_SVG: Record<string, string> = {
  anthropic: ANTHROPIC_LOGO_SVG,
  // FORK: tinker-bridge = claude CLI; keep Anthropic branding in timeline/treemap.
  "claude-code": ANTHROPIC_LOGO_SVG,
  google: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke-width="2"><animate attributeName="stroke" values="#4285f4;#ea4335;#fbbc04;#34a853;#4285f4" dur="4s" repeatCount="indefinite"/></circle><circle cx="7" cy="7" r="3" fill="url(#gg)"/><defs><radialGradient id="gg"><stop offset="0%" stop-color="#4285f4"/><stop offset="100%" stop-color="#34a853"/></radialGradient></defs></svg>`,
  // FORK 2026-08-28 (the architect: chart ChatGPT bubbles used a white "AI" disc).
  // Same blossom as PROVIDER_ICONS.openai in app.ts (models panel), tinted the
  // EEG / circle colour #10A37F so the mark and the ring agree.
  openai: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22.28 9.37a5.88 5.88 0 0 0-.51-4.86 5.97 5.97 0 0 0-6.43-2.83A5.9 5.9 0 0 0 10.87 0a5.97 5.97 0 0 0-5.69 4.13 5.88 5.88 0 0 0-3.93 2.85 5.97 5.97 0 0 0 .74 6.99 5.88 5.88 0 0 0 .51 4.86 5.97 5.97 0 0 0 6.43 2.83A5.9 5.9 0 0 0 13.4 24a5.97 5.97 0 0 0 5.69-4.13 5.88 5.88 0 0 0 3.93-2.85 5.97 5.97 0 0 0-.74-6.99zM13.4 22.3a4.42 4.42 0 0 1-2.84-1.03l.14-.08 4.72-2.73a.77.77 0 0 0 .39-.67v-6.66l2 1.15a.07.07 0 0 1 .04.06v5.52a4.46 4.46 0 0 1-4.46 4.44zM3.48 18.2a4.42 4.42 0 0 1-.53-2.97l.14.08 4.72 2.73a.77.77 0 0 0 .77 0l5.76-3.33v2.31a.07.07 0 0 1-.03.06l-4.77 2.76a4.46 4.46 0 0 1-6.06-1.64zM2.2 7.87A4.42 4.42 0 0 1 4.52 5.9v5.62a.77.77 0 0 0 .39.67l5.76 3.33-2 1.15a.07.07 0 0 1-.07 0L3.83 13.9A4.46 4.46 0 0 1 2.2 7.87zm17.33 4.03l-5.76-3.33 2-1.15a.07.07 0 0 1 .07 0l4.77 2.76a4.46 4.46 0 0 1-.69 8.05v-5.66a.77.77 0 0 0-.39-.67zM21.5 9.7l-.14-.08-4.72-2.73a.77.77 0 0 0-.77 0L10.1 10.2V7.9a.07.07 0 0 1 .03-.06l4.77-2.76a4.46 4.46 0 0 1 6.6 4.62zM8.93 13.34l-2-1.15a.07.07 0 0 1-.04-.06V6.61a4.46 4.46 0 0 1 7.3-3.42l-.14.08-4.72 2.73a.77.77 0 0 0-.39.67zm1.08-2.34L12 9.77l1.99 1.15v2.3L12 14.36l-1.99-1.15z" fill="#10A37F"/></svg>`,
  "github-copilot": COPILOT_LOGO_IMG,
  ollama: `<svg width="14" height="14" viewBox="0 0 14 14"><rect width="14" height="14" rx="3" fill="#ff6b35"/><text x="7" y="11" text-anchor="middle" font-size="9">🦙</text></svg>`,
  // FORK 2026-07-21 (the architect): Grok/xAI "planet with one ring" mark (white on dark).
  xai: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18.6 8.9 A7.3 7.3 0 0 1 8.9 18.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M5.4 15.1 A7.3 7.3 0 0 1 15.1 5.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M3.2 20.8 L8 16 M16 8 L20.8 3.2" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>`,
};
PROVIDER_LOGO_SVG.grok = PROVIDER_LOGO_SVG.xai;
// FORK 2026-07-22 (the architect): codex / openai-codex (gpt-5.5/5.6 on the ChatGPT sub)
// = OpenAI mark.
PROVIDER_LOGO_SVG.codex = PROVIDER_LOGO_SVG.openai;
PROVIDER_LOGO_SVG["openai-codex"] = PROVIDER_LOGO_SVG.openai;

// Neutral "reached through a router, vendor unidentified" glyph — three nodes and a
// branch, in the chart's own cream at low weight so it never reads as a brand. This
// is what an unknown provider gets instead of somebody else's logo.
const UNKNOWN_MARK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12h4M14 7h6M14 17h6" stroke="#b9ab97" stroke-width="1.8" stroke-linecap="round"/><path d="M8 12c0-2.8 2.2-5 6-5M8 12c0 2.8 2.2 5 6 5" stroke="#b9ab97" stroke-width="1.8" stroke-linecap="round"/><circle cx="3.4" cy="12" r="1.7" fill="#b9ab97"/><circle cx="20.6" cy="7" r="1.7" fill="#b9ab97"/><circle cx="20.6" cy="17" r="1.7" fill="#b9ab97"/></svg>`;

// The vendor segment of a routed id (`openrouter/<vendor>/<model>`) mapped onto the
// PROVIDER_LOGO_SVG keys. Only vendors whose official art we already ship appear
// here — this table resolves identity, it never invents it.
const ROUTED_VENDOR_ALIASES: Record<string, string> = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
  "x-ai": "xai",
};

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97757",
  "claude-code": "#D97757",
  google: "#8ab4f8",
  openai: "#ccc",
  "github-copilot": "#00A4EF",
  ollama: "#ff9b6b",
  xai: "#111",
  grok: "#111",
  unknown: "#8b949e",
};

export const PROVIDER_BORDER_COLORS: Record<string, string> = {
  anthropic: "#6e40c9",
  "claude-code": "#6e40c9",
  google: "#1a73e8",
  openai: "#444",
  "github-copilot": "#0078D4",
  ollama: "#ff6b35",
  unknown: "#30363d",
};

export function getProviderColor(provider: string): string {
  return PROVIDER_COLORS[provider] ?? PROVIDER_COLORS.unknown;
}

export function getProviderBorderColor(provider: string): string {
  return PROVIDER_BORDER_COLORS[provider] ?? PROVIDER_BORDER_COLORS.unknown;
}

// FORK 2026-08-30 (the architect: "openrouter bubbles have the wrong icon"). This function
// used to default to PROVIDER_LOGO_SVG.anthropic, which made it a LIE GENERATOR: for
// any provider it did not know it returned a specific vendor's registered trademark
// as though that were the answer. `openrouter` is not in the table, so 15 of the 99
// models on the smart x cost chart wore the Claude sparkle — NVIDIA, Meta, Tencent,
// MiniMax, Xiaomi, Meituan and friends all branded as Anthropic.
//
// The defect was DOCUMENTED at getModelLogoSvg below since 2026-08-04 ("painted a
// Claude sparkle next to a Kimi model") and the fix applied there was to add a second
// function callers were told to prefer. That left the loaded gun in place: two
// callers still reach for this one (smart-cost-chart scLogoFor, prefrontal-tree), and
// a caller that forgets the convention gets a wrong brand rather than an error.
//
// An unknown provider now returns a NEUTRAL routed mark. Being unidentified is a fact
// the chart is allowed to show; being mislabelled as a competitor is not.
export function getProviderLogoSvg(provider: string): string {
  return PROVIDER_LOGO_SVG[provider] ?? UNKNOWN_MARK_SVG;
}

/**
 * The mark for a model reached THROUGH a router, resolved in falling order of how
 * much identity we can actually prove:
 *
 *   1. the vendor mark keyed off the model id (Kimi/Qwen/GLM/DeepSeek),
 *   2. the vendor named in the id's MIDDLE segment — `openrouter/<vendor>/<model>` —
 *      when that vendor is one whose official art we already ship,
 *   3. the provider's own mark,
 *   4. a neutral routed glyph.
 *
 * Step 2 is what recovers `openrouter/google/gemini-3.7-flash`,
 * `openrouter/openai/gpt-5.3-codex` and `openrouter/anthropic/claude-opus-5-fast`:
 * the vendor is stated verbatim in the id and was simply never read, because
 * vendorOfModel() only pattern-matches the four Chinese labs.
 *
 * There is deliberately NO step that guesses. Vendors we hold no art for (NVIDIA,
 * Meta, Tencent, MiniMax, Xiaomi, Meituan, Upstage, Thinking Machines, Nex AGI,
 * InclusionAI) land on the neutral glyph and are told apart by their bubble colour
 * and label, which is honest. Their real marks need the @lobehub/icons-static-svg
 * package that generated vendor-marks.ts and is no longer installed.
 */
export function getRoutedLogoSvg(modelId: string, provider: string): string {
  const byModel = getModelLogoSvg(modelId);
  if (byModel) return byModel;
  const seg = (modelId || "").split("/");
  if (seg.length >= 3) {
    const alias = ROUTED_VENDOR_ALIASES[seg[1].toLowerCase()];
    if (alias && PROVIDER_LOGO_SVG[alias]) return PROVIDER_LOGO_SVG[alias];
  }
  return PROVIDER_LOGO_SVG[provider] ?? UNKNOWN_MARK_SVG;
}

// FORK 2026-08-04 (the architect): the OpenRouter vendors (Kimi, Qwen, GLM, DeepSeek) all
// report provider "openrouter", so getProviderLogoSvg fell through to its Anthropic
// default and painted a Claude sparkle next to a Kimi model. Identity for these is
// carried by the MODEL id, so callers that have one should prefer this function and
// fall back to getProviderLogoSvg only when THIS function returns undefined
// (getProviderLogoSvg itself never does — it always defaults to the sparkle).
// CAVEAT: vendorOfModel() is first-match-wins and tests qwen before deepseek, so a
// cross-vendor id like "deepseek/deepseek-r1-distill-qwen-32b" resolves to qwen.
// That ordering fix belongs in vendor-marks.ts, not here.
export function getModelLogoSvg(modelId: string): string | undefined {
  const key = vendorOfModel(modelId);
  return key ? VENDOR_MARKS[key]?.svg : undefined;
}

// Row/glow colour for those same models. Deliberately the EEG *trace* colour, not the
// brand colour: the trace palette is separability-tuned (GLM's trace is green while its
// mark is blue), so a model's row glow agrees with its seismograph trace — NOT with the
// brand fill inside its logo.
export function getModelAccentColor(modelId: string): string | undefined {
  const key = vendorOfModel(modelId);
  return key ? VENDOR_MARKS[key]?.trace : undefined;
}
