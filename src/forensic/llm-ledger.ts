/**
 * LLM ledger — an append-only record of every model call: the full request sent, the full
 * response received, and the DRIVER (the human, cron or channel sender behind the call).
 *
 * On by default. One SQLite file at `<state>/forensic/llm-ledger.sqlite`; request and response
 * bodies are gzipped JSON. It lives outside `agents/<id>/sessions/`, so session maintenance
 * (default: enforce, 30 days, 500 entries) never prunes it. Nothing here ever deletes a row.
 *
 * Env:
 *   OPENCLAW_LLM_LEDGER=0|off|false        disable
 *   OPENCLAW_LLM_LEDGER_PATH=<file>        override the database path
 *   OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER=id  driver for calls no seat/cron/channel explains
 *
 * Recording must never break a model call: every write is deferred and every failure is
 * swallowed after one warning.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { STATE_DIR } from "../config/paths.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { loadOperators, lookupOperator } from "../shared/hivemind-seats.js";
import { safeJsonStringify } from "../utils/safe-json.js";

export type LedgerDriver = { id: string; source: string };

export type LedgerCallMeta = {
  source: "agent" | "completion" | string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  spawnedBy?: string | null;
  trigger?: string;
  provider?: string;
  model?: string;
  api?: string;
};

export type LedgerRow = LedgerCallMeta & {
  callId: string;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  outcome: "ok" | "error" | "aborted";
  stopReason?: string | null;
  error?: string | null;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  request: unknown;
  response: unknown;
  driver?: LedgerDriver;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  source TEXT NOT NULL,
  run_id TEXT,
  session_key TEXT,
  session_id TEXT,
  agent_id TEXT,
  spawned_by TEXT,
  trigger TEXT,
  origin_kind TEXT,
  provider TEXT,
  model TEXT,
  api TEXT,
  driver TEXT NOT NULL,
  driver_source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  stop_reason TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  request_gz BLOB,
  response_gz BLOB
);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at);
CREATE INDEX IF NOT EXISTS calls_driver ON calls(driver, started_at);
CREATE INDEX IF NOT EXISTS calls_session ON calls(session_key, started_at);
CREATE INDEX IF NOT EXISTS calls_model ON calls(model, started_at);
`;

export function isLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENCLAW_LLM_LEDGER?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

export function resolveLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.OPENCLAW_LLM_LEDGER_PATH?.trim() || path.join(STATE_DIR, "forensic", "llm-ledger.sqlite")
  );
}

export function openLedger(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  return db;
}

let shared: { file: string; db: DatabaseSync } | null = null;
let warned = false;

function sharedLedger(): DatabaseSync | null {
  const file = resolveLedgerPath();
  if (shared?.file === file) return shared.db;
  try {
    shared?.db.close();
    shared = { file, db: openLedger(file) };
    return shared.db;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[llm-ledger] recording disabled for this process after an error: ${String(err)}`);
}

/** Test hook: forget the cached handle so a new OPENCLAW_LLM_LEDGER_PATH takes effect. */
export function resetLedgerForTest(): void {
  shared?.db.close();
  shared = null;
  warned = false;
  sessionDrivers.clear();
}

// ─── Drivers ────────────────────────────────────────────────────────────────

const sessionDrivers = new Map<string, LedgerDriver>();

/** Called when a human (seat) or a client sends a message into a session. */
export function noteSessionDriver(
  sessionKey: string | undefined,
  driver: LedgerDriver | null,
): void {
  if (!sessionKey || !driver?.id) return;
  sessionDrivers.set(sessionKey, driver);
}

/**
 * The driver behind a gateway client's message: its seat's operator → the configured default →
 * the client's own id. A seat with no operator record still names the seat.
 */
export function driverForGatewayClient(
  client: { seatId?: string; connect?: { client?: { id?: string } } } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): LedgerDriver {
  if (client?.seatId) {
    const op = lookupOperator(loadOperators(home), client.seatId);
    return { id: op?.operatorId ?? client.seatId, source: "seat" };
  }
  const fallback = env.OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER?.trim();
  if (fallback) return { id: fallback, source: "default" };
  return { id: `client:${client?.connect?.client?.id ?? "internal"}`, source: "client" };
}

/** What kind of thing started a session, from its key (`agent:<id>:<kind>:…`). */
export function originKindForSessionKey(sessionKey: string | undefined): string {
  if (!sessionKey) return "unknown";
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts.length > 2 ? parts[2] : parts[0] || "unknown";
}

const CHANNEL_KINDS = new Set([
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "msteams",
  "feishu",
  "sms",
  "email",
]);

function lastLedgerDriver(db: DatabaseSync | null, sessionKey: string): LedgerDriver | null {
  if (!db) return null;
  try {
    const row = db
      .prepare(
        "SELECT driver, driver_source FROM calls WHERE session_key = ? AND driver_source IN ('seat','client','default') ORDER BY id DESC LIMIT 1",
      )
      .get(sessionKey) as { driver?: string; driver_source?: string } | undefined;
    return row?.driver ? { id: row.driver, source: `${row.driver_source}:carried` } : null;
  } catch {
    return null;
  }
}

/**
 * Resolution order: the session's last human sender → the parent that spawned it → what the
 * session key proves (cron, channel peer) → the env default → "unknown".
 */
export function resolveDriver(
  meta: Pick<LedgerCallMeta, "sessionKey" | "spawnedBy">,
  db: DatabaseSync | null = null,
  env: NodeJS.ProcessEnv = process.env,
  depth = 0,
): LedgerDriver {
  const key = meta.sessionKey;
  if (key) {
    const noted = sessionDrivers.get(key) ?? lastLedgerDriver(db, key);
    if (noted) return noted;
  }
  if (meta.spawnedBy && depth < 8) {
    const parent = resolveDriver({ sessionKey: meta.spawnedBy }, db, env, depth + 1);
    if (parent.source !== "unknown") return { id: parent.id, source: `inherited:${parent.source}` };
  }
  const kind = originKindForSessionKey(key);
  const parts = key?.split(":") ?? [];
  if (kind === "cron") return { id: `cron:${parts[3] ?? "?"}`, source: "cron" };
  if (CHANNEL_KINDS.has(kind)) {
    return { id: `${kind}:${parts.slice(3).join(":") || "?"}`, source: "channel" };
  }
  const fallback = env.OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER?.trim();
  if (fallback) return { id: fallback, source: "default" };
  return { id: "unknown", source: "unknown" };
}

// ─── Writing ────────────────────────────────────────────────────────────────

function gz(value: unknown): { blob: Uint8Array | null; bytes: number } {
  if (value === undefined || value === null) return { blob: null, bytes: 0 };
  const json = typeof value === "string" ? value : (safeJsonStringify(value) ?? "null");
  const buf = Buffer.from(json, "utf8");
  return { blob: gzipSync(buf), bytes: buf.length };
}

export function decodeLedgerBlob(blob: Uint8Array | null | undefined): unknown {
  if (!blob) return null;
  return JSON.parse(gunzipSync(blob).toString("utf8"));
}

/** Synchronous insert. Duplicate call_ids are ignored, so a backfill can be re-run safely. */
export function insertLedgerRow(db: DatabaseSync, row: LedgerRow): void {
  const driver = row.driver ?? resolveDriver(row, db);
  const req = gz(row.request);
  const res = gz(row.response);
  db.prepare(
    `INSERT OR IGNORE INTO calls (call_id, started_at, ended_at, duration_ms, source, run_id, session_key,
       session_id, agent_id, spawned_by, trigger, origin_kind, provider, model, api, driver, driver_source,
       outcome, stop_reason, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       request_bytes, response_bytes, request_gz, response_gz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.callId,
    row.startedAt,
    row.endedAt ?? null,
    row.durationMs ?? null,
    row.source,
    row.runId ?? null,
    row.sessionKey ?? null,
    row.sessionId ?? null,
    row.agentId ?? null,
    row.spawnedBy ?? null,
    row.trigger ?? null,
    originKindForSessionKey(row.sessionKey),
    row.provider ?? null,
    row.model ?? null,
    row.api ?? null,
    driver.id,
    driver.source,
    row.outcome,
    row.stopReason ?? null,
    row.error ?? null,
    row.usage?.input ?? null,
    row.usage?.output ?? null,
    row.usage?.cacheRead ?? null,
    row.usage?.cacheWrite ?? null,
    req.bytes,
    res.bytes,
    req.blob,
    res.blob,
  );
}

let callSeq = 0;

function recordDeferred(row: Omit<LedgerRow, "callId" | "driver">): void {
  if (!isLedgerEnabled()) return;
  // Resolve the driver NOW: the session's sender may change before the deferred write runs.
  const driver = resolveDriver(row, null);
  const callId = `${row.runId ?? "norun"}:${Date.now().toString(36)}:${process.pid}:${(callSeq += 1)}`;
  setImmediate(() => {
    const db = sharedLedger();
    if (!db) return;
    try {
      const resolved = driver.source === "unknown" ? resolveDriver(row, db) : driver;
      insertLedgerRow(db, { ...row, callId, driver: resolved });
    } catch (err) {
      warnOnce(err);
    }
  });
}

type AssistantLike = {
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

function requestOf(context: unknown): unknown {
  const c = (context ?? {}) as { systemPrompt?: unknown; messages?: unknown; tools?: unknown };
  return { systemPrompt: c.systemPrompt ?? null, messages: c.messages ?? [], tools: c.tools ?? [] };
}

/** Record one finished call (used directly by one-shot completion paths). */
export function recordLedgerCall(
  meta: LedgerCallMeta,
  context: unknown,
  startedAtMs: number,
  outcome: { response?: unknown; error?: unknown },
): void {
  try {
    const msg = (outcome.response ?? null) as AssistantLike | null;
    const stop = msg?.stopReason ?? null;
    const failed = outcome.error !== undefined || stop === "error";
    recordDeferred({
      ...meta,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      outcome: stop === "aborted" ? "aborted" : failed ? "error" : "ok",
      stopReason: stop,
      error: outcome.error !== undefined ? String(outcome.error) : (msg?.errorMessage ?? null),
      usage: msg?.usage ?? null,
      request: requestOf(context),
      response: outcome.response ?? null,
    });
  } catch (err) {
    warnOnce(err);
  }
}

/** Wrap an agent streamFn so every call it makes lands in the ledger. */
export function wrapStreamFnWithLedger(streamFn: StreamFn, meta: LedgerCallMeta): StreamFn {
  if (!isLedgerEnabled()) return streamFn;
  return ((model, context, options) => {
    const startedAt = Date.now();
    const callMeta: LedgerCallMeta = {
      ...meta,
      provider: (model as { provider?: string }).provider ?? meta.provider,
      model: (model as { id?: string }).id ?? meta.model,
      api: (model as { api?: string }).api ?? meta.api,
    };
    const observe = (stream: unknown) => {
      const result = (stream as { result?: () => Promise<unknown> })?.result;
      if (typeof result !== "function") {
        recordLedgerCall(callMeta, context, startedAt, { error: "stream exposes no result()" });
        return stream;
      }
      result.call(stream).then(
        (response) => recordLedgerCall(callMeta, context, startedAt, { response }),
        (error) => recordLedgerCall(callMeta, context, startedAt, { error }),
      );
      return stream;
    };
    try {
      const out = streamFn(model, context, options);
      if (out && typeof (out as PromiseLike<unknown>).then === "function") {
        return (out as Promise<unknown>).then(observe, (error) => {
          recordLedgerCall(callMeta, context, startedAt, { error });
          throw error;
        });
      }
      return observe(out);
    } catch (error) {
      recordLedgerCall(callMeta, context, startedAt, { error });
      throw error;
    }
  }) as StreamFn;
}

/** Record a one-shot `await complete(...)`-style call without changing its result or error. */
export async function withLedgerCompletion<T>(
  meta: LedgerCallMeta,
  context: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const response = await run();
    recordLedgerCall(meta, context, startedAt, { response });
    return response;
  } catch (error) {
    recordLedgerCall(meta, context, startedAt, { error });
    throw error;
  }
}

/** A recorded twin of any `(model, context, options) => Promise<message>` completion function. */
export function ledgeredCompletion<
  M extends { provider?: string; id?: string; api?: string },
  C,
  O,
  R,
>(source: string, fn: (model: M, context: C, options?: O) => Promise<R>) {
  return (model: M, context: C, options?: O): Promise<R> =>
    withLedgerCompletion(
      { source, provider: model.provider, model: model.id, api: model.api },
      context,
      () => fn(model, context, options),
    );
}
