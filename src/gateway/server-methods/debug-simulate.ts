/**
 * FORK 2026-05-12 — `debug.simulate.stuckSession({sessionKey?, ageMs?})`
 *
 * Closes the agent-feedback-symmetry loop in the inverse direction:
 * the bible's `failures.md` declares "M10 stuck session can be diagnosed
 * with `gateway.stuckSessions`". This RPC injects a fake stuck session
 * so the claim is round-trip-tested — without it we just trust the
 * diagnose_with arrow.
 *
 * Why scope it narrowly (one mode only) for now:
 *   - The simulator pattern is the valuable part; the specific failure
 *     modes can be added incrementally as the rest of the simulation
 *     surface area is built out.
 *   - The other failure modes (M1 SIGTERM, M5 plugin-load-fail) need
 *     deeper hooks into pi-agent-core / plugin loader. Out-of-scope
 *     for "make tinkerclaw great again without overdoing it".
 *   - One concrete pattern is easier to copy than a complete API.
 *
 * The injected session is identified by `__simulated: true` so it can
 * be cleaned up by anyone, including the probe-driven self-test flow.
 *
 * Scope: ADMIN_SCOPE. Writes in-memory state — never to be exposed to
 * unauthenticated clients.
 */

import {
  diagnosticSessionStates,
  type SessionState,
} from "../../logging/diagnostic-session-state.js";
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
};
