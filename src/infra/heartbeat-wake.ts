import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  isHeartbeatActionWakeReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeRequest = {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;

/**
 * FORK 2026-08-03 — A CRON WAKE IS NOT A HEARTBEAT.
 *
 * Every cron delivery used to be expressed as `requestHeartbeatNow(...)`, so the single
 * switch that stops the periodic self-poll also stopped ALL cron work: the heartbeat
 * runner answers `{status:"skipped", reason:"disabled"}` before it ever looks at the
 * payload that was already queued, and `cron/service/timer.ts` copied that verdict into
 * the CRON's own outcome. Measured on this deployment: 18 jobs fired on schedule and did
 * zero work from 2026-07-30 onward, and the only evidence was the word "disabled" inside
 * a run-log nobody reads.
 *
 * The two concerns are now separate LANES over ONE shared delivery mechanism
 * (design-principles #18 — one canonical derivation, not a second copy of the wake
 * machinery):
 *   - "heartbeat" — the periodic self-poll. Governed by the enabled flag below.
 *   - "cron"      — operator-scheduled work. Never gated by that flag, and never
 *                   coalesced away by a heartbeat wake for the same session.
 */
export type WakeLane = "heartbeat" | "cron";

/**
 * Delivery handler for the cron lane. Registered independently of the heartbeat runner;
 * an implementation MUST NOT consult `areHeartbeatsEnabled()`.
 */
export type CronWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;

let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

/**
 * Whether the PERIODIC SELF-POLL is on. This is deliberately not a statement about
 * whether the gateway may deliver a queued payload to a session — cron delivery runs on
 * its own lane and must never be vetoed by this flag.
 */
export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

type WakeTimerKind = "normal" | "retry";
type PendingWakeReason = {
  lane: WakeLane;
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
let cronHandler: CronWakeHandler | null = null;
let cronHandlerGeneration = 0;

/**
 * Pick the handler for a lane. The cron lane prefers its own handler — the ungated path —
 * and falls back to the heartbeat handler only so a cron wake is never silently dropped
 * before the cron handler is wired. A cron wake NEVER runs on the heartbeat handler when
 * a cron handler exists.
 */
function resolveLaneHandler(lane: WakeLane): HeartbeatWakeHandler | null {
  if (lane === "cron") {
    return cronHandler ?? handler;
  }
  return handler;
}
const pendingWakes = new Map<string, PendingWakeReason>();
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let timerKind: WakeTimerKind | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

function resolveReasonPriority(reason: string): number {
  const kind = resolveHeartbeatReasonKind(reason);
  if (kind === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (kind === "interval") {
    return REASON_PRIORITY.INTERVAL;
  }
  if (isHeartbeatActionWakeReason(reason)) {
    return REASON_PRIORITY.ACTION;
  }
  return REASON_PRIORITY.DEFAULT;
}

function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
}

function normalizeWakeTarget(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed || undefined;
}

function getWakeTargetKey(params: { lane: WakeLane; agentId?: string; sessionKey?: string }) {
  const agentId = normalizeWakeTarget(params.agentId);
  const sessionKey = normalizeWakeTarget(params.sessionKey);
  // The lane is part of the identity. Without it a cron wake and a periodic heartbeat
  // wake for the same session collapse into one entry and the lower-priority one is
  // dropped — i.e. the cron silently loses its wake to the self-poll.
  return `${params.lane}::${agentId ?? ""}::${sessionKey ?? ""}`;
}

function queuePendingWakeReason(params: {
  lane: WakeLane;
  reason?: string;
  requestedAt?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}) {
  const requestedAt = params.requestedAt ?? Date.now();
  const normalizedReason = normalizeWakeReason(params.reason);
  const normalizedAgentId = normalizeWakeTarget(params.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params.sessionKey);
  const wakeTargetKey = getWakeTargetKey({
    lane: params.lane,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const next: PendingWakeReason = {
    lane: params.lane,
    reason: normalizedReason,
    priority: resolveReasonPriority(normalizedReason),
    requestedAt,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
    heartbeat: params.heartbeat,
  };
  const previous = pendingWakes.get(wakeTargetKey);
  if (!previous) {
    pendingWakes.set(wakeTargetKey, next);
    return;
  }
  const merged =
    (next.heartbeat ?? previous.heartbeat)
      ? { ...next, heartbeat: next.heartbeat ?? previous.heartbeat }
      : next;
  if (next.priority > previous.priority) {
    pendingWakes.set(wakeTargetKey, merged);
    return;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    pendingWakes.set(wakeTargetKey, merged);
  }
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (timer) {
    // Keep retry cooldown as a hard minimum delay. This prevents the
    // finally-path reschedule (often delay=0) from collapsing backoff.
    if (timerKind === "retry") {
      return;
    }
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
  }
  timerDueAt = dueAt;
  timerKind = kind;
  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;
    if (!handler && !cronHandler) {
      // Nothing is wired yet. Return BEFORE draining so the queue survives until a
      // handler registers (setHeartbeatWakeHandler / setCronWakeHandler reschedule).
      return;
    }
    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const pendingBatch = Array.from(pendingWakes.values());
    pendingWakes.clear();
    running = true;
    try {
      for (const pendingWake of pendingBatch) {
        const wakeOpts = {
          reason: pendingWake.reason ?? undefined,
          ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
          ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
          ...(pendingWake.heartbeat ? { heartbeat: pendingWake.heartbeat } : {}),
        };
        const laneHandler = resolveLaneHandler(pendingWake.lane);
        if (!laneHandler) {
          // This lane has no handler yet. Re-queue instead of dropping: a wake that
          // vanishes because its lane was not wired is exactly the silent failure this
          // split exists to end.
          queuePendingWakeReason({
            lane: pendingWake.lane,
            reason: pendingWake.reason,
            requestedAt: pendingWake.requestedAt,
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
            heartbeat: pendingWake.heartbeat,
          });
          schedule(DEFAULT_RETRY_MS, "retry");
          continue;
        }
        const res = await laneHandler(wakeOpts);
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // The main lane is busy; retry this wake target soon.
          queuePendingWakeReason({
            lane: pendingWake.lane,
            reason: pendingWake.reason ?? "retry",
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
            heartbeat: pendingWake.heartbeat,
          });
          schedule(DEFAULT_RETRY_MS, "retry");
        }
      }
    } catch {
      // Error is already logged by the wake handler; schedule a retry.
      for (const pendingWake of pendingBatch) {
        queuePendingWakeReason({
          lane: pendingWake.lane,
          reason: pendingWake.reason ?? "retry",
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
          heartbeat: pendingWake.heartbeat,
        });
      }
      schedule(DEFAULT_RETRY_MS, "retry");
    } finally {
      running = false;
      if (pendingWakes.size > 0 || scheduled) {
        schedule(delay, "normal");
      }
    }
  }, delay);
  timer.unref?.();
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    timerKind = null;
    // Reset module-level execution state that may be stale from interrupted
    // runs in the previous lifecycle. Without this, `running === true` from
    // an interrupted heartbeat blocks all future schedule() attempts, and
    // `scheduled === true` can cause spurious immediate re-runs.
    running = false;
    scheduled = false;
  }
  if (handler && pendingWakes.size > 0) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }
  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestHeartbeatNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}) {
  queuePendingWakeReason({
    lane: "heartbeat",
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
    heartbeat: opts?.heartbeat,
  });
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

/**
 * Register (or clear) the CRON wake handler — the delivery path for operator-scheduled
 * work. Deliberately a SEPARATE slot from `setHeartbeatWakeHandler`: the whole point is
 * that turning the periodic self-poll off must not turn cron delivery off. The handler
 * registered here MUST NOT consult `areHeartbeatsEnabled()` and must not depend on the
 * heartbeat interval config.
 *
 * Returns a disposer that clears this specific registration; stale disposers (from an
 * earlier registration) are no-ops, matching `setHeartbeatWakeHandler`.
 */
export function setCronWakeHandler(next: CronWakeHandler | null): () => void {
  cronHandlerGeneration += 1;
  const generation = cronHandlerGeneration;
  cronHandler = next;
  if (cronHandler && pendingWakes.size > 0) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }
  return () => {
    if (cronHandlerGeneration !== generation) {
      return;
    }
    if (cronHandler !== next) {
      return;
    }
    cronHandlerGeneration += 1;
    cronHandler = null;
  };
}

export function hasCronWakeHandler() {
  return cronHandler !== null;
}

/**
 * Queue a CRON wake. Same coalescing/retry machinery as `requestHeartbeatNow` — the wake
 * machinery is SHARED, not duplicated — but on the cron lane, so it is never merged away
 * by a periodic heartbeat wake and never gated by the heartbeat-enabled flag.
 */
export function requestCronWake(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}) {
  queuePendingWakeReason({
    lane: "cron",
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
    heartbeat: opts?.heartbeat,
  });
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

/**
 * Deliver a cron wake now and await the verdict, bypassing the coalescing timer.
 * When nothing is wired the reason is `"no-wake-handler"` — a distinct, greppable string,
 * never the heartbeat's "disabled", so a missing wiring can never be mistaken for an
 * operator switching something off.
 */
export async function runCronWakeOnce(opts?: HeartbeatWakeRequest): Promise<HeartbeatRunResult> {
  const laneHandler = resolveLaneHandler("cron");
  if (!laneHandler) {
    return { status: "skipped", reason: "no-wake-handler" };
  }
  return await laneHandler({
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
    heartbeat: opts?.heartbeat,
  });
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingWakes.size > 0 || Boolean(timer) || scheduled;
}

export function resetHeartbeatWakeStateForTests() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  timerKind = null;
  pendingWakes.clear();
  scheduled = false;
  running = false;
  handlerGeneration += 1;
  handler = null;
  cronHandlerGeneration += 1;
  cronHandler = null;
}
