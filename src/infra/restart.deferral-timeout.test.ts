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
});
