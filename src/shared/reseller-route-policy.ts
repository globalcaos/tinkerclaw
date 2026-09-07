/**
 * Never route a model through a reseller when we hold a DIRECT subscription with its vendor.
 *
 * FORK 2026-09-02 (the architect): "No claude models should ever route through openrouter,
 * since we have a 20x subscription that makes it way cheaper ... make sure no models are
 * routed through openrouter if we have a direct subscription (which includes gemini, gpt,
 * grok and claude)."
 *
 * WHY THIS IS A PREDICATE AND NOT A DELETION. The obvious reading of that instruction is
 * "remove the offending rows", and the rows were removed. But a deleted row does not stop a
 * route: the Herbalist tab spent 2026-09-02 dead-ending on `openrouter/anthropic/claude-fable-5.1`
 * — a route already absent from `openclaw.json` — because the Tinker model slider had pinned it
 * in the BROWSER's localStorage and re-sent it as a `chat.send({model})` parameter on every
 * turn. That OpenRouter key had $0.0088 of credit left, so each turn returned a 402 and, with
 * `agents.defaults.model.fallbacks` empty, the failure was terminal (`next=none`). The
 * identical model was sitting on the subscription the whole time. A list you edit protects you
 * once; a predicate the surfaces read protects you every time.
 *
 * THE VETO IS BY VENDOR NAMESPACE, NOT BY MODEL NAME. `openrouter/anthropic/<anything>` is
 * refused, so a new Anthropic, OpenAI, Google or xAI model appearing on OpenRouter is caught
 * the day it appears, with nobody editing a list. Naming individual models would put us back
 * to maintaining exactly the kind of allowlist that goes stale silently.
 *
 * WHAT IT MUST NOT DO. Most OpenRouter models have no direct route at all — deepseek, z-ai,
 * qwen, moonshot, meta, minimax. OpenRouter is the ONLY way to reach them, and vetoing those
 * would delete capability rather than save money. Hence a vendor SET, not a blanket
 * `startsWith("openrouter/")`.
 *
 * The price gap this protects is not marginal: `openrouter/anthropic/claude-opus-5-fast`
 * carried relCost 50.0 ($10/$50 per Mtok) at an intelligence index of 63.0532 — the SAME index
 * as `claude-code/claude-opus-5`, which rides the Max 20x subscription at roughly EUR0.15/Mtok
 * amortised. Same model, same measured intelligence, two orders of magnitude apart in cost.
 *
 * Dependency-free on purpose: imported by the gateway (`src/`) and the browser (`tinker-ui/`)
 * alike, the same way `src/shared/rel-cost-table.ts` and `src/shared/thalamus-candidates.ts`
 * are, so both boundaries decide with ONE rule instead of two that drift.
 */

/**
 * OpenRouter vendor namespaces we can reach directly, on a subscription we already pay for.
 *
 * `x-ai` is OpenRouter's spelling; `xai` is ours (the provider id in `openclaw.json`). Both are
 * listed because this predicate is fed catalog ids from both sides.
 */
export const DIRECT_SUBSCRIPTION_VENDORS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "xai",
]);

/**
 * True when `modelId` reaches a direct-subscription vendor the long way round, via OpenRouter.
 *
 * Shape is `openrouter/<vendor>/<model>`; anything shorter carries no model to veto and is
 * accepted rather than thrown on, so a malformed or partial id degrades to "not our problem"
 * instead of taking a render path down with it.
 */
export function isRedundantResellerRoute(modelId: string): boolean {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return false;
  }
  const parts = modelId.split("/");
  if (parts.length < 3 || parts[0] !== "openrouter") {
    return false;
  }
  return DIRECT_SUBSCRIPTION_VENDORS.has(parts[1].toLowerCase());
}
