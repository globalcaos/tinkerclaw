import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { tryInflightSteer } from "./inflight-steer-hook.js";

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

export type EmbeddedRunModelSwitchRequest = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

/**
 * Use global singleton state so busy/streaming checks stay consistent even
 * when the bundler emits multiple copies of this module into separate chunks.
 */
const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

// FORK: sessionIdsByKey maps session-key → sessionId so cross-session routing
// can resolve a live run by either handle. Upstream doesn't track this on the
// singleton, so every merge drops it; restored here and in the initializer.
const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedPiQueueHandle>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
  modelSwitchRequests: new Map<string, EmbeddedRunModelSwitchRequest>(),
}));
const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedPiQueueHandle>());
const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());
const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS =
  embeddedRunState.modelSwitchRequests ??
  (embeddedRunState.modelSwitchRequests = new Map<string, EmbeddedRunModelSwitchRequest>());

// FORK: Batch multiple steered messages into a single injection.
// Messages arriving within the debounce window are concatenated with
// double-newline separators and steered as one combined user message.
const STEER_DEBOUNCE_MS = 300;
// FORK (2026-08-28): The debounce timer resets on EVERY new message, so a fast
// typist could postpone injection indefinitely. Cap the total wait from the
// FIRST buffered message: 5 debounce windows (1500 ms) is long enough to batch
// a burst of quick follow-ups, short enough that the injection still lands
// within the current tool round instead of drifting behind the whole turn.
const STEER_MAX_WAIT_MS = 1_500;

// FORK (2026-08-28): A buffered user message must NEVER vanish. The caller can
// hand the buffer a fallback that re-delivers the text as a NEW follow-up turn
// (agent-runner owns the followup-queue context this registry doesn't have);
// when the run ends before the flush timer fires, the fallback — not the
// void — gets the text.
type SteerDeliveryFallback = (texts: string[], combined: string) => void;
type SteerBuffer = {
  texts: string[];
  timer: NodeJS.Timeout;
  // FORK (2026-08-28): timestamp of the FIRST buffered message — anchor for
  // the max-wait cap. Deliberately not refreshed on subsequent messages.
  firstBufferedAt: number;
  fallback?: SteerDeliveryFallback;
};
const steerBuffers = new Map<string, SteerBuffer>();

// FORK (2026-08-28): Last-resort delivery when no live handle can take the
// buffered text. With a registered fallback the text becomes a NEW follow-up
// turn (the Claude Code shape: finish the immediate work, then resume with the
// follow-up as fresh input). Without one, fail LOUDLY — a debug line is how
// this hole stayed invisible; an ERROR carrying the message head is at least
// recoverable from the logs.
function deliverSteerBufferViaFallback(
  sessionId: string,
  buf: SteerBuffer,
  combined: string,
  reason: string,
): boolean {
  if (buf.fallback) {
    try {
      buf.fallback(buf.texts, combined);
      diag.debug(
        `steer flush: delivered via followup fallback sessionId=${sessionId} reason=${reason} chars=${combined.length}`,
      );
      return true;
    } catch (err) {
      diag.error(
        `steer flush: followup fallback threw — buffered user message LOST sessionId=${sessionId} reason=${reason} err=${String(err)} head=${JSON.stringify(combined.slice(0, 200))}`,
      );
      return false;
    }
  }
  diag.error(
    `steer flush DROPPED a buffered user message: sessionId=${sessionId} reason=${reason} messages=${buf.texts.length} chars=${combined.length} head=${JSON.stringify(combined.slice(0, 200))} — no delivery fallback registered (pass onDeliveryLost to queueEmbeddedPiMessage)`,
  );
  return false;
}

function flushSteerBuffer(sessionId: string, opts?: { runEnding?: boolean }) {
  const buf = steerBuffers.get(sessionId);
  if (!buf || buf.texts.length === 0) {
    return;
  }
  steerBuffers.delete(sessionId);
  clearTimeout(buf.timer);
  const combined = buf.texts.join("\n\n");
  // FORK (2026-08-28): The run is tearing down NOW (clearActiveEmbeddedRun).
  // Steering into a finishing worker or queueMessage()-ing a "next round" that
  // will never come are both dead letters — with a registered fallback, skip
  // the handle entirely and deliver as a NEW follow-up turn. Mutually
  // exclusive with the paths below — never both, or the message would be
  // delivered twice.
  if (opts?.runEnding && buf.fallback) {
    deliverSteerBufferViaFallback(sessionId, buf, combined, "run_ending");
    return;
  }
  // FORK P4 (in-flight steer): try to fold the message INTO the live provider
  // turn first — tinker-bridge writes it to the running claude-cli stdin, which
  // picks it up between tool rounds (like Claude Code), so it changes the
  // current answer instead of waiting for the whole turn + a separate next turn.
  // Only fall back to the pi-agent-core steeringQueue (next-round delivery) when
  // no live provider worker accepts it. Mutually exclusive — never both, or the
  // message would be delivered twice.
  if (tryInflightSteer(sessionId, combined)) {
    diag.debug(
      `steer flush: folded into live turn sessionId=${sessionId} chars=${combined.length}`,
    );
    return;
  }
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    // FORK (2026-08-28): The run ended during the debounce window. This used
    // to be a silent drop behind a debug line — the ONE way a buffered user
    // message could vanish. Deliver as a new follow-up turn instead, or fail
    // loudly when no fallback was registered.
    deliverSteerBufferViaFallback(sessionId, buf, combined, "no_active_run");
    return;
  }
  diag.debug(
    `steer flush: sessionId=${sessionId} messages=${buf.texts.length} chars=${combined.length}`,
  );
  void handle.queueMessage(combined);
}

// FORK (2026-08-28): `true` means ACCEPTED FOR DELIVERY, not yet delivered —
// the flush delivers via in-flight steer or the run's next round, and when the
// run ends first, via `opts.onDeliveryLost` as a NEW follow-up turn. Callers
// that treat `true` as "handled" and skip their own fallback should pass
// onDeliveryLost; without it a run that ends mid-debounce surfaces as a diag
// ERROR — never a silent drop. Return type stays boolean so the existing call
// sites (agent-runner steer path, subagent announce delivery, dozens of test
// mocks) keep compiling unchanged.
export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
  opts?: { onDeliveryLost?: SteerDeliveryFallback },
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }
  logMessageQueued({ sessionId, source: "embedded-agent-runner" });
  // FORK: Buffer the message — flush after debounce window so rapid
  // follow-up messages are combined into a single steer injection.
  const now = Date.now();
  const existing = steerBuffers.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.texts.push(text);
    if (opts?.onDeliveryLost) {
      // FORK (2026-08-28): latest caller-supplied fallback wins — in practice
      // one session has one delivery path, so this is a refresh, not a race.
      existing.fallback = opts.onDeliveryLost;
    }
    // FORK (2026-08-28): keep debouncing for batching, but never schedule the
    // flush past the max-wait cap measured from the FIRST buffered message —
    // a steady stream of keystroke-fast messages must not postpone injection
    // indefinitely.
    const elapsedMs = now - existing.firstBufferedAt;
    const delayMs = Math.min(STEER_DEBOUNCE_MS, Math.max(0, STEER_MAX_WAIT_MS - elapsedMs));
    existing.timer = setTimeout(() => flushSteerBuffer(sessionId), delayMs);
  } else {
    steerBuffers.set(sessionId, {
      texts: [text],
      timer: setTimeout(() => flushSteerBuffer(sessionId), STEER_DEBOUNCE_MS),
      firstBufferedAt: now,
      fallback: opts?.onDeliveryLost,
    });
  }
  return true;
}

/**
 * Abort embedded PI runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedPiRun(sessionId: string): boolean;
export function abortEmbeddedPiRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting" },
): boolean;
export function abortEmbeddedPiRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    if (!handle) {
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }
    diag.debug(`aborting run: sessionId=${sessionId}`);
    try {
      handle.abort();
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }
    return true;
  }

  const mode = opts?.mode;
  if (mode === "compacting") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      if (!handle.isCompacting()) {
        continue;
      }
      diag.debug(`aborting compacting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  }

  if (mode === "all") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      diag.debug(`aborting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  }

  return false;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}

export function getActiveEmbeddedRunCount(): number {
  return ACTIVE_EMBEDDED_RUNS.size;
}

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

export function requestEmbeddedRunModelSwitch(
  sessionId: string,
  request: EmbeddedRunModelSwitchRequest,
): boolean {
  const normalizedSessionId = sessionId.trim();
  const provider = request.provider.trim();
  const model = request.model.trim();
  if (!normalizedSessionId || !provider || !model) {
    return false;
  }
  EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.set(normalizedSessionId, {
    provider,
    model,
    authProfileId: normalizeOptionalString(request.authProfileId),
    authProfileIdSource: normalizeOptionalString(request.authProfileId)
      ? request.authProfileIdSource
      : undefined,
  });
  diag.debug(
    `model switch requested: sessionId=${normalizedSessionId} provider=${provider} model=${model}`,
  );
  return true;
}

export function consumeEmbeddedRunModelSwitch(
  sessionId: string,
): EmbeddedRunModelSwitchRequest | undefined {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return undefined;
  }
  const request = EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.get(normalizedSessionId);
  if (request) {
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(normalizedSessionId);
  }
  return request;
}

/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight runs can release session write locks before
 * the next lifecycle starts. If no timeout is passed, waits indefinitely.
 */
export async function waitForActiveEmbeddedRuns(
  timeoutMs?: number,
  opts?: { pollMs?: number },
): Promise<{ drained: boolean }> {
  const pollMsRaw = opts?.pollMs ?? 250;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    return { drained: getActiveEmbeddedRunCount() === 0 };
  }
  const maxWaitMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(pollMs, Math.floor(timeoutMs))
      : undefined;

  const startedAt = Date.now();
  while (true) {
    if (ACTIVE_EMBEDDED_RUNS.size === 0) {
      return { drained: true };
    }
    const elapsedMs = Date.now() - startedAt;
    if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
      diag.warn(
        `wait for active embedded runs timed out: activeRuns=${ACTIVE_EMBEDDED_RUNS.size} timeoutMs=${maxWaitMs}`,
      );
      return { drained: false };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

/**
 * Resolves the active embedded run's sessionId for a given session key.
 * Checks exact match first, then partial (substring) match.
 */
export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined {
  if (ACTIVE_EMBEDDED_RUNS.has(sessionKey)) {
    return sessionKey;
  }
  for (const sessionId of ACTIVE_EMBEDDED_RUNS.keys()) {
    if (sessionId.includes(sessionKey) || sessionKey.includes(sessionId)) {
      return sessionId;
    }
  }
  return undefined;
}

/**
 * Ambiguity-aware variant of {@link resolveActiveEmbeddedRunSessionId}.
 *
 * The substring fallback above returns the FIRST matching run, which is Map
 * insertion order. That is fine when a session key identifies exactly one run,
 * but several UI tabs share one agent session key (e.g. every Claude Code tab
 * is `agent:main:main`), so a fuzzy match silently picks a sibling tab. Callers
 * that route a message to a specific requester must not guess: delivering a
 * subagent result into the wrong tab makes an unrelated agent act on it.
 *
 * Exact match always wins. Otherwise substring matches are counted, and a
 * unique match is returned; two or more candidates report `ambiguous` with no
 * sessionId so the caller can fail closed instead of picking one.
 */
export function resolveActiveEmbeddedRunSessionIdUnique(sessionKey: string): {
  sessionId?: string;
  ambiguous: boolean;
  candidateCount: number;
} {
  if (ACTIVE_EMBEDDED_RUNS.has(sessionKey)) {
    return { sessionId: sessionKey, ambiguous: false, candidateCount: 1 };
  }
  const matches: string[] = [];
  for (const sessionId of ACTIVE_EMBEDDED_RUNS.keys()) {
    if (sessionId.includes(sessionKey) || sessionKey.includes(sessionId)) {
      matches.push(sessionId);
    }
  }
  if (matches.length === 1) {
    return { sessionId: matches[0], ambiguous: false, candidateCount: 1 };
  }
  if (matches.length > 1) {
    diag.debug(
      `ambiguous active run for sessionKey=${sessionKey} candidates=${matches.length}; refusing to guess`,
    );
    return { ambiguous: true, candidateCount: matches.length };
  }
  return { ambiguous: false, candidateCount: 0 };
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    // FORK: Flush any pending steer buffer before clearing the run
    // so buffered messages aren't silently lost.
    // FORK (2026-08-28): runEnding tells the flush this handle is a dead
    // letter — with a registered fallback the text becomes a NEW follow-up
    // turn instead of a queueMessage() the finished run will never read.
    const pending = steerBuffers.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      flushSteerBuffer(sessionId, { runEnding: true });
    }
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(sessionId);
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export const __testing = {
  resetActiveEmbeddedRuns() {
    // FORK (2026-08-28): also drop pending steer buffers — a leftover flush
    // timer firing after reset would now log a loud DROPPED error into an
    // unrelated test.
    for (const buf of steerBuffers.values()) {
      clearTimeout(buf.timer);
    }
    steerBuffers.clear();
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.clear();
  },
};

export type { EmbeddedPiQueueHandle, SteerDeliveryFallback };
