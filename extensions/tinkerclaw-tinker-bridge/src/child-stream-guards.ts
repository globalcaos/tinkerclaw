// FORK 2026-09-14 — error listeners for a child process's stdio pipes.
//
// Why this file exists: `child.stdin.write()` does NOT throw when the child has already died —
// the EPIPE arrives later, as an 'error' EVENT on the stdin stream. A stream 'error' with no
// listener becomes an uncaught exception, and on 2026-09-14 that took the whole gateway down
// three times in eleven minutes (07:49, 07:52, 08:00: `Uncaught exception: Error: write EPIPE`
// at `afterWriteDispatched` ← `this.proc.stdin.write(stdinLine)` in worker.ts). The `try/catch`
// around the write was already there; it can only see the synchronous failure class.
//
// The guard is deliberately tiny and side-effect free: it attaches ONE listener per present
// stream and forwards the error to the caller, who decides what the failure means for the turn.
// It never throws, and a throwing callback is swallowed — an error handler that itself throws
// is exactly the crash this file prevents.

export type ChildStreamName = "stdin" | "stdout" | "stderr";

type ErrorEmitterLike = {
  on: (event: "error", listener: (err: unknown) => void) => unknown;
};

export type ChildStreamsLike = {
  stdin?: ErrorEmitterLike | null;
  stdout?: ErrorEmitterLike | null;
  stderr?: ErrorEmitterLike | null;
};

const CHILD_STREAM_NAMES: readonly ChildStreamName[] = ["stdin", "stdout", "stderr"];

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Attach an 'error' listener to each present stdio stream of `proc`, forwarding to `onError`.
 * Returns the names of the streams that were guarded (useful for logging and tests).
 */
export function guardChildStreams(
  proc: ChildStreamsLike,
  onError: (stream: ChildStreamName, err: Error) => void,
): ChildStreamName[] {
  const guarded: ChildStreamName[] = [];
  for (const name of CHILD_STREAM_NAMES) {
    const stream = proc[name];
    if (!stream || typeof stream.on !== "function") {
      continue;
    }
    stream.on("error", (err: unknown) => {
      try {
        onError(name, toError(err));
      } catch {
        // Never let an error handler become the next uncaught exception.
      }
    });
    guarded.push(name);
  }
  return guarded;
}
