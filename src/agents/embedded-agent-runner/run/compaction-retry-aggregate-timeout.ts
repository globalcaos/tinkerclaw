/**
 * Wait for compaction retry completion with an aggregate timeout to avoid
 * holding a session lane indefinitely when retry resolution is lost.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
  isCompactionStillInFlight?: () => boolean;
  /**
   * Upper bound on the TOTAL wait even while compaction reports in-flight.
   * Without it a hung in-flight compaction (an LLM summarize call that never
   * returns) extends the window forever and holds the lane until the run-level
   * timeout kills the whole attempt — discarding an already-completed answer.
   * Undefined keeps the legacy unbounded-extension behavior.
   */
  inflightHardCapMs?: number;
}): Promise<{ timedOut: boolean; timedOutWhileInFlight: boolean }> {
  const timeoutMsRaw = params.aggregateTimeoutMs;
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1, Math.floor(timeoutMsRaw)) : 1;

  let timedOut = false;
  let timedOutWhileInFlight = false;
  let elapsedWindowMs = 0;
  // Reflect the retry promise so late rejections after a timeout stay handled
  // without masking failures that settle before the timeout path wins.
  const waitPromise = params.waitForCompactionRetry().then(
    () => ({ kind: "done" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await params.abortable(
        Promise.race([
          waitPromise,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]),
      );

      if (result !== "timeout") {
        if (result.kind === "done") {
          break;
        }
        throw result.error;
      }

      elapsedWindowMs += timeoutMs;

      // Keep extending the timeout window while compaction is actively running.
      // We only trigger the fallback timeout once compaction appears idle —
      // unless the total wait crossed inflightHardCapMs (see the param doc).
      const inFlight = params.isCompactionStillInFlight?.() ?? false;
      if (
        inFlight &&
        (params.inflightHardCapMs === undefined || elapsedWindowMs < params.inflightHardCapMs)
      ) {
        continue;
      }

      timedOut = true;
      timedOutWhileInFlight = inFlight;
      params.onTimeout?.();
      break;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return { timedOut, timedOutWhileInFlight };
}
