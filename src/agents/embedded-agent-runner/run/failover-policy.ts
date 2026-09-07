import type { FailoverReason } from "../../embedded-agent-helpers.js";

/**
 * FORK 2026-09-03 (the user pressed Stop and the chat answered
 * "⚠️ Agent failed before reply: LLM request timed out.", transcript 12a0e0c4).
 *
 * A user Stop reaches the runner as an AbortError whose message is
 * "This operation was aborted", and that string is matched by
 * `ERROR_PATTERNS.timeout` in `embedded-agent-helpers/failover-matches.ts`
 * (`/\boperation was aborted\b/i`, added for Ollama/fetch stream aborts,
 * openclaw#58315). That pattern is CORRECT for genuine transport aborts, so it
 * must NOT be narrowed. The fix belongs upstream of it: when the abort came
 * from OUTSIDE the runner (`externalAbort`) the error text is irrelevant — a
 * human pressing Stop is not a provider failure and must never be classified,
 * counted or reported as one.
 *
 * ALTERNATIVE REJECTED: adding "aborted" to `FailoverReason`. That union is the
 * set of PROVIDER failure classes — it drives auth-profile cooldowns, profile
 * rotation, HTTP-status mapping (`resolveFailoverStatus`) and the model
 * fallback chain. A user Stop belongs to none of them, so it travels as a
 * surface-only reason here and as `FailoverError.code` on the wire.
 */
export const USER_ABORT_FAILOVER_REASON = "aborted" as const;

/**
 * Discriminator stamped onto the `code` of the FailoverError a user Stop
 * surfaces, so downstream callers can tell "the human pressed Stop" from "the
 * provider failed" WITHOUT re-parsing the message — the message is exactly what
 * lied in the original bug. `FailoverError.code` is a plain string field, which
 * keeps `FailoverReason` unpolluted.
 */
export const USER_ABORT_FAILOVER_CODE = "user_abort";

/** Neutral bubble for a user Stop: no warning emoji, no "Logs:" line. */
export const USER_ABORT_SURFACE_MESSAGE = "Stopped.";

export type UserAbortFailoverReason = typeof USER_ABORT_FAILOVER_REASON;

/** Reasons a `surface_error` decision may carry: provider failures + user Stop. */
export type RunFailoverSurfaceReason = FailoverReason | UserAbortFailoverReason;

export function isUserAbortFailoverReason(
  reason: RunFailoverSurfaceReason | null | undefined,
): reason is UserAbortFailoverReason {
  return reason === USER_ABORT_FAILOVER_REASON;
}

/**
 * The provider-failure half of a surface reason — `null` for a user Stop, so
 * callers that need a real `FailoverReason` (status mapping, FailoverError)
 * cannot accidentally receive "aborted".
 */
export function toProviderFailoverReason(
  reason: RunFailoverSurfaceReason | null | undefined,
): FailoverReason | null {
  if (reason == null || reason === USER_ABORT_FAILOVER_REASON) {
    return null;
  }
  return reason;
}

const MAX_USER_ABORT_ERROR_DEPTH = 8;

/**
 * True when `err` — or anything it wraps: a `cause` chain, or a
 * `FallbackSummaryError` attempt row — was produced by a user Stop.
 *
 * Structural on purpose: importing `model-fallback.js` here would be a cycle,
 * and the attempts rows carry `code` verbatim (`describeFailoverError()` copies
 * `FailoverError.code` into `FallbackAttempt.code`). This matters because with
 * 2+ fallback candidates the Stop-flavoured error is NOT the last one thrown:
 * later candidates re-throw the already-aborted signal and get classified
 * `timeout`, so only the attempts walk finds the Stop.
 *
 * Reads only `code`, never the message — the message is what lied.
 */
export function isUserAbortFailoverError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > MAX_USER_ABORT_ERROR_DEPTH) {
    return false;
  }
  const candidate = err as { code?: unknown; cause?: unknown; attempts?: unknown };
  if (candidate.code === USER_ABORT_FAILOVER_CODE) {
    return true;
  }
  if (Array.isArray(candidate.attempts)) {
    for (const attempt of candidate.attempts) {
      if (!attempt || typeof attempt !== "object") {
        continue;
      }
      if ((attempt as { code?: unknown }).code === USER_ABORT_FAILOVER_CODE) {
        return true;
      }
      if (isUserAbortFailoverError((attempt as { error?: unknown }).error, depth + 1)) {
        return true;
      }
    }
  }
  return isUserAbortFailoverError(candidate.cause, depth + 1);
}

export type RunFailoverDecisionAction =
  | "continue_normal"
  | "rotate_profile"
  | "fallback_model"
  | "surface_error"
  | "return_error_payload";

export type RunFailoverDecision =
  | {
      action: "continue_normal";
    }
  | {
      action: "rotate_profile";
      reason: FailoverReason | null;
    }
  | {
      // Only `surface_error` may carry the user-Stop reason: it is the terminal
      // decision. Rotation and model fallback are provider-failure remedies and
      // must never be reached for an abort.
      action: "surface_error";
      reason: RunFailoverSurfaceReason | null;
    }
  | {
      action: "fallback_model";
      reason: FailoverReason;
    }
  | {
      action: "return_error_payload";
    };

export type RetryLimitFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "fallback_model" | "return_error_payload" }
>;

export type PromptFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "rotate_profile" | "fallback_model" | "surface_error" }
>;

export type AssistantFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "continue_normal" | "rotate_profile" | "fallback_model" | "surface_error" }
>;

type RetryLimitDecisionParams = {
  stage: "retry_limit";
  fallbackConfigured: boolean;
  failoverReason: FailoverReason | null;
};

type PromptDecisionParams = {
  stage: "prompt";
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  profileRotated: boolean;
};

type AssistantDecisionParams = {
  stage: "assistant";
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  timedOutDuringCompaction: boolean;
  profileRotated: boolean;
};

export type RunFailoverDecisionParams =
  | RetryLimitDecisionParams
  | PromptDecisionParams
  | AssistantDecisionParams;

function shouldEscalateRetryLimit(reason: FailoverReason | null): boolean {
  return Boolean(
    reason &&
    reason !== "timeout" &&
    reason !== "model_not_found" &&
    reason !== "format" &&
    reason !== "session_expired",
  );
}

function shouldRotatePrompt(params: PromptDecisionParams): boolean {
  return params.failoverFailure && params.failoverReason !== "timeout";
}

function shouldRotateAssistant(params: AssistantDecisionParams): boolean {
  return (
    (!params.aborted && (params.failoverFailure || params.failoverReason !== null)) ||
    (params.timedOut && !params.timedOutDuringCompaction)
  );
}

export function mergeRetryFailoverReason(params: {
  previous: FailoverReason | null;
  failoverReason: FailoverReason | null;
  timedOut?: boolean;
}): FailoverReason | null {
  return params.failoverReason ?? (params.timedOut ? "timeout" : null) ?? params.previous;
}

export function resolveRunFailoverDecision(
  params: RetryLimitDecisionParams,
): RetryLimitFailoverDecision;
export function resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision;
export function resolveRunFailoverDecision(
  params: AssistantDecisionParams,
): AssistantFailoverDecision;
export function resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision {
  if (params.stage === "retry_limit") {
    if (params.fallbackConfigured && shouldEscalateRetryLimit(params.failoverReason)) {
      const fallbackReason = params.failoverReason ?? "unknown";
      return {
        action: "fallback_model",
        reason: fallbackReason,
      };
    }
    return {
      action: "return_error_payload",
    };
  }

  if (params.stage === "prompt") {
    if (params.externalAbort) {
      // FORK 2026-09-03: the abort came from outside the runner (chat.abort /
      // the Stop button / a restart drain). Whatever the provider error text
      // says — and for a raw AbortError it says "This operation was aborted",
      // which the timeout matcher claims — this is a user Stop, not a failure.
      return {
        action: "surface_error",
        reason: USER_ABORT_FAILOVER_REASON,
      };
    }
    if (!params.profileRotated && shouldRotatePrompt(params)) {
      return {
        action: "rotate_profile",
        reason: params.failoverReason,
      };
    }
    if (params.fallbackConfigured && params.failoverFailure) {
      return {
        action: "fallback_model",
        reason: params.failoverReason ?? "unknown",
      };
    }
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }

  if (params.externalAbort) {
    // FORK 2026-09-03: assistant-stage twin of the prompt-stage branch above.
    // This is the branch the live incident took (runId 12a0e0c4): `timedOut`
    // was true only because the AbortError text matched ERROR_PATTERNS.timeout,
    // and `reason: params.failoverReason` (null) let assistant-failover.ts fall
    // through to `params.timedOut ? "timeout"` and print "LLM request timed
    // out." for a user Stop.
    return {
      action: "surface_error",
      reason: USER_ABORT_FAILOVER_REASON,
    };
  }
  const assistantShouldRotate = shouldRotateAssistant(params);
  if (!params.profileRotated && assistantShouldRotate) {
    return {
      action: "rotate_profile",
      reason: params.failoverReason,
    };
  }
  if (assistantShouldRotate && params.fallbackConfigured) {
    return {
      action: "fallback_model",
      reason: params.timedOut ? "timeout" : (params.failoverReason ?? "unknown"),
    };
  }
  if (!assistantShouldRotate) {
    return {
      action: "continue_normal",
    };
  }
  return {
    action: "surface_error",
    reason: params.failoverReason,
  };
}
