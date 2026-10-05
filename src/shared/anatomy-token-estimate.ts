/**
 * P11 (context-window-panel.md) — the ONE chars→tokens estimate of the context-anatomy ladder:
 * ceil(chars / 3.5). Rough by design: good enough for anatomy, never for billing.
 *
 * Shared (browser-safe, no imports) so the gateway's anatomy rows (src/agents/context-anatomy.ts)
 * and the UI's call timeline (tinker-ui/src/panels/call-timeline.ts) draw with the same number.
 * canonical-derivations.md caps how many `estimateTokens` implementations the tree may carry:
 * call this one rather than writing another.
 */
export const ANATOMY_CHARS_PER_TOKEN = 3.5;

/** ceil(chars / 3.5); a non-finite or non-positive count is 0 tokens. */
export function estimateTokens(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / ANATOMY_CHARS_PER_TOKEN) : 0;
}
