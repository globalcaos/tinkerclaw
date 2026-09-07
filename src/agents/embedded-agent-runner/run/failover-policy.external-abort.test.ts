import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { handleAssistantFailover } from "./assistant-failover.js";
import {
  isUserAbortFailoverError,
  isUserAbortFailoverReason,
  resolveRunFailoverDecision,
  toProviderFailoverReason,
  USER_ABORT_FAILOVER_CODE,
  USER_ABORT_FAILOVER_REASON,
  USER_ABORT_SURFACE_MESSAGE,
} from "./failover-policy.js";

// Regression suite for the 2026-08-27 incident (transcript 12a0e0c4, runId
// 12a0e0c4 16:26): pressing Stop produced
//   "⚠️ Agent failed before reply: LLM request timed out."
// and marked the session FAILED. Cause: chat.abort's AbortError message
// "This operation was aborted" is matched by ERROR_PATTERNS.timeout
// (failover-matches.ts `/\boperation was aborted\b/i`), so the runner arrived
// at the failover policy with timedOut=true. The policy must decide on
// `externalAbort`, never on the error text.

describe("resolveRunFailoverDecision — external abort is a user Stop, not a timeout", () => {
  it("reports 'aborted' when the abort text is the one the timeout matcher claims", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: true,
        fallbackConfigured: false,
        failoverFailure: false,
        // What classifyFailoverReason() returns for "This operation was aborted".
        failoverReason: "timeout",
        timedOut: true,
        timedOutDuringCompaction: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: USER_ABORT_FAILOVER_REASON,
    });
  });

  it("reports 'aborted' regardless of the error text carried alongside the abort", () => {
    for (const failoverReason of ["rate_limit", "overloaded", "auth", null] as const) {
      expect(
        resolveRunFailoverDecision({
          stage: "assistant",
          aborted: true,
          externalAbort: true,
          fallbackConfigured: true,
          failoverFailure: true,
          failoverReason,
          timedOut: false,
          timedOutDuringCompaction: false,
          profileRotated: true,
        }),
      ).toEqual({
        action: "surface_error",
        reason: USER_ABORT_FAILOVER_REASON,
      });
    }
  });

  it("reports 'aborted' at the prompt stage too", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: true,
        externalAbort: true,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: USER_ABORT_FAILOVER_REASON,
    });
  });

  it("leaves a genuine provider timeout classified as 'timeout'", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: false,
        failoverFailure: false,
        failoverReason: "timeout",
        timedOut: true,
        timedOutDuringCompaction: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });
});

describe("user-abort helpers", () => {
  it("recognises the surface reason and keeps it out of provider classification", () => {
    expect(isUserAbortFailoverReason(USER_ABORT_FAILOVER_REASON)).toBe(true);
    expect(isUserAbortFailoverReason("timeout")).toBe(false);
    expect(isUserAbortFailoverReason(null)).toBe(false);
    expect(toProviderFailoverReason(USER_ABORT_FAILOVER_REASON)).toBeNull();
    expect(toProviderFailoverReason(null)).toBeNull();
    expect(toProviderFailoverReason("timeout")).toBe("timeout");
  });

  it("finds the user-abort code through cause chains and fallback-summary attempts", () => {
    const stopped = Object.assign(new Error(USER_ABORT_SURFACE_MESSAGE), {
      code: USER_ABORT_FAILOVER_CODE,
    });
    expect(isUserAbortFailoverError(stopped)).toBe(true);
    expect(isUserAbortFailoverError(new Error("wrapped", { cause: stopped }))).toBe(true);
    // With 2+ fallback candidates the Stop is NOT the last error thrown: later
    // candidates re-throw the already-aborted signal and classify as timeout,
    // so only the attempts rows still carry the Stop.
    expect(
      isUserAbortFailoverError(
        Object.assign(new Error("All models failed (2): ..."), {
          attempts: [
            {
              provider: "xai",
              model: "grok-4.5",
              error: USER_ABORT_SURFACE_MESSAGE,
              reason: "unknown",
              code: USER_ABORT_FAILOVER_CODE,
            },
            {
              provider: "anthropic",
              model: "claude-haiku-4-5-20251001",
              error: "This operation was aborted",
              reason: "timeout",
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(isUserAbortFailoverError(new Error("LLM request timed out."))).toBe(false);
    expect(isUserAbortFailoverError(undefined)).toBe(false);
    expect(isUserAbortFailoverError("Stopped.")).toBe(false);
  });

  it("terminates on a self-referencing cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUserAbortFailoverError(looped)).toBe(false);
  });
});

type AssistantParams = Parameters<typeof handleAssistantFailover>[0];

function makeAssistantParams(overrides: Partial<AssistantParams> = {}): AssistantParams {
  const provider = "xai";
  const model = "grok-4.5";
  return {
    initialDecision: { action: "surface_error", reason: USER_ABORT_FAILOVER_REASON },
    aborted: true,
    externalAbort: true,
    fallbackConfigured: false,
    failoverFailure: false,
    failoverReason: null,
    // The runner really does arrive here with timedOut=true for a user Stop:
    // isTimeoutError() matches the AbortError text. That is the trap.
    timedOut: true,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    allowSameModelIdleTimeoutRetry: false,
    assistantProfileFailureReason: null,
    lastProfileId: undefined,
    modelId: model,
    provider,
    activeErrorContext: { provider, model },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: undefined,
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: false,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    advanceAuthProfile: vi.fn(async () => false),
    ...overrides,
  };
}

describe("handleAssistantFailover — user Stop copy", () => {
  it("surfaces a neutral 'Stopped.' instead of 'LLM request timed out.'", async () => {
    const outcome = await handleAssistantFailover(makeAssistantParams());

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("expected throw outcome");
    }
    expect(outcome.error).toBeInstanceOf(FailoverError);
    expect(outcome.error.message).toBe(USER_ABORT_SURFACE_MESSAGE);
    expect(outcome.error.message).not.toMatch(/timed out/i);
    expect(outcome.error.message).not.toContain("⚠️");
    expect(outcome.error.message).not.toContain("Logs:");
    expect(outcome.error.code).toBe(USER_ABORT_FAILOVER_CODE);
    expect(isUserAbortFailoverError(outcome.error)).toBe(true);
  });

  it("keeps the provider-timeout copy for a real timeout", async () => {
    const outcome = await handleAssistantFailover(
      makeAssistantParams({
        initialDecision: { action: "surface_error", reason: "timeout" },
        aborted: false,
        externalAbort: false,
        failoverReason: "timeout",
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("expected throw outcome");
    }
    expect(outcome.error.message).toBe("LLM request timed out.");
    expect(outcome.error.reason).toBe("timeout");
    expect(outcome.error.status).toBe(408);
    expect(isUserAbortFailoverError(outcome.error)).toBe(false);
  });
});
