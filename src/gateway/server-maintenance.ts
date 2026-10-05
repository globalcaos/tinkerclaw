import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import type { HealthSummary } from "../commands/health.js";
import { getSessionRunLiveness, sweepStaleRunContextsDetailed } from "../infra/agent-events.js";
import { logInstrumentLivenessSummary } from "../infra/instrument-liveness.js";
import { cleanOldMedia } from "../media/store.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { formatRpcObservabilitySummaryIfChanged } from "./rpc-observability.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
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
  /**
   * FORK 2026-09-24 (prompt-queue.md G4 follow-up) — the subscriber-gated sender and the
   * `sessions.subscribe` connection set, the pair every other `sessions.changed` emitter uses
   * (server-chat.ts lifecycle start/end, server-methods/agent.ts, server-methods/sessions.ts). The
   * stale-run sweep sends its `sessions.changed` through them. REQUIRED: an optional accessor the
   * startup path forgot to forward would turn the sweep's announcement back into silence.
   */
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
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
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed). Never
    // silently: every removal is announced (prompt-queue.md §6.2 "Sweep (C9)").
    sweepAndAnnounceStaleRunContexts(params, now);
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

/** The `reason` a run-set sweep stamps on the terminal it emits and on `sessions.changed`. */
export const STALE_SWEEP_REASON = "stale-sweep";

/**
 * The longest silence an active reply operation can shield its run's context from the sweep.
 *
 * A reply operation can leak: the FORK 2026-04-20 block in createReplyOperation documents entries
 * that outlive their turn when `complete()` never fires, and such an entry is cleared only by the
 * NEXT prompt on that session. Without a ceiling, one leaked operation would hold `run.live` true
 * for its session until then, which is the latch the sweep exists to prevent. Six hours is far
 * above the longest pre-model wait measured (49 min, 2026-09-23); a turn that is really working
 * emits agent events and never comes near it.
 */
export const REPLY_OPERATION_KEEPALIVE_CEILING_MS = 6 * 60 * 60_000;

type StaleRunSweepDeps = Pick<
  Parameters<typeof startGatewayMaintenanceTimers>[0],
  | "broadcast"
  | "broadcastToConnIds"
  | "getSessionEventSubscriberConnIds"
  | "nodeSendToSession"
  | "logHealth"
  | "chatAbortControllers"
  | "chatRunState"
  | "chatRunBuffers"
  | "chatDeltaSentAt"
  | "chatDeltaLastBroadcastLen"
  | "agentRunSeq"
>;

function formatSilence(silentMs: number): string {
  return Number.isFinite(silentMs)
    ? `${Math.max(1, Math.round(silentMs / 60_000))} min`
    : "an unknown time";
}

function staleSweepErrorMessage(silentMs: number): string {
  return (
    `No activity from this run for ${formatSilence(silentMs)}, so the gateway stopped ` +
    `tracking it (${STALE_SWEEP_REASON}). If it was still working, its answer will be in ` +
    "the history on reload."
  );
}

/**
 * FORK 2026-09-24 — prompt-queue.md §6.2 "Sweep (C9)", step G4: NO SILENT SWEEP OF A PENDING
 * TURN.
 *
 * The run-set sweep used to drop a context after 30 min of silence and broadcast nothing. Turns
 * were measured waiting 21–49 min before the model on 2026-09-23 (bug-log.md), and such a turn
 * emits no agent event, so the sweep could clear `run.live` under a turn that was still coming
 * and tell no client. Now:
 *   1. a context is KEPT while something still owns its run: a chat abort controller for the same
 *      runId (its expiry, in the loop above, emits that run's one terminal), or its session's
 *      active reply operation, if the context was registered after that operation began and has
 *      been silent for at most REPLY_OPERATION_KEEPALIVE_CEILING_MS;
 *   2. a context that IS removed is announced: one `sessions.changed` per session with the fresh
 *      `run` liveness, sent to the `sessions.subscribe` connections like every other emitter's,
 *      one log line per run, and one `chat` `error` (reason "stale-sweep") per run whose chat
 *      stream is still open.
 *
 * "Still open" is `agentRunSeq.has(runId)`. server-chat.ts sets it on every relayed event, and
 * every terminal path deletes it: finalizeLifecycleEvent (server-chat.ts), abortChatRunById
 * (chat-abort.ts), broadcastChatFinal and broadcastChatError (server-methods/chat.ts). That gate
 * is a named deviation from "always emit the terminal". The commonest orphan is a chat.send run
 * whose lifecycle end never arrived: chat.ts's backstop `final` has ALREADY ended it without
 * clearing its context, and the UI paints every non-recoverable `chat` `error` as a persisted red
 * bubble (tinker-ui/src/app.ts). An unconditional terminal would put a false error under an
 * answered turn. Runs not shown in chat get no chat terminal either (server-chat.ts gates on
 * isControlUiVisible the same way), and neither do heartbeats, which are not prompts; their
 * session still gets `sessions.changed`.
 *
 * The terminal is emitted here, not as a synthetic lifecycle `error`: that would reach every
 * agent-event listener (session-store writes, the subagent registry, plugins) as if the run had
 * failed.
 */
function sweepAndAnnounceStaleRunContexts(params: StaleRunSweepDeps, now: number): void {
  // Why each dropped context was NOT kept by a reply operation. Logged, so a session-key form
  // mismatch between a run context and its reply operation reads "none" instead of passing for
  // an ordinary orphan.
  const replyOpVerdicts = new Map<string, string>();
  let swept: ReturnType<typeof sweepStaleRunContextsDetailed>;
  try {
    swept = sweepStaleRunContextsDetailed({
      now,
      keepAlive: (runId, ctx, silentMs) => {
        if (params.chatAbortControllers.has(runId)) {
          return true;
        }
        const startedAt = ctx.sessionKey
          ? replyRunRegistry.get(ctx.sessionKey)?.startedAt
          : undefined;
        if (startedAt === undefined) {
          replyOpVerdicts.set(runId, "none");
          return false;
        }
        // The run set is keyed per RUN (getSessionRunLiveness): a context registered before the
        // operation began is an earlier turn's orphan, and the live turn must not keep it alive.
        if ((ctx.registeredAt ?? 0) < startedAt) {
          replyOpVerdicts.set(runId, "later-turn");
          return false;
        }
        if (silentMs > REPLY_OPERATION_KEEPALIVE_CEILING_MS) {
          replyOpVerdicts.set(runId, "past-ceiling");
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    params.logHealth.error(`run-context sweep failed: ${formatError(err)}`);
    return;
  }
  const changedSessions = new Map<string, string>();
  for (const ctx of swept) {
    try {
      const sessionKey = ctx.sessionKey;
      let terminal = "none (no session)";
      if (sessionKey) {
        changedSessions.set(sessionKey, ctx.runId);
        if (ctx.isHeartbeat) {
          terminal = "none (heartbeat)";
        } else if (ctx.isControlUiVisible === false) {
          terminal = "none (not shown in chat)";
        } else if (params.chatRunState.abortedRuns.has(ctx.runId)) {
          terminal = "none (already aborted)";
        } else if (!params.agentRunSeq.has(ctx.runId)) {
          terminal = "none (no open chat stream)";
        } else {
          const payload = {
            runId: ctx.runId,
            sessionKey,
            seq: (params.agentRunSeq.get(ctx.runId) ?? 0) + 1,
            state: "error" as const,
            errorMessage: staleSweepErrorMessage(ctx.silentMs),
            reason: STALE_SWEEP_REASON,
          };
          params.broadcast("chat", payload);
          params.nodeSendToSession(sessionKey, "chat", payload);
          // The same teardown abortChatRunById does: as far as any client knows, the run is over.
          params.agentRunSeq.delete(ctx.runId);
          params.chatRunBuffers.delete(ctx.runId);
          params.chatDeltaSentAt.delete(ctx.runId);
          params.chatDeltaLastBroadcastLen.delete(ctx.runId);
          terminal = "chat error";
        }
      }
      const replyOp = replyOpVerdicts.get(ctx.runId) ?? "-";
      params.logHealth.info(
        `stale-sweep: dropped run context runId=${ctx.runId} session=${sessionKey ?? "-"} ` +
          `silent=${formatSilence(ctx.silentMs)} replyOp=${replyOp} terminal=${terminal}`,
      );
    } catch (err) {
      params.logHealth.error(
        `stale-sweep: could not announce runId=${ctx.runId}: ${formatError(err)}`,
      );
    }
  }
  if (changedSessions.size === 0) {
    return;
  }
  // FORK 2026-09-24 (G4 follow-up) — `sessions.changed` goes to the `sessions.subscribe`
  // connections through `broadcastToConnIds`, the channel every other emitter of this event uses
  // (server-chat.ts lifecycle start/end, server-methods/agent.ts and sessions.ts). The first G4
  // cut used the unscoped `broadcast` because this timer was not handed the subscriber set, which
  // made the sweep the one emitter that also reached connections that never subscribed.
  // server-startup-early.ts now threads both through from server.impl.ts. Nobody subscribed means
  // nothing to send, exactly as server-chat.ts decides; the per-run log line above still records
  // every removal.
  let subscriberConnIds: ReadonlySet<string>;
  try {
    subscriberConnIds = params.getSessionEventSubscriberConnIds();
  } catch (err) {
    params.logHealth.error(
      `stale-sweep: session-event subscribers unavailable: ${formatError(err)}`,
    );
    return;
  }
  if (subscriberConnIds.size === 0) {
    return;
  }
  for (const [sessionKey, runId] of changedSessions) {
    try {
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          reason: STALE_SWEEP_REASON,
          runId,
          ts: now,
          run: getSessionRunLiveness(sessionKey, now),
        },
        subscriberConnIds,
        { dropIfSlow: true },
      );
    } catch (err) {
      params.logHealth.error(
        `stale-sweep: sessions.changed failed session=${sessionKey}: ${formatError(err)}`,
      );
    }
  }
}
