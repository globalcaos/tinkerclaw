/**
 * FORK: Proactive OAuth Refresh extension entry point.
 *
 * Hooks into gateway lifecycle (`gateway_start` / `gateway_stop`) to start and
 * stop proactive OAuth token refresh. This keeps Claude subscription tokens
 * fresh so the gateway never hits request-time refresh failures after
 * sleep/reboot.
 *
 * Replaces the inline FORK modifications in server.impl.ts — the same
 * `startProactiveOAuthRefresh()` function is called, just wired via the plugin
 * hook system instead of inline code.
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "tinkerclaw-proactive-auth",
  name: "Proactive OAuth Refresh",
  description:
    "Keeps OAuth subscription tokens fresh by proactively refreshing " +
    "them before expiry. Mirrors Claude Code's single-writer refresh approach.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const enabled = cfg.enabled !== false;

    if (!enabled) {
      api.logger.info("[proactive-auth] disabled via config");
      return;
    }

    // Hold a reference to the refresh handle so we can stop it on gateway_stop.
    let refreshHandle: { stop: () => void } | null = null;

    // -----------------------------------------------------------------------
    // Hook: gateway_start — start proactive OAuth token refresh
    // -----------------------------------------------------------------------
    api.on("gateway_start", async (_event: { port: number }) => {
      try {
        // Dynamic import: proactive-refresh.ts lives in the main source tree
        // and uses deep internal modules (auth store, config, file locks).
        // We import it at runtime to avoid bundling issues.
        const { startProactiveOAuthRefresh } =
          await import("../../src/agents/auth-profiles/proactive-refresh.js");
        refreshHandle = startProactiveOAuthRefresh();
        api.logger.info("[proactive-auth] started proactive OAuth refresh");
      } catch (err) {
        api.logger.warn(
          `[proactive-auth] failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // -----------------------------------------------------------------------
    // Hook: gateway_stop — stop proactive OAuth token refresh
    // -----------------------------------------------------------------------
    api.on("gateway_stop", async (_event: { reason?: string }) => {
      if (refreshHandle) {
        refreshHandle.stop();
        refreshHandle = null;
        api.logger.info("[proactive-auth] stopped proactive OAuth refresh");
      }
    });

    api.logger.info("[proactive-auth] ready");
  },
});
