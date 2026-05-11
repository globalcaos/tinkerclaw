/**
 * FORK 2026-05-11 — J15 RSC live-system probes for the gateway itself.
 *
 *   gateway.stuckSessions({thresholdMs?})
 *     READ_SCOPE. Returns the same data the journal `[diagnostic] stuck
 *     session: …` line emits, but as a single tool call instead of a
 *     `journalctl --grep` against the live host. Threshold defaults to
 *     60_000ms so an inspection picks up sessions that are starting to
 *     drift, not just ones already past the warn threshold.
 *
 *   gateway.diagnosticSessionCount()
 *     Bounded sanity probe for the diagnosticSessionStates map size.
 *     Cheap; used to verify the map isn't leaking entries.
 *
 * Both surface live in-memory state and never touch credentials.
 */

import {
  diagnosticSessionStates,
  type SessionState,
} from "../../logging/diagnostic-session-state.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_THRESHOLD_MS = 60_000;
const MAX_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const MAX_RETURNED = 50;

function pickStuck(now: number, thresholdMs: number): Array<Record<string, unknown>> {
  const rows: Array<{ ageMs: number; row: Record<string, unknown> }> = [];
  for (const [mapKey, state] of diagnosticSessionStates.entries()) {
    const ageMs = now - state.lastActivity;
    if (state.state !== "processing" || ageMs < thresholdMs) {
      continue;
    }
    rows.push({
      ageMs,
      row: serializeStuck(mapKey, state, ageMs),
    });
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return rows.slice(0, MAX_RETURNED).map((r) => r.row);
}

function serializeStuck(
  mapKey: string,
  state: SessionState,
  ageMs: number,
): Record<string, unknown> {
  return {
    mapKey,
    sessionId: state.sessionId ?? null,
    sessionKey: state.sessionKey ?? null,
    state: state.state,
    ageMs,
    ageSeconds: Math.round(ageMs / 1000),
    queueDepth: state.queueDepth,
    toolCallCount: state.toolCallHistory?.length ?? 0,
    lastToolCall: state.toolCallHistory?.at(-1)
      ? {
          toolName: state.toolCallHistory.at(-1)!.toolName,
          timestamp: state.toolCallHistory.at(-1)!.timestamp,
          ageMs: Date.now() - state.toolCallHistory.at(-1)!.timestamp,
        }
      : null,
  };
}

export const gatewayProbesHandlers: GatewayRequestHandlers = {
  "gateway.stuckSessions": async ({ params, respond }) => {
    const p = (params ?? {}) as { thresholdMs?: unknown };
    let thresholdMs = DEFAULT_THRESHOLD_MS;
    if (typeof p.thresholdMs === "number" && Number.isFinite(p.thresholdMs)) {
      thresholdMs = Math.min(Math.max(0, Math.floor(p.thresholdMs)), MAX_THRESHOLD_MS);
    }
    const now = Date.now();
    const stuck = pickStuck(now, thresholdMs);
    respond(
      true,
      {
        thresholdMs,
        totalSessions: diagnosticSessionStates.size,
        stuckCount: stuck.length,
        stuck,
        now,
      },
      undefined,
    );
  },

  "gateway.diagnosticSessionCount": async ({ respond }) => {
    let processing = 0;
    let idle = 0;
    let waiting = 0;
    for (const state of diagnosticSessionStates.values()) {
      if (state.state === "processing") processing += 1;
      else if (state.state === "idle") idle += 1;
      else if (state.state === "waiting") waiting += 1;
    }
    respond(
      true,
      {
        total: diagnosticSessionStates.size,
        byState: { processing, idle, waiting },
      },
      undefined,
    );
  },
};
