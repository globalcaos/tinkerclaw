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
import { fileURLToPath } from "node:url";
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
// WAL maintenance tuning — FORK 2026-08-28 (gateway event-loop stall hunt)
// ---------------------------------------------------------------------------

/**
 * Steady-state busy timeout for ordinary queries.
 *
 * Named rather than inlined because checkpointAnatomyWal() narrows this window and then has
 * to RESTORE it. The same number written in two places is exactly how the restored value
 * silently drifts away from the real one.
 */
const ANATOMY_BUSY_TIMEOUT_MS = 5000;

/**
 * How often the WAL sidecar is truncated back to zero bytes.
 *
 * Measured 2026-08-28 on the live DB: the `-wal` file had reached 36,552,672 bytes — 9x the
 * ~4 MB that SQLite's default `wal_autocheckpoint` (1000 pages) is meant to hold it at.
 * Autocheckpoint is PASSIVE: it gives up the instant any reader still holds an older
 * snapshot, and this DB always has long-lived readers (the timeline UI polls it). So the
 * automatic checkpoint never wins, the log grows without bound, and every later reader walks
 * a longer WAL index. better-sqlite3 is SYNCHRONOUS — that cost lands ON the gateway event
 * loop. The fix is an EXPLICIT periodic TRUNCATE checkpoint on a timer, so that no
 * user-facing query ever pays for it inline.
 */
const ANATOMY_WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Delay before the FIRST checkpoint after the DB is opened.
 *
 * Not zero: a checkpoint during boot would compete with the migrations below. Not the full
 * interval either — a process that restarts more often than every 30 minutes would then never
 * checkpoint at all, and this fix would read as shipped while doing literally nothing. A
 * short leading pass guarantees at least one checkpoint per process lifetime.
 */
const ANATOMY_WAL_CHECKPOINT_STARTUP_DELAY_MS = 60 * 1000;

/**
 * busy_timeout in force ONLY while a checkpoint runs.
 *
 * `wal_checkpoint(TRUNCATE)` BLOCKS on the busy handler until every reader is on the newest
 * snapshot. Measured 2026-08-28 with a second connection pinning an OLD snapshot (it opened a
 * read transaction, and only then did the writer append frames — a reader already on the
 * newest snapshot does not block a checkpoint at all): at busy_timeout=5000 the checkpoint
 * blocked for 5,026 ms; at 250 it blocked for 251 ms. Five seconds of frozen event loop every
 * 30 minutes is the exact freeze this change exists to remove, so the window is narrowed for
 * the checkpoint and restored immediately after. A checkpoint that loses the race is skipped,
 * not retried harder — the next tick tries again.
 */
const ANATOMY_WAL_CHECKPOINT_BUSY_TIMEOUT_MS = 250;

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
/** Handle for the periodic WAL TRUNCATE checkpoint. Null when no checkpoint is armed. */
let walCheckpointTimer: ReturnType<typeof setTimeout> | null = null;

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
  db.pragma(`busy_timeout = ${ANATOMY_BUSY_TIMEOUT_MS}`);

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
      assistant_response TEXT,
      harness TEXT,
      effort TEXT,
      route TEXT,
      harness_version TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp_ms ON anatomy_events(timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_session_key ON anatomy_events(session_key);

    -- FORK 2026-08-28 (gateway event-loop stall hunt): updateAnatomyResponse() matches on
    -- (run_id, round_number) and NOTHING indexed run_id, so every response update was a full
    -- SCAN of a 44,516-row / 185 MB table. EXPLAIN QUERY PLAN went from "SCAN anatomy_events"
    -- to "SEARCH anatomy_events USING INDEX idx_run_round (run_id=? AND round_number=?)", and
    -- the UPDATE itself from a 67.13 ms median-of-5 to 0.01 ms — measured on a byte copy of
    -- the live DB (185,593,856 B + a 36 MB -wal), never on the live file. better-sqlite3 is
    -- SYNCHRONOUS, so that was 67 ms of BLOCKED gateway event loop on the per-TURN path
    -- (src/fork/attempt-hooks.ts:1103, conditional). Sizing honesty: the per-ROUND caller at
    -- attempt-hooks.ts:792 sits inside emitRoundComplete(), which has ZERO callers — this fix
    -- is NOT justified off that dead path.
    -- Lives in this block rather than in a migrateToVN() on purpose: the block re-executes on
    -- EVERY open and both columns predate v1, so existing DBs pick the index up too. Cost is a
    -- one-off index build on the next open (measured 105 ms on that same copy), plus one extra
    -- b-tree write per INSERT.
    CREATE INDEX IF NOT EXISTS idx_run_round ON anatomy_events(run_id, round_number);
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
  migrateToV4(db);
  migrateToV5(db);

  // FORK 2026-08-28: arm WAL truncation. Deliberately AFTER the migrations — the first tick is
  // a minute out, so a partially-migrated DB is never checkpointed.
  startWalCheckpoints();

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

// ---------------------------------------------------------------------------
// Vendor / route canonicalisation
// ---------------------------------------------------------------------------

/**
 * THE CONFIGURED PROVIDER IDS ARE NOT ALL VENDORS, and this is the single place that says so.
 *
 * `openclaw.json` lists `models.providers` as ollama, claude-code, xai, openrouter. Two of the ids
 * this system records are not vendors at all — they are CLIs used as a backend route:
 *
 *   claude-code  serves claude-opus-5 / sonnet / fable   -> vendor ANTHROPIC, via the Claude Code CLI
 *   codex        serves gpt-5.6-sol / terra / luna       -> vendor OPENAI,    via the Codex CLI
 *
 * A provider is who bills you and owns the model: anthropic, openai, openrouter, github-copilot,
 * xai, google, ollama. A ROUTE is how the bytes get there: the vendor's API, or a CLI driven as a
 * subprocess. Recording a route in the provider column made "which vendor served this turn?"
 * unanswerable without knowing the trivia above.
 *
 * WHY THE CONFIG KEY IS NOT RENAMED HERE. `claude-code` and `anthropic` are BOTH live provider
 * surfaces serving the SAME models by different paths — extensions/anthropic (direct API) and the
 * claude-code entry (the CLI, on a flat-rate subscription). Renaming the config key to `anthropic`
 * would collide with the existing one and erase the ability to express "use the CLI route", which
 * is the whole point of the cc-bridge. The config id stays; this function is where the id becomes
 * an honest (vendor, route) pair, and it is the only place that mapping is written down.
 */
export function resolveVendorAndRoute(providerId: string | null | undefined): {
  provider: string | null;
  route: string | null;
} {
  if (!providerId) {
    return { provider: null, route: null };
  }
  switch (providerId) {
    case "claude-code":
      return { provider: "anthropic", route: "claude-code" };
    case "codex":
      return { provider: "openai", route: "codex" };
    default:
      // Everything else already names a vendor; it reaches the vendor over its own API.
      return { provider: providerId, route: "api" };
  }
}

/**
 * Which build of this fork is running, for the `harness_version` column.
 *
 * Read from dist/build-info.json — the same artefact the deploy script verifies and the only thing
 * on disk that describes the RUNNING code. Deliberately NOT `git rev-parse HEAD`: the version
 * banner in this repo already made that mistake and prints the working tree's HEAD rather than the
 * build's, so a turn taken on a stale dist would be stamped with a commit it never ran. Cached —
 * the build cannot change under a running process without a restart.
 */
let cachedHarnessVersion: string | null | undefined;
export function resolveHarnessVersion(): string | null {
  if (cachedHarnessVersion !== undefined) {
    return cachedHarnessVersion;
  }
  cachedHarnessVersion = null;
  // Resolved from THIS MODULE'S OWN LOCATION, walking up to the build root — never process.cwd().
  // The first version used cwd and produced NULL on every row: the gateway does not run from the
  // repo root, so cwd/dist/build-info.json did not exist. The compiled module lives inside the
  // build, so its own path is the only thing that reliably knows WHICH BUILD it belongs to.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, "build-info.json"), "utf-8")) as {
        commit?: string;
        version?: string;
      };
      const sha = typeof info.commit === "string" ? info.commit.slice(0, 11) : null;
      if (sha || info.version) {
        cachedHarnessVersion =
          info.version && sha ? `${info.version}+${sha}` : (sha ?? info.version ?? null);
        break;
      }
    } catch {
      // keep walking upward
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return cachedHarnessVersion;
}

// ---------------------------------------------------------------------------
// Schema v4 migration — add `harness`
// ---------------------------------------------------------------------------

/**
 * WHICH HARNESS RAN THE TURN — distinct from which provider served the model.
 *
 * The table already records `provider` and `model`, and on this deployment the newest rows read
 * `provider=claude-code, model=claude-opus-5`. That names the BACKEND, not the runner: OpenClaw
 * driving the Claude Code CLI as a model provider produces exactly the same two values as a turn
 * taken inside Claude Code itself. Forensically the two are very different events — different
 * tools, different context assembly, different failure modes — and until now the table could not
 * tell them apart.
 *
 * `harness` closes that. Values are the RUNNER:
 *   'tinkerclaw'  — this fork's gateway took the turn
 *   'claude-code' — a Claude Code session took this turn
 * Left free-form TEXT rather than a CHECK constraint so a future runner can be recorded without a
 * migration; the cost of a typo is a stray value, the cost of a constraint is a blocked writer.
 *
 * Existing rows are BACKFILLED to 'tinkerclaw', which is correct: every row written before this
 * migration came from the gateway, because it is the only thing that has ever written here.
 * Backfilling rather than leaving NULL matters — a NULL would be indistinguishable from "a writer
 * that forgot the field", and this session has spent a day on signals that cannot tell absence
 * from failure.
 */
function migrateToV4(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version >= 4) {
    return;
  }
  const cols = database.prepare("PRAGMA table_info(anatomy_events)").all() as Array<{
    name: string;
  }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("harness")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN harness TEXT");
  }
  // `effort` rides along in the same migration. The table records model and provider but never
  // the reasoning effort the turn was run at, even though it is a first-class routing decision
  // here (there is an effort-router in the algorithm ledger) and Claude Code stamps it on every
  // assistant record. Comparing two turns without it means comparing two different experiments.
  // Deliberately NOT backfilled: nothing on disk records the effort of a past turn, and inventing
  // a default would fabricate an experimental condition. NULL here honestly means "not recorded".
  if (!colNames.has("effort")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN effort TEXT");
  }
  // Every pre-existing row is a tinkerclaw gateway turn — the gateway was the only writer until now.
  const backfilled = database
    .prepare("UPDATE anatomy_events SET harness = 'tinkerclaw' WHERE harness IS NULL")
    .run().changes;
  database.exec("CREATE INDEX IF NOT EXISTS idx_harness ON anatomy_events(harness)");
  database.pragma("user_version = 4");
  console.log(
    `[anatomy-db] Migrated to v4: added harness + effort columns (harness backfilled on ${backfilled} rows; effort left NULL — unrecorded is not zero)`,
  );
}

// ---------------------------------------------------------------------------
// Schema v5 migration — add `route` + `harness_version`, and normalise the vendor column
// ---------------------------------------------------------------------------

/**
 * Splits WHO SERVED THE MODEL from HOW THE BYTES GOT THERE, and records which build ran the turn.
 *
 * Until v5 the provider column held a mix of vendors (anthropic, openai, xai, openrouter, google,
 * github-copilot, ollama) and CLI routes (claude-code, codex). Measured before this migration:
 * 2,934 rows said provider='claude-code' while every model on them was an Anthropic model, and 189
 * said provider='codex' while every model was an OpenAI gpt-5.6. Those rows are corrected in place
 * to their real vendor with the route preserved, so nothing is lost — the CLI path is still
 * queryable, it is simply no longer masquerading as the vendor.
 *
 * Everything else is backfilled route='api': it reaches its vendor over that vendor's own API.
 *
 * `harness_version` is left NULL for history. Nothing on disk records which build served a turn
 * from six weeks ago, and stamping today's commit onto old rows would be inventing provenance —
 * the same reason `effort` was not backfilled in v4.
 */
function migrateToV5(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version >= 5) {
    return;
  }
  const cols = new Set(
    (database.prepare("PRAGMA table_info(anatomy_events)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("route")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN route TEXT");
  }
  if (!cols.has("harness_version")) {
    database.exec("ALTER TABLE anatomy_events ADD COLUMN harness_version TEXT");
  }

  // The two ids that named a CLI rather than a vendor. Corrected in place, route preserved.
  const cc = database
    .prepare(
      "UPDATE anatomy_events SET provider='anthropic', route='claude-code' WHERE provider='claude-code'",
    )
    .run().changes;
  const cx = database
    .prepare("UPDATE anatomy_events SET provider='openai', route='codex' WHERE provider='codex'")
    .run().changes;
  // Everything else already named a vendor and reached it over that vendor's API — EXCEPT rows
  // whose harness already implies a route. A Claude Code turn reaches Anthropic through the CC CLI,
  // never through the API, so a blanket "route IS NULL -> api" mislabels every one of them. The
  // first version of this migration did exactly that to 5,360 already-projected rows: the filter
  // asked "is route unknown?" when the question is "is the route KNOWABLE from something else?".
  const api = database
    .prepare(
      `UPDATE anatomy_events SET route='api'
        WHERE route IS NULL AND provider IS NOT NULL
          AND (harness IS NULL OR harness NOT IN ('claude-code'))`,
    )
    .run().changes;
  // And give those rows the route their harness already determines.
  const implied = database
    .prepare(
      "UPDATE anatomy_events SET route='claude-code' WHERE route IS NULL AND harness='claude-code'",
    )
    .run().changes;

  database.exec("CREATE INDEX IF NOT EXISTS idx_route ON anatomy_events(route)");
  database.pragma("user_version = 5");
  console.log(
    `[anatomy-db] Migrated to v5: added route + harness_version ` +
      `(normalised ${cc} claude-code -> anthropic, ${cx} codex -> openai, ${api} marked route=api, ${implied} implied by harness; ` +
      `harness_version left NULL for history — unrecorded is not guessable)`,
  );
}

// ---------------------------------------------------------------------------
// WAL maintenance — periodic TRUNCATE checkpoint (FORK 2026-08-28)
// ---------------------------------------------------------------------------

/** Outcome of one TRUNCATE checkpoint. `truncated` is the only claim of success. */
export type AnatomyWalCheckpointResult = {
  /** SQLite reported busy=0 — frames copied AND the log actually reset to zero bytes. */
  truncated: boolean;
  /** WAL frames present when the checkpoint ran (0 once the log has really been reset). */
  log: number;
  /** Frames copied into the main DB. Can be non-zero even when `truncated` is false. */
  checkpointed: number;
};

/**
 * Run one `wal_checkpoint(TRUNCATE)` against the open handle. NEVER THROWS.
 *
 * Two measurements from 2026-08-28 shape this function, and both are counter-intuitive:
 *
 * 1. A STARVED CHECKPOINT DOES NOT THROW. With a second connection pinning an older snapshot,
 *    `PRAGMA wal_checkpoint(TRUNCATE)` returned `{busy:1, log:506, checkpointed:254}` and
 *    raised nothing, and the `-wal` file did not shrink by a byte. So a
 *    `try { exec(...) } catch {}` implementation reports SUCCESS on the exact failure this fix
 *    targets — the WAL is not truncated and the caller is told it was. The `busy` column is
 *    the only honest evidence, so it is read and returned rather than inferred from the
 *    absence of an exception. (This is also why the shared `src/infra/sqlite-wal.ts` helper is
 *    not reused here: its `checkpoint()` returns true whenever `db.exec` did not throw, and it
 *    is typed for `node:sqlite` `DatabaseSync`, not better-sqlite3.)
 * 2. IT BLOCKS FOR THE FULL busy_timeout. Same experiment: 5,026 ms at busy_timeout=5000,
 *    251 ms at 250. Hence the narrowed window, restored in `finally` so that neither an early
 *    return nor a throw can leave ordinary queries stuck on the 250 ms timeout.
 *
 * It CAN also throw, which is why the outer catch is not decorative: a read transaction left
 * open on THIS connection makes the same pragma raise "database table is locked" outright.
 *
 * Note `checkpointed` is often non-zero while `busy` is 1 (254 of 506 frames in the run above):
 * those frames DID reach the main DB and only the log reset lost the race. Partial progress is
 * normal, not a failure. On success SQLite reports all three columns as 0 — `log:0` means the
 * log really was reset, which is why `truncated` keys off `busy` rather than off `log`.
 */
export function checkpointAnatomyWal(): AnatomyWalCheckpointResult {
  const database = db;
  // `open` is false after close(), and pragma() on a closed handle THROWS ("The database
  // connection is not open"). A timer can outlive closeAnatomyDb() by one tick.
  if (!database?.open) {
    return { truncated: false, log: 0, checkpointed: 0 };
  }
  try {
    database.pragma(`busy_timeout = ${ANATOMY_WAL_CHECKPOINT_BUSY_TIMEOUT_MS}`);
    try {
      const rows = database.pragma("wal_checkpoint(TRUNCATE)") as
        | Array<{ busy?: number; log?: number; checkpointed?: number }>
        | undefined;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) {
        return { truncated: false, log: 0, checkpointed: 0 };
      }
      return {
        // Default 1 (= busy) when the column is missing: unknown must never read as success.
        truncated: Number(row.busy ?? 1) === 0,
        log: Number(row.log ?? 0),
        checkpointed: Number(row.checkpointed ?? 0),
      };
    } finally {
      database.pragma(`busy_timeout = ${ANATOMY_BUSY_TIMEOUT_MS}`);
    }
  } catch {
    // A handle closed underneath us, or a genuine throw. Skipping is correct: the WAL stays
    // large for one more interval, which is strictly better than throwing out of a timer
    // callback and taking the gateway with it.
    return { truncated: false, log: 0, checkpointed: 0 };
  }
}

/** Arm the next checkpoint. Self-rescheduling, so there is exactly one live handle. */
function scheduleWalCheckpoint(delayMs: number): void {
  const timer = setTimeout(() => {
    walCheckpointTimer = null;
    const result = checkpointAnatomyWal();
    if (!result.truncated && result.log > 0) {
      // At most one line per interval, and only when there is a real problem. A WAL that
      // cannot be reset is how the 36 MB sidecar happened, and it is invisible without this.
      console.warn(
        `[anatomy-db] WAL checkpoint starved by a long-lived reader ` +
          `(${result.log} frames still in the log, ${result.checkpointed} copied) — retrying in ` +
          `${Math.round(ANATOMY_WAL_CHECKPOINT_INTERVAL_MS / 60000)} min`,
      );
    }
    // Re-arm only while a handle is open, so closeAnatomyDb() ends the chain for good.
    if (db?.open) {
      scheduleWalCheckpoint(ANATOMY_WAL_CHECKPOINT_INTERVAL_MS);
    }
  }, delayMs);
  // A maintenance tick must never be the reason the process refuses to exit.
  if (timer.unref) {
    timer.unref();
  }
  walCheckpointTimer = timer;
}

/** Start periodic WAL truncation. Idempotent — a second call while armed is a no-op. */
function startWalCheckpoints(): void {
  if (walCheckpointTimer) {
    return;
  }
  scheduleWalCheckpoint(ANATOMY_WAL_CHECKPOINT_STARTUP_DELAY_MS);
}

/** Cancel any armed checkpoint. Safe to call when none is armed. */
function stopWalCheckpoints(): void {
  if (walCheckpointTimer) {
    clearTimeout(walCheckpointTimer);
    walCheckpointTimer = null;
  }
}

/** Close the database handle and reset singleton state. */
export function closeAnatomyDb(): void {
  // Stop the timer FIRST: a tick landing between close() and the null assignment would hit a
  // closed handle. checkpointAnatomyWal() survives that, but not arming it is cheaper.
  stopWalCheckpoints();
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
        response_content, user_message, assistant_response, harness, effort, route, harness_version
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
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
    resolveVendorAndRoute(event.provider).provider,
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
    // WHICH HARNESS RAN THE TURN — see migrateToV4. Every caller of this function is the gateway,
    // so 'tinkerclaw' is the honest default rather than a guess; the override exists so a future
    // in-process runner can identify itself without a schema change. Claude Code turns do NOT come
    // through here — they are ingested by the memory-bridge archiver, which writes 'claude-code'.
    (ext["harness"] as string) ?? "tinkerclaw",
    (ext["effort"] as string) ?? null,
    resolveVendorAndRoute(event.provider).route,
    (ext["harnessVersion"] as string) ?? resolveHarnessVersion(),
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
        response_content, user_message, assistant_response, harness, effort, route, harness_version
      )
      SELECT
        ?, (run_id || ?), turn, round_number, timestamp_ms,
        model, provider, auth_profile_id, duration_ms, stop_reason,
        compaction_cycle, context_sent, context_window, tools_triggered,
        topics, topic_transition, memories_injected,
        response_tokens, response_thinking_tokens, response_text_tokens,
        response_tool_call_tokens, cache_read_tokens, cache_creation_tokens,
        -- harness is COPIED, not re-defaulted: a fork of a claude-code turn is still a record of
        -- a claude-code turn. Re-stamping it 'tinkerclaw' here would launder provenance through a
        -- session fork, which is precisely the kind of quiet rewrite this column exists to prevent.
        response_content, user_message, assistant_response, harness, effort, route, harness_version
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
      // FORK 2026-07-28: `id DESC` is a REQUIRED tie-breaker, not a nicety. Several events in
      // one turn can share a timestamp_ms (a tool loop emits per round; tests spread one event
      // object across many turns), and with only `timestamp_ms DESC` SQLite may return tied rows
      // in ANY order — in practice rowid-ascending, i.e. OLDEST first, the exact opposite of the
      // documented "newest-first" contract. `id` is the autoincrement insertion order, so this
      // makes "newest" deterministic instead of a property of the query planner.
      `SELECT * FROM anatomy_events WHERE session_key = ? ORDER BY timestamp_ms DESC, id DESC LIMIT ?`,
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
