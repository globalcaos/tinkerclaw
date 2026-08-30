import type { ChildProcess } from "node:child_process";
import os from "node:os";
import process from "node:process";

export type ChildProcessBridgeOptions = {
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
  /**
   * Seam so tests can observe the exit instead of taking the test runner down
   * with them. Defaults to a real `process.exit`.
   */
  exitProcess?: (code: number) => void;
  /**
   * Whether the parent must die once a forwarded terminating signal has taken
   * the child down. Defaults to true -- see the comment inside the signal
   * listener for why this is not optional in practice. Opt out only if the
   * caller drives its own shutdown after the child exits.
   */
  exitOnSignal?: boolean;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/**
 * Signals whose *default* disposition is to terminate the process. Attaching any
 * listener for one of these replaces that default, so for these -- and only
 * these -- the bridge has to perform the death itself.
 */
const terminatingSignals: ReadonlySet<NodeJS.Signals> = new Set([
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGBREAK",
]);

/**
 * The conventional "died from <signal>" status: 128 + signum, which is what
 * shells, systemd and `timeout` expect to observe (SIGHUP 129, SIGINT 130,
 * SIGQUIT 131, SIGTERM 143 on POSIX). Read from `os.constants.signals` rather
 * than a hand-written table so the numbers stay correct per platform.
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const signum: number | undefined = os.constants.signals[signal];
  return typeof signum === "number" ? 128 + signum : 1;
}

function childAlreadyExited(child: ChildProcess): boolean {
  // `typeof`, not `!== null`: fake children in unit tests leave these fields
  // undefined, and `undefined !== null` would misread a live child as dead.
  return typeof child.exitCode === "number" || typeof child.signalCode === "string";
}

export function attachChildProcessBridge(
  child: ChildProcess,
  {
    signals = defaultSignals,
    onSignal,
    exitProcess = (code: number): void => {
      process.exit(code);
    },
    exitOnSignal = true,
  }: ChildProcessBridgeOptions = {},
): { detach: () => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  let forwardedSignal: NodeJS.Signals | undefined;
  let childExited = false;
  let exitRequested = false;

  const exitFromSignal = (signal: NodeJS.Signals): void => {
    if (exitRequested) {
      return;
    }
    exitRequested = true;
    exitProcess(signalExitCode(signal));
  };

  for (const signal of signals) {
    const listener = (): void => {
      onSignal?.(signal);
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      if (!exitOnSignal || !terminatingSignals.has(signal)) {
        return;
      }
      // Node drops the default "terminate now" disposition the moment ANY
      // listener exists for a terminating signal. Forwarding and returning
      // therefore made this process permanently immune to SIGTERM: on
      // 2026-08-17 `timeout 900 openclaw agent ...` fired SIGTERM at the 900s
      // mark, nothing died, and -- plain `timeout` has no --kill-after -- it
      // then waited 13h55m. So the parent must not outlive the child: once the
      // child is gone we exit 128 + signum, and `timeout`, systemd and shells
      // observe an ordinary signal death instead of a hang.
      //
      // DELIBERATELY NO SIGKILL WATCHDOG (decided 2026-08-18): we WAIT for the
      // child rather than arming a grace-period timer. A child that refuses to
      // die must stay VISIBLE and manually stoppable in the UI, not be silently
      // reaped in the background. Please do not "helpfully" add the timer back.
      forwardedSignal = signal;
      if (childExited || childAlreadyExited(child)) {
        exitFromSignal(signal);
      }
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  child.once("exit", () => {
    childExited = true;
    detach();
    if (forwardedSignal) {
      exitFromSignal(forwardedSignal);
    }
  });
  child.once("error", detach);

  return { detach };
}
