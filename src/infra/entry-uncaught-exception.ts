import type { restoreTerminalState } from "../terminal/restore.js";
import type { formatUncaughtError } from "./errors.js";
import type { runFatalErrorHooks } from "./fatal-error-hooks.js";
import {
  isBenignUncaughtExceptionError,
  isUncaughtExceptionHandled,
} from "./unhandled-rejections.js";

/**
 * What the root entry (`src/index.ts`, built as `dist/index.js`, the file the gateway service
 * starts) does with an uncaught exception. Same policy as the listener in `src/cli/run-main.ts`:
 *
 * - "handled": a handler registered with `registerUncaughtExceptionHandler` claimed the error.
 * - "benign": EPIPE or EIO (`isBenignUncaughtExceptionError`), for example a write to the stdin
 *   of a child that already died. One warning, and the process keeps running.
 * - "fatal": anything else. Log it, run the fatal-error hooks, restore the terminal, exit(1).
 */
export type EntryUncaughtExceptionOutcome = "handled" | "benign" | "fatal";

/** Side effects come in as arguments so the policy can be tested without a process listener. */
export type EntryUncaughtDeps = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
  formatUncaughtError: typeof formatUncaughtError;
  runFatalErrorHooks: typeof runFatalErrorHooks;
  restoreTerminalState: typeof restoreTerminalState;
  /** Defaults to `isUncaughtExceptionHandled`. */
  isHandled?: typeof isUncaughtExceptionHandled;
  /** Defaults to `isBenignUncaughtExceptionError`. */
  isBenign?: typeof isBenignUncaughtExceptionError;
};

export function handleEntryUncaughtException(
  error: unknown,
  deps: EntryUncaughtDeps,
): EntryUncaughtExceptionOutcome {
  const isHandled = deps.isHandled ?? isUncaughtExceptionHandled;
  const isBenign = deps.isBenign ?? isBenignUncaughtExceptionError;
  if (isHandled(error)) {
    return "handled";
  }
  if (isBenign(error)) {
    deps.warn(
      "[openclaw] Non-fatal uncaught exception (continuing):",
      deps.formatUncaughtError(error),
    );
    return "benign";
  }
  deps.error("[openclaw] Uncaught exception:", deps.formatUncaughtError(error));
  for (const message of deps.runFatalErrorHooks({ reason: "uncaught_exception", error })) {
    deps.error("[openclaw]", message);
  }
  deps.restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
  deps.exit(1);
  return "fatal";
}
