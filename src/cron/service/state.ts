import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "../../infra/heartbeat-wake.js";
import type {
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronMessageChannel,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
  CronStoreFile,
} from "../types.js";

export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  /** Snapshot of the job at the time of the event. Present for all actions where the job is accessible. */
  job?: CronJob;
  runAtMs?: number;
  durationMs?: number;
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  delivery?: CronDeliveryTrace;
  sessionId?: string;
  sessionKey?: string;
  nextRunAtMs?: number;
} & CronRunTelemetry;

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** CronConfig for session retention settings. */
  cronConfig?: CronConfig;
  /** Default agent id for jobs without an agent id. */
  defaultAgentId?: string;
  /** Resolve session store path for a given agent id. */
  resolveSessionStorePath?: (agentId?: string) => string;
  /** Path to the session store (sessions.json) for reaper use. */
  sessionStorePath?: string;
  /**
   * Delay in ms between missed job executions on startup.
   * Prevents overwhelming the gateway when many jobs are overdue.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  missedJobStaggerMs?: number;
  /**
   * Maximum number of missed jobs to run immediately on startup.
   * Additional missed jobs will be rescheduled to fire gradually.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  maxMissedJobsPerRestart?: number;
  enqueueSystemEvent: (
    text: string,
    opts?: { agentId?: string; sessionKey?: string; contextKey?: string; trusted?: boolean },
  ) => void;
  requestHeartbeatNow: (opts?: HeartbeatWakeRequest) => void;
  runHeartbeatOnce?: (opts?: {
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    /** Optional heartbeat config override (e.g. target: "last" for cron-triggered heartbeats). */
    heartbeat?: { target?: string };
  }) => Promise<HeartbeatRunResult>;
  /**
   * CRON LANE (see src/infra/heartbeat-wake.ts). Delivers a cron payload without consulting
   * whether the periodic self-poll is switched on.
   *
   * These MUST be injected rather than imported directly by the timer, and the injector MUST
   * resolve the wake target with the same helper the enqueue path uses. A cron job that targets
   * the main session carries NO explicit `job.sessionKey`, so the raw value is `undefined`; the
   * gateway's `resolveCronWakeTarget` is what turns that into the agent's concrete main session
   * key. Calling the wake functions directly bypasses that resolution, the wake lands on the
   * generic configured heartbeat session, and the payload sits unread on the main queue — the
   * 2026-07-25 bug, re-introduced on 2026-08-03 by routing around this layer and fixed again here.
   */
  requestCronWakeNow?: (opts?: HeartbeatWakeRequest) => void;
  runCronWakeOnce?: (opts?: {
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: { target?: string };
  }) => Promise<HeartbeatRunResult>;
  /**
   * WakeMode=now: max time to wait for runHeartbeatOnce to stop returning
   * { status:"skipped", reason:"requests-in-flight" } before falling back to
   * requestHeartbeatNow.
   */
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  /** WakeMode=now: delay between runHeartbeatOnce retries while busy. */
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    abortSignal?: AbortSignal;
    onExecutionStarted?: () => void;
  }) => Promise<
    {
      summary?: string;
      /** Last non-empty agent text output (not truncated). */
      outputText?: string;
      /**
       * `true` when the isolated run already delivered its output to the target
       * channel (including matching messaging-tool sends). See:
       * https://github.com/openclaw/openclaw/issues/15692
       */
      delivered?: boolean;
      /**
       * `true` when announce/direct delivery was attempted for this run, even
       * if the final per-message ack status is uncertain.
       */
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    } & CronRunOutcome &
      CronRunTelemetry
  >;
  sendCronFailureAlert?: (params: {
    job: CronJob;
    text: string;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
  }) => Promise<void>;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
  /**
   * Job ids whose missing `sessionTarget` was defaulted at load and warned
   * about. Used to suppress duplicate warns across forceReload ticks so a
   * single broken job does not spam the log on every scheduler cycle.
   */
  warnedMissingSessionTargetJobIds: Set<string>;
  storeLoadedAtMs: number | null;
  storeFileMtimeMs: number | null;
};

export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedMissingSessionTargetJobIds: new Set<string>(),
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}

export type CronRunMode = "due" | "force";
export type CronWakeMode = "now" | "next-heartbeat";

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: false };

export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

export type CronAddResult = CronJob;
export type CronUpdateResult = CronJob;

export type CronListResult = CronJob[];
export type CronAddInput = CronJobCreate;
export type CronUpdateInput = CronJobPatch;
