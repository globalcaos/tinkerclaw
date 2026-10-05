import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { isLoopbackHost } from "../gateway/net.js";
import { readConnectPairingRequiredMessage } from "../gateway/protocol/connect-error-details.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventsDbPath } from "../infra/events/paths.js";
import {
  assertReadOnlySelect,
  EVENTS_QUERY_DEFAULT_ROW_CAP,
  EVENTS_SQL_DEFAULT_TIME_BUDGET_MS,
  EVENTS_SQL_MAX_ROW_CAP,
  EventsQueryError,
  type EventsQueryResult,
  guardSavedQueryResult,
  orderCatalogSilentFirst,
  resolveSavedQuery,
  runIsolatedReadOnlySql,
} from "../infra/events/query.js";
import { CATALOG_QUERY_NAME, SAVED_QUERIES } from "../infra/events/saved-queries.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp, isValidTimeZone } from "../logging/timestamps.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { createSafeStreamWriter } from "../terminal/stream-writer.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsCliRuntimeModule = typeof import("./logs-cli.runtime.js");

let logsCliRuntimePromise: Promise<LogsCliRuntimeModule> | undefined;

async function loadLogsCliRuntime(): Promise<LogsCliRuntimeModule> {
  logsCliRuntimePromise ??= import("./logs-cli.runtime.js");
  return logsCliRuntimePromise;
}

type LogsTailPayload = {
  file?: string;
  cursor?: number;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  localFallback?: boolean;
};

type LogsCliOptions = {
  limit?: string;
  maxBytes?: string;
  follow?: boolean;
  interval?: string;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  localTime?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const LOCAL_FALLBACK_NOTICE = "Gateway pairing required; reading local log file instead.";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  cursor: number | undefined,
  showProgress: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  try {
    const payload = await callGatewayFromCli(
      "logs.tail",
      opts,
      { cursor, limit, maxBytes },
      { progress: showProgress },
    );
    if (!payload || typeof payload !== "object") {
      throw new Error("Unexpected logs.tail response");
    }
    return payload as LogsTailPayload;
  } catch (error) {
    if (!shouldUseLocalLogsFallback(opts, error)) {
      throw error;
    }
    return {
      ...(await readConfiguredLogTail({ cursor, limit, maxBytes })),
      localFallback: true,
    };
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shouldUseLocalLogsFallback(opts: LogsCliOptions, error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (!readConnectPairingRequiredMessage(message)) {
    return false;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  const connection = buildGatewayConnectionDetails();
  if (connection.urlSource !== "local loopback") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname);
  } catch {
    return false;
  }
}

export function formatLogTimestamp(
  value?: string,
  mode: "pretty" | "plain" = "plain",
  localTime = false,
) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (mode === "pretty") {
    return formatTimestamp(parsed, { style: "short", timeZone: localTime ? undefined : "UTC" });
  }
  return localTime ? formatTimestamp(parsed, { style: "long" }) : parsed.toISOString();
}

function formatLogLine(
  raw: string,
  opts: {
    pretty: boolean;
    rich: boolean;
    localTime: boolean;
  },
): string {
  const parsed = parseLogLine(raw);
  if (!parsed) {
    return raw;
  }
  const label = parsed.subsystem ?? parsed.module ?? "";
  const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
  const level = parsed.level ?? "";
  const levelLabel = level.padEnd(5).trim();
  const message = parsed.message || parsed.raw;

  if (!opts.pretty) {
    return [time, level, label, message].filter(Boolean).join(" ").trim();
  }

  const timeLabel = colorize(opts.rich, theme.muted, time);
  const labelValue = colorize(opts.rich, theme.accent, label);
  const levelValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, levelLabel)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, levelLabel)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, levelLabel)
          : colorize(opts.rich, theme.info, levelLabel);
  const messageValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, message)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, message)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, message)
          : colorize(opts.rich, theme.info, message);

  const head = [timeLabel, levelValue, labelValue].filter(Boolean).join(" ");
  return [head, messageValue].filter(Boolean).join(" ").trim();
}

function createLogWriters() {
  const writer = createSafeStreamWriter({
    beforeWrite: () => clearActiveProgressLine(),
    onBrokenPipe: (err, stream) => {
      const code = err.code ?? "EPIPE";
      const target = stream === process.stdout ? "stdout" : "stderr";
      const message = `openclaw logs: output ${target} closed (${code}). Stopping tail.`;
      try {
        clearActiveProgressLine();
        process.stderr.write(`${message}\n`);
      } catch {
        // ignore secondary failures while reporting the broken pipe
      }
    },
  });

  return {
    logLine: (text: string) => writer.writeLine(process.stdout, text),
    errorLine: (text: string) => writer.writeLine(process.stderr, text),
    emitJsonLine: (payload: Record<string, unknown>, toStdErr = false) =>
      writer.write(toStdErr ? process.stderr : process.stdout, `${JSON.stringify(payload)}\n`),
  };
}

async function emitGatewayError(
  err: unknown,
  opts: LogsCliOptions,
  mode: "json" | "text",
  rich: boolean,
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean,
  errorLine: (text: string) => boolean,
) {
  const runtime = await loadLogsCliRuntime();
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
  const errorText = formatErrorMessage(err);

  const details = runtime.buildGatewayConnectionDetails({ url: opts.url });
  if (mode === "json") {
    if (
      !emitJsonLine(
        {
          type: "error",
          message,
          error: errorText,
          details,
          hint,
        },
        true,
      )
    ) {
      return;
    }
    return;
  }

  if (!errorLine(colorize(rich, theme.error, message))) {
    return;
  }
  if (!errorLine(details.message)) {
    return;
  }
  errorLine(colorize(rich, theme.muted, hint));
}

// ─── FORK 2026-09-25: the events-database query surface (logging.md §8.2, §9 step 10) ───────
//
// `logs query` and `logs catalog` ask the gateway (logs.query / logs.catalog: a saved query BY
// NAME, run on the events writer thread) unless --local; `logs sql` is LOCAL ONLY and never goes
// over RPC. Every local read runs in a child process on a read-only connection with a row cap and
// a time budget that ends in SIGKILL (infra/events/query.ts runIsolatedReadOnlySql).

type EventsQueryPayload = EventsQueryResult & {
  readonly name?: string;
  readonly description?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

type LogsEventsCliOptions = {
  list?: boolean;
  since?: string;
  label?: string;
  limit?: string;
  budgetMs?: string;
  silent?: boolean;
  local?: boolean;
  db?: string;
  json?: boolean;
  plain?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const LOCAL_QUERY_HINT =
  "Hint: --local reads the events database file directly when the gateway cannot answer.";

function parseCliPositiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new EventsQueryError(
      "invalid",
      `${flag} must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/** The local file: --db, else paths.ts's resolution — which refuses when off or under a test runner. */
function resolveLocalEventsDb(dbOption: string | undefined): string {
  const explicit = dbOption?.trim();
  let dbPath: string;
  if (explicit) {
    dbPath = explicit;
  } else {
    const resolution = resolveEventsDbPath(process.env);
    if (!resolution.enabled) {
      throw new EventsQueryError(
        "unavailable",
        resolution.reason === "disabled"
          ? "the events database is turned off (OPENCLAW_EVENTS_DB=0); pass --db <file> to read one"
          : "there is no default events database under a test runner; pass --db <file>",
      );
    }
    dbPath = resolution.dbPath;
  }
  if (!existsSync(dbPath)) {
    throw new EventsQueryError(
      "unavailable",
      `no events database at ${dbPath} yet (the gateway's events writer creates it)`,
    );
  }
  return dbPath;
}

function isEventsQueryPayload(value: unknown): value is EventsQueryPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { rows?: unknown }).rows) &&
    Array.isArray((value as { columns?: unknown }).columns)
  );
}

/** A saved query against the local file, with the same guards the writer thread applies. */
async function runSavedQueryLocally(
  name: string,
  input: Record<string, unknown>,
  opts: LogsEventsCliOptions,
): Promise<EventsQueryPayload> {
  const resolved = resolveSavedQuery(name, input, {
    nowMs: Date.now(),
    limit: parseCliPositiveInt(opts.limit, "--limit", EVENTS_QUERY_DEFAULT_ROW_CAP),
    maxRowCap: EVENTS_SQL_MAX_ROW_CAP,
  });
  const result = await runIsolatedReadOnlySql({
    dbPath: resolveLocalEventsDb(opts.db),
    sql: resolved.query.sql,
    params: resolved.params,
    rowCap: resolved.rowCap,
    timeBudgetMs: EVENTS_SQL_DEFAULT_TIME_BUDGET_MS,
  });
  return {
    name: resolved.query.name,
    description: resolved.query.description,
    params: resolved.params,
    ...guardSavedQueryResult(result),
  };
}

function printEventsQueryPayload(
  payload: EventsQueryPayload,
  opts: LogsEventsCliOptions,
  columns: readonly string[] = payload.columns,
): void {
  const { logLine, errorLine, emitJsonLine } = createLogWriters();
  if (opts.json) {
    emitJsonLine({ ...payload });
    return;
  }
  if (payload.rows.length === 0) {
    logLine("(no rows)");
  } else {
    logLine(
      renderTable({
        width: getTerminalTableWidth(),
        ...(opts.plain ? { border: "none" as const } : {}),
        columns: columns.map((key, index) => ({
          key,
          header: key,
          flex: index === columns.length - 1,
        })),
        rows: payload.rows.map((row) =>
          Object.fromEntries(
            columns.map((key) => [
              key,
              row[key] === null || row[key] === undefined ? "" : String(row[key]),
            ]),
          ),
        ),
      }).trimEnd(),
    );
  }
  if (payload.truncated === "row_cap") {
    errorLine(`Stopped at ${payload.rowCount} rows (raise --limit).`);
  } else if (payload.truncated === "time_budget") {
    errorLine(`Stopped at the time budget after ${payload.rowCount} rows.`);
  }
  if (payload.redactedSessionKeys > 0) {
    errorLine(
      `${payload.redactedSessionKeys} cell(s) held a raw session key and were redacted: a producer ` +
        "is leaking one past the writer (logging.md L4).",
    );
  }
}

function reportEventsQueryError(err: unknown, opts: LogsEventsCliOptions, hint?: string): void {
  const { errorLine, emitJsonLine } = createLogWriters();
  const message = err instanceof Error ? err.message : String(err);
  // A refusal of the request itself (bad SQL, a bad flag) gets no hint: --local would not help.
  const shownHint = err instanceof EventsQueryError ? undefined : hint;
  if (opts.json) {
    emitJsonLine({ type: "error", message, ...(shownHint ? { hint: shownHint } : {}) }, true);
  } else {
    const rich = isRich();
    errorLine(colorize(rich, theme.error, message));
    if (shownHint) {
      errorLine(colorize(rich, theme.muted, shownHint));
    }
  }
  process.exitCode = 1;
}

function printSavedQueryList(opts: LogsEventsCliOptions): void {
  const { logLine, emitJsonLine } = createLogWriters();
  if (opts.json) {
    emitJsonLine({
      type: "saved-queries",
      queries: SAVED_QUERIES.map((query) => ({
        name: query.name,
        description: query.description,
        params: query.params,
        defaultSince: query.defaultSince ?? null,
        reads: query.reads,
      })),
    });
    return;
  }
  logLine(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "name", header: "Name" },
        { key: "params", header: "Takes" },
        { key: "description", header: "Question", flex: true },
      ],
      rows: SAVED_QUERIES.map((query) => ({
        name: query.name,
        params:
          query.params.length === 0
            ? "(fixed window)"
            : query.params
                .map((param) => (param === "since" ? `--since (${query.defaultSince})` : "--label"))
                .join(" "),
        description: query.description,
      })),
    }).trimEnd(),
  );
}

function registerLogsEventsCli(logs: Command): void {
  // `logs query … --json` / `--limit` must reach the subcommand, not the tail's own options of the
  // same names. The root program enables positional options too (program/build-program.ts).
  logs.enablePositionalOptions();

  const query = logs
    .command("query")
    .description("Run a saved events-database query by name (logging.md §8.1); no name lists them")
    .argument("[name]", "Saved query name")
    .option("--list", "List the saved queries", false)
    .option("--since <duration>", "Window start: 30m, 12h, 7d or 4w (queries that take it)")
    .option("--label <label>", "Label filter (queries that take it)")
    .option("--limit <n>", "Max rows", String(EVENTS_QUERY_DEFAULT_ROW_CAP))
    .option("--local", "Read the events database file instead of asking the gateway", false)
    .option("--db <path>", "With --local: the events database file (default: the state dir's)")
    .option("--json", "Emit JSON", false)
    .option("--plain", "No table borders", false);
  addGatewayClientOptions(query);
  query.action(async (name: string | undefined, opts: LogsEventsCliOptions) => {
    if (opts.list || name === undefined) {
      printSavedQueryList(opts);
      return;
    }
    const input: Record<string, unknown> = {};
    if (opts.since !== undefined) {
      input.since = opts.since;
    }
    if (opts.label !== undefined) {
      input.label = opts.label;
    }
    try {
      const payload: unknown = opts.local
        ? await runSavedQueryLocally(name, input, opts)
        : await callGatewayFromCli(
            "logs.query",
            opts,
            {
              name,
              ...(Object.keys(input).length > 0 ? { params: input } : {}),
              limit: parseCliPositiveInt(opts.limit, "--limit", EVENTS_QUERY_DEFAULT_ROW_CAP),
            },
            { progress: !opts.json },
          );
      if (!isEventsQueryPayload(payload)) {
        throw new Error("Unexpected logs.query response");
      }
      printEventsQueryPayload(payload, opts);
    } catch (err) {
      reportEventsQueryError(err, opts, opts.local ? undefined : LOCAL_QUERY_HINT);
    }
  });

  logs
    .command("sql")
    .description("Run ONE read-only SELECT/WITH on the local events database (never over RPC)")
    .argument("<sql>", "A single SELECT or WITH statement")
    .option("--limit <n>", "Max rows", String(EVENTS_QUERY_DEFAULT_ROW_CAP))
    .option(
      "--budget-ms <ms>",
      "Time budget; past it the query is stopped, and killed if one step overruns",
      String(EVENTS_SQL_DEFAULT_TIME_BUDGET_MS),
    )
    .option("--db <path>", "The events database file (default: the state dir's)")
    .option("--json", "Emit JSON", false)
    .option("--plain", "No table borders", false)
    .action(async (sql: string, opts: LogsEventsCliOptions) => {
      try {
        // The statement is judged before any file is looked for: a write is refused as a write.
        assertReadOnlySelect(sql);
        const result = await runIsolatedReadOnlySql({
          dbPath: resolveLocalEventsDb(opts.db),
          sql,
          rowCap: parseCliPositiveInt(opts.limit, "--limit", EVENTS_QUERY_DEFAULT_ROW_CAP),
          timeBudgetMs: parseCliPositiveInt(
            opts.budgetMs,
            "--budget-ms",
            EVENTS_SQL_DEFAULT_TIME_BUDGET_MS,
          ),
        });
        printEventsQueryPayload(result, opts);
      } catch (err) {
        reportEventsQueryError(err, opts);
      }
    });

  const catalog = logs
    .command("catalog")
    .description("The event catalog with row counts in the window and last-seen times")
    .option("--silent", "Declared events with no row in the window first", false)
    .option("--since <duration>", "Window for the counts (default 7d)")
    .option("--local", "Read the events database file instead of asking the gateway", false)
    .option("--db <path>", "With --local: the events database file (default: the state dir's)")
    .option("--json", "Emit JSON", false)
    .option("--plain", "No table borders", false);
  addGatewayClientOptions(catalog);
  catalog.action(async (opts: LogsEventsCliOptions) => {
    try {
      let payload: unknown;
      if (opts.local) {
        const local = await runSavedQueryLocally(
          CATALOG_QUERY_NAME,
          opts.since === undefined ? {} : { since: opts.since },
          { ...opts, limit: String(EVENTS_SQL_MAX_ROW_CAP) },
        );
        payload = opts.silent ? { ...local, rows: orderCatalogSilentFirst(local.rows) } : local;
      } else {
        payload = await callGatewayFromCli(
          "logs.catalog",
          opts,
          {
            ...(opts.silent ? { silent: true } : {}),
            ...(opts.since !== undefined ? { since: opts.since } : {}),
          },
          { progress: !opts.json },
        );
      }
      if (!isEventsQueryPayload(payload)) {
        throw new Error("Unexpected logs.catalog response");
      }
      if (opts.json) {
        printEventsQueryPayload(payload, opts);
        return;
      }
      // The text table shows a readable last-seen time; the rows are this call's own copy.
      for (const row of payload.rows) {
        row.last_seen =
          typeof row.last_ts_ms === "number" ? new Date(row.last_ts_ms).toISOString() : null;
      }
      printEventsQueryPayload(payload, opts, [
        "name",
        "kind",
        "retention",
        "paper",
        "rows_since",
        "last_seen",
      ]);
    } catch (err) {
      reportEventsQueryError(err, opts, opts.local ? undefined : LOCAL_QUERY_HINT);
    }
  });
}

export function registerLogsCli(program: Command) {
  const logs = program
    .command("logs")
    .description("Tail gateway file logs via RPC")
    .option("--limit <n>", "Max lines to return", "200")
    .option("--max-bytes <n>", "Max bytes to read", "250000")
    .option("--follow", "Follow log output", false)
    .option("--interval <ms>", "Polling interval in ms", "1000")
    .option("--json", "Emit JSON log lines", false)
    .option("--plain", "Plain text output (no ANSI styling)", false)
    .option("--no-color", "Disable ANSI colors")
    .option("--local-time", "Display timestamps in local timezone", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/logs", "docs.openclaw.ai/cli/logs")}\n`,
    );

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    const { logLine, errorLine, emitJsonLine } = createLogWriters();
    const interval = parsePositiveInt(opts.interval, 1000);
    let cursor: number | undefined;
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && process.stdout.isTTY && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime =
      Boolean(opts.localTime) || (!!process.env.TZ && isValidTimeZone(process.env.TZ));

    while (true) {
      let payload: LogsTailPayload;
      // Show progress spinner only on first fetch, not during follow polling
      const showProgress = first && !opts.follow;
      try {
        payload = await fetchLogs(opts, cursor, showProgress);
      } catch (err) {
        await emitGatewayError(
          err,
          opts,
          jsonMode ? "json" : "text",
          rich,
          emitJsonLine,
          errorLine,
        );
        process.exit(1);
        return;
      }
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (jsonMode) {
        if (first) {
          if (
            !emitJsonLine({
              type: "meta",
              file: payload.file,
              cursor: payload.cursor,
              size: payload.size,
            })
          ) {
            return;
          }
        }
        for (const line of lines) {
          const parsed = parseLogLine(line);
          if (parsed) {
            if (!emitJsonLine({ type: "log", ...parsed })) {
              return;
            }
          } else {
            if (!emitJsonLine({ type: "raw", raw: line })) {
              return;
            }
          }
        }
        if (payload.truncated) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log tail truncated (increase --max-bytes).",
            })
          ) {
            return;
          }
        }
        if (payload.reset) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log cursor reset (file rotated).",
            })
          ) {
            return;
          }
        }
      } else {
        if (first && payload.file && payload.localFallback === true) {
          if (!errorLine(colorize(rich, theme.warn, LOCAL_FALLBACK_NOTICE))) {
            return;
          }
        }
        if (first && payload.file) {
          const prefix = pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:";
          if (!logLine(`${prefix} ${payload.file}`)) {
            return;
          }
        }
        for (const line of lines) {
          if (
            !logLine(
              formatLogLine(line, {
                pretty,
                rich,
                localTime,
              }),
            )
          ) {
            return;
          }
        }
        if (payload.truncated) {
          if (!errorLine("Log tail truncated (increase --max-bytes).")) {
            return;
          }
        }
        if (payload.reset) {
          if (!errorLine("Log cursor reset (file rotated).")) {
            return;
          }
        }
      }
      cursor =
        typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
          ? payload.cursor
          : cursor;
      first = false;

      if (!opts.follow) {
        return;
      }
      await delay(interval);
    }
  });

  registerLogsEventsCli(logs);
}
