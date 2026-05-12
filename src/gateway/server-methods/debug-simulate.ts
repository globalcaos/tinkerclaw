/**
 * FORK 2026-05-12 — failure-mode simulators for round-trip-testing the
 * bible's `manifest_via:` ↔ `diagnose_with:` symmetry (design-principle #13).
 *
 * Each simulator injects a controlled fault into in-memory state and
 * returns a token the corresponding probe should report. Pair every
 * simulator with a `clear` action so tests can deterministically reset.
 *
 * Current simulators (failures.md mapping):
 *   - `debug.simulate.stuckSession`   ↔ M10 (stuck session.status=running)
 *   - `debug.simulate.pluginLoadFail` ↔ M5  (plugin native-deps missing at boot)
 *
 * Scope: ADMIN_SCOPE. Writes in-memory state — never to be exposed to
 * unauthenticated clients.
 */

import {
  diagnosticSessionStates,
  type SessionState,
} from "../../logging/diagnostic-session-state.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_AGE_MS = 120_000; // 2 minutes — well past the stuck threshold

export const debugSimulateHandlers: GatewayRequestHandlers = {
  "debug.simulate.stuckSession": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      sessionKey?: unknown;
      sessionId?: unknown;
      ageMs?: unknown;
      action?: unknown; // "inject" (default) or "clear"
    };
    const action = typeof p.action === "string" ? p.action : "inject";
    const sessionKey =
      typeof p.sessionKey === "string" && p.sessionKey.trim()
        ? p.sessionKey.trim()
        : `__simulated:${Date.now()}`;

    if (action === "clear") {
      // Clear any simulated entries (the key we created, plus any leftovers).
      let removed = 0;
      for (const [key, state] of diagnosticSessionStates.entries()) {
        if (
          key.startsWith("__simulated:") ||
          (state as SessionState & { __simulated?: boolean }).__simulated === true
        ) {
          diagnosticSessionStates.delete(key);
          removed += 1;
        }
      }
      respond(true, { action: "clear", removed }, undefined);
      return;
    }

    let ageMs = DEFAULT_AGE_MS;
    if (typeof p.ageMs === "number" && Number.isFinite(p.ageMs) && p.ageMs > 0) {
      ageMs = Math.min(Math.floor(p.ageMs), 60 * 60 * 1000); // cap at 1 hour
    }

    const sessionId = typeof p.sessionId === "string" ? p.sessionId : `sim-${Date.now()}`;
    const simulated: SessionState & { __simulated: true } = {
      sessionId,
      sessionKey,
      lastActivity: Date.now() - ageMs,
      state: "processing",
      queueDepth: 0,
      __simulated: true,
    };
    diagnosticSessionStates.set(sessionKey, simulated);

    respond(
      true,
      {
        action: "inject",
        sessionKey,
        sessionId,
        ageMs,
        note: "call gateway.stuckSessions to confirm; call this RPC with {action:'clear'} to remove.",
      },
      undefined,
    );
  },

  /**
   * `debug.simulate.pluginLoadFail({pluginId?, action?})` — M5 manifest_via.
   *
   * Injects a fake failure record into the in-memory PluginRegistry so
   * `plugin.boot.status({status:"error"})` reports it. The injected plugin's
   * id is prefixed `__simulated-` so cleanup is deterministic.
   *
   * Modes:
   *   - `inject` (default): add a fake plugin record with status=error.
   *   - `clear`: remove every plugin record whose id starts with `__simulated-`.
   */
  "debug.simulate.pluginLoadFail": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      pluginId?: unknown;
      action?: unknown;
      failurePhase?: unknown;
      error?: unknown;
    };
    const action = typeof p.action === "string" ? p.action : "inject";
    const state = getPluginRegistryState();
    const registry = state?.activeRegistry;
    if (!registry || !Array.isArray(registry.plugins)) {
      respond(
        true,
        { error: "plugin registry not initialized (gateway may still be booting)" },
        undefined,
      );
      return;
    }

    if (action === "clear") {
      const before = registry.plugins.length;
      registry.plugins = registry.plugins.filter(
        (r) => !r.id.startsWith("__simulated-"),
      ) as typeof registry.plugins;
      respond(true, { action: "clear", removed: before - registry.plugins.length }, undefined);
      return;
    }

    const pluginId =
      typeof p.pluginId === "string" && p.pluginId.trim()
        ? p.pluginId.trim()
        : `__simulated-${Date.now()}`;
    const failurePhase =
      p.failurePhase === "validation" || p.failurePhase === "register" ? p.failurePhase : "load";
    const errorMessage =
      typeof p.error === "string" && p.error.trim()
        ? p.error.trim()
        : "Cannot find module '@sinclair/typebox' (simulated)";

    // Construct a minimal PluginRecord with all required fields. Cast to the
    // registry's array shape — we only fill the fields plugin.boot.status reads.
    const record = {
      id: pluginId,
      name: pluginId,
      version: "0.0.0-simulated",
      source: "(simulated)",
      origin: "bundled",
      enabled: true,
      status: "error",
      error: errorMessage,
      failedAt: new Date(),
      failurePhase,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: [],
      memoryEmbeddingProviderIds: [],
      agentHarnessIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServiceIds: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry.plugins as any[]).push(record);

    respond(
      true,
      {
        action: "inject",
        pluginId,
        failurePhase,
        error: errorMessage,
        note: "call plugin.boot.status with {status:\"error\"} to confirm; clear with {action:'clear'}.",
      },
      undefined,
    );
  },
};
