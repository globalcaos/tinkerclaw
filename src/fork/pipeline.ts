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

// ----------------------------------------------------------------------------
// Correlation IDs — design-principles.md #10 ("one ID threads through everything").
// ----------------------------------------------------------------------------

/**
 * The shape every operation should carry: an explicit `correlationId` field.
 * Existing fork operations use `runId` for chat turns and `sessionKey` for
 * session-scoped events. `correlationId` is the unifying name for new code;
 * legacy callers map their existing ID into this field.
 */
export type WithCorrelationId<I> = I & { correlationId: string };

let mintCounter = 0;
/**
 * Mint a fresh correlation ID. Format: `t<base36-ts>-<base36-counter>`.
 * The timestamp prefix is the only part that needs to be human-decodable;
 * the counter is just for uniqueness when many IDs are minted in the same
 * millisecond.
 */
export function mintCorrelationId(prefix = "t"): string {
  const ts = Date.now().toString(36);
  const seq = (mintCounter = (mintCounter + 1) % 1_000_000).toString(36);
  return `${prefix}${ts}-${seq.padStart(4, "0")}`;
}

/**
 * Ensure every input flowing through the pipeline has a correlationId.
 * If the caller already supplied one, it's preserved; otherwise a fresh
 * one is minted and attached. The wrapped function receives the input
 * with the guaranteed field, so downstream code can rely on it.
 *
 * Combine with `withTrace` and `includeInput: (i) => ({correlationId: i.correlationId})`
 * to thread the ID into every log line.
 */
export function withCorrelationId<I, O>(
  prefix?: string,
): AsyncWrapper<I, O> & {
  attach: (input: I) => WithCorrelationId<I>;
} {
  const wrapper: AsyncWrapper<I, O> =
    (next) =>
    async (input: I): Promise<O> => {
      const enriched = attach(input);
      return next(enriched);
    };
  const attach = (input: I): WithCorrelationId<I> => {
    const existing = (input as { correlationId?: string } | undefined)?.correlationId;
    if (typeof existing === "string" && existing.length > 0) {
      return input as WithCorrelationId<I>;
    }
    return {
      ...(input as object),
      correlationId: mintCorrelationId(prefix),
    } as WithCorrelationId<I>;
  };
  return Object.assign(wrapper, { attach });
}

// ----------------------------------------------------------------------------
// Completion tracking — design-principles.md #12 ("negative evidence is logged too").
// ----------------------------------------------------------------------------

/**
 * Tracks in-flight operations and logs a `${label}.unfinished` event if a
 * matching completion event doesn't fire within `timeoutMs`. The wrapper
 * starts a timer on entry; the timer is cleared on success or failure (the
 * inner `next()` resolves/rejects). If the timer fires first — typically
 * because the inner call hung beyond the timeout window — the unfinished
 * event is emitted with the correlationId for forensic replay later.
 *
 * NOT a timeout enforcer. This wrapper only OBSERVES; it does not abort.
 * Combine with `withTimeout(...)` if you also want to bail out.
 *
 * Bible anchor: design-principles.md #12. Bug-log analogue: 7 entries
 * of class `event-ordering` boil down to "lifecycle:end never fired and
 * we didn't notice" — exactly this surface.
 */
export function withCompletionTracking<I, O>(opts: {
  label: string;
  timeoutMs: number;
  logger?: StructuredLogger;
  includeInput?: (input: I) => Record<string, unknown>;
}): AsyncWrapper<I, O> {
  const { label, timeoutMs, logger = DEFAULT_LOGGER, includeInput } = opts;
  if (timeoutMs <= 0) throw new Error(`withCompletionTracking: timeoutMs must be > 0`);
  return (next) =>
    (input: I): Promise<O> => {
      const fields = includeInput ? includeInput(input) : {};
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        const warn = logger.warn ?? logger.info;
        warn(`${label}.unfinished`, { timeoutMs, ...fields });
      }, timeoutMs);
      return next(input).then(
        (value) => {
          settled = true;
          clearTimeout(timer);
          return value;
        },
        (err) => {
          settled = true;
          clearTimeout(timer);
          throw err;
        },
      );
    };
}
