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
  // FORK 2026-09-02 — the OpenRouter vendors, mapped off the id's middle segment.
  // `tencent` and `xiaomi` point at their MODEL-FAMILY marks on purpose; see the
  // note above PROVIDER_LOGO_SVG's vendor block.
  nvidia: "nvidia",
  meta: "meta",
  tencent: "hunyuan",
  minimax: "minimax",
  xiaomi: "xiaomimimo",
  upstage: "upstage",
  meituan: "longcat",
};

// ─── OpenRouter vendor marks (FORK 2026-09-02) ───
// Raised as outstanding on 2026-08-30 and finished here: 12 models were falling
// through to the neutral routed glyph because we shipped no art for their vendor.
// These are the OFFICIAL brand marks from @lobehub/icons-static-svg@1.94.0 — the
// same source that generated vendor-marks.ts — fetched with `npm pack` into /tmp,
// inlined, and NOT added as a dependency: nothing here is needed at runtime.
//
// Every mark is the vendor's real artwork. None was drawn by hand, which is the
// whole reason this waited: approximating ten trademarks from memory is inventing
// them. Where the package ships a `-color` variant its official colour is used
// verbatim; where it does not, the tint is picked for legibility on the #120e0b
// paper. That is a rendering choice and not a brand claim — the same convention
// vendor-marks.ts states ("Trace colours are NOT the brand colours"), and the mark's
// SHAPE is what carries identity.
//
// TWO ENTRIES ARE PRODUCT MARKS, NOT PARENT-COMPANY MARKS, deliberately: `tencent`
// resolves to HUNYUAN and `xiaomi` to XIAOMI MIMO, because this chart plots models,
// not conglomerates — Tencent the company also makes WeChat. If a Tencent model ever
// ships outside the Hunyuan family, this alias is the line that has to change.
//
// STILL UNCOVERED, and honestly so: Thinking Machines (inkling, inkling-small),
// InclusionAI (ling-3.0-flash) and Nex AGI (nex-n2-pro) ship no mark in the package
// — verified by name and by parent org. Those four models keep the neutral glyph.
// official NVIDIA green, straight off the package's -color variant
PROVIDER_LOGO_SVG["nvidia"] =
  `<svg width="14" height="14" fill="#74B71B" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z"></path></svg>`;
// official Meta blue from the -color variant
PROVIDER_LOGO_SVG["meta"] =
  `<svg width="14" height="14" fill="#0082FB" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z"></path></svg>`;
// the LIGHTER of Hunyuan's two official blues (#0055E9/#00BCFF) — the dark one sinks into the #120e0b paper at 14px
PROVIDER_LOGO_SVG["hunyuan"] =
  `<svg width="14" height="14" fill="#00BCFF" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0c6.627 0 12 5.373 12 12s-5.373 12-12 12S0 18.627 0 12 5.373 0 12 0zm1.652 1.123l-.01-.001c.533.097 1.023.233 1.41.404 6.084 2.683 7.396 9.214 1.601 14.338a3.781 3.781 0 01-5.337-.328 3.654 3.654 0 01-.884-3.044c-1.934.6-3.295 2.305-3.524 4.45-.204 1.912.324 4.044 2.056 5.634l.245.067C10.1 22.876 11.036 23 12 23c6.075 0 11-4.925 11-11 0-5.513-4.056-10.08-9.348-10.877zM2.748 6.21c-.178.269-.348.536-.51.803l-.235.394.078-.167A10.957 10.957 0 001 12c0 4.919 3.228 9.083 7.682 10.49l.214.065C3.523 18.528 2.84 14.149 6.47 8.68A2.234 2.234 0 102.748 6.21zm10.157-5.172c4.408 1.33 3.61 5.41 2.447 6.924-.86 1.117-2.922 1.46-3.708 2.238-.666.657-1.077 1.462-1.212 2.291A5.303 5.303 0 0112 12.258a5.672 5.672 0 001.404-11.169 10.51 10.51 0 00-.5-.052z"></path></svg>`;
// official LongCat green from the -color variant
PROVIDER_LOGO_SVG["longcat"] =
  `<svg width="14" height="14" fill="#29E154" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M.507 19.883a.507.507 0 01-.489-.642L4.29 3.745a1.013 1.013 0 011.533-.578l5.622 3.687a1.013 1.013 0 001.11 0L18.2 3.165a1.013 1.013 0 011.532.58l4.25 15.497a.506.506 0 01-.49.64H18.07a6.297 6.297 0 001.53-4.115v-.177a6.09 6.09 0 00-1.513-4.017l-.697-3.495a.438.438 0 00-.694-.266L14.07 9.781a.748.748 0 01-.654.121 5.156 5.156 0 00-2.833 0 .746.746 0 01-.653-.121L7.302 7.81a.435.435 0 00-.688.269l-.675 3.652a5.36 5.36 0 00-1.539 3.76v.333c0 1.474.527 2.9 1.488 4.02l.032.038H.507z"></path><path d="M9.213 16.843h1.52v-3.546h-1.29l-.23 3.546zm5.573 0h-1.52v-3.546h1.29l.23 3.546z"></path></svg>`;
// no -color variant shipped; warm red picked for legibility, per this file's standing rule that a tint is a rendering choice, not a brand claim
PROVIDER_LOGO_SVG["minimax"] =
  `<svg width="14" height="14" fill="#FF6B5A" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"></path></svg>`;
// no -color variant shipped; Xiaomi's orange family, picked for legibility
PROVIDER_LOGO_SVG["xiaomimimo"] =
  `<svg width="14" height="14" fill="#FF7A33" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z"></path></svg>`;
// no -color variant shipped; violet, chosen to clear the blues and greens above it
PROVIDER_LOGO_SVG["upstage"] =
  `<svg width="14" height="14" fill="#A88BFF" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19.763 0l-.373 1.297h2.594L22.354 0h-2.591z"></path><path d="M16.192 2.27l-.376 1.298h5.52l.37-1.298h-5.514z"></path><path d="M12.897 4.54l-.377 1.298h8.167l.37-1.297h-8.16z"></path><path d="M2.85 6.81l-.377 1.298h17.565l.37-1.297H2.85z"></path><path d="M3.884 9.081l-.376 1.297H19.39l.37-1.297H3.883z"></path><path d="M4.088 24l.376-1.297H1.866L1.5 24h2.588z"></path><path d="M7.662 21.73l.376-1.298H2.515L2.15 21.73h5.513z"></path><path d="M10.957 19.46l.377-1.298h-8.17l-.367 1.297h8.16z"></path><path d="M21.005 17.19l.376-1.298H3.812l-.366 1.297h17.559z"></path><path d="M19.967 14.919l.376-1.297H4.461l-.366 1.297h15.872z"></path><path d="M18.787 12.649l.376-1.298H4.26l-.366 1.298h14.893z"></path></svg>`;

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
 * Step 2 is what recovers `openrouter/google/gemini-3.7-flash` and
 * `openrouter/anthropic/claude-fable-5.1`: the vendor is stated verbatim in the id
 * and was simply never read, because vendorOfModel() only pattern-matches the four
 * Chinese labs.
 *
 * FORK 2026-09-02: this note used to cite `openrouter/openai/gpt-5.3-codex` and
 * `openrouter/anthropic/claude-opus-5-fast`. The architect banned OpenRouter routes
 * that duplicate a vendor we hold a direct subscription with, and both ids left the
 * catalog. Nothing in the CODE changed: ROUTED_VENDOR_ALIASES is keyed on the id's
 * middle SEGMENT, not on any model, so the `openai` and `anthropic` aliases stay and
 * keep resolving whatever routed id arrives next.
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
