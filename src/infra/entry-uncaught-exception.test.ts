import { describe, expect, it, vi } from "vitest";
import {
  type EntryUncaughtDeps,
  handleEntryUncaughtException,
} from "./entry-uncaught-exception.js";

// 2026-10-19: a write to the stdin of a child that had died raised EPIPE with no 'error'
// listener, and the root entry's handler exited the gateway; it crash-looped 18 times.
// Each fake appends to `events`, so one assertion checks what ran and in which order.
function createDeps() {
  const events: string[] = [];
  const deps = {
    warn: vi.fn<EntryUncaughtDeps["warn"]>(() => {
      events.push("warn");
    }),
    error: vi.fn<EntryUncaughtDeps["error"]>(() => {
      events.push("error");
    }),
    exit: vi.fn<EntryUncaughtDeps["exit"]>(() => {
      events.push("exit");
    }),
    formatUncaughtError: vi.fn<EntryUncaughtDeps["formatUncaughtError"]>((error) =>
      error instanceof Error ? `formatted ${error.message}` : "formatted non-error",
    ),
    runFatalErrorHooks: vi.fn<EntryUncaughtDeps["runFatalErrorHooks"]>(() => {
      events.push("hooks");
      return ["hook note"];
    }),
    restoreTerminalState: vi.fn<EntryUncaughtDeps["restoreTerminalState"]>(() => {
      events.push("restore");
    }),
  };
  return { deps, events };
}

describe("handleEntryUncaughtException", () => {
  it.each([
    { code: "EPIPE", message: "write EPIPE" },
    { code: "EIO", message: "read EIO" },
  ])("keeps the process alive on $code: one warning, no exit", ({ code, message }) => {
    const { deps, events } = createDeps();
    const error = Object.assign(new Error(message), { code });

    expect(handleEntryUncaughtException(error, deps)).toBe("benign");

    expect(events).toEqual(["warn"]);
    expect(deps.warn.mock.calls).toEqual([
      ["[openclaw] Non-fatal uncaught exception (continuing):", `formatted ${message}`],
    ]);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.runFatalErrorHooks).not.toHaveBeenCalled();
  });

  it("exits on any other error: logs, runs the fatal hooks, restores the terminal", () => {
    const { deps, events } = createDeps();
    const error = new Error("boom");

    expect(handleEntryUncaughtException(error, deps)).toBe("fatal");

    expect(events).toEqual(["error", "hooks", "error", "restore", "exit"]);
    expect(deps.error.mock.calls).toEqual([
      ["[openclaw] Uncaught exception:", "formatted boom"],
      ["[openclaw]", "hook note"],
    ]);
    expect(deps.runFatalErrorHooks).toHaveBeenCalledWith({ reason: "uncaught_exception", error });
    expect(deps.restoreTerminalState).toHaveBeenCalledWith("uncaught exception", {
      resumeStdinIfPaused: false,
    });
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("returns before the benign check when a registered handler claims the error", () => {
    const { deps, events } = createDeps();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const isHandled = vi.fn<NonNullable<EntryUncaughtDeps["isHandled"]>>(() => true);

    expect(handleEntryUncaughtException(error, { ...deps, isHandled })).toBe("handled");

    expect(isHandled.mock.calls).toEqual([[error]]);
    expect(events).toEqual([]);
    expect(deps.formatUncaughtError).not.toHaveBeenCalled();
  });
});
