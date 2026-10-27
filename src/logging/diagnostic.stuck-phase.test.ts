import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  diagnosticLogger,
  logSessionStateChange,
  logSessionStuck,
  resetDiagnosticStateForTest,
  startDiagnosticHeartbeat,
  type DiagnosticReplyPhaseProbe,
} from "./diagnostic.js";

/**
 * FORK 2026-09-24 (prompt-queue.md §7 G6, Task 15's P3). The `[diagnostic] stuck session` line
 * carries the reply-operation phase through an INJECTED probe, so a turn the gateway accepted but
 * has not taken to the model reads `phase=queued` instead of looking like a hung model call.
 *
 * CONTROL: the no-probe cases pin the pre-G6 line byte for byte. Against the pre-G6 tree the
 * probe cases FAIL (nothing appends the field), so a green run cannot come from a broken fixture.
 */

const SESSION = { sessionId: "s-phase", sessionKey: "agent:main:main" } as const;

// The pre-G6 line for SESSION, byte for byte.
const PRE_G6_LINE =
  "stuck session: sessionId=s-phase sessionKey=agent:main:main state=processing age=300s" +
  " reason=no-progress-signal lastProgressAgo=unknown queueDepth=0";

function watchStuckLines(): () => string[] {
  const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  return () =>
    warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("stuck session:"));
}

function logStuck(replyPhaseProbe?: DiagnosticReplyPhaseProbe): void {
  logSessionStateChange({ ...SESSION, state: "processing" });
  logSessionStuck({ ...SESSION, state: "processing", ageMs: 300_000, replyPhaseProbe });
}

describe("stuck-session line: reply-operation phase (prompt-queue.md G6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("CONTROL: without a probe the line is unchanged, with no phase field", () => {
    const stuckLines = watchStuckLines();
    logStuck();
    expect(stuckLines()).toEqual([PRE_G6_LINE]);
  });

  it("with a probe, a turn that has not reached the model reads phase=queued", () => {
    const stuckLines = watchStuckLines();
    const probe = vi.fn<DiagnosticReplyPhaseProbe>(() => "queued");
    logStuck(probe);
    expect(stuckLines()).toEqual([`${PRE_G6_LINE} phase=queued`]);
    expect(probe).toHaveBeenCalledWith(SESSION);
  });

  it("reads phase=none when the probe finds no reply operation for the session", () => {
    const stuckLines = watchStuckLines();
    logStuck(() => undefined);
    expect(stuckLines()).toEqual([`${PRE_G6_LINE} phase=none`]);
  });

  it("reads phase=unknown when the probe throws, and still warns", () => {
    const stuckLines = watchStuckLines();
    expect(() =>
      logStuck(() => {
        throw new Error("registry unavailable");
      }),
    ).not.toThrow();
    expect(stuckLines()).toEqual([`${PRE_G6_LINE} phase=unknown`]);
  });

  it("does not consult the probe when a live, progressing turn is not warned about", () => {
    const stuckLines = watchStuckLines();
    const probe = vi.fn<DiagnosticReplyPhaseProbe>(() => "queued");
    logSessionStateChange({ ...SESSION, state: "processing" });
    logSessionStuck({
      ...SESSION,
      state: "processing",
      ageMs: 300_000,
      clientAlive: true,
      lastProgressAtMs: Date.now(),
      replyPhaseProbe: probe,
    });
    expect(stuckLines()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("the heartbeat passes the probe it was started with to the stuck-session line", () => {
    const stuckLines = watchStuckLines();
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      { replyPhaseProbe: () => "queued" },
    );
    logSessionStateChange({ ...SESSION, state: "processing" });
    vi.advanceTimersByTime(150_000);
    const lines = stuckLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.endsWith(" phase=queued"))).toBe(true);
  });

  it("CONTROL: a heartbeat started without a probe writes no phase field", () => {
    const stuckLines = watchStuckLines();
    startDiagnosticHeartbeat({ diagnostics: { enabled: true } });
    logSessionStateChange({ ...SESSION, state: "processing" });
    vi.advanceTimersByTime(150_000);
    const lines = stuckLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("phase="))).toBe(false);
  });
});
