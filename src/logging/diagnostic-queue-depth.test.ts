/**
 * FORK 2026-08-23 — `queueDepth` must mean "accepted but NOT STARTED".
 *
 * The architect: "the 'prompt queued' message is not working well, it shown during normal
 * operation after I send a normal prompt."
 *
 * It was incremented on enqueue and decremented only on the transition to IDLE, so for the whole
 * of a normal turn the counter still read 1 while that very prompt was the one running. The
 * activity strip then rendered "turn running" and "1 prompt queued" together — one prompt
 * described twice, and the second description false. It matters beyond cosmetics: the strip
 * offers "Clear" on a queued row precisely because clearing destroys nothing that has started.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { diagnosticSessionStates } from "./diagnostic-session-state.js";
import { logMessageQueued, logSessionStateChange } from "./diagnostic.js";

const SESSION = { sessionId: "s-queue-depth", sessionKey: "agent:main:tinker:qd" };

function depth(): number {
  for (const [, st] of diagnosticSessionStates.entries()) {
    if (st.sessionId === SESSION.sessionId || st.sessionKey === SESSION.sessionKey) {
      return st.queueDepth;
    }
  }
  return -1;
}

beforeEach(() => {
  diagnosticSessionStates.clear();
  setDiagnosticsEnabledForProcess(true);
});

describe("queueDepth counts prompts that have NOT started", () => {
  it("is 0 once the only queued prompt starts running — the reported bug", () => {
    logMessageQueued({ ...SESSION, source: "test" });
    expect(depth(), "a prompt accepted but not started is queued").toBe(1);

    logSessionStateChange({ ...SESSION, state: "processing" });
    expect(depth(), "the running prompt must no longer be counted as queued").toBe(0);
  });

  it("keeps a genuine backlog visible while one runs", () => {
    logMessageQueued({ ...SESSION, source: "test" });
    logMessageQueued({ ...SESSION, source: "test" });
    logMessageQueued({ ...SESSION, source: "test" });
    expect(depth()).toBe(3);

    logSessionStateChange({ ...SESSION, state: "processing" });
    // One started; two are still waiting, and the strip should say exactly that.
    expect(depth()).toBe(2);
  });

  it("does not double-decrement across the full lifecycle", () => {
    logMessageQueued({ ...SESSION, source: "test" });
    logSessionStateChange({ ...SESSION, state: "processing" });
    logSessionStateChange({ ...SESSION, state: "idle" });
    expect(depth(), "finishing must not subtract a second time").toBe(0);
  });

  it("does not decrement on repeated processing reports", () => {
    logMessageQueued({ ...SESSION, source: "test" });
    logMessageQueued({ ...SESSION, source: "test" });
    logSessionStateChange({ ...SESSION, state: "processing" });
    logSessionStateChange({ ...SESSION, state: "processing" });
    expect(depth(), "only a TRANSITION into processing dequeues").toBe(1);
  });

  it("still clears a prompt that goes straight to idle without ever running", () => {
    // An enqueue that is rejected or aborted before it starts. Leaving it pinned at 1 forever
    // is the failure being replaced, so the idle branch survives as a floor for this path.
    logMessageQueued({ ...SESSION, source: "test" });
    logSessionStateChange({ ...SESSION, state: "idle" });
    expect(depth()).toBe(0);
  });

  it("never goes negative", () => {
    logSessionStateChange({ ...SESSION, state: "processing" });
    logSessionStateChange({ ...SESSION, state: "idle" });
    expect(depth()).toBeGreaterThanOrEqual(0);
  });
});
