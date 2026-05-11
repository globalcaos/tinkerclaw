/**
 * FORK 2026-05-11 — plugin.boot.status — J15 RSC probe for plugin
 * registry state. Surfaces per-plugin `{id, name, status, error,
 * failurePhase, failedAt, version, gatewayMethods, toolNames,
 * channelIds, providerIds}` for every plugin the gateway tried to load
 * (loaded / disabled / error).
 *
 * Replaces the journal-grep pattern `[plugins] ... failed to load`
 * with a single tool call. Targets bible's M5 (native-deps missing)
 * and M6 (configSchema missing) failure modes — both used to require
 * scrolling boot logs to enumerate.
 *
 * Scope: READ_SCOPE. No credentials, no rebound capability — only
 * inspection-grade state already exposed via the in-memory plugin
 * registry.
 */
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import type { GatewayRequestHandlers } from "./types.js";

const MAX_ROWS = 200;
const MAX_ERROR_CHARS = 600;

function summarizeError(error: string | undefined): string | null {
  if (!error) return null;
  if (error.length <= MAX_ERROR_CHARS) return error;
  return `${error.slice(0, MAX_ERROR_CHARS)}…(truncated)`;
}

export const pluginProbesHandlers: GatewayRequestHandlers = {
  "plugin.boot.status": async ({ params, respond }) => {
    const p = (params ?? {}) as { id?: unknown; status?: unknown };
    const filterId = typeof p.id === "string" ? p.id.trim() : undefined;
    const filterStatus = typeof p.status === "string" ? p.status.trim() : undefined;

    const state = getPluginRegistryState();
    const registry = state?.activeRegistry;
    if (!registry) {
      respond(
        true,
        {
          error: "plugin registry not initialized — gateway boot may still be in progress",
          totalPlugins: 0,
          byStatus: { loaded: 0, disabled: 0, error: 0 },
          plugins: [],
        },
        undefined,
      );
      return;
    }
    const allPlugins = registry.plugins ?? [];
    let loaded = 0;
    let disabled = 0;
    let errored = 0;
    const rows = [];
    for (const r of allPlugins) {
      if (r.status === "loaded") loaded += 1;
      else if (r.status === "disabled") disabled += 1;
      else if (r.status === "error") errored += 1;
      if (filterId && r.id !== filterId && r.name !== filterId) continue;
      if (filterStatus && r.status !== filterStatus) continue;
      rows.push({
        id: r.id,
        name: r.name,
        version: r.version ?? null,
        status: r.status,
        enabled: r.enabled,
        explicitlyEnabled: r.explicitlyEnabled ?? null,
        origin: r.origin,
        source: r.source,
        error: summarizeError(r.error),
        failurePhase: r.failurePhase ?? null,
        failedAt: r.failedAt ? r.failedAt.toISOString() : null,
        configSchema: r.configSchema,
        // counts so we can tell at a glance what a plugin contributes
        gatewayMethods: r.gatewayMethods ?? [],
        toolCount: (r.toolNames ?? []).length,
        channelCount: (r.channelIds ?? []).length,
        providerCount: (r.providerIds ?? []).length,
        cliBackendCount: (r.cliBackendIds ?? []).length,
        hookCount: r.hookCount ?? 0,
        httpRouteCount: r.httpRoutes ?? 0,
      });
    }
    // Sort: errors first (most actionable), then disabled, then loaded; within
    // each bucket sort alphabetically.
    rows.sort((a, b) => {
      const rank = (s: string) => (s === "error" ? 0 : s === "disabled" ? 1 : 2);
      const diff = rank(a.status) - rank(b.status);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });
    respond(
      true,
      {
        totalPlugins: allPlugins.length,
        byStatus: { loaded, disabled, error: errored },
        returned: Math.min(rows.length, MAX_ROWS),
        plugins: rows.slice(0, MAX_ROWS),
      },
      undefined,
    );
  },
};
