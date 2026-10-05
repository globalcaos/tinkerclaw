import { touchAgentRunContextsForSession } from "../../infra/agent-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type ReplyRunKey = string;

export type ReplyBackendKind = "embedded" | "cli";

export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  cancel(reason?: ReplyBackendCancelReason): void;
  isStreaming(): boolean;
  queueMessage?: (text: string) => Promise<void>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export type ReplyOperationPhase =
  | "queued"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_failed";

export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  /**
   * Wall-clock time this operation was created. A run context registered before it belongs to an
   * earlier turn, so this operation must neither refresh nor shield it (prompt-queue.md §6.2
   * "Sweep (C9)"). Optional only so hand-built test doubles still type-check;
   * createReplyOperation always sets it.
   */
  readonly startedAt?: number;
  /**
   * The FIRST prompt this operation answers (`promptKeys[0]`): PQ-1's one identity, the key the
   * client sent with `chat.send` (a webchat FollowupRun's `messageId` IS that idempotencyKey, see
   * agent-runner.ts "RECORD THE STEER"). Kept beside `promptKeys` for readers that know one key;
   * for a single-prompt turn the two cannot disagree. Undefined when the creator passed no key (a
   * heartbeat, an overflow-summary follow-up); the snapshot then omits the turn rather than invent
   * a key. Optional for the same reason as `startedAt`: hand-built test doubles still type-check.
   */
  readonly promptKey?: string;
  /**
   * FORK 2026-09-24 (prompt-queue.md §6.3, §7 steps G3 and G5): EVERY prompt this operation
   * answers, in arrival order, trimmed and deduplicated; empty when it answers none. More than one
   * for a coalesced follow-up: a collect-mode batch, or a lost steer re-enqueued with every
   * buffered caller's key (queue/types.ts resolveFollowupRunPromptKeys). sessions.list reads it to
   * report EACH as PREPARING, then RUNNING (src/gateway/session-utils.ts
   * deriveSessionPendingPrompts).
   *
   * Shape: one ordered list on the one operation, sharing one `since` (`startedAt`). The keys share
   * a single turn, so they change state together. One operation per key would break the registry's
   * one-operation-per-session rule, and leaving the extra keys only on the follow-up queue item
   * would report them BEHIND while their turn runs (drain.ts keeps a batch queued until its run
   * returns). A list, not a set, because arrival order is the order the client shows them in.
   * Optional only so hand-built test doubles still type-check; createReplyOperation always sets it.
   */
  readonly promptKeys?: readonly string[];
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  complete(): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
  abortForRestart(): void;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    /** See ReplyOperation.promptKey. */
    promptKey?: string;
    /** See ReplyOperation.promptKeys. */
    promptKeys?: readonly string[];
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  isStreaming(sessionKey: string): boolean;
  abort(sessionKey: string): boolean;
  waitForIdle(sessionKey: string, timeoutMs?: number): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

type ReplyRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
  /**
   * Prompts each unsettled operation's running turn accepted by steer (recordSteeredReplyPrompt):
   * prompt key → the time it was accepted. Keyed by the operation object, so the record dies with
   * it. Optional and created on first use (the runs.ts `waiters` pattern), so the singleton's
   * factory stays unchanged.
   */
  steeredPromptsByOperation?: WeakMap<ReplyOperation, Map<string, number>>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeKeysBySessionId: new Map<string, string>(),
  waitKeysBySessionId: new Map<string, string>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
}));

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

function createUserAbortError(): Error {
  const err = new Error("Reply operation aborted by user");
  err.name = "AbortError";
  return err;
}

function registerWaitSessionId(sessionKey: string, sessionId: string): void {
  replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}

function clearWaitSessionIds(sessionKey: string): void {
  for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) {
    if (mappedKey === sessionKey) {
      replyRunState.waitKeysBySessionId.delete(sessionId);
    }
  }
}

function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  const sessionKey = replyRunState.activeKeysBySessionId.get(normalizedSessionId);
  if (!sessionKey) {
    return undefined;
  }
  return replyRunState.activeRunsByKey.get(sessionKey);
}

function resolveReplyRunWaitKey(sessionId: string): string | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return (
    replyRunState.activeKeysBySessionId.get(normalizedSessionId) ??
    replyRunState.waitKeysBySessionId.get(normalizedSessionId)
  );
}

function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  if (operation.phase !== "running") {
    return false;
  }
  const backend = getAttachedBackend(operation);
  return backend?.isCompacting?.() ?? false;
}

const attachedBackendByOperation = new WeakMap<ReplyOperation, ReplyBackendHandle>();

function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  operation: ReplyOperation;
}): void {
  // FORK 2026-10-02 (bug-log [reset-refused-after-a-turn]): only the operation that still owns the
  // key clears it. One that a newer operation replaced (the stale force-clear in
  // createReplyOperation) ends without touching the newer one's entry or waking its waiters.
  if (replyRunState.activeRunsByKey.get(params.sessionKey) !== params.operation) {
    return;
  }
  replyRunState.activeRunsByKey.delete(params.sessionKey);
  if (replyRunState.activeSessionIdsByKey.get(params.sessionKey) === params.sessionId) {
    replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  } else {
    replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  }
  if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
    replyRunState.activeKeysBySessionId.delete(params.sessionId);
  }
  clearWaitSessionIds(params.sessionKey);
  notifyReplyRunEnded(params.sessionKey);
}

/**
 * ReplyOperation.promptKeys from the creator's input: `promptKey` first, then `promptKeys`, each
 * trimmed, with empties and repeats dropped (the first occurrence wins); frozen.
 */
function normalizeReplyPromptKeys(
  promptKey: string | undefined,
  promptKeys: readonly string[] | undefined,
): readonly string[] {
  const keys: string[] = [];
  for (const raw of [promptKey, ...(promptKeys ?? [])]) {
    const key = normalizeOptionalString(raw);
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return Object.freeze(keys);
}

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  resetTriggered: boolean;
  /**
   * See ReplyOperation.promptKey and promptKeys. Not validated like the two keys above: a turn
   * without a prompt key is ordinary, and refusing it would trade a missing badge for a missing
   * answer. Both may be passed: `promptKey` is listed first, then `promptKeys`, deduplicated.
   */
  promptKey?: string;
  promptKeys?: readonly string[];
  upstreamAbortSignal?: AbortSignal;
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  if (replyRunState.activeRunsByKey.has(sessionKey)) {
    // FORK 2026-04-20: before failing, check if the existing operation is
    // actually stale (completed phase, no live streaming). If it is, force-
    // clear and proceed. The proper path is `replyOperation.complete()`
    // called from followup-runner's finally block; when that fails to fire
    // (upstream edge case we haven't pinpointed yet), the registry entry
    // persists indefinitely and every subsequent prompt throws. The
    // force-clear keeps the UX working; if we're wrong about "stale", the
    // previous op genuinely still runs and the interrupt path (abort from
    // sessions.steer) is the legitimate fix.
    const existing = replyRunState.activeRunsByKey.get(sessionKey);
    const backend = existing ? attachedBackendByOperation.get(existing) : undefined;
    const looksStale =
      existing !== undefined &&
      (existing.phase === "completed" ||
        existing.phase === "failed" ||
        existing.phase === "aborted" ||
        !backend ||
        !backend.isStreaming());
    if (looksStale) {
      replyRunState.activeRunsByKey.delete(sessionKey);
      replyRunState.activeSessionIdsByKey.delete(sessionKey);
      const staleSessionId = existing ? (existing.sessionId as string | undefined) : undefined;
      if (staleSessionId) {
        const mapped = replyRunState.activeKeysBySessionId.get(staleSessionId);
        if (mapped === sessionKey) {
          replyRunState.activeKeysBySessionId.delete(staleSessionId);
        }
      }
      clearWaitSessionIds(sessionKey);
    } else {
      throw new ReplyRunAlreadyActiveError(sessionKey);
    }
  }

  const controller = new AbortController();
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  const startedAt = Date.now();
  const promptKeys = normalizeReplyPromptKeys(params.promptKey, params.promptKeys);
  const promptKey: string | undefined = promptKeys[0];

  const clearState = () => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    clearReplyRunState({
      sessionKey,
      sessionId: currentSessionId,
      operation,
    });
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const abortWithReason = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    opts?: { abortedCode?: ReplyOperationAbortCode },
  ) => {
    if (opts?.abortedCode && !result) {
      result = { kind: "aborted", code: opts.abortedCode };
    }
    phase = "aborted";
    abortInternally(abortReason);
    getAttachedBackend(operation)?.cancel(reason);
  };

  if (params.upstreamAbortSignal) {
    if (params.upstreamAbortSignal.aborted) {
      abortInternally(params.upstreamAbortSignal.reason);
    } else {
      params.upstreamAbortSignal.addEventListener(
        "abort",
        () => {
          abortInternally(params.upstreamAbortSignal?.reason);
        },
        { once: true },
      );
    }
  }

  const operation: ReplyOperation = {
    get key() {
      return sessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get abortSignal() {
      return controller.signal;
    },
    get resetTriggered() {
      return params.resetTriggered;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
    get startedAt() {
      return startedAt;
    },
    get promptKey() {
      return promptKey;
    },
    get promptKeys() {
      return promptKeys;
    },
    setPhase(next) {
      if (result) {
        return;
      }
      phase = next;
      // FORK 2026-09-24 (prompt-queue.md §6.2 "Sweep (C9)", step G4): a phase change is activity.
      // A turn that is compacting, flushing memory or starting its run emits no agent event, so
      // without this its run context aged toward the stale-run sweep while the turn was working.
      // Only contexts registered since this operation began: older ones are earlier turns.
      touchAgentRunContextsForSession(sessionKey, startedAt);
    },
    updateSessionId(nextSessionId) {
      if (result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      if (
        replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) &&
        replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== sessionKey
      ) {
        throw new Error(
          `Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      replyRunState.activeKeysBySessionId.delete(currentSessionId);
      registerWaitSessionId(sessionKey, currentSessionId);
      currentSessionId = normalizedNextSessionId;
      replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
      registerWaitSessionId(sessionKey, currentSessionId);
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : "user_abort"
            : "superseded",
        );
        return;
      }
      attachedBackendByOperation.set(operation, handle);
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (getAttachedBackend(operation) === handle) {
        attachedBackendByOperation.delete(operation);
      }
    },
    complete() {
      if (!result) {
        result = { kind: "completed" };
        phase = "completed";
      }
      clearState();
    },
    fail(code, cause) {
      if (!result) {
        result = { kind: "failed", code, cause };
        phase = "failed";
      }
      clearState();
    },
    abortByUser() {
      const phaseBeforeAbort = phase;
      abortWithReason("user_abort", createUserAbortError(), {
        abortedCode: "aborted_by_user",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      }
    },
    abortForRestart() {
      const phaseBeforeAbort = phase;
      abortWithReason("restart", new Error("Reply operation aborted for restart"), {
        abortedCode: "aborted_for_restart",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      }
    },
  };

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
  replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
  registerWaitSessionId(sessionKey, currentSessionId);

  return operation;
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin(params) {
    return createReplyOperation(params);
  },
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeRunsByKey.get(normalizedSessionKey);
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return false;
    }
    return replyRunState.activeRunsByKey.has(normalizedSessionKey);
  },
  isStreaming(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation || operation.phase !== "running") {
      return false;
    }
    return getAttachedBackend(operation)?.isStreaming() ?? false;
  },
  abort(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation) {
      return false;
    }
    operation.abortByUser();
    return true;
  },
  waitForIdle(sessionKey, timeoutMs = 15_000) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
      const waiter: ReplyRunWaiter = {
        resolve,
        timer: setTimeout(
          () => {
            waiters.delete(waiter);
            if (waiters.size === 0) {
              replyRunState.waitersByKey.delete(normalizedSessionKey);
            }
            resolve(false);
          },
          Math.max(100, timeoutMs),
        ),
      };
      waiters.add(waiter);
      replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
      if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          replyRunState.waitersByKey.delete(normalizedSessionKey);
        }
        clearTimeout(waiter.timer);
        resolve(true);
      }
    });
  },
  resolveSessionId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
  },
};

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  return replyRunRegistry.resolveSessionId(sessionKey);
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function isReplyRunStreamingForSessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.phase !== "running") {
    return false;
  }
  return getAttachedBackend(operation)?.isStreaming() ?? false;
}

export function queueReplyRunMessage(sessionId: string, text: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const backend = operation ? getAttachedBackend(operation) : undefined;
  if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
    return false;
  }
  if (!backend.isStreaming()) {
    return false;
  }
  void backend.queueMessage(text);
  return true;
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  operation.abortByUser();
  return true;
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

export function abortActiveReplyRuns(opts: { mode: "all" | "compacting" }): boolean {
  let aborted = false;
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
      continue;
    }
    operation.abortForRestart();
    aborted = true;
  }
  return aborted;
}

export function getActiveReplyRunCount(): number {
  return replyRunState.activeRunsByKey.size;
}

export function listActiveReplyRunSessionIds(): string[] {
  return [...replyRunState.activeSessionIdsByKey.values()];
}

/** One prompt a running turn accepted by steer: its key and the time it was accepted. */
export type SteeredReplyPrompt = { key: string; since: number };

function steeredPromptsByOperation(): WeakMap<ReplyOperation, Map<string, number>> {
  return (replyRunState.steeredPromptsByOperation ??= new WeakMap<
    ReplyOperation,
    Map<string, number>
  >());
}

/** The operation registered for `sessionKey`, while it has not settled (`result` is still null). */
function resolveUnsettledReplyOperation(sessionKey: string): ReplyOperation | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return undefined;
  }
  const operation = replyRunState.activeRunsByKey.get(normalizedSessionKey);
  return operation && operation.result === null ? operation : undefined;
}

/**
 * Record that the turn running on `sessionKey` ACCEPTED `promptKey` by steer.
 *
 * FORK 2026-09-24 (prompt-queue.md §2 STEERED, §7 step G5). A steered prompt is answered inside the
 * running turn, so its STEERED state lasts until THAT turn ends (§2 "STEERED → ANSWERED: host turn
 * R ends"; §6.1 "cleared by host turn's terminal"). The steer buffer cannot report it: it holds its
 * callers' keys only until it flushes, within STEER_MAX_WAIT_MS (1.5 s,
 * src/agents/embedded-agent-runner/runs.ts). The running operation is the one holder whose
 * lifetime is the host turn, so the key is kept on it and dies with it. This is not a new holder
 * of "live" (§6.4): it is read only while its operation is registered and unsettled, and it can
 * never make a session look live on its own.
 *
 * Returns false and records nothing when no unsettled operation holds the session key, or the
 * prompt key is empty. For a key recorded twice, the first acceptance time wins. Production caller:
 * agent-runner.ts's steer branch, once per key of each prompt the steer buffer accepted.
 */
export function recordSteeredReplyPrompt(
  sessionKey: string,
  promptKey: string,
  at: number = Date.now(),
): boolean {
  const normalizedPromptKey = normalizeOptionalString(promptKey);
  const operation = resolveUnsettledReplyOperation(sessionKey);
  if (!normalizedPromptKey || !operation) {
    return false;
  }
  const byOperation = steeredPromptsByOperation();
  let steered = byOperation.get(operation);
  if (!steered) {
    steered = new Map<string, number>();
    byOperation.set(operation, steered);
  }
  if (!steered.has(normalizedPromptKey)) {
    steered.set(normalizedPromptKey, at);
  }
  return true;
}

/**
 * The prompts recordSteeredReplyPrompt kept on the operation registered for `sessionKey`, in
 * acceptance order. Empty once that operation settles or leaves the registry: the host turn ended,
 * and their STEERED state with it.
 */
export function listSteeredReplyPrompts(sessionKey: string): SteeredReplyPrompt[] {
  const operation = resolveUnsettledReplyOperation(sessionKey);
  const steered = operation ? steeredPromptsByOperation().get(operation) : undefined;
  return steered ? [...steered].map(([key, since]) => ({ key, since })) : [];
}

export const __testing = {
  resetReplyRunRegistry(): void {
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
    replyRunState.waitersByKey.clear();
  },
};
