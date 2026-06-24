/**
 * FORK 2026-05-12 — fork-side structured logger.
 *
 * The gateway today emits text log lines (`[diagnostic] stuck session: …`).
 * design-principles.md #9 ("observability is a design property, not a bolt-on")
 * says new event sources should emit structured JSON, not text — so a
 * future `gateway.flow.replay` can read the events table rather than
 * grep journalctl text.
 *
 * Scope: this logger is for NEW fork-side code. Existing text-log call
 * sites stay as they are (rule of three — refactor on the third change,
 * not the first). Modules that adopt this logger get JSON-line output
 * with consistent fields:
 *
 *   {ts, level, service, event, correlationId?, ...fields}
 *
 * Writes to stdout (or stderr for warn/error) by default; can be wrapped
 * with `pipeline.ts:withTrace` and friends for composed observability.
 *
 * Why fork-side and not upstream: the upstream logger is a different
 * surface owned by upstream (`src/logging/diagnostic.ts`). Touching it
 * would violate design-principles.md #8 (minimal-touch upstream files).
 * Adopting this logger in new fork code is the cheapest way to start
 * accumulating structured events without merge friction.
 */

import { mintCorrelationId } from "./pipeline.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * One structured event record. ALL fields except `correlationId` are
 * required so the event has a consistent shape — `correlationId` is
 * optional only because some events fire outside any operation context
 * (gateway boot, cron tick scheduler), and those use the literal
 * "system" as their correlationId so the schema is uniform downstream.
 */
export type LogRecord = {
  ts: string; // ISO 8601 UTC
  level: LogLevel;
  service: string;
  event: string;
  correlationId: string;
  fields: Record<string, unknown>;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LoggerOptions = {
  /** Service tag attached to every record. Examples: `tinker-bridge`, `gateway-probes`, `auto-reply`. */
  service: string;
  /** Minimum level to emit. Default: `info`. */
  minLevel?: LogLevel;
  /** Override stream — useful for testing. Default: process.stdout (warn/error → stderr). */
  out?: (line: string, level: LogLevel) => void;
  /** Static fields added to every record (e.g., `{version: "2026.5.12"}`). */
  staticFields?: Record<string, unknown>;
};

const defaultOut = (line: string, level: LogLevel) => {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export type ForkLogger = {
  /** Logger scoped to a specific correlation ID. All events inherit it. */
  withCorrelationId: (correlationId: string) => ForkLogger;
  trace: (event: string, fields?: Record<string, unknown>) => void;
  debug: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
};

/**
 * Create a structured logger. Cheap (no I/O at construction time);
 * each `info` / `warn` call writes one JSON line.
 *
 * Example:
 * ```
 * const log = createLogger({service: "gateway-probes"});
 * const correlationId = mintCorrelationId();
 * const scoped = log.withCorrelationId(correlationId);
 * scoped.info("probe.called", {probe: "stuckSessions", thresholdMs: 60_000});
 * // → {"ts":"2026-05-12T…","level":"info","service":"gateway-probes",
 * //    "event":"probe.called","correlationId":"t…","probe":"stuckSessions","thresholdMs":60000}
 * ```
 */
export function createLogger(opts: LoggerOptions): ForkLogger {
  const minLevel = opts.minLevel ?? "info";
  const out = opts.out ?? defaultOut;
  const staticFields = opts.staticFields ?? {};

  function emit(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> | undefined,
    correlationId: string,
  ) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      service: opts.service,
      event,
      correlationId,
      fields: { ...staticFields, ...(fields ?? {}) },
    };
    // Flatten the record so consumers don't need to navigate nested `fields`
    // — but keep the inner staticFields and per-call fields visible.
    const flat: Record<string, unknown> = {
      ts: record.ts,
      level: record.level,
      service: record.service,
      event: record.event,
      correlationId: record.correlationId,
      ...record.fields,
    };
    out(JSON.stringify(flat), level);
  }

  function make(correlationId: string): ForkLogger {
    return {
      withCorrelationId: (id) => make(id),
      trace: (event, fields) => emit("trace", event, fields, correlationId),
      debug: (event, fields) => emit("debug", event, fields, correlationId),
      info: (event, fields) => emit("info", event, fields, correlationId),
      warn: (event, fields) => emit("warn", event, fields, correlationId),
      error: (event, fields) => emit("error", event, fields, correlationId),
    };
  }

  // Default-scoped logger uses "system" as correlation ID when no operation
  // is active. Callers should immediately .withCorrelationId() at the start
  // of a request scope.
  return make("system");
}

/**
 * Convenience for one-off events without holding onto a logger.
 *
 * Don't use this in hot paths — every call constructs a fresh logger and
 * formats one record. Fine for "log once at module load" or "log once at
 * a rare failure point."
 */
export function logOnce(opts: {
  service: string;
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
  correlationId?: string;
}): void {
  const correlationId = opts.correlationId ?? mintCorrelationId();
  const logger = createLogger({ service: opts.service }).withCorrelationId(correlationId);
  logger[opts.level](opts.event, opts.fields);
}
