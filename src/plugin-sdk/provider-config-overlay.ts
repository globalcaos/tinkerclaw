/**
 * FORK 2026-05-10 — plugin SDK surface for the runtime provider-config overlay.
 *
 * Plugins import this module to register provider-config defaults that take
 * effect at runtime (in particular `timeoutSeconds`, which the LLM idle
 * watchdog reads). See `src/agents/plugin-provider-config-overlay.ts` for
 * the full rationale.
 */
export {
  registerPluginProviderConfigOverlay,
  type ProviderOverlayConfig,
} from "../agents/plugin-provider-config-overlay.js";
