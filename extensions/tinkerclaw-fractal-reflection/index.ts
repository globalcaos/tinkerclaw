/**
 * FORK: Fractal Reflection extension entry point.
 *
 * Registers an `agent_end` hook that injects a self-reflection prompt into the
 * session after each interactive turn. The 4-level framework (specific, pattern,
 * system, worldview) nudges the agent to think about what it did, find patterns,
 * and improve.
 *
 * Skips automated sessions (subagent, isolated, cron, heartbeat) and applies a
 * per-session debounce (default 30s) to avoid noise.
 *
 * Injection uses callGateway("sessions.send") -- the same path as the
 * sessions_send tool. The prompt lives in fractal-prompt.md within this
 * extension directory.
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  injectFractalReflection,
  isAutomatedSession,
} from "./src/fractal-inject.js";

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "tinkerclaw-fractal-reflection",
  name: "Fractal Reflection",
  description:
    "Post-turn self-reflection with 4-level framework. " +
    "The agent reflects on what it did, finds patterns, and improves.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const enabled = cfg.enabled !== false;
    const debounceMs = (cfg.debounceMs as number) ?? 30_000;

    if (!enabled) {
      api.logger.info("[fractal-reflection] disabled via config");
      return;
    }

    // Resolve extension root directory for prompt loading
    const extensionDir = api.rootDir ?? __dirname;

    // -----------------------------------------------------------------------
    // Hook: agent_end — fires after the full agent run (including tool calls)
    // -----------------------------------------------------------------------
    api.on(
      "agent_end",
      async (
        event: { success?: boolean; durationMs?: number; messages?: unknown[] },
        ctx: { sessionKey?: string; trigger?: string },
      ) => {
        // Only inject after successful runs
        if (event.success === false) {
          return;
        }

        const sessionKey = ctx.sessionKey ?? "";

        // Skip automated sessions
        if (!sessionKey || isAutomatedSession(sessionKey)) {
          return;
        }
        if (ctx.trigger === "heartbeat" || ctx.trigger === "cron") {
          return;
        }

        // Fire-and-forget: don't block the agent lifecycle
        injectFractalReflection({
          sessionKey,
          extensionDir,
          debounceMs,
          messages: event.messages,
          log: api.logger,
        }).catch((err) => {
          api.logger.warn(`[fractal-reflection] unhandled: ${String(err)}`);
        });
      },
    );

    api.logger.info(
      `[fractal-reflection] ready (debounce=${debounceMs}ms, dir=${extensionDir})`,
    );
  },
});
