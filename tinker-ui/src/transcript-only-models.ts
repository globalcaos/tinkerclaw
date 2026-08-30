/**
 * FORK 2026-07-31 — the thinking indicator must name the model that is THINKING.
 *
 * the architect, on the 2026-07-31 gateway restart: "I can see now a thinking indicator
 * that is not orange (the color that would identify anthropic's models) although
 * opus was answering. Also, I can read 'gatewa'."
 *
 * Both symptoms had one cause. `gateway-injected` and `delivery-mirror` are
 * SERVER-SIDE SENTINELS stamped on messages the gateway writes into a transcript
 * itself (`src/gateway/server-methods/chat-transcript-inject.ts`) — most visibly the
 * "Gateway restarted" envelope pushed via `chat.inject` after a restart. They carry
 * provider `openclaw` and they are NOT models anyone ran.
 *
 * The server already treats them as transcript-only (`TRANSCRIPT_ONLY_OPENCLAW_MODELS`
 * in `src/agents/embedded-agent-runner/replay-history.ts`, and the predicate in
 * `src/agents/embedded-agent-subscribe.handlers.messages.ts`). The UI did not, so the
 * indicator painted provider `openclaw` — absent from PROVIDER_COLORS, hence the grey
 * `#6b7280` fallback rather than Anthropic orange — and pushed `gateway-injected`
 * through a `.slice(0, 6)` label fallback, which rendered "gatewa".
 *
 * Extracted into its own module (following the `subagent-color.ts` precedent) so the
 * behaviour is unit-testable instead of buried in the app.ts monolith.
 */

/** Models that only ever exist as transcript bookkeeping, never as a real run. */
export const TRANSCRIPT_ONLY_MODELS: ReadonlySet<string> = new Set([
  "gateway-injected",
  "delivery-mirror",
]);

/** True when `model` is a gateway bookkeeping sentinel rather than a real model. */
export function isTranscriptOnlyModel(model?: string | null): boolean {
  return typeof model === "string" && TRANSCRIPT_ONLY_MODELS.has(model);
}

/**
 * Compact an UNRECOGNISED model label without turning it into gibberish.
 *
 * The previous fallback was a blind `.slice(0, 6)`, which reduced any id the
 * nickname table doesn't know to a meaningless stub ("gateway-injected" → "gatewa").
 * the architect: "I am not against the thinking indicator informing about the internal state
 * of the LLM, but 'gatewa' is not clear enough."
 *
 * So: cut on a separator, so what survives is a whole word, and mark the cut with an
 * ellipsis so a truncated label LOOKS truncated instead of looking like a model
 * nobody has heard of.
 */
export function compactUnknownModelLabel(base: string): string {
  if (base.length <= 8) {
    return base;
  }
  const head = base.split(/[-_/]/)[0] ?? "";
  const label = head.length >= 3 && head.length <= 10 ? head : base.slice(0, 8);
  return label.length < base.length ? `${label}…` : label;
}
