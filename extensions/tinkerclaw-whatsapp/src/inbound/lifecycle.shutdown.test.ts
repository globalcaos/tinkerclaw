import { describe, expect, it, vi } from "vitest";
import { closeInboundMonitorSocket } from "./lifecycle.js";

/** The exact shape node raises when writing into a dead pipe. */
function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
}

/** whatsmeow-node's TimeoutError: a disconnect whose ack never arrives. */
function ackTimeout(): NodeJS.ErrnoException {
  return Object.assign(new Error("Command 1f2e timed out"), { code: "ERR_TIMEOUT" });
}

describe("closeInboundMonitorSocket — gateway shutdown safety", () => {
  it("resolves and warns once when the disconnect rejects with EPIPE", async () => {
    const close = vi.fn(() => Promise.reject(epipe()));
    const onWarn = vi.fn();

    await expect(closeInboundMonitorSocket({ ws: { close } }, onWarn)).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/EPIPE/);
  });

  it("resolves when the disconnect throws EPIPE synchronously", async () => {
    const onWarn = vi.fn();
    const close = vi.fn(() => {
      throw epipe();
    });

    await expect(closeInboundMonitorSocket({ ws: { close } }, onWarn)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("swallows a disconnect-ack timeout — shutdown does not need the ack", async () => {
    const onWarn = vi.fn();
    const close = vi.fn(() => Promise.reject(ackTimeout()));

    await expect(closeInboundMonitorSocket({ ws: { close } }, onWarn)).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/timed out/);
  });

  it("is idempotent — a second close is a no-op", async () => {
    const close = vi.fn(() => Promise.reject(epipe()));
    const onWarn = vi.fn();
    const sock = { ws: { close } };

    await closeInboundMonitorSocket(sock, onWarn);
    await closeInboundMonitorSocket(sock, onWarn);

    expect(close).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error that is not a shutdown transport error", async () => {
    const close = vi.fn(() => Promise.reject(new Error("boom")));

    await expect(closeInboundMonitorSocket({ ws: { close } })).rejects.toThrow("boom");
  });

  it("gives up on a close that never settles instead of stalling SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const onWarn = vi.fn();
      const close = vi.fn(() => new Promise<void>(() => {}));
      const pending = closeInboundMonitorSocket({ ws: { close } }, onWarn);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toBeUndefined();
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onWarn.mock.calls[0]?.[0]).toMatch(/did not settle/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no unhandled rejection when the close settles after we gave up", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let rejectLate: (err: unknown) => void = () => {};
    vi.useFakeTimers();
    try {
      const close = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const pending = closeInboundMonitorSocket({ ws: { close } }, () => {});

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();

      // The dead pipe answers long after shutdown moved on.
      rejectLate(epipe());
    } finally {
      vi.useRealTimers();
      // Give node a real turn to raise unhandledRejection, if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("tolerates a socket with no ws and a ws with no close", async () => {
    await expect(closeInboundMonitorSocket({})).resolves.toBeUndefined();
    await expect(closeInboundMonitorSocket({ ws: {} })).resolves.toBeUndefined();
  });
});
