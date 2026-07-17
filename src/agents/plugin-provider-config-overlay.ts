/**
 * FORK 2026-05-10 — runtime overlay for plugin-supplied provider config defaults.
 *
 * **Problem this solves.** Plugins that drive a provider (e.g. tinker-bridge for
 * `claude-code`) ship sensible runtime defaults via their `discovery.run`
 * callback — most importantly `timeoutSeconds`. Today those defaults are
 * consumed only when WRITING `models.json` (see `models-config.plan.ts`
 * `mergeProviders`). At gateway runtime, `resolveConfiguredProviderConfig`
 * reads from `cfg.models.providers[provider]` (i.e. the explicit
 * `openclaw.json` block) and ignores plugin discovery entirely. Net effect:
 * every plugin-supplied default that matters at runtime (timeoutSeconds for
 * the LLM idle watchdog being the canonical one) has to be *duplicated*
 * into `openclaw.json` by hand or it silently doesn't take effect.
 *
 * The 2026-05-05 fix that put `timeoutSeconds: 600` into the tinker-bridge
 * catalog was load-bearing in spirit but dead code in practice — it never
 * reached `applyConfiguredProviderOverrides → resolveProviderRequestTimeoutMs
 * → params.model.requestTimeoutMs → resolveLlmIdleTimeoutMs`. The watchdog
 * stayed at 120s. Heavy turns SIGTERMed and surfaced as `🤖 ⚠️ Something went
 * wrong while processing your request.` for the user.
 *
 * **What this module does.** A simple module-level map. Plugins call
 * `registerPluginProviderConfigOverlay(providerId, partial)` from their
 * `register()` hook (synchronous, runs before any model resolution).
 * `resolveConfiguredProviderConfig` then merges `{...overlay, ...explicit}`
 * so explicit values from `openclaw.json` still win on a per-key basis but
 * the plugin's defaults flow through for keys the user never set.
 *
 * Today the only key that matters is `timeoutSeconds`; the type is wide
 * (Partial<ProviderOverlayConfig>) so future plugins can supply defaults
 * for `baseUrl`, `headers`, etc. without changing this module.
 */

export type ProviderOverlayConfig = {
  timeoutSeconds?: number;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string | undefined>;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
};

const overlay = new Map<string, ProviderOverlayConfig>();

/**
 * Register plugin-supplied defaults for a provider. Subsequent calls with
 * the same providerId merge (later keys win). Plugins should call this in
 * their `register()` hook so the overlay is populated before the first
 * model resolution runs.
 */
export function registerPluginProviderConfigOverlay(
  providerId: string,
  partial: ProviderOverlayConfig,
): void {
  const id = providerId.trim();
  if (!id) {
    return;
  }
  const existing = overlay.get(id);
  overlay.set(id, { ...(existing ?? {}), ...partial });
}

/**
 * Read the overlay for a provider, or undefined if no plugin has registered
 * defaults. Returns the live object — callers must NOT mutate it.
 */
export function getPluginProviderConfigOverlay(
  providerId: string,
): ProviderOverlayConfig | undefined {
  return overlay.get(providerId.trim());
}

/**
 * Test-only reset. Not exported via the plugin SDK; used by unit tests.
 */
export function clearPluginProviderConfigOverlayForTests(): void {
  overlay.clear();
}
