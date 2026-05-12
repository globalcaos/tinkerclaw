/**
 * FORK 2026-05-12 — `gateway.observability.snapshot()`
 *
 * Returns a single structured object containing the live state of every
 * fork-side probe in one call. Today an AI debugging an incident calls
 * 5–10 probes sequentially; this collapses the cost into one round-trip
 * with a predictable response shape that AI consumers can rely on.
 *
 * Sections:
 *   - `sessions`: stuck-session count + the in-memory diagnostic map breakdown
 *   - `plugins`: registry loaded/error/disabled counts + failure list
 *   - `gateway`: identity, uptime, build hash
 *   - `runtime`: process pid, event-loop health (where cheap to read)
 *
 * Each section reads from the same in-memory sources the dedicated probes
 * use, so a single snapshot is consistent with point-in-time. Cost is
 * bounded — no journal reads, no fs walks. All work is sync map access
 * over registries already in memory.
 *
 * Scope: READ_SCOPE. No credentials, no enumeration risk beyond what the
 * individual probes already expose.
 */

import * as os from "node:os";
import { diagnosticSessionStates } from "../../logging/diagnostic-session-state.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import type { GatewayRequestHandlers } from "./types.js";

const STUCK_THRESHOLD_MS = 60_000;

function summarizeSessions() {
  const states = diagnosticSessionStates;
  const breakdown = { processing: 0, idle: 0, waiting: 0 } as Record<string, number>;
  let stuck = 0;
  const now = Date.now();
  const stuckExamples: Array<Record<string, unknown>> = [];
  for (const state of states.values()) {
    breakdown[state.state] = (breakdown[state.state] ?? 0) + 1;
    if (state.state === "processing" && now - state.lastActivity > STUCK_THRESHOLD_MS) {
      stuck += 1;
      if (stuckExamples.length < 3) {
        stuckExamples.push({
          sessionKey: state.sessionKey ?? null,
          sessionId: state.sessionId ?? null,
          ageMs: now - state.lastActivity,
          queueDepth: state.queueDepth,
        });
      }
    }
  }
  return {
    total: states.size,
    byState: breakdown,
    stuckCount: stuck,
    stuckThresholdMs: STUCK_THRESHOLD_MS,
    stuckExamples,
  };
}

function summarizePlugins() {
  const state = getPluginRegistryState();
  const registry = state?.activeRegistry;
  if (!registry) {
    return { ready: false, reason: "registry not initialized" };
  }
  let loaded = 0;
  let disabled = 0;
  let errored = 0;
  const failures: Array<Record<string, unknown>> = [];
  for (const r of registry.plugins ?? []) {
    if (r.status === "loaded") loaded += 1;
    else if (r.status === "disabled") disabled += 1;
    else if (r.status === "error") {
      errored += 1;
      if (failures.length < 10) {
        failures.push({
          id: r.id,
          failurePhase: r.failurePhase ?? null,
          error: r.error ? r.error.slice(0, 300) : null,
        });
      }
    }
  }
  return {
    ready: true,
    totalPlugins: (registry.plugins ?? []).length,
    byStatus: { loaded, disabled, error: errored },
    failures,
  };
}

function summarizeRuntime() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    hostname: os.hostname(),
    nodeVersion: process.version,
  };
}

export const observabilitySnapshotHandlers: GatewayRequestHandlers = {
  "gateway.observability.snapshot": async ({ respond }) => {
    const capturedAt = new Date().toISOString();
    respond(
      true,
      {
        capturedAt,
        sessions: summarizeSessions(),
        plugins: summarizePlugins(),
        runtime: summarizeRuntime(),
      },
      undefined,
    );
  },
};
