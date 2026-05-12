/**
 * FORK 2026-05-12 — composable async wrappers ("middleware pipeline").
 *
 * The fork has at least five hand-coded wrapper patterns today:
 *   - `streamWithIdleTimeout` wraps the LLM stream with a watchdog.
 *   - cc-bridge's heartbeat wraps the stream with periodic keep-alive.
 *   - `applyConfiguredProviderOverrides` wraps providerConfig with overlay merge.
 *   - The pre-push PII guard wraps `git push` with a leak grep.
 *   - The bible:invariants runner wraps `runShell` with retry-on-transient.
 *
 * Each is bespoke closure soup. This module factors out the shared shape:
 * "given a function next, return a wrapped function that does X then calls
 * next." Composing wrappers is `compose(a, b, c)(next)` which yields
 * `a(b(c(next)))` — innermost-first execution.
 *
 * Discipline:
 *   - This file is fork-only and lives in `src/fork/`. Upstream never
 *     imports from here; safe for parallel edits per `ownership.md`.
 *   - Wrappers are pure higher-order functions. No globals, no state
 *     captured at module load — every wrapper takes its config explicitly.
 *   - The bundled wrappers (`withRetry`, `withTimeout`, `withTrace`) are
 *     the high-frequency ones. Specialised wrappers (idle-timeout, PII
 *     guard) stay where they are; this module is the substrate, not a
 *     replacement for domain-specific logic.
 */

/**
 * An async unary function — the shape every wrapper composes around.
 */
export type AsyncFn<I, O> = (input: I) => Promise<O>;

/**
 * A wrapper takes the inner function (`next`) and returns a wrapped one.
 * Wrappers run "around" the inner call: setup → call next → teardown.
 */
export type AsyncWrapper<I, O> = (next: AsyncFn<I, O>) => AsyncFn<I, O>;

/**
 * Compose multiple wrappers into a single wrapper.
 *
 * Order: the FIRST wrapper is the OUTERMOST layer (closest to the caller).
 * The LAST wrapper is the INNERMOST layer (closest to the actual work).
 *
 * ```
 * compose(withTrace, withRetry, withTimeout)(doWork)
 *   ≡ withTrace(withRetry(withTimeout(doWork)))
 *
 * call flow:
 *   caller → withTrace.before → withRetry → withTimeout → doWork
 *                                                       ↓
 *   caller ← withTrace.after  ← withRetry ← withTimeout ← doWork
 * ```
 */
export function compose<I, O>(...wrappers: AsyncWrapper<I, O>[]): AsyncWrapper<I, O> {
  return (next) => wrappers.reduceRight((acc, wrap) => wrap(acc), next);
}

// ----------------------------------------------------------------------------
// Canned wrappers — the high-frequency ones every fork probe might want.
// ----------------------------------------------------------------------------

/**
 * Retry on failure, optionally classifying which errors are retryable.
 *
 * @param attempts  Total attempts including the first (so 2 = one retry).
 * @param backoffMs Sleep before retry. Either a constant or a function of
 *                  attempt number (1-based).
 * @param isRetryable If provided, returning false skips retry — the error
 *                    is thrown as-is. Defaults to "always retry".
 */
export function withRetry<I, O>(opts: {
  attempts: number;
  backoffMs?: number | ((attempt: number) => number);
  isRetryable?: (err: unknown) => boolean;
}): AsyncWrapper<I, O> {
  const { attempts, backoffMs = 0, isRetryable } = opts;
  if (attempts < 1) {
    throw new Error(`withRetry: attempts must be >= 1, got ${attempts}`);
  }
  return (next) =>
    async (input: I): Promise<O> => {
      let lastErr: unknown;
      for (let i = 1; i <= attempts; i += 1) {
        try {
          return await next(input);
        } catch (err) {
          lastErr = err;
          if (isRetryable && !isRetryable(err)) throw err;
          if (i === attempts) break;
          const sleep = typeof backoffMs === "function" ? backoffMs(i) : backoffMs;
          if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
        }
      }
      throw lastErr;
    };
}

/**
 * Reject if the inner call doesn't resolve within `ms` milliseconds.
 *
 * Uses Promise.race + setTimeout. Note: this does NOT cancel the inner
 * work, only stops waiting for it. For cancellable work, pass an
 * AbortSignal through the input type and have `next` honour it.
 */
export function withTimeout<I, O>(ms: number, label = "operation"): AsyncWrapper<I, O> {
  if (ms <= 0) throw new Error(`withTimeout: ms must be > 0, got ${ms}`);
  return (next) =>
    (input: I): Promise<O> => {
      return new Promise<O>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        next(input).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    };
}

/**
 * Log entry and exit (plus duration) around the inner call.
 *
 * The default logger writes to console.log. Pass a structured logger
 * (`{info: (event, fields) => void}`) for production use — the function
 * accepts any object with an `info` method.
 */
export type StructuredLogger = {
  info: (event: string, fields: Record<string, unknown>) => void;
  warn?: (event: string, fields: Record<string, unknown>) => void;
};

const DEFAULT_LOGGER: StructuredLogger = {
  info: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
};

export function withTrace<I, O>(opts: {
  label: string;
  logger?: StructuredLogger;
  includeInput?: (input: I) => Record<string, unknown>;
}): AsyncWrapper<I, O> {
  const { label, logger = DEFAULT_LOGGER, includeInput } = opts;
  return (next) =>
    async (input: I): Promise<O> => {
      const start = Date.now();
      const inputFields = includeInput ? includeInput(input) : {};
      logger.info(`${label}.start`, inputFields);
      try {
        const result = await next(input);
        logger.info(`${label}.ok`, { durationMs: Date.now() - start, ...inputFields });
        return result;
      } catch (err) {
        const fail = logger.warn ?? logger.info;
        fail(`${label}.fail`, {
          durationMs: Date.now() - start,
          errorMessage: err instanceof Error ? err.message : String(err),
          ...inputFields,
        });
        throw err;
      }
    };
}
