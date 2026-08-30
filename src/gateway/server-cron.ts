import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestCronWake, requestHeartbeatNow, runCronWakeOnce } from "../infra/heartbeat-wake.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type {
  PluginHookCronChangedEvent,
  PluginHookGatewayCronJob,
  PluginHookGatewayCronService,
  PluginHookGatewayContext,
} from "../plugins/hook-types.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

/**
 * FORK 2026-07-26 (a dead cron fleet reported "ok" for six days). A heartbeat
 * result of "ran" proves only that SOME turn executed — never that the turn
 * received THIS cron's payload. While the wake-key bug routed wakes to the
 * generic heartbeat session, every job enqueued its brief onto the main session
 * queue, woke a different session that peeked an empty queue, answered a bare
 * "[OpenClaw heartbeat poll]" in ~8s, and logged status "ok". The whole fleet
 * looked green while producing nothing, so nobody noticed until it was asked.
 *
 * The event queue is the ground truth: the woken turn DRAINS the payload it
 * receives. So if this job's own event is still pending after the wake
 * returned, the payload was never delivered — that is a failed run, not an ok
 * one. Reported as "failed" so the run log and cron panel show it red on day
 * one instead of after a week of silence.
 */
export function resolveCronWakeOutcome(params: {
  result: HeartbeatRunResult;
  payloadStillQueued: boolean;
}): HeartbeatRunResult {
  if (params.result.status !== "ran" || !params.payloadStillQueued) {
    return params.result;
  }
  return {
    status: "failed",
    reason:
      "cron payload was still queued after the wake returned — the woken turn never received it (phantom run)",
  };
}

/**
 * True when the cron event tagged for `reason` is still sitting on the session
 * queue. Matches on the job's own contextKey (`cron:<jobId>`, which is exactly
 * the wake `reason`) so a DIFFERENT job enqueuing during a long-running turn
 * cannot be mistaken for this job's undelivered payload.
 */
export function isCronPayloadStillQueued(sessionKey: string, reason?: string): boolean {
  const contextKey = reason?.trim().toLowerCase();
  if (!contextKey || !contextKey.startsWith("cron:")) {
    return false;
  }
  return peekSystemEventEntries(sessionKey).some(
    (event) => (event.contextKey ?? "") === contextKey,
  );
}

/** Pick only the keys whose values are not `undefined` from an object. */
function pickDefined<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<Pick<T, (typeof keys)[number]>> {
  const result: Partial<Pick<T, (typeof keys)[number]>> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) {
      (result as Record<string, unknown>)[k as string] = obj[k];
    }
  }
  return result;
}

/** Map internal CronJob to the public plugin SDK shape. */
function toPluginCronJob(job: CronJob): PluginHookGatewayCronJob {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    schedule: job.schedule ? structuredClone(job.schedule) : undefined,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload ? structuredClone(job.payload) : undefined,
    state: {
      nextRunAtMs: job.state.nextRunAtMs,
      runningAtMs: job.state.runningAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
      lastError: job.state.lastError,
      lastDurationMs: job.state.lastDurationMs,
    },
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  };
}

export function buildGatewayCronService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const findAgentEntry = (cfg: OpenClawConfig, agentId: string) =>
    Array.isArray(cfg.agents?.list)
      ? cfg.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        )
      : undefined;

  const hasConfiguredAgent = (cfg: OpenClawConfig, agentId: string) =>
    Boolean(findAgentEntry(cfg, agentId));

  const mergeRuntimeAgentConfig = (runtimeConfig: OpenClawConfig, requestedAgentId: string) => {
    if (hasConfiguredAgent(runtimeConfig, requestedAgentId)) {
      return runtimeConfig;
    }
    const fallbackAgentEntry = findAgentEntry(params.cfg, requestedAgentId);
    if (!fallbackAgentEntry) {
      return runtimeConfig;
    }
    const startupAgents = params.cfg.agents;
    const runtimeAgents = runtimeConfig.agents;
    return {
      ...runtimeConfig,
      agents: {
        ...startupAgents,
        ...runtimeAgents,
        defaults: {
          ...startupAgents?.defaults,
          ...runtimeAgents?.defaults,
        },
        list: [...(runtimeAgents?.list ?? []), fallbackAgentEntry],
      },
    };
  };

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const effectiveConfig =
      normalized !== undefined ? mergeRuntimeAgentConfig(runtimeConfig, normalized) : runtimeConfig;
    const agentId =
      normalized !== undefined && hasConfiguredAgent(effectiveConfig, normalized)
        ? normalized
        : resolveDefaultAgentId(effectiveConfig);
    return { agentId, cfg: effectiveConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: OpenClawConfig;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const requestedAgentId =
      typeof opts?.agentId === "string" && opts.agentId.trim()
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const runtimeConfigBase = getRuntimeConfig();
    const runtimeConfig =
      derivedAgentId !== undefined
        ? mergeRuntimeAgentConfig(runtimeConfigBase, derivedAgentId)
        : runtimeConfigBase;
    // FORK 2026-07-25: always resolve a CONCRETE wake session key, mirroring the
    // enqueueSystemEvent path above. Previously this returned sessionKey=undefined
    // whenever a job carried no explicit sessionKey (the normal case for main-target
    // crons). enqueueSystemEvent still fell back to the agent's MAIN session key, but
    // runHeartbeatOnce received forcedSessionKey=undefined and therefore resolved the
    // generic configured heartbeat session instead. The woken turn peeked an empty
    // queue and answered "no task in flight" while the cron's payload sat unread on
    // the main session queue — every main-target cron silently no-op'd (status "ok",
    // ~6s, 15 output tokens). Both paths must resolve the SAME key.
    const agentId = derivedAgentId ?? resolveDefaultAgentId(runtimeConfig);
    const sessionKey = resolveCronSessionKey({
      runtimeConfig,
      agentId,
      requestedSessionKey: opts?.sessionKey,
    });
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const runCronChangedHook = (evt: PluginHookCronChangedEvent) => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("cron_changed")) {
      return;
    }
    const hookCtx: PluginHookGatewayContext = {
      config: getRuntimeConfig(),
      getCron: () => cron as PluginHookGatewayCronService,
    };
    void hookRunner.runCronChanged(evt, hookCtx).catch((err) => {
      cronLogger.warn(
        { err: formatErrorMessage(err), jobId: evt.jobId },
        "cron_changed hook failed",
      );
    });
  };

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      const accepted = enqueueSystemEvent(text, {
        sessionKey,
        contextKey: opts?.contextKey,
        trusted: opts?.trusted,
      });
      // FORK 2026-07-26: the delivery boundary was completely unlogged, which is
      // why a week of silent no-op crons looked green. Log the key the payload
      // was queued ON so it can be diffed against the key the wake peeks.
      console.error(
        `[cron-diag] payload enqueued sessionKey=${sessionKey} contextKey=${opts?.contextKey} accepted=${accepted} queueDepth=${peekSystemEventEntries(sessionKey).length} chars=${text.trim().length}`,
      );
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: opts?.heartbeat,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      // FORK 2026-07-26: pair of the "cron payload enqueued" line above. If these
      // two keys ever differ, or queueDepth is 0 here after a successful enqueue,
      // the woken turn will get a bare heartbeat poll instead of the cron brief.
      console.error(
        `[cron-diag] wake target sessionKey=${sessionKey} reason=${opts?.reason} queueDepth=${peekSystemEventEntries(sessionKey).length}`,
      );
      // Merge cron-supplied heartbeat overrides (e.g. target: "last") with the
      // fully resolved agent heartbeat config so cron-triggered heartbeats
      // respect agent-specific overrides (agents.list[].heartbeat) before
      // falling back to agents.defaults.heartbeat.
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      const result = await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: heartbeatOverride,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
      return resolveCronWakeOutcome({
        result,
        payloadStillQueued: isCronPayloadStillQueued(sessionKey, opts?.reason),
      });
    },
    // ── CRON LANE ───────────────────────────────────────────────────────────────────
    // Same resolution as the two heartbeat deps above, on purpose. The timer must never
    // import the wake functions directly: a main-target cron carries no explicit
    // job.sessionKey, so without resolveCronWakeTarget the wake goes out with
    // sessionKey=undefined, lands on the generic configured heartbeat session, and the
    // payload sits unread on the main queue. That is the 2026-07-25 defect; it was
    // re-introduced on 2026-08-03 by calling runCronWakeOnce directly and is fixed here by
    // routing the cron lane through the SAME resolver (design-principles #18).
    requestCronWakeNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestCronWake({
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: opts?.heartbeat,
      });
    },
    runCronWakeOnce: async (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      // Pair of the "cron payload enqueued" line. If these two keys ever differ, or
      // queueDepth is 0 here after a successful enqueue, the woken turn gets a bare poll
      // instead of the cron brief.
      console.error(
        `[cron-diag] wake target lane=cron sessionKey=${sessionKey} reason=${opts?.reason} queueDepth=${peekSystemEventEntries(sessionKey).length}`,
      );
      const result = await runCronWakeOnce({
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: opts?.heartbeat,
      });
      return resolveCronWakeOutcome({
        result,
        payloadStillQueued: isCronPayloadStillQueued(sessionKey, opts?.reason),
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal, onExecutionStarted }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
      try {
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          message,
          abortSignal,
          onExecutionStarted,
          agentId,
          sessionKey,
          lane: "cron",
        });
      } finally {
        await cleanupBrowserSessionsForLifecycleEnd({
          sessionKeys: [sessionKey],
          onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg),
        });
      }
    },
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) =>
      await sendGatewayCronFailureAlert({
        deps: params.deps,
        logger: cronLogger,
        resolveCronAgent,
        webhookToken: params.cfg.cron?.webhookToken,
        job,
        text,
        channel,
        to,
        mode,
        accountId,
      }),
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      // Build hook event from CronEvent. The job snapshot is carried on the
      // internal event so it's available even for "removed" actions where
      // getJob() would return undefined. `delivery` and `usage` are
      // intentionally omitted — they contain internal channel/token detail
      // that is not part of the public plugin SDK surface.
      const hookEvt: PluginHookCronChangedEvent = {
        action: evt.action,
        jobId: evt.jobId,
        ...(evt.job ? { job: toPluginCronJob(evt.job) } : {}),
        ...pickDefined(evt, [
          "runAtMs",
          "durationMs",
          "status",
          "error",
          "summary",
          "delivered",
          "deliveryStatus",
          "deliveryError",
          "sessionId",
          "sessionKey",
          "nextRunAtMs",
          "model",
          "provider",
        ]),
      };
      runCronChangedHook(hookEvt);
      if (evt.action === "finished") {
        const job = evt.job ?? cron.getJob(evt.jobId);
        dispatchGatewayCronFinishedNotifications({
          evt,
          job,
          deps: params.deps,
          logger: cronLogger,
          resolveCronAgent,
          webhookToken: params.cfg.cron?.webhookToken,
          legacyWebhook: params.cfg.cron?.webhook,
          globalFailureDestination: params.cfg.cron?.failureDestination,
          warnedLegacyWebhookJobs,
        });

        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(
          logPath,
          {
            ts: Date.now(),
            jobId: evt.jobId,
            action: "finished",
            status: evt.status,
            error: evt.error,
            summary: evt.summary,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            deliveryError: evt.deliveryError,
            delivery: evt.delivery,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            runAtMs: evt.runAtMs,
            durationMs: evt.durationMs,
            nextRunAtMs: evt.nextRunAtMs,
            model: evt.model,
            provider: evt.provider,
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
