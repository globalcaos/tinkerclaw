import type { HealthSummary } from "../commands/health.js";
import { sweepStaleRunContexts } from "../infra/agent-events.js";
import { logInstrumentLivenessSummary } from "../infra/instrument-liveness.js";
import { cleanOldMedia } from "../media/store.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { formatRpcObservabilitySummaryIfChanged } from "./rpc-observability.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  // `info` added 2026-08-04 for the RPC observability line below, and REQUIRED rather than
  // optional on purpose. The first attempt declared `debug?:` and called `logHealth.debug?.(…)`
  // — but log.child() exposes only info/warn/error (LogMethod, src/logger.ts:18), so the guarded
  // call silently did nothing and the line never appeared, through a green build and a green
  // deploy. An optional call to a method that does not exist is indistinguishable from a working
  // one with nothing to say. Required means the compiler catches it instead of the journal
  // staying quiet for a week.
  logHealth: { error: (msg: string) => void; info: (msg: string) => void };
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  mediaCleanupTtlMs?: number;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
} {
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    params.broadcast("tick", payload);
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: true })
      .catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
    // FORK 2026-07-28 — SCHEDULE THE LIVENESS REPORT.
    //
    // The instrument-liveness registry was written to catch components that are registered but
    // never run, and then shipped with NO caller for its own report: it recorded into memory
    // and nothing ever read it. That made the liveness detector instance #7 of the exact shape
    // it exists to catch — a counter nobody reads is not an alarm.
    //
    // It rides the existing health tick rather than a timer of its own, so there is one fewer
    // thing that can itself stop running. It logs WARN only when something is unexpectedly
    // silent; a healthy fleet is a DEBUG line.
    logInstrumentLivenessSummary();
    // FORK 2026-08-04 — the RPC surface's only report, deliberately emitted on the SAME tick and
    // next to the same summary. capability-coverage.mjs measured the 185-method gateway RPC
    // surface at zero observability; the fix would have been worthless parked anywhere else,
    // because the failure this whole file exists to prevent is a perfectly good record written
    // somewhere nobody looks (fractal wrote 2,466 of them). One more line in the report that IS
    // read beats a new surface that is not.
    const rpcSummary = formatRpcObservabilitySummaryIfChanged();
    if (rpcSummary) params.logHealth.info(rpcSummary);
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: true })
    .catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    for (const [k, v] of params.dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const entries = [...params.dedupe.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < params.dedupe.size - DEDUPE_MAX; i++) {
        params.dedupe.delete(entries[i][0]);
      }
    }

    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      let removed = 0;
      for (const runId of params.agentRunSeq.keys()) {
        params.agentRunSeq.delete(runId);
        removed += 1;
        if (removed >= excess) {
          break;
        }
      }
    }

    for (const [runId, entry] of params.chatAbortControllers) {
      if (now <= entry.expiresAtMs) {
        continue;
      }
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunBuffers: params.chatRunBuffers,
          chatDeltaSentAt: params.chatDeltaSentAt,
          chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
          chatAbortedRuns: params.chatRunState.abortedRuns,
          removeChatRun: params.removeChatRun,
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          nodeSendToSession: params.nodeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "timeout" },
      );
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
      if (now - abortedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunBuffers.delete(runId);
      params.chatDeltaSentAt.delete(runId);
      params.chatDeltaLastBroadcastLen.delete(runId);
    }

    // Prune expired control-plane rate-limit buckets to prevent unbounded
    // growth when many unique clients connect over time.
    pruneStaleControlPlaneBuckets(now);

    // Sweep stale buffers for runs that were never explicitly aborted.
    // Only reap orphaned buffers after the abort controller is gone; active
    // runs can legitimately sit idle while tools/models work.
    for (const [runId, lastSentAt] of params.chatDeltaSentAt) {
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue; // already handled above
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastSentAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunBuffers.delete(runId);
      params.chatDeltaSentAt.delete(runId);
      params.chatDeltaLastBroadcastLen.delete(runId);
    }
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed).
    sweepStaleRunContexts();
  }, 60_000);

  if (typeof params.mediaCleanupTtlMs !== "number") {
    return { tickInterval, healthInterval, dedupeCleanup, mediaCleanup: null };
  }

  let mediaCleanupInFlight: Promise<void> | null = null;
  const runMediaCleanup = () => {
    if (mediaCleanupInFlight) {
      return mediaCleanupInFlight;
    }
    mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
      recursive: true,
      pruneEmptyDirs: true,
    })
      .catch((err) => {
        params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        mediaCleanupInFlight = null;
      });
    return mediaCleanupInFlight;
  };

  const mediaCleanup = setInterval(() => {
    void runMediaCleanup();
  }, 60 * 60_000);

  void runMediaCleanup();

  return { tickInterval, healthInterval, dedupeCleanup, mediaCleanup };
}
