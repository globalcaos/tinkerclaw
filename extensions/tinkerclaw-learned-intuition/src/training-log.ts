/**
 * FORK: SQLite training logger for AMYGDALA.
 *
 * Uses better-sqlite3 (synchronous but fast, no event-loop blocking
 * for brief single-row writes). WAL mode allows concurrent Python
 * training process to read without blocking Node writes.
 *
 * All exposed methods are async (for API consistency).
 * Gracefully handles missing better-sqlite3 (logs warning, no-ops).
 */

import type { PrudenceEnsembleOutput, PersonalityEnsembleOutput } from "./types.js";
import type { SituationTemplate } from "./types.js";

// -- Config --

export interface TrainingLogConfig {
  /** Path to SQLite database file */
  db_path: string;
  /** Maximum entries before rotation (future use) */
  max_entries: number;
  /** Rolling window in days for data retention */
  rolling_window_days: number;
}

// -- Entry types --

export interface EvaluationLogEntry {
  situation: SituationTemplate;
  serialized: string;
  embedding: Float32Array;
  prudence_output: PrudenceEnsembleOutput | null;
  personality_output: PersonalityEnsembleOutput | null;
  gate_decision: string;
  timestamp: string;
  latency_ms: number;
  outcome: string | null;
  alpha_prudence: number;
  alpha_personality: number;
  phase: number;
  /** v3.1: novelty score (1 − top-k cosine to history); null when disabled. */
  novelty?: number | null;
  /** v3.1: action disposition (proceed | ask | block). */
  disposition?: string | null;
  /** v3.1: salience channel that drove the decision (aegis | novelty | none). */
  signal?: string | null;
}

// -- TrainingLog --

export class TrainingLog {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private insertStmt: any = null;
  private config: TrainingLogConfig;
  private _available = false;

  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_DELAY_MS = 100;

  constructor(config: TrainingLogConfig) {
    this.config = config;
  }

  /** Whether the training log is available (better-sqlite3 loaded + DB open) */
  get available(): boolean {
    return this._available;
  }

  /**
   * Open the database, set pragmas, and create tables if they don't exist.
   * Safe to call multiple times (idempotent).
   * Gracefully handles missing better-sqlite3.
   */
  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      const Database = (await import("better-sqlite3")).default;
      this.db = new Database(this.config.db_path);
    } catch {
      // better-sqlite3 not available -- training log disabled
      return;
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("wal_autocheckpoint = 1000");

    this.createTables();
    this.migrate();

    this.insertStmt = this.db.prepare(`
      INSERT INTO amygdala_evaluations (
        timestamp, situation_json, serialized, embedding,
        gate_decision, prudence_combined, prudence_per_arch,
        prediction_set, ensemble_disagreement, personality_combined,
        outcome, latency_ms, alpha_prudence, alpha_personality, phase,
        novelty, disposition, signal
      ) VALUES (
        @timestamp, @situation_json, @serialized, @embedding,
        @gate_decision, @prudence_combined, @prudence_per_arch,
        @prediction_set, @ensemble_disagreement, @personality_combined,
        @outcome, @latency_ms, @alpha_prudence, @alpha_personality, @phase,
        @novelty, @disposition, @signal
      )
    `);

    this._available = true;
  }

  /**
   * Append an evaluation record.
   * Returns the inserted row ID (for later outcome recording).
   * Returns -1 if DB not available.
   */
  async append(entry: EvaluationLogEntry): Promise<number> {
    if (!this._available || !this.db || !this.insertStmt) {
      return -1;
    }

    const row = {
      timestamp: entry.timestamp,
      situation_json: JSON.stringify(entry.situation),
      serialized: entry.serialized,
      embedding: Buffer.from(entry.embedding.buffer),
      gate_decision: entry.gate_decision,
      // v3.1: ensemble columns are now nullable — store NULL (not "{}") when the
      // legacy ensemble did not run, so the data honestly reflects what was used.
      prudence_combined: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.combined)
        : null,
      prudence_per_arch: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.per_architecture)
        : null,
      prediction_set: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.prediction_set)
        : null,
      ensemble_disagreement: entry.prudence_output?.ensemble_disagreement ?? null,
      personality_combined: entry.personality_output
        ? Buffer.from(entry.personality_output.combined_embedding.buffer)
        : null,
      outcome: entry.outcome,
      latency_ms: entry.latency_ms,
      alpha_prudence: entry.alpha_prudence,
      alpha_personality: entry.alpha_personality,
      phase: entry.phase,
      novelty: entry.novelty ?? null,
      disposition: entry.disposition ?? null,
      signal: entry.signal ?? null,
    };

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        const info = this.insertStmt.run(row);
        return info.lastInsertRowid as number;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === "SQLITE_BUSY" && attempt < TrainingLog.MAX_RETRIES) {
          const delay = TrainingLog.BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error("TrainingLog.append: exhausted retries on SQLITE_BUSY");
  }

  /**
   * Update the outcome for a previously logged evaluation.
   */
  async updateOutcome(
    evaluationId: number,
    outcome: string,
    source: string,
    weight = 1.0,
  ): Promise<void> {
    if (!this._available || !this.db) {
      return;
    }

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        this.db
          .prepare(`
          UPDATE amygdala_evaluations
          SET outcome = ?,
              outcome_source = ?,
              outcome_timestamp = datetime('now'),
              outcome_weight = ?
          WHERE id = ?
        `)
          .run(outcome, source, weight, evaluationId);
        return;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === "SQLITE_BUSY" && attempt < TrainingLog.MAX_RETRIES) {
          await sleep(TrainingLog.BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Log a human override of a blocked action.
   */
  async logOverride(evaluationId: number, reason: string): Promise<void> {
    if (!this._available || !this.db) {
      return;
    }

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        this.db
          .prepare(`
          UPDATE amygdala_evaluations
          SET user_override = TRUE,
              user_override_reason = ?
          WHERE id = ?
        `)
          .run(reason, evaluationId);
        return;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === "SQLITE_BUSY" && attempt < TrainingLog.MAX_RETRIES) {
          await sleep(TrainingLog.BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    this.insertStmt = null;
    this.db?.close();
    this.db = null;
    this._available = false;
  }

  // -- Schema creation --

  private createTables(): void {
    // v3.1 schema (user_version 1): ensemble columns are NULLABLE (the legacy
    // 5-net ensemble is retired from the decision path), plus novelty /
    // disposition / signal. Fresh DBs get this directly; existing DBs are
    // brought here by migrate().
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS amygdala_evaluations (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp             TEXT NOT NULL,
        situation_json        TEXT NOT NULL,
        serialized            TEXT NOT NULL,
        embedding             BLOB NOT NULL,
        gate_decision         TEXT NOT NULL,
        prudence_combined     TEXT,
        prudence_per_arch     TEXT,
        prediction_set        TEXT,
        ensemble_disagreement REAL,
        personality_combined  BLOB,
        outcome               TEXT,
        outcome_source        TEXT,
        outcome_timestamp     TEXT,
        outcome_weight        REAL DEFAULT 1.0,
        user_override         BOOLEAN DEFAULT FALSE,
        user_override_reason  TEXT,
        latency_ms            REAL NOT NULL DEFAULT 0,
        alpha_prudence        REAL NOT NULL DEFAULT 0,
        alpha_personality     REAL NOT NULL DEFAULT 0,
        phase                 INTEGER NOT NULL DEFAULT 1,
        novelty               REAL,
        disposition           TEXT,
        signal                TEXT,
        created_at            TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_eval_timestamp
        ON amygdala_evaluations(timestamp);
      CREATE INDEX IF NOT EXISTS idx_eval_outcome
        ON amygdala_evaluations(outcome);
      CREATE INDEX IF NOT EXISTS idx_eval_gate
        ON amygdala_evaluations(gate_decision);
      CREATE INDEX IF NOT EXISTS idx_eval_phase
        ON amygdala_evaluations(phase);

      CREATE TABLE IF NOT EXISTS amygdala_calibration (
        key        TEXT PRIMARY KEY,
        value      REAL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conformal_calibration (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        network_key                 TEXT NOT NULL,
        timestamp                   TEXT NOT NULL,
        prob_safe                   REAL NOT NULL,
        prob_needs_review           REAL NOT NULL,
        prob_dangerous              REAL NOT NULL,
        actual_outcome              TEXT NOT NULL,
        nonconformity_safe          REAL NOT NULL,
        nonconformity_needs_review  REAL NOT NULL,
        nonconformity_dangerous     REAL NOT NULL,
        created_at                  TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conformal_network
        ON conformal_calibration(network_key);
      CREATE INDEX IF NOT EXISTS idx_conformal_ts
        ON conformal_calibration(timestamp);

      CREATE TABLE IF NOT EXISTS trust_ramp_history (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        date                    TEXT NOT NULL,
        alpha_prudence          REAL NOT NULL,
        alpha_personality       REAL NOT NULL,
        phase                   INTEGER NOT NULL,
        reward_7d_avg           REAL NOT NULL DEFAULT 0,
        avg_prediction_set_size REAL NOT NULL DEFAULT 0,
        conformal_coverage      REAL NOT NULL DEFAULT 0,
        notes                   TEXT,
        created_at              TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS meta_learner_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        family      TEXT NOT NULL,
        weight_a    REAL NOT NULL,
        weight_b    REAL NOT NULL,
        weight_c    REAL NOT NULL,
        weight_d    REAL NOT NULL,
        weight_e    REAL NOT NULL,
        perf_a      REAL,
        perf_b      REAL,
        perf_c      REAL,
        perf_d      REAL,
        perf_e      REAL,
        created_at  TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * v3.1 schema migration (PRAGMA user_version 0 → 1). Idempotent.
   *
   * Existing live DBs carry NOT NULL on the ensemble columns and lack
   * novelty/disposition/signal. SQLite cannot drop NOT NULL in place, so we
   * rebuild the table (copy rows, new columns NULL) when needed. A fresh DB
   * already has the v1 schema from createTables() and only the version bumps.
   */
  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version >= 1) return;

    const cols = this.db.pragma("table_info(amygdala_evaluations)") as Array<{
      name: string;
      notnull: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    const hasNovelty = byName.has("novelty");
    const ensembleNotNull = (byName.get("prudence_combined")?.notnull ?? 0) === 1;
    const needsRebuild = ensembleNotNull || !hasNovelty;

    const tx = this.db.transaction(() => {
      if (needsRebuild) {
        this.db.exec(`
          CREATE TABLE amygdala_evaluations_v1 (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp             TEXT NOT NULL,
            situation_json        TEXT NOT NULL,
            serialized            TEXT NOT NULL,
            embedding             BLOB NOT NULL,
            gate_decision         TEXT NOT NULL,
            prudence_combined     TEXT,
            prudence_per_arch     TEXT,
            prediction_set        TEXT,
            ensemble_disagreement REAL,
            personality_combined  BLOB,
            outcome               TEXT,
            outcome_source        TEXT,
            outcome_timestamp     TEXT,
            outcome_weight        REAL DEFAULT 1.0,
            user_override         BOOLEAN DEFAULT FALSE,
            user_override_reason  TEXT,
            latency_ms            REAL NOT NULL DEFAULT 0,
            alpha_prudence        REAL NOT NULL DEFAULT 0,
            alpha_personality     REAL NOT NULL DEFAULT 0,
            phase                 INTEGER NOT NULL DEFAULT 1,
            novelty               REAL,
            disposition           TEXT,
            signal                TEXT,
            created_at            TEXT DEFAULT (datetime('now'))
          );
          INSERT INTO amygdala_evaluations_v1 (
            id, timestamp, situation_json, serialized, embedding, gate_decision,
            prudence_combined, prudence_per_arch, prediction_set, ensemble_disagreement,
            personality_combined, outcome, outcome_source, outcome_timestamp,
            outcome_weight, user_override, user_override_reason, latency_ms,
            alpha_prudence, alpha_personality, phase, created_at
          )
          SELECT
            id, timestamp, situation_json, serialized, embedding, gate_decision,
            prudence_combined, prudence_per_arch, prediction_set, ensemble_disagreement,
            personality_combined, outcome, outcome_source, outcome_timestamp,
            outcome_weight, user_override, user_override_reason, latency_ms,
            alpha_prudence, alpha_personality, phase, created_at
          FROM amygdala_evaluations;
          DROP TABLE amygdala_evaluations;
          ALTER TABLE amygdala_evaluations_v1 RENAME TO amygdala_evaluations;
          CREATE INDEX IF NOT EXISTS idx_eval_timestamp ON amygdala_evaluations(timestamp);
          CREATE INDEX IF NOT EXISTS idx_eval_outcome ON amygdala_evaluations(outcome);
          CREATE INDEX IF NOT EXISTS idx_eval_gate ON amygdala_evaluations(gate_decision);
          CREATE INDEX IF NOT EXISTS idx_eval_phase ON amygdala_evaluations(phase);
        `);
      }
      this.db.pragma("user_version = 1");
    });
    tx();
  }

  /**
   * Most-recent situation embeddings (newest last), decoded from the BLOB
   * column. Drives the novelty channel's reference set.
   */
  getRecentEmbeddings(cap: number, dim = 512): Float32Array[] {
    if (!this._available || !this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT embedding FROM amygdala_evaluations
         WHERE embedding IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(cap) as Array<{ embedding: Buffer }>;
    const out: Float32Array[] = [];
    for (const r of rows) {
      if (!r.embedding) continue;
      const f = new Float32Array(
        r.embedding.buffer,
        r.embedding.byteOffset,
        Math.floor(r.embedding.byteLength / 4),
      );
      if (f.length === dim) out.push(new Float32Array(f));
    }
    out.reverse(); // oldest → newest
    return out;
  }

  /** Read a calibration scalar (e.g. the novelty threshold). */
  getCalibration(key: string): number | null {
    if (!this._available || !this.db) return null;
    const row = this.db.prepare(`SELECT value FROM amygdala_calibration WHERE key = ?`).get(key) as
      | { value: number }
      | undefined;
    return row ? row.value : null;
  }

  /** Upsert a calibration scalar. */
  setCalibration(key: string, value: number): void {
    if (!this._available || !this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO amygdala_calibration (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value);
    } catch {
      /* best-effort */
    }
  }
}

// -- Utilities --

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
