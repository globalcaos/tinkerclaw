/**
 * Target: allowIdleTimeoutRetry in src/agents/embedded-agent-runner/run.ts
 *
 * Why this exists (bug history): the LLM idle watchdog kills a turn that has emitted no
 * pi-ai stream event for the idle window. The only automatic recovery is a same-model
 * retry, and its gate reused `canRestartForLiveSwitch`, which requires
 * `toolMetas.length === 0 && assistantTexts.length === 0`. Combined with the gate's own
 * `!producedNoContent` (text OR thinking present) the two were mutually exclusive except
 * for a thinking-only stall. Measured over 2026-08-27..09-03: 1 retry fired against 77
 * surfaced idle timeouts, and the architect typed "keep going" after ~40 of them.
 *
 * What these specs catch: a regression that re-couples this decision to the live-switch
 * predicate (which would silently drop the retry back to ~never), and any loosening of the
 * two side-effect guards that must never be repeated.
 */
import { describe, expect, it } from "vitest";
import { allowIdleTimeoutRetry } from "./run.js";

/** A turn cut mid tool-loop after real output — the case that used to be refused. */
const TOOL_LOOP_STALL = {
  timedOut: true,
  idleTimedOut: true,
  timedOutDuringCompaction: false,
  fallbackConfigured: false,
  producedNoContent: false,
  didSendViaMessagingTool: false,
  didSendDeterministicApprovalPrompt: false,
  retriesSoFar: 0,
};

describe("allowIdleTimeoutRetry", () => {
  it("retries a turn cut mid tool-loop (the case the old gate could never reach)", () => {
    expect(allowIdleTimeoutRetry(TOOL_LOOP_STALL)).toBe(true);
  });

  it("allows a second retry and refuses a third", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, retriesSoFar: 1 })).toBe(true);
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, retriesSoFar: 2 })).toBe(false);
  });

  it("refuses when the stall happened during compaction", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, timedOutDuringCompaction: true })).toBe(
      false,
    );
  });

  it("refuses when a fallback model is configured — failover owns that case", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, fallbackConfigured: true })).toBe(false);
  });

  it("refuses an empty attempt — the empty-response retry path owns that one", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, producedNoContent: true })).toBe(false);
  });

  it("never repeats a turn that already sent a message or showed an approval prompt", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, didSendViaMessagingTool: true })).toBe(
      false,
    );
    expect(
      allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, didSendDeterministicApprovalPrompt: true }),
    ).toBe(false);
  });

  it("refuses a non-idle timeout (a wall-clock deadline is not this retry's business)", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, idleTimedOut: false })).toBe(false);
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, timedOut: false })).toBe(false);
  });

  it("honours an explicit maxRetries override", () => {
    expect(allowIdleTimeoutRetry({ ...TOOL_LOOP_STALL, retriesSoFar: 1, maxRetries: 1 })).toBe(
      false,
    );
  });
});
