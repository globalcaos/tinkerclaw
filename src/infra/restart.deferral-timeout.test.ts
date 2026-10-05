import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, deferGatewayRestartUntilIdle, type RestartDeferralHooks } from "./restart.js";

describe("deferGatewayRestartUntilIdle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __testing.resetSigusr1State();
    // Add a listener so emitGatewayRestart uses process.emit instead of process.kill
    process.on("SIGUSR1", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __testing.resetSigusr1State();
    process.removeAllListeners("SIGUSR1");
  });

  it("falls back to the default 15-minute cap when maxWaitMs is not specified", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
      onStillPending: vi.fn(),
    };

    // Always return 1 pending item to prevent draining
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks,
    });

    // Just before the 15-minute default cap
    vi.advanceTimersByTime(899_999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onStillPending).toHaveBeenCalled();

    // Crossing the cap forces the restart
    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("explicit maxWaitMs <= 0 disables the cap", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    // Always return 1 pending item to prevent draining
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 0,
      hooks,
    });

    // Twice the default 15-minute cap — explicit opt-out waits forever
    vi.advanceTimersByTime(900_000);
    vi.advanceTimersByTime(900_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("respects custom maxWaitMs configuration", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    const customTimeoutMs = 120_000; // 2 minutes

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: customTimeoutMs,
      hooks,
    });

    // Advance to just before 2 minutes
    vi.advanceTimersByTime(119_999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();

    // Advance past 2 minutes
    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("calls onReady and does not timeout when pending count drops to 0", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    let pending = 3;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      hooks,
    });

    // Advance a few poll intervals, then drain
    vi.advanceTimersByTime(1000);
    expect(hooks.onReady).not.toHaveBeenCalled();

    pending = 0;
    vi.advanceTimersByTime(500); // Next poll interval
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("immediately restarts when pending count is 0", () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    // onReady should be called synchronously
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("handles getPendingCount error by restarting immediately", () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      hooks,
    });

    expect(hooks.onCheckError).toHaveBeenCalledOnce();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  // FORK 2026-09-14 — the cap must never force a restart on top of live work. On 2026-09-14
  // 12:46:28 "restart timeout after 901633ms … restarting anyway" SIGTERMed a 21-minute turn and
  // every other in-flight chat; the count it waited on never drains on a busy day, so the cap
  // was the normal path. `canForceOnTimeout` gates it.
  describe("canForceOnTimeout gate", () => {
    it("keeps polling past the cap while the gate is closed, then restarts the tick it opens", () => {
      let forceAllowed = false;
      const hooks: RestartDeferralHooks = {
        onTimeout: vi.fn(),
        onTimeoutDeferred: vi.fn(),
        onStillPending: vi.fn(),
        onReady: vi.fn(),
      };

      deferGatewayRestartUntilIdle({
        getPendingCount: () => 1,
        maxWaitMs: 60_000,
        canForceOnTimeout: () => forceAllowed,
        hooks,
      });

      // Cap elapses: the old code would have fired onTimeout here and emitted the restart.
      vi.advanceTimersByTime(60_500);
      expect(hooks.onTimeout).not.toHaveBeenCalled();
      expect(hooks.onTimeoutDeferred).toHaveBeenCalledOnce();

      // Ten more minutes of live work: still no forced restart, and the deferred notice is
      // rate-limited to the same 30 s cadence as onStillPending (not once per 500 ms poll).
      vi.advanceTimersByTime(600_000);
      expect(hooks.onTimeout).not.toHaveBeenCalled();
      expect(hooks.onTimeoutDeferred.mock.calls.length).toBeLessThanOrEqual(22);
      expect(hooks.onTimeoutDeferred.mock.calls.length).toBeGreaterThanOrEqual(20);
      // Past the cap the "still deferred" notice yields to the "cap reached" notice.
      const stillPendingCalls = (hooks.onStillPending as ReturnType<typeof vi.fn>).mock.calls
        .length;

      // The gate opens (last live turn finished): the very next poll restarts.
      forceAllowed = true;
      vi.advanceTimersByTime(500);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
      expect(hooks.onReady).not.toHaveBeenCalled();
      expect((hooks.onStillPending as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        stillPendingCalls,
      );

      // And nothing keeps polling afterwards.
      vi.advanceTimersByTime(60_000);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
    });

    it("drains normally past the cap: pending → 0 fires onReady, not onTimeout", () => {
      let pending = 2;
      const hooks: RestartDeferralHooks = {
        onTimeout: vi.fn(),
        onTimeoutDeferred: vi.fn(),
        onReady: vi.fn(),
      };

      deferGatewayRestartUntilIdle({
        getPendingCount: () => pending,
        maxWaitMs: 30_000,
        canForceOnTimeout: () => false,
        hooks,
      });

      vi.advanceTimersByTime(90_000);
      expect(hooks.onTimeout).not.toHaveBeenCalled();
      expect(hooks.onReady).not.toHaveBeenCalled();

      pending = 0;
      vi.advanceTimersByTime(500);
      expect(hooks.onReady).toHaveBeenCalledOnce();
      expect(hooks.onTimeout).not.toHaveBeenCalled();
    });

    it("a throwing gate restores the old forced-restart behaviour rather than wedging", () => {
      const hooks: RestartDeferralHooks = {
        onTimeout: vi.fn(),
        onTimeoutDeferred: vi.fn(),
      };

      deferGatewayRestartUntilIdle({
        getPendingCount: () => 1,
        maxWaitMs: 10_000,
        canForceOnTimeout: () => {
          throw new Error("gate bug");
        },
        hooks,
      });

      vi.advanceTimersByTime(10_500);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
      expect(hooks.onTimeoutDeferred).not.toHaveBeenCalled();
    });

    it("without a gate the cap behaves exactly as before", () => {
      const hooks: RestartDeferralHooks = {
        onTimeout: vi.fn(),
        onTimeoutDeferred: vi.fn(),
      };

      deferGatewayRestartUntilIdle({
        getPendingCount: () => 1,
        maxWaitMs: 10_000,
        hooks,
      });

      vi.advanceTimersByTime(10_500);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
      expect(hooks.onTimeoutDeferred).not.toHaveBeenCalled();
    });
  });
});
