/**
 * FORK 2026-08-08 — what belongs on the EEG paper, and how loudly (spec:
 * docs/superpowers/specs/2026-08-08-eeg-all-scope-spend-clock-design.md).
 *
 * Pure classification, deliberately split from both the clock and the renderer: "which sessions am
 * I showing" is a policy question that has been answered inconsistently in three places before, and
 * policy that lives inside a 1200-line draw function cannot be tested.
 *
 * THE HONESTY RULE. The architect chose "the €1 grid means €1 of TOTAL spend". That invariant is
 * only true if everything that costs money is on the paper — so background system lanes (fractal
 * reflection, crons, title-suggest, the orchestrator) are DRAWN, merely recessed, rather than
 * dropped. When they are muted the axis label MUST change. A meter that reads like a total while
 * showing a subset is exactly the failure that let a €146 OpenRouter burn run unnoticed for three
 * days; this module refuses to reproduce it.
 */

/** How prominently a sample is drawn. Hue always stays the provider's brand paint. */
export type EegRenderClass =
  /** The tab being viewed (and the fan-out it initiated): solid fill. */
  | "viewed"
  /** Another human tab: same provider hue, outline only — no extra layout space needed. */
  | "other-tab"
  /** Non-tab machinery: thin, low-chroma, no branch fan. Infrastructure, not conversation. */
  | "background";

export type EegScope = "session" | "all";

export interface EegScopeDeps {
  /** Is this session key one of the UI's tabs at all (vs an orchestrator/cron/reflection lane)? */
  isTab: (sessionKey: string) => boolean;
  /** Does this key resolve to the viewed tab — the tab itself, or work it initiated? */
  belongsToViewedTab: (sessionKey: string) => boolean;
}

/**
 * Classify one sample's session key.
 *
 * Order matters: ownership by the viewed tab wins over everything, so a fan-out leg the viewed tab
 * launched renders solid even though the leg's own key is not a tab key.
 */
export function eegRenderClassOf(sessionKey: string, deps: EegScopeDeps): EegRenderClass {
  const sk = sessionKey || "";
  if (deps.belongsToViewedTab(sk)) return "viewed";
  if (deps.isTab(sk)) return "other-tab";
  return "background";
}

/** Is a classified sample drawn at all, under this scope and mute setting? */
export function eegIsInScope(
  cls: EegRenderClass,
  scope: EegScope,
  backgroundMuted: boolean,
): boolean {
  if (scope === "session") return cls === "viewed";
  if (cls === "background") return !backgroundMuted;
  return true;
}

/**
 * The gutter/axis label. This is not decoration — it is the honesty contract of the instrument, so
 * it is derived from the same inputs that decide what is drawn, and never written by hand at a call
 * site.
 *
 * `backgroundPresent` distinguishes "muted and therefore incomplete" from "muted but there was
 * nothing to hide anyway", so the alarming label only appears when it is actually true.
 */
export function eegAxisLabel(
  scope: EegScope,
  backgroundMuted: boolean,
  backgroundPresent: boolean,
): string {
  if (scope === "session") return "€ this tab";
  if (backgroundMuted && backgroundPresent) return "€ shown spend";
  return "€ total spend";
}
