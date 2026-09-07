import { describe, expect, it } from "vitest";
import {
  buildErrorEnvelope,
  classifyAbortCause,
  classifyRawErrorMessage,
  killCauseFromRaw,
} from "./error-envelope.js";

/**
 * FORK 2026-09-03 — SIGTERM cause attribution.
 *
 * Every tinker-bridge turn that is cut short ends the same way:
 * `worker.kill("SIGTERM")` -> `onExit` rejects -> stream.ts emits `__ERR_ENV__`.
 * Until this change `classifyRawErrorMessage` read only the SIGNAL, so a user
 * pressing Stop, an LLM idle timeout, the run deadline, budget exhaustion, a
 * `sessions_yield` and the fast-fail init-stall abort ALL rendered as
 * "Gateway restarted — I'm resuming it automatically". Nothing restarted and
 * nothing resumed; the user typed "keep going".
 *
 * These tests run against the REAL producer strings (verified on disk — see the
 * table above `classifyAbortCause`) and NOT against hand-written enum tokens.
 * That is deliberate: an earlier draft tested the parser with synthetic
 * `reason=user-abort` inputs and stayed green while three of its five
 * classifications were unreachable, because the regexes had been written against
 * invented strings. The table test below is what fails if one of those upstream
 * messages is reworded.
 */

/** The exact `AbortSignal.reason` texts, as worker.ts formats them (`name: message`). */
const REAL_ABORT_CAUSES = {
  /** reply-run-registry.ts createUserAbortError() */
  userStop: "AbortError: Reply operation aborted by user",
  /** reply-run-registry.ts abortForRestart() */
  gatewayDrain: "Error: Reply operation aborted for restart",
  /** attempt.ts makeTimeoutAbortReason() */
  runDeadline: "TimeoutError: request timed out",
  /** llm-idle-timeout.ts createTimeoutPromise() */
  idleTimeout: "Error: LLM idle timeout (300s): no response from model",
  /** attempt.ts makeBudgetAbortReason() */
  budget: "Error: budget-exhausted",
  /** attempt.ts runAbortController.abort("sessions_yield") — a bare string */
  sessionYield: "sessions_yield",
  /** stream.ts fast-fail watchdog — a literal at the call site */
  fastFail: "fast-fail-init-stall",
} as const;

const exitRaw = (cause: string, opts?: { signal?: string; code?: string; tail?: string }) =>
  `claude subprocess exited (code=${opts?.code ?? "null"} signal=${
    opts?.signal ?? "SIGTERM"
  } reason=[${cause}]) stderr=${opts?.tail ?? ""}`;

/**
 * The two claims that were false for every cause but the restart. Matched as the
 * exact promise, never as a loose keyword: the HONEST copy legitimately contains
 * the words "restarted" and "resuming" inside its negation ("Nothing restarted
 * and nothing is resuming on its own").
 */
const FALSE_PROMISE = /gateway restarted|resuming it automatically/i;

describe("classifyAbortCause reads the REAL producer strings", () => {
  it.each([
    [REAL_ABORT_CAUSES.userStop, "user-abort"],
    [REAL_ABORT_CAUSES.gatewayDrain, "gateway-shutdown"],
    [REAL_ABORT_CAUSES.runDeadline, "run-deadline"],
    [REAL_ABORT_CAUSES.idleTimeout, "idle-timeout"],
    [REAL_ABORT_CAUSES.budget, "budget-exhausted"],
    [REAL_ABORT_CAUSES.sessionYield, "session-yield"],
    [REAL_ABORT_CAUSES.fastFail, "fast-fail-init-stall"],
    // node's default abort reason names no cause at all
    ["AbortError: This operation was aborted", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (cause, expected) => {
    expect(classifyAbortCause(cause)).toBe(expected);
  });
});

describe("a cut turn is named by its cause, not by SIGTERM", () => {
  it("a real gateway restart keeps the restart-and-resume copy", () => {
    const raw = exitRaw(REAL_ABORT_CAUSES.gatewayDrain);
    expect(classifyRawErrorMessage(raw)).toBe("tinker_bridge_sigterm");
    const env = buildErrorEnvelope({ raw });
    expect(env.headline).toBe("Gateway restarted");
    expect(env.explanation).toMatch(/resuming it automatically/);
    expect(env.fatal).toBe(false);
    expect(env.details?.killCause).toBe("gateway-shutdown");
  });

  it("a user Stop is calm and promises nothing", () => {
    const env = buildErrorEnvelope({ raw: exitRaw(REAL_ABORT_CAUSES.userStop) });
    expect(env.headline).toBe("Stopped.");
    expect(env.category).toBe("interrupted");
    expect(env.fatal).toBe(false);
    expect(env.suggestedActions).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(FALSE_PROMISE);
  });

  it("an idle timeout names the silence the producer measured", () => {
    const env = buildErrorEnvelope({ raw: exitRaw(REAL_ABORT_CAUSES.idleTimeout) });
    expect(env.headline).toBe("No response from the model for 300 s — the turn was cut");
    expect(env.suggestedActions).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(FALSE_PROMISE);
  });

  it("promises a retry ONLY when the caller says one is scheduled", () => {
    const raw = exitRaw(REAL_ABORT_CAUSES.idleTimeout);
    expect(buildErrorEnvelope({ raw }).suggestedActions).toEqual([]);
    expect(buildErrorEnvelope({ raw, retryScheduled: true }).suggestedActions?.[0]).toBe(
      "Retrying automatically",
    );
  });

  it("the run deadline, the budget and a yield each get their own honest bubble", () => {
    const deadline = buildErrorEnvelope({ raw: exitRaw(REAL_ABORT_CAUSES.runDeadline) });
    expect(deadline.headline).toBe("The turn hit its time limit");
    const budget = buildErrorEnvelope({ raw: exitRaw(REAL_ABORT_CAUSES.budget) });
    expect(budget.headline).toBe("The run hit its budget");
    const yielded = buildErrorEnvelope({ raw: exitRaw(REAL_ABORT_CAUSES.sessionYield) });
    expect(yielded.headline).toBe("Turn paused to wait for a subagent");
    for (const env of [deadline, budget, yielded]) {
      expect(JSON.stringify(env)).not.toMatch(FALSE_PROMISE);
    }
  });

  it("a fast-fail init stall says the model never started", () => {
    const raw = exitRaw(REAL_ABORT_CAUSES.fastFail);
    expect(classifyRawErrorMessage(raw)).toBe("tinker_bridge_fast_fail_init");
    const env = buildErrorEnvelope({ raw });
    expect(env.headline).toBe("The model never started replying (gateway busy)");
    expect(JSON.stringify(env)).not.toMatch(FALSE_PROMISE);
  });

  it("an unrecognised or ABSENT cause promises nothing — the regression gate", () => {
    const raws = [
      exitRaw(""),
      exitRaw("AbortError: This operation was aborted"),
      // an older bundle / a replayed transcript, with no reason= at all
      "claude subprocess exited (code=null signal=SIGTERM) stderr=",
    ];
    for (const raw of raws) {
      const env = buildErrorEnvelope({ raw });
      expect(env.headline).toBe("The turn was interrupted");
      expect(JSON.stringify(env)).not.toMatch(FALSE_PROMISE);
    }
  });

  it("reads the cause next to signal=, not one printed into the stderr tail", () => {
    const raw = exitRaw(REAL_ABORT_CAUSES.userStop, {
      tail: "a tool printed reason=[Reply operation aborted for restart]",
    });
    expect(killCauseFromRaw(raw).cause).toBe("user-abort");
    expect(buildErrorEnvelope({ raw }).headline).toBe("Stopped.");
  });

  it("SIGKILL is unaffected", () => {
    expect(classifyRawErrorMessage(exitRaw("", { signal: "SIGKILL", code: "137" }))).toBe(
      "tinker_bridge_sigkill",
    );
  });
});

describe("rate-limit envelopes only promise a retry that exists", () => {
  const raw = "You've hit your session limit · resets 12pm (Europe/Madrid)";

  it("makes no retry promise without retryScheduledAt", () => {
    const env = buildErrorEnvelope({ raw });
    expect(env.category).toBe("rate_limit");
    expect(JSON.stringify(env.suggestedActions)).not.toMatch(
      /automatic retry|retrying automatically/i,
    );
  });

  it("names the wall-clock time when a retry IS scheduled", () => {
    const at = Date.now() + 45 * 60_000;
    const d = new Date(at);
    const expected = `Retrying automatically at ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
    expect(buildErrorEnvelope({ raw, retryScheduledAt: at }).suggestedActions?.[0]).toBe(expected);
  });
});

describe("envelope hygiene", () => {
  it("does not invent a details object for an unrelated error", () => {
    expect(buildErrorEnvelope({ raw: "401 authentication_error" }).details).toBeUndefined();
  });

  it("merges the kill cause into caller-supplied details instead of replacing them", () => {
    const env = buildErrorEnvelope({
      raw: exitRaw(REAL_ABORT_CAUSES.userStop),
      details: { source: "agent-runner", laneDepth: 2 },
    });
    expect(env.details?.source).toBe("agent-runner");
    expect(env.details?.laneDepth).toBe(2);
    expect(env.details?.killCause).toBe("user-abort");
  });
});
