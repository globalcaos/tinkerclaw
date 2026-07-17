/**
 * FORK: Context Anatomy DB — SQLite persistence for timeline anatomy events.
 *
 * Stores per-turn/per-round LLM context anatomy events to
 * `~/.openclaw/data/anatomy-timeline.db` for real-time timeline UI queries
 * and full historical analysis (no pruning — data kept indefinitely).
 *
 * JSON columns (context_sent, memories_injected, etc.) are zlib-compressed
 * before storage to reduce disk usage on highly repetitive data.
 *
 * Wired in: anatomy events are inserted by context-anatomy-collector.ts
 * (or equivalent) after each LLM round completes. Queried by the timeline
 * API route (server-timeline.ts) to serve the Tinker UI round-level view.
 *
 * Pattern follows src/whatsapp-history/db.ts — singleton + WAL mode.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import Database from "better-sqlite3";
import type { ContextAnatomyEvent } from "./context-anatomy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = (() => {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(homeDir, ".openclaw", "data", "anatomy-timeline.db");
})();

// FORK 2026-07-16: test seam. These tests write REAL rows (insertAnatomyEvent has no
// mock), so pointing them at the production DB pollutes it and makes ordering
// assertions flaky (bug-log [eeg-subagent-single-session-gap]). A test sets an
// isolated tmp path via setAnatomyDbPathForTests() → deterministic, no pollution.
// Production never sets the override, so DB_PATH is used verbatim.
let dbPathOverride: string | null = null;
function resolveDbPath(): string {
  return dbPathOverride ?? DB_PATH;
}

// ---------------------------------------------------------------------------
// Compression helpers — zlib for JSON columns
// ---------------------------------------------------------------------------

/** Compress a JSON-serializable value to a Buffer for BLOB storage. */
function compressJson(value: unknown): Buffer {
  return deflateSync(JSON.stringify(value));
}

/**
 * Decompress a column value that may be either:
 * - a Buffer (zlib-compressed BLOB, new rows)
 * - a string (uncompressed TEXT, legacy rows)
 * Returns the parsed JS value, or undefined on failure.
 */
function decompressJson<T>(value: Buffer | string | null): T | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    if (Buffer.isBuffer(value)) {
      return JSON.parse(inflateSync(value).toString("utf-8")) as T;
    }
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/**
 * Open (or return the cached) anatomy SQLite database.
 *
 * Creates the data directory if needed, enables WAL mode + busy_timeout,
 * creates the `anatomy_events` table and indexes, and sets user_version=1.
 */
export function openAnatomyDb(): Database.Database {
  if (db) {
    return db;
  }

  const activePath = resolveDbPath();
  const dir = path.dirname(activePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(activePath);

  // WAL mode allows concurrent reads during writes — essential for live timeline + query overlap
  db.pragma("journal_mode = WAL");
  // Busy timeout prevents SQLITE_BUSY errors when another process briefly holds the write lock
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS anatomy_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      run_id TEXT,
      turn INTEGER NOT NULL,
      round_number INTEGER,
      timestamp_ms INTEGER NOT NULL,
      model TEXT,
      provider TEXT,
      auth_profile_id TEXT,
      duration_ms INTEGER,
      stop_reason TEXT,
      compaction_cycle INTEGER,
      context_sent TEXT,
      context_window TEXT,
      tools_triggered TEXT,
      topics TEXT,
      topic_transition TEXT,
      memories_injected TEXT,
      response_tokens INTEGER,
      response_thinking_tokens INTEGER,
      response_text_tokens INTEGER,
      response_tool_call_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      response_content TEXT,
      user_message TEXT,
      assistant_response TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp_ms ON anatomy_events(timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_session_key ON anatomy_events(session_key);
  `);

  // Mark schema version if this is a brand-new DB (version 0).
  // migrateFromJsonl() will advance version to 2 when done.
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion < 1) {
    db.pragma("user_version = 1");
  }

  migrateFromJsonl(db);

  // Schema v3: add user_message + assistant_response columns to existing DBs
  migrateToV3(db);

  return db;
}

// ---------------------------------------------------------------------------
// One-time JSONL migration
// ---------------------------------------------------------------------------

/**
 * Migrate historical anatomy events from `~/.openclaw/context-anatomy/*.jsonl`
 * into the SQLite DB.
 *
 * Runs exactly once: guarded by `user_version >= 2`. After a successful
 * migration (or when there is nothing to migrate) `user_version` is set to 2.
 * The original JSONL files are left on disk as a backup.
 *
 * @param database - Already-open DB handle (passed from openAnatomyDb to avoid
 *   re-entering the singleton guard).
 */
function migrateFromJsonl(database: Database.Database): void {
  // user_version >= 2 means migration already ran — skip.
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version >= 2) {
    return;
  }

  const anatomyDir = path.join(homedir(), ".openclaw", "context-anatomy");
  if (!fs.existsSync(anatomyDir)) {
    database.pragma("user_version = 2");
    return;
  }

  const files = fs.readdirSync(anatomyDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    database.pragma("user_version = 2");
    return;
  }

  console.log(`[anatomy-db] Migrating ${files.length} JSONL files to SQLite...`);
  let totalEvents = 0;

  // Wrap each file's inserts in a transaction for bulk-insert performance.
  const insertMany = database.transaction((events: ContextAnatomyEvent[]) => {
    for (const event of events) {
      insertAnatomyEvent(event);
    }
  });

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(anatomyDir, file), "utf-8");
      const events: ContextAnatomyEvent[] = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          events.push(JSON.parse(trimmed) as ContextAnatomyEvent);
        } catch {
          // Skip malformed lines — don't abort the whole file.
        }
      }
      if (events.length > 0) {
        insertMany(events);
        totalEvents += events.length;
      }
    } catch (err) {
      console.warn(`[anatomy-db] Failed to migrate ${file}:`, err);
    }
  }

  database.pragma("user_version = 2");
  console.log(`[anatomy-db] Migration complete: ${totalEvents} events from ${files.length} files`);
}

// ---------------------------------------------------------------------------
// Schema v3 migration — add user_message + assistant_response columns
// ---------------------------------------------------------------------------

function migrateToV3(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version >= 3) {
    return;
  }
  // Check if columns already exist (defensive — CREATE TABLE may have them on new DBs)
  const cols = database.prepare("PRAGMA table_info(anatomy_events)").all() as Array<{
    name: string;
  }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("user_message")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN user_message TEXT");
  }
  if (!colNames.has("assistant_response")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN assistant_response TEXT");
  }
  database.pragma("user_version = 3");
  console.log("[anatomy-db] Migrated to v3: added user_message + assistant_response columns");
}

/** Close the database handle and reset singleton state. */
export function closeAnatomyDb(): void {
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
  }
}

/**
 * TEST-ONLY: redirect the DB to an isolated path (closes the current handle and
 * drops the cached insert statement so the next open() uses the new path). Pass
 * null to restore the production path. Never called by production code.
 */
export function setAnatomyDbPathForTests(p: string | null): void {
  closeAnatomyDb();
  dbPathOverride = p;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Insert a new anatomy event row.
 *
 * Uses a cached prepared statement for performance. JSON columns are
 * zlib-compressed before storage.
 */
export function insertAnatomyEvent(event: ContextAnatomyEvent): void {
  const database = openAnatomyDb();

  if (!insertStmt) {
    insertStmt = database.prepare(`
      INSERT INTO anatomy_events (
        session_key, run_id, turn, round_number, timestamp_ms,
        model, provider, auth_profile_id, duration_ms, stop_reason,
        compaction_cycle, context_sent, context_window, tools_triggered,
        topics, topic_transition, memories_injected,
        response_tokens, response_thinking_tokens, response_text_tokens,
        response_tool_call_tokens, cache_read_tokens, cache_creation_tokens,
        response_content, user_message, assistant_response
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `);
  }

  const ext = event as unknown as Record<string, unknown>;
  insertStmt.run(
    event.sessionKey ?? null,
    (ext["runId"] as string) ?? null,
    event.turn,
    event.roundNumber ?? null,
    event.timestampMs,
    event.model ?? null,
    event.provider ?? null,
    event.authProfileId ?? null,
    (ext["durationMs"] as number) ?? null,
    (ext["stopReason"] as string) ?? null,
    event.compactionCycle ?? null,
    event.contextSent ? compressJson(event.contextSent) : null,
    event.contextWindow ? compressJson(event.contextWindow) : null,
    ext["toolsTriggered"] ? compressJson(ext["toolsTriggered"]) : null,
    event.topics ? compressJson(event.topics) : null,
    event.topicTransition ? compressJson(event.topicTransition) : null,
    event.memoriesInjected ? compressJson(event.memoriesInjected) : null,
    event.responseTokens ?? null,
    (ext["responseThinkingTokens"] as number) ?? null,
    (ext["responseTextTokens"] as number) ?? null,
    (ext["responseToolCallTokens"] as number) ?? null,
    (ext["cacheReadTokens"] as number) ?? null,
    (ext["cacheCreationTokens"] as number) ?? null,
    (ext["responseContent"] as string) ?? null,
    event.userMessage ? compressJson(event.userMessage) : null,
    event.assistantResponse ? compressJson(event.assistantResponse) : null,
  );
}

// ---------------------------------------------------------------------------
// Copy (session fork)
// ---------------------------------------------------------------------------

/**
 * Copy every anatomy event row from one session key to another. Used by the
 * `sessions.fork` RPC so a CLONED tab's EEG/anatomy trace forks DURABLY
 * alongside its transcript (the EEG is keyed by session_key, server-side, so a
 * fresh clone key otherwise has zero rows → an empty seismograph).
 *
 * - `session_key` is rewritten to `toKey` (the routing key the EEG reads by).
 * - `run_id` is suffixed with the clone key so a late `updateAnatomyResponse`
 *   on the SOURCE run (which matches on run_id WITHOUT a session_key filter)
 *   can never cross-write a copied row. A NULL run_id stays NULL.
 * - `id` is omitted (AUTOINCREMENT assigns fresh ids).
 * - timestamps + the zlib-compressed BLOB columns are copied verbatim (no
 *   decompress round-trip), so the clone shows the parent's exact timeline.
 *
 * Best-effort: the caller wraps this so an anatomy-copy failure never aborts
 * the transcript fork. Returns the number of rows copied.
 */
export function copyAnatomyEventsToNewKey(fromKey: string, toKey: string): number {
  if (!fromKey || !toKey || fromKey === toKey) {
    return 0;
  }
  const database = openAnatomyDb();
  const runIdSuffix = `#fork:${toKey}`;
  const result = database
    .prepare(
      `
      INSERT INTO anatomy_events (
        session_key, run_id, turn, round_number, timestamp_ms,
        model, provider, auth_profile_id, duration_ms, stop_reason,
        compaction_cycle, context_sent, context_window, tools_triggered,
        topics, topic_transition, memories_injected,
        response_tokens, response_thinking_tokens, response_text_tokens,
        response_tool_call_tokens, cache_read_tokens, cache_creation_tokens,
        response_content, user_message, assistant_response
      )
      SELECT
        ?, (run_id || ?), turn, round_number, timestamp_ms,
        model, provider, auth_profile_id, duration_ms, stop_reason,
        compaction_cycle, context_sent, context_window, tools_triggered,
        topics, topic_transition, memories_injected,
        response_tokens, response_thinking_tokens, response_text_tokens,
        response_tool_call_tokens, cache_read_tokens, cache_creation_tokens,
        response_content, user_message, assistant_response
      FROM anatomy_events
      WHERE session_key = ?
    `,
    )
    .run(toKey, runIdSuffix, fromKey);
  return typeof result.changes === "number" ? result.changes : 0;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update response-side columns for an existing event identified by
 * (run_id, round_number). Falls back to a minimal INSERT if no row exists.
 *
 * Used when response metadata (token counts, stop reason, duration) arrives
 * after the initial context event was already written.
 */
export function updateAnatomyResponse(
  runId: string,
  roundNumber: number,
  data: {
    durationMs?: number;
    stopReason?: string;
    responseTokens?: number;
    responseThinkingTokens?: number;
    responseTextTokens?: number;
    responseToolCallTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    responseContent?: string;
    toolsTriggered?: unknown;
    assistantResponse?: string;
  },
): void {
  const database = openAnatomyDb();

  database
    .prepare(
      `
      UPDATE anatomy_events SET
        duration_ms = COALESCE(?, duration_ms),
        stop_reason = COALESCE(?, stop_reason),
        response_tokens = COALESCE(?, response_tokens),
        response_thinking_tokens = COALESCE(?, response_thinking_tokens),
        response_text_tokens = COALESCE(?, response_text_tokens),
        response_tool_call_tokens = COALESCE(?, response_tool_call_tokens),
        cache_read_tokens = COALESCE(?, cache_read_tokens),
        cache_creation_tokens = COALESCE(?, cache_creation_tokens),
        response_content = COALESCE(?, response_content),
        tools_triggered = COALESCE(?, tools_triggered),
        assistant_response = COALESCE(?, assistant_response)
      WHERE run_id = ? AND round_number = ?
    `,
    )
    .run(
      data.durationMs ?? null,
      data.stopReason ?? null,
      data.responseTokens ?? null,
      data.responseThinkingTokens ?? null,
      data.responseTextTokens ?? null,
      data.responseToolCallTokens ?? null,
      data.cacheReadTokens ?? null,
      data.cacheCreationTokens ?? null,
      data.responseContent ?? null,
      data.toolsTriggered != null ? compressJson(data.toolsTriggered) : null,
      data.assistantResponse ? compressJson(data.assistantResponse) : null,
      runId,
      roundNumber,
    );

  // If no matching row was found, skip — a response-only stub without session key,
  // model, or context breakdown is not useful for the timeline.
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

/** Raw DB row shape. JSON columns may be Buffer (compressed) or string (legacy). */
interface AnatomyRow {
  id: number;
  session_key: string;
  run_id: string | null;
  turn: number;
  round_number: number | null;
  timestamp_ms: number;
  model: string | null;
  provider: string | null;
  auth_profile_id: string | null;
  duration_ms: number | null;
  stop_reason: string | null;
  compaction_cycle: number | null;
  context_sent: Buffer | string | null;
  context_window: Buffer | string | null;
  tools_triggered: Buffer | string | null;
  topics: Buffer | string | null;
  topic_transition: Buffer | string | null;
  memories_injected: Buffer | string | null;
  response_tokens: number | null;
  response_thinking_tokens: number | null;
  response_text_tokens: number | null;
  response_tool_call_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  response_content: string | null;
  user_message: Buffer | string | null;
  assistant_response: Buffer | string | null;
}

/**
 * Convert a raw DB row back to a {@link ContextAnatomyEvent}.
 *
 * Handles both zlib-compressed BLOBs (new rows) and plain-text JSON (legacy
 * rows written before compression was added) transparently via decompressJson.
 *
 * Extended fields (runId, durationMs, etc.) that are not yet on the
 * canonical type are attached via object spread so callers can access them.
 */
export function parseRow(row: AnatomyRow): ContextAnatomyEvent & Record<string, unknown> {
  return {
    // Core ContextAnatomyEvent fields
    turn: row.turn,
    roundNumber: row.round_number ?? undefined,
    compactionCycle: row.compaction_cycle ?? 0,
    timestamp: new Date(row.timestamp_ms).toISOString(),
    timestampMs: row.timestamp_ms,
    model: row.model ?? "",
    provider: row.provider ?? "",
    sessionKey: row.session_key || undefined,
    topics: decompressJson<string[]>(row.topics) ?? [],
    topicTransition: decompressJson<{ from: string[]; to: string[]; changed: boolean }>(
      row.topic_transition,
    ),
    contextSent: decompressJson(row.context_sent) ?? {
      systemPromptChars: 0,
      systemPromptTokens: 0,
      injectedFiles: [],
      injectedFilesTotalChars: 0,
      injectedFilesTotalTokens: 0,
      skillsChars: 0,
      skillsTokens: 0,
      toolSchemasChars: 0,
      toolSchemasTokens: 0,
      conversationHistoryChars: 0,
      conversationHistoryTokens: 0,
      toolResultsChars: 0,
      toolResultsTokens: 0,
      userMessageChars: 0,
      userMessageTokens: 0,
      totalChars: 0,
      totalTokens: 0,
    },
    contextWindow: decompressJson(row.context_window) ?? {
      maxTokens: 0,
      usedTokens: 0,
      utilizationPercent: 0,
    },
    authProfileId: row.auth_profile_id ?? undefined,
    responseTokens: row.response_tokens ?? undefined,
    memoriesInjected: decompressJson(row.memories_injected) ?? { autoRecall: [], searched: [] },
    // Extended fields not yet on the canonical type
    runId: row.run_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    toolsTriggered: decompressJson(row.tools_triggered),
    responseThinkingTokens: row.response_thinking_tokens ?? undefined,
    responseTextTokens: row.response_text_tokens ?? undefined,
    responseToolCallTokens: row.response_tool_call_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheCreationTokens: row.cache_creation_tokens ?? undefined,
    responseContent: decompressJson(row.response_content) ?? undefined,
    userMessage: decompressJson<string>(row.user_message) ?? undefined,
    assistantResponse: decompressJson<string>(row.assistant_response) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Return anatomy events from the last `hours` hours, oldest first.
 * Defaults to 48 hours. Capped to `limit` rows (default 500) to keep
 * response sizes manageable — returns the MOST RECENT rows within the window.
 */
export function queryRecentEvents(
  hours = 48,
  limit = 500,
): Array<ContextAnatomyEvent & Record<string, unknown>> {
  const database = openAnatomyDb();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  // Sub-select the newest `limit` rows in the window, then re-sort ASC for display
  const rows = database
    .prepare(
      `SELECT * FROM (
        SELECT * FROM anatomy_events WHERE timestamp_ms > ?
        ORDER BY timestamp_ms DESC LIMIT ?
      ) ORDER BY timestamp_ms ASC`,
    )
    .all(cutoff, limit) as AnatomyRow[];
  return rows.map(parseRow);
}

/**
 * Return the most recent `limit` anatomy events for a given session key,
 * newest first.
 */
export function querySessionEvents(
  sessionKey: string,
  limit = 50,
): Array<ContextAnatomyEvent & Record<string, unknown>> {
  const database = openAnatomyDb();
  const rows = database
    .prepare(
      `SELECT * FROM anatomy_events WHERE session_key = ? ORDER BY timestamp_ms DESC LIMIT ?`,
    )
    .all(sessionKey, limit) as AnatomyRow[];
  return rows.map(parseRow);
}

/**
 * FORK 2026-07-16 (EEG fan-out visibility): derive the agent ROOT of a session key
 * so its subagents can be found. Subagents are minted FLAT under the agent root —
 * `agent:main:subagent:<uuid>` (bible §5.8L) — REGARDLESS of the spawning tab
 * (`agent:main:main`, `agent:main:tinker:<id>`, `agent:main:dashboard:<uuid>` all
 * share the root). So the root is the first two key segments (`agent:main`), the
 * SAME derivation app.ts chatEventIsSubagentOfView() uses. A key that is itself a
 * subagent, or not an `agent:` session, returns null: no family to expand.
 *
 * NB: the flat key loses WHICH tab spawned each subagent, so a tree query is
 * root-wide. The caller (EEG backfill) time-bounds the result to the viewed
 * session's window so unrelated/stale fan-outs don't bleed onto its paper.
 */
function agentRootForTree(sessionKey: string): string | null {
  if (!sessionKey || sessionKey.includes(":subagent:")) return null;
  if (!sessionKey.startsWith("agent:")) return null;
  const root = sessionKey.split(":").slice(0, 2).join(":");
  return root.includes(":") ? root : null;
}

/**
 * FORK 2026-07-16 (EEG single-session gap fix, see memory
 * reference_eeg_subagents_invisible_single_session): return the viewed session's
 * events PLUS every subagent event under its agent root, oldest first. This is what
 * lets the EEG paint fan-out branches reload-proof — subagent anatomy rows exist in
 * the DB keyed `agent:main:subagent:<uuid>` but the single-session query never found
 * them. No schema migration: the parent linkage is already ENCODED in the flat key.
 *
 * For a non-`:main` session (clone/fork/subagent) there is no family to expand, so it
 * falls back to a plain single-session query.
 */
export function querySessionTree(
  sessionKey: string,
  limit = 500,
): Array<ContextAnatomyEvent & Record<string, unknown>> {
  const root = agentRootForTree(sessionKey);
  if (!root) {
    return querySessionEvents(sessionKey, limit);
  }
  const database = openAnatomyDb();
  const subLike = `${root}:subagent:%`;
  const rows = database
    .prepare(
      `SELECT * FROM (
        SELECT * FROM anatomy_events
        WHERE session_key = ? OR session_key LIKE ?
        ORDER BY timestamp_ms DESC LIMIT ?
      ) ORDER BY timestamp_ms ASC`,
    )
    .all(sessionKey, subLike, limit) as AnatomyRow[];
  return rows.map(parseRow);
}

/**
 * Return `limit` anatomy events older than `beforeMs`, newest first in that window,
 * then re-sorted ASC for display. Used for infinite-scroll pagination.
 */
export function queryEventsBefore(
  beforeMs: number,
  limit = 50,
): Array<ContextAnatomyEvent & Record<string, unknown>> {
  const database = openAnatomyDb();
  const rows = database
    .prepare(
      `SELECT * FROM (
        SELECT * FROM anatomy_events WHERE timestamp_ms < ?
        ORDER BY timestamp_ms DESC LIMIT ?
      ) ORDER BY timestamp_ms ASC`,
    )
    .all(beforeMs, limit) as AnatomyRow[];
  return rows.map(parseRow);
}

// ---------------------------------------------------------------------------
// Global registry — allows extensions to call query functions without
// importing better-sqlite3 (extensions run in the same process but can't
// import bundled gateway internals).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridge for extensions
(globalThis as any).__anatomyDb = {
  queryRecentEvents,
  querySessionEvents,
  querySessionTree,
  queryEventsBefore,
};
