/**
 * The events-database query engine — TINKER_UI_DESIGN_BIBLE/logging.md §8.2 (§9 step 10).
 *
 * Two doors, one rule each:
 *
 *  - SAVED queries (saved-queries.ts), by NAME. Over RPC (`logs.query`, `logs.catalog`) they run in
 *    the events WRITER THREAD on a second, READ-ONLY connection this module opens
 *    (openReadOnlyEventsDatabase; writer-worker.ts calls runSavedQuery) — never on the gateway's
 *    main thread, which only validates the request (resolveSavedQuery) and posts it (emit.ts
 *    runSavedEventsQuery). The CLI's `--local` path runs the same entries through the isolated
 *    runner below.
 *  - AD-HOC SQL (`tinkerclaw logs sql`), LOCAL ONLY — never over RPC. runIsolatedReadOnlySql runs
 *    it in a CHILD PROCESS on a read-only connection, after assertReadOnlySelect has admitted it.
 *
 * READ-ONLY BY CONSTRUCTION, in three layers (query.test.ts holds each one on its own):
 *  1. the connection is opened `readOnly: true` (SQLITE_OPEN_READONLY) with `PRAGMA query_only`,
 *     so INSERT / UPDATE / DELETE / CREATE — TEMP included — fail with SQLITE_READONLY, and an
 *     ATTACHed file inherits the read-only open;
 *  2. assertReadOnlySelect admits exactly ONE statement whose first keyword is SELECT or WITH (and
 *     a WITH whose main statement is a SELECT). This layer is NOT redundant: on a read-only
 *     connection `VACUUM INTO '<file>'` still writes a new file (measured on node 22.23 /
 *     SQLite 3.x, 2026-09-25), `ATTACH` still opens any other SQLite file on the host (the LLM
 *     ledger holds private bodies), and node:sqlite's prepare() silently DROPS everything after the
 *     first statement instead of refusing it;
 *  3. there is no path from a client to SQL text: the RPC takes a registry name.
 *
 * LIMITS. A row cap (the result stops at `rowCap` and says `truncated: "row_cap"`) and a time
 * budget. node:sqlite on node 22 has no progress handler or interrupt, and a worker_threads
 * terminate() does NOT stop a running sqlite3_step (measured: a 13 s aggregate ran to the end after
 * terminate() at 0.3 s, and process.exit() waited for it). So:
 *  - between rows, every runner stops at the budget (`truncated: "time_budget"`);
 *  - the isolated runner is ALSO killed with SIGKILL at budget + grace — the only hard wall there
 *    is for one long step (an aggregate over a runaway CTE), which is why ad-hoc SQL runs in a
 *    child process and nowhere else;
 *  - a saved query in the writer thread has no hard wall: the entries are fixed, windowed reads of
 *    `events_name_ts`, and the main thread's wait is SOFT (emit.ts), so a slow one fails the RPC
 *    without tearing the writer down.
 *
 * L4: rows never hold a raw session key (emit.ts hashes it), and runSavedQuery refuses a result
 * column named like one, so no saved query can grow into returning one.
 */

import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { getSavedQuery, SAVED_QUERY_NAMES, type SavedQuery } from "./saved-queries.js";

// ─── limits ─────────────────────────────────────────────────────────────────

/** Rows a query returns when the caller names no limit. */
export const EVENTS_QUERY_DEFAULT_ROW_CAP = 1_000;
/** The most rows one RPC answer may carry (it is structured-cloned off the worker, then JSON'd). */
export const EVENTS_QUERY_RPC_MAX_ROW_CAP = 5_000;
/** The writer thread stops a saved query between rows at this budget. */
export const EVENTS_QUERY_RPC_TIME_BUDGET_MS = 5_000;
/** The most rows the local CLI may ask for. */
export const EVENTS_SQL_MAX_ROW_CAP = 50_000;
export const EVENTS_SQL_DEFAULT_TIME_BUDGET_MS = 10_000;
export const EVENTS_SQL_MAX_TIME_BUDGET_MS = 120_000;
/**
 * The isolated runner is SIGKILLed this long after its budget: node's start-up and the open are
 * inside it, so the per-row stop normally answers first and the kill only fires on one long step.
 */
export const EVENTS_SQL_KILL_GRACE_MS = 1_500;
/** A result bigger than this on the child's stdout is refused (lower the row cap). */
export const EVENTS_SQL_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const EVENTS_SQL_MAX_CHARS = 64 * 1024;
/** The longest `since` a caller may ask for; research rows are never deleted (§7.4). */
export const EVENTS_QUERY_MAX_SINCE_DAYS = 3_650;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};
const DURATION_PATTERN = /^(\d{1,6})([mhdw])$/;
/** emit.ts's label rule: printable ASCII, no whitespace, at most 128 chars. */
const LABEL_PARAM_PATTERN = /^[\x21-\x7e]{1,128}$/;
/** L4: a result column that would carry a raw session key. */
const RAW_SESSION_KEY_COLUMN = /(^|_)session_?key$/i;
/** What a cell that parsed as a raw session key is replaced with. */
export const REDACTED_SESSION_KEY = "<redacted:session_key>";

// ─── types ──────────────────────────────────────────────────────────────────

export type EventsQueryValue = string | number | null;
export type EventsQueryRow = Record<string, EventsQueryValue>;
export type EventsQueryTruncation = "row_cap" | "time_budget" | null;

export interface EventsQueryResult {
  /** The first row's column names, in order; empty when there are no rows. */
  readonly columns: string[];
  readonly rows: EventsQueryRow[];
  readonly rowCount: number;
  /** Why the answer stopped before the query did; null when it is complete. */
  readonly truncated: EventsQueryTruncation;
  readonly elapsedMs: number;
  /**
   * Cells a saved query's answer carried that parse as a RAW session key (the canonical parser),
   * replaced by REDACTED_SESSION_KEY. Always 0 unless a producer leaked a key into a label or an
   * id column past the writer's L4 rules — nonzero is a defect report, not a normal reading.
   */
  readonly redactedSessionKeys: number;
}

/** A saved query's bound parameters, exactly the ones its `params` declares. */
export type SavedQueryBoundParams = {
  since_ms?: number;
  label?: string | null;
};

export interface ResolvedSavedQuery {
  readonly query: SavedQuery;
  readonly params: SavedQueryBoundParams;
  readonly rowCap: number;
}

export type EventsQueryErrorCode =
  | "invalid"
  | "not_read_only"
  | "time_budget"
  | "too_large"
  | "unavailable"
  | "failed";

export class EventsQueryError extends Error {
  readonly code: EventsQueryErrorCode;

  constructor(code: EventsQueryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EventsQueryError";
    this.code = code;
  }
}

// ─── request validation (the main thread's half) ───────────────────────────

/** "30m", "12h", "7d", "4w" → milliseconds; anything else, or past 10 years, is refused. */
export function parseSinceDuration(value: unknown): number {
  if (typeof value !== "string") {
    throw new EventsQueryError("invalid", "since must be a duration string such as 7d");
  }
  const match = DURATION_PATTERN.exec(value.trim());
  if (match === null) {
    throw new EventsQueryError(
      "invalid",
      `since must look like 30m, 12h, 7d or 4w, not ${JSON.stringify(value.slice(0, 32))}`,
    );
  }
  const ms = Number(match[1]) * DURATION_UNIT_MS[match[2]];
  if (ms <= 0 || ms > EVENTS_QUERY_MAX_SINCE_DAYS * DURATION_UNIT_MS.d) {
    throw new EventsQueryError(
      "invalid",
      `since must be between 1m and ${EVENTS_QUERY_MAX_SINCE_DAYS}d`,
    );
  }
  return ms;
}

function parseRowCap(value: unknown, maxRowCap: number): number {
  if (value === undefined || value === null) {
    return Math.min(EVENTS_QUERY_DEFAULT_ROW_CAP, maxRowCap);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxRowCap) {
    throw new EventsQueryError("invalid", `limit must be an integer from 1 to ${maxRowCap}`);
  }
  return value;
}

/**
 * Validates a saved-query request and binds its parameters. `input` is the caller's `{since?,
 * label?}`; a key the query does not declare is refused, never ignored (a silently dropped filter
 * reads as an answer to the filtered question). `since_ms` is minute-aligned, so a per-minute
 * rollup stamped at its window start is not cut in half at the boundary.
 */
export function resolveSavedQuery(
  name: unknown,
  input: unknown,
  options: { readonly nowMs: number; readonly limit?: unknown; readonly maxRowCap: number },
): ResolvedSavedQuery {
  if (typeof name !== "string" || name.length === 0) {
    throw new EventsQueryError("invalid", "name must be a saved query name");
  }
  const query = getSavedQuery(name);
  if (query === undefined) {
    throw new EventsQueryError(
      "invalid",
      `unknown saved query ${JSON.stringify(name.slice(0, 64))}; known: ${SAVED_QUERY_NAMES.join(", ")}`,
    );
  }
  let given: Record<string, unknown> = {};
  if (input !== undefined && input !== null) {
    if (typeof input !== "object" || Array.isArray(input)) {
      throw new EventsQueryError("invalid", "params must be an object such as {since: '7d'}");
    }
    given = input as Record<string, unknown>;
  }
  for (const key of Object.keys(given)) {
    if (!(query.params as readonly string[]).includes(key)) {
      throw new EventsQueryError(
        "invalid",
        `saved query ${query.name} takes ${
          query.params.length === 0 ? "no parameters (fixed window)" : query.params.join(", ")
        }, not ${JSON.stringify(key.slice(0, 32))}`,
      );
    }
  }
  const params: SavedQueryBoundParams = {};
  if (query.params.includes("since")) {
    const sinceMs = parseSinceDuration(given.since ?? query.defaultSince);
    params.since_ms = Math.floor((options.nowMs - sinceMs) / 60_000) * 60_000;
  }
  if (query.params.includes("label")) {
    const label = given.label;
    if (label !== undefined && label !== null) {
      if (typeof label !== "string" || !LABEL_PARAM_PATTERN.test(label)) {
        throw new EventsQueryError(
          "invalid",
          "label must be 1-128 printable ASCII characters without spaces",
        );
      }
      params.label = label;
    } else {
      params.label = null;
    }
  }
  return { query, params, rowCap: parseRowCap(options.limit, options.maxRowCap) };
}

// ─── the read-only guard ───────────────────────────────────────────────────

type SqlToken =
  | { readonly kind: "word"; readonly upper: string; readonly depth: number }
  | { readonly kind: "semicolon" }
  | { readonly kind: "other" };

/** An identifier or keyword character: ASCII letters, `_`, and anything non-ASCII (as SQLite). */
function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * A lexer just deep enough to find statement boundaries and keywords: comments, string literals
 * and quoted identifiers are skipped whole, so a `;` or a DELETE inside them is not a token.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const skipQuoted = (close: string, doubled: boolean): void => {
    i += 1;
    for (;;) {
      if (i >= n) {
        throw new EventsQueryError("invalid", "unterminated quoted string or identifier");
      }
      if (sql[i] === close) {
        if (doubled && sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        return;
      }
      i += 1;
    }
  };
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      // SQLite ends an unterminated block comment at the end of the input; so does this.
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'") {
      skipQuoted("'", true);
      tokens.push({ kind: "other" });
    } else if (ch === '"' || ch === "`") {
      skipQuoted(ch, true);
      tokens.push({ kind: "other" });
    } else if (ch === "[") {
      skipQuoted("]", false);
      tokens.push({ kind: "other" });
    } else if (ch === ";") {
      tokens.push({ kind: "semicolon" });
      i += 1;
    } else if (ch === "(") {
      depth += 1;
      tokens.push({ kind: "other" });
      i += 1;
    } else if (ch === ")") {
      depth -= 1;
      tokens.push({ kind: "other" });
      i += 1;
    } else if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) {
        j += 1;
      }
      tokens.push({ kind: "word", upper: sql.slice(i, j).toUpperCase(), depth });
      i = j;
    } else if ((ch === "@" || ch === ":" || ch === "$") && /[A-Za-z0-9_]/.test(sql[i + 1] ?? "")) {
      // A named parameter is one token: `@delete` is a parameter, not a keyword.
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) {
        j += 1;
      }
      tokens.push({ kind: "other" });
      i = j;
    } else {
      tokens.push({ kind: "other" });
      i += 1;
    }
  }
  return tokens;
}

const STATEMENT_KEYWORDS = new Set(["SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"]);

/**
 * Admits exactly one SELECT, or one WITH whose main statement is a SELECT (logging.md §8.2:
 * "`SELECT` and `WITH` only"). Throws EventsQueryError("not_read_only") otherwise. Layer 2 of the
 * header: the read-only connection is layer 1 and does not depend on this.
 */
export function assertReadOnlySelect(sql: unknown): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new EventsQueryError("not_read_only", "the SQL is empty");
  }
  if (sql.length > EVENTS_SQL_MAX_CHARS) {
    throw new EventsQueryError("invalid", `the SQL is longer than ${EVENTS_SQL_MAX_CHARS} chars`);
  }
  const tokens = tokenizeSql(sql);
  const end = tokens.findIndex((token) => token.kind === "semicolon");
  if (end !== -1 && tokens.slice(end + 1).some((token) => token.kind !== "semicolon")) {
    throw new EventsQueryError(
      "not_read_only",
      "one statement only: node:sqlite would silently skip everything after the first `;`",
    );
  }
  const statement = end === -1 ? tokens : tokens.slice(0, end);
  const first = statement[0];
  if (first === undefined || first.kind !== "word") {
    throw new EventsQueryError("not_read_only", "the statement must start with SELECT or WITH");
  }
  if (first.upper === "SELECT") {
    return;
  }
  if (first.upper !== "WITH") {
    throw new EventsQueryError(
      "not_read_only",
      `only SELECT and WITH are allowed here, not ${first.upper}`,
    );
  }
  // After the CTE list, the first depth-0 statement keyword is the main statement.
  const main = statement
    .slice(1)
    .find(
      (token): token is Extract<SqlToken, { kind: "word" }> =>
        token.kind === "word" && token.depth === 0 && STATEMENT_KEYWORDS.has(token.upper),
    );
  if (main === undefined || (main.upper !== "SELECT" && main.upper !== "VALUES")) {
    throw new EventsQueryError(
      "not_read_only",
      `a WITH statement must end in a SELECT${main === undefined ? "" : `, not ${main.upper}`}`,
    );
  }
}

// ─── the in-thread runner (the writer thread's read connection) ────────────

/**
 * A READ-ONLY connection to the events database (layer 1 of the header). Lives here, not in
 * writer-worker.ts: the writer's own connection is opened only through schema.ts's
 * openEventsDatabase (§7.3's pragma order), and this optic's verify gate holds writer-worker.ts
 * free of any other open. The file must exist — a read-only open never creates one.
 */
export function openReadOnlyEventsDatabase(path: string): DatabaseSync {
  if (path === ":memory:") {
    throw new EventsQueryError(
      "unavailable",
      "saved queries read a file-backed events database, not :memory:",
    );
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function toQueryValue(value: unknown): EventsQueryValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return `<blob:${value.length} bytes>`;
  }
  // node:sqlite yields only the types above; anything else is named, never guessed at.
  return `<${typeof value}>`;
}

/**
 * Runs one statement on `db`, stopping at `rowCap` rows or at `timeBudgetMs` between rows. The
 * budget is checked BEFORE a row is taken, so `truncated` is set only when a row really was left
 * behind; breaking out of the iterator resets the statement, which ends its read snapshot (a
 * held snapshot would block the writer's WAL checkpoints — §8.2's anatomy-WAL lesson).
 */
export function runEventsQuery(
  db: DatabaseSync,
  sql: string,
  params: SavedQueryBoundParams | null,
  options: { readonly rowCap: number; readonly timeBudgetMs: number; readonly now?: () => number },
): EventsQueryResult {
  const now = options.now ?? Date.now;
  const started = now();
  const statement = db.prepare(sql);
  const rows: EventsQueryRow[] = [];
  let truncated: EventsQueryTruncation = null;
  const iterator = params === null ? statement.iterate() : statement.iterate(toSqlParams(params));
  for (const raw of iterator) {
    if (rows.length >= options.rowCap) {
      truncated = "row_cap";
      break;
    }
    if (now() - started > options.timeBudgetMs) {
      truncated = "time_budget";
      break;
    }
    const row: EventsQueryRow = {};
    for (const [key, value] of Object.entries(raw)) {
      row[key] = toQueryValue(value);
    }
    rows.push(row);
  }
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    rowCount: rows.length,
    truncated,
    elapsedMs: Math.max(0, now() - started),
    redactedSessionKeys: 0,
  };
}

/** node:sqlite's named parameters: only the keys that are set (an unknown key is an error). */
function toSqlParams(params: SavedQueryBoundParams): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (params.since_ms !== undefined) {
    out.since_ms = params.since_ms;
  }
  if (params.label !== undefined) {
    out.label = params.label;
  }
  return out;
}

/**
 * L4, enforced on the way OUT: every string cell that the canonical session-key parser recognises
 * (never a new regex — design-principles #18) is replaced and counted. The writer hashes
 * `sessionKey` into session_hash, but a label or an id column only has to be printable ASCII, so
 * a producer that passed a raw key there would otherwise reach a READ-scope client verbatim.
 */
export function redactRawSessionKeys(result: EventsQueryResult): EventsQueryResult {
  let redacted = 0;
  const rows = result.rows.map((row) => {
    let copy: EventsQueryRow | null = null;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" && parseAgentSessionKey(value) !== null) {
        copy ??= { ...row };
        copy[key] = REDACTED_SESSION_KEY;
        redacted += 1;
      }
    }
    return copy ?? row;
  });
  return { ...result, rows, redactedSessionKeys: result.redactedSessionKeys + redacted };
}

/** L4: refuses an answer with a column that would carry a raw session key. */
export function assertNoRawSessionKeyColumns(columns: readonly string[]): void {
  const offending = columns.find((column) => RAW_SESSION_KEY_COLUMN.test(column));
  if (offending !== undefined) {
    throw new EventsQueryError(
      "failed",
      `refusing a result column named ${JSON.stringify(offending)}: a query answer carries ` +
        "session_hash and session_kind, never a raw session key (logging.md L4)",
    );
  }
}

/** Only the parameters the query declares, type-checked again: the wire is not trusted. */
function bindDeclaredParams(
  query: SavedQuery,
  params: SavedQueryBoundParams,
): SavedQueryBoundParams {
  const bound: SavedQueryBoundParams = {};
  if (query.params.includes("since")) {
    if (typeof params.since_ms !== "number" || !Number.isFinite(params.since_ms)) {
      throw new EventsQueryError("invalid", `saved query ${query.name} needs a numeric since_ms`);
    }
    bound.since_ms = params.since_ms;
  }
  if (query.params.includes("label")) {
    const label = params.label ?? null;
    if (label !== null && (typeof label !== "string" || !LABEL_PARAM_PATTERN.test(label))) {
      throw new EventsQueryError("invalid", "label must be 1-128 printable ASCII characters");
    }
    bound.label = label;
  }
  return bound;
}

/**
 * A saved query BY NAME on a read-only connection — the writer thread's `query` request
 * (writer-worker.ts). The SQL comes from the registry in this process, never from the request.
 */
export function runSavedQuery(
  db: DatabaseSync,
  request: {
    readonly name: string;
    readonly params: SavedQueryBoundParams;
    readonly rowCap: number;
    readonly timeBudgetMs: number;
  },
): EventsQueryResult {
  const query = getSavedQuery(request.name);
  if (query === undefined) {
    throw new EventsQueryError("invalid", `unknown saved query ${JSON.stringify(request.name)}`);
  }
  const rowCap = Math.min(Math.max(1, Math.floor(request.rowCap)), EVENTS_SQL_MAX_ROW_CAP);
  const timeBudgetMs = Math.min(
    Math.max(1, Math.floor(request.timeBudgetMs)),
    EVENTS_SQL_MAX_TIME_BUDGET_MS,
  );
  const result = runEventsQuery(db, query.sql, bindDeclaredParams(query, request.params), {
    rowCap,
    timeBudgetMs,
  });
  return guardSavedQueryResult(result);
}

/**
 * What every saved-query answer passes through before it leaves — the writer thread's and the
 * CLI's `--local` alike: no raw-session-key column, and no cell that parses as a raw key.
 */
export function guardSavedQueryResult(result: EventsQueryResult): EventsQueryResult {
  assertNoRawSessionKeyColumns(result.columns);
  return redactRawSessionKeys(result);
}

/** `--silent` (§3 L2): declared events with no row in the window first, then the rest; stable. */
export function orderCatalogSilentFirst(rows: readonly EventsQueryRow[]): EventsQueryRow[] {
  const silent = rows.filter((row) => row.rows_since === 0);
  const seen = rows.filter((row) => row.rows_since !== 0);
  return [...silent, ...seen];
}

// ─── the isolated runner (the local CLI) ───────────────────────────────────

/**
 * The child's whole program: plain CommonJS over node:sqlite and nothing else, so it runs the same
 * from TypeScript source and from the bundled dist without an entry file of its own. It repeats
 * runEventsQuery's loop (row cap, then the between-rows budget); query.test.ts holds both.
 */
const ISOLATED_SQL_RUNNER_SOURCE = [
  '"use strict";',
  'const { DatabaseSync } = require("node:sqlite");',
  "const chunks = [];",
  'process.stdin.on("data", (chunk) => chunks.push(chunk));',
  'process.stdin.on("end", () => {',
  "  let out;",
  "  try {",
  '    const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));',
  "    const started = Date.now();",
  "    const db = new DatabaseSync(req.dbPath, { readOnly: true });",
  "    try {",
  '      db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");',
  "      const statement = db.prepare(req.sql);",
  "      const rows = [];",
  "      let truncated = null;",
  "      const iterator = req.params === null ? statement.iterate() : statement.iterate(req.params);",
  "      for (const row of iterator) {",
  '        if (rows.length >= req.rowCap) { truncated = "row_cap"; break; }',
  '        if (Date.now() - started > req.timeBudgetMs) { truncated = "time_budget"; break; }',
  "        rows.push(row);",
  "      }",
  "      out = { ok: true, rows, truncated, elapsedMs: Date.now() - started };",
  "    } finally {",
  "      db.close();",
  "    }",
  "  } catch (error) {",
  "    out = { ok: false, message: String((error && error.message) || error).slice(0, 500) };",
  "  }",
  "  process.stdout.write(JSON.stringify(out, (key, value) =>",
  '    value instanceof Uint8Array ? "<blob:" + value.length + " bytes>"',
  '      : typeof value === "bigint" ? String(value) : value));',
  "});",
].join("\n");

export interface IsolatedSqlOptions {
  readonly dbPath: string;
  readonly sql: string;
  /** Named parameters (a saved query run with --local); null for ad-hoc SQL. */
  readonly params?: SavedQueryBoundParams | null;
  readonly rowCap: number;
  readonly timeBudgetMs: number;
  /** Test seam: the node binary; defaults to this process's. */
  readonly execPath?: string;
}

/**
 * Runs ONE admitted SELECT/WITH in a child process on a read-only connection, with a row cap, a
 * between-rows budget, and a SIGKILL at budget + EVENTS_SQL_KILL_GRACE_MS — the only hard time
 * wall node 22 offers (see the header). Rejects with EventsQueryError; never touches the caller's
 * thread with SQLite.
 */
export function runIsolatedReadOnlySql(options: IsolatedSqlOptions): Promise<EventsQueryResult> {
  try {
    assertReadOnlySelect(options.sql);
    if (
      !Number.isInteger(options.rowCap) ||
      options.rowCap < 1 ||
      options.rowCap > EVENTS_SQL_MAX_ROW_CAP
    ) {
      throw new EventsQueryError(
        "invalid",
        `the row cap must be an integer from 1 to ${EVENTS_SQL_MAX_ROW_CAP}`,
      );
    }
    if (
      !Number.isInteger(options.timeBudgetMs) ||
      options.timeBudgetMs < 1 ||
      options.timeBudgetMs > EVENTS_SQL_MAX_TIME_BUDGET_MS
    ) {
      throw new EventsQueryError(
        "invalid",
        `the time budget must be an integer from 1 to ${EVENTS_SQL_MAX_TIME_BUDGET_MS} ms`,
      );
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<EventsQueryResult>((resolve, reject) => {
    const child = spawn(
      options.execPath ?? process.execPath,
      ["--no-warnings", "-e", ISOLATED_SQL_RUNNER_SOURCE],
      {
        stdio: ["pipe", "pipe", "pipe"],
        // A dev NODE_OPTIONS (a tsx loader, an inspector) has no business in a 30-line runner.
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let stoppedFor: "time_budget" | "too_large" | null = null;
    // The hard wall: SIGKILL ends a child stuck inside one sqlite3_step, which nothing else can.
    const killTimer = setTimeout(() => {
      stoppedFor = "time_budget";
      child.kill("SIGKILL");
    }, options.timeBudgetMs + EVENTS_SQL_KILL_GRACE_MS);
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        fn();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > EVENTS_SQL_MAX_OUTPUT_BYTES) {
        stoppedFor = "too_large";
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) {
        stderr += chunk.toString("utf8");
      }
    });
    child.stdin.on("error", () => {
      // The child died before reading its input; its exit reports why.
    });
    child.on("error", (error) => {
      settle(() =>
        reject(
          new EventsQueryError(
            "unavailable",
            `could not start the query runner: ${error.message}`,
            {
              cause: error,
            },
          ),
        ),
      );
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (stoppedFor === "time_budget") {
          reject(
            new EventsQueryError(
              "time_budget",
              `the query ran past its ${options.timeBudgetMs} ms time budget and was killed`,
            ),
          );
          return;
        }
        if (stoppedFor === "too_large") {
          reject(
            new EventsQueryError(
              "too_large",
              `the result passed ${EVENTS_SQL_MAX_OUTPUT_BYTES} bytes; lower the row limit`,
            ),
          );
          return;
        }
        let out: {
          ok?: boolean;
          message?: string;
          rows?: EventsQueryRow[];
          truncated?: EventsQueryTruncation;
          elapsedMs?: number;
        };
        try {
          out = JSON.parse(Buffer.concat(stdout).toString("utf8")) as typeof out;
        } catch {
          reject(
            new EventsQueryError(
              "failed",
              `the query runner exited (code ${code ?? "none"}, signal ${signal ?? "none"}) ` +
                `without an answer${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
            ),
          );
          return;
        }
        if (out.ok !== true || !Array.isArray(out.rows)) {
          reject(new EventsQueryError("failed", out.message ?? "the query failed"));
          return;
        }
        const rows = out.rows;
        resolve({
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          rows,
          rowCount: rows.length,
          truncated: out.truncated ?? null,
          elapsedMs: out.elapsedMs ?? 0,
          redactedSessionKeys: 0,
        });
      });
    });
    child.stdin.end(
      JSON.stringify({
        dbPath: options.dbPath,
        sql: options.sql,
        params: options.params ?? null,
        rowCap: options.rowCap,
        timeBudgetMs: options.timeBudgetMs,
      }),
    );
  });
}
