// ============================================================
// src/amygdala/training-log.ts
// SQLite training logger for AMYGDALA.
//
// Uses better-sqlite3 (synchronous but fast, no event-loop blocking
// for brief single-row writes). WAL mode allows concurrent Python
// training process to read without blocking Node writes.
//
// All exposed methods are async (for API consistency and to allow
// future migration to async sqlite if needed). better-sqlite3 calls
// are sync internally but wrapped in try/catch + retry logic.
// ============================================================

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type {
  PrudenceEnsembleOutput,
  PersonalityEnsembleOutput,
} from './types.js';
import type { SituationTemplate } from './types.js';

// ── Config ───────────────────────────────────────────────────

export interface TrainingLogConfig {
  /** Path to SQLite database file */
  db_path: string;
  /** Maximum entries before rotation (future use) */
  max_entries: number;
  /** Rolling window in days for data retention */
  rolling_window_days: number;
}

// ── Entry types ──────────────────────────────────────────────

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
}

// ── TrainingLog ──────────────────────────────────────────────

export class TrainingLog {
  private db: Database.Database | null = null;
  private insertStmt: Statement | null = null;
  private config: TrainingLogConfig;

  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_DELAY_MS = 100;

  constructor(config: TrainingLogConfig) {
    this.config = config;
  }

  /**
   * Open the database, set pragmas, and create tables if they don't exist.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    this.db = new Database(this.config.db_path);

    // WAL mode is critical for concurrent Python/Node access.
    // Without WAL, the nightly Python training script and runtime Node process
    // deadlock on write conflicts.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // busy_timeout: wait up to 5s when the Python training process holds a lock.
    // Covers typical nightly training write bursts (~2-3s of sustained writes).
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('wal_autocheckpoint = 1000');

    this.createTables();

    this.insertStmt = this.db.prepare(`
      INSERT INTO amygdala_evaluations (
        timestamp, situation_json, serialized, embedding,
        gate_decision, prudence_combined, prudence_per_arch,
        prediction_set, ensemble_disagreement, personality_combined,
        outcome, latency_ms, alpha_prudence, alpha_personality, phase
      ) VALUES (
        @timestamp, @situation_json, @serialized, @embedding,
        @gate_decision, @prudence_combined, @prudence_per_arch,
        @prediction_set, @ensemble_disagreement, @personality_combined,
        @outcome, @latency_ms, @alpha_prudence, @alpha_personality, @phase
      )
    `);
  }

  /**
   * Append an evaluation record.
   * Returns the inserted row ID (for later outcome recording).
   *
   * Uses application-level retry with exponential backoff on SQLITE_BUSY,
   * in addition to the busy_timeout pragma (belt-and-suspenders).
   */
  async append(entry: EvaluationLogEntry): Promise<number> {
    this.assertOpen();

    const row = {
      timestamp: entry.timestamp,
      situation_json: JSON.stringify(entry.situation),
      serialized: entry.serialized,
      embedding: Buffer.from(entry.embedding.buffer),
      gate_decision: entry.gate_decision,
      prudence_combined: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.combined)
        : '{}',
      prudence_per_arch: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.per_architecture)
        : '{}',
      prediction_set: entry.prudence_output
        ? JSON.stringify(entry.prudence_output.prediction_set)
        : '[]',
      ensemble_disagreement: entry.prudence_output?.ensemble_disagreement ?? 0,
      personality_combined: entry.personality_output
        ? Buffer.from(entry.personality_output.combined_embedding.buffer)
        : null,
      outcome: entry.outcome,
      latency_ms: entry.latency_ms,
      alpha_prudence: entry.alpha_prudence,
      alpha_personality: entry.alpha_personality,
      phase: entry.phase,
    };

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        const info = this.insertStmt!.run(row);
        return info.lastInsertRowid as number;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === 'SQLITE_BUSY' && attempt < TrainingLog.MAX_RETRIES) {
          const delay = TrainingLog.BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error('TrainingLog.append: exhausted retries on SQLITE_BUSY');
  }

  /**
   * Update the outcome for a previously logged evaluation.
   * Called asynchronously when the outcome is known (up to 72h later).
   */
  async updateOutcome(
    evaluationId: number,
    outcome: string,
    source: string,
    weight = 1.0,
  ): Promise<void> {
    this.assertOpen();

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        this.db!.prepare(`
          UPDATE amygdala_evaluations
          SET outcome = ?,
              outcome_source = ?,
              outcome_timestamp = datetime('now'),
              outcome_weight = ?
          WHERE id = ?
        `).run(outcome, source, weight, evaluationId);
        return;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === 'SQLITE_BUSY' && attempt < TrainingLog.MAX_RETRIES) {
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
    this.assertOpen();

    for (let attempt = 0; attempt <= TrainingLog.MAX_RETRIES; attempt++) {
      try {
        this.db!.prepare(`
          UPDATE amygdala_evaluations
          SET user_override = TRUE,
              user_override_reason = ?
          WHERE id = ?
        `).run(reason, evaluationId);
        return;
      } catch (err: unknown) {
        const sqlErr = err as { code?: string };
        if (sqlErr.code === 'SQLITE_BUSY' && attempt < TrainingLog.MAX_RETRIES) {
          await sleep(TrainingLog.BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Return a buffer of recent labeled evaluations for PPO training.
   * The Python nightly process also reads this directly via SQLite.
   *
   * @param limit  Maximum number of recent entries to return
   * @param minOutcome  Only return entries that have an outcome label
   */
  async getTrainingBuffer(
    limit = 1000,
    onlyLabeled = true,
  ): Promise<Array<{ id: number; row: Record<string, unknown> }>> {
    this.assertOpen();

    const whereClause = onlyLabeled ? 'WHERE outcome IS NOT NULL' : '';
    const rows = this.db!
      .prepare(
        `SELECT id, timestamp, situation_json, serialized, embedding,
                gate_decision, prudence_combined, prudence_per_arch,
                prediction_set, ensemble_disagreement, personality_combined,
                outcome, outcome_source, outcome_weight,
                user_override, user_override_reason,
                latency_ms, alpha_prudence, alpha_personality, phase
         FROM amygdala_evaluations
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({ id: row['id'] as number, row }));
  }

  async close(): Promise<void> {
    this.insertStmt = null;
    this.db?.close();
    this.db = null;
  }

  // ── Schema creation ──────────────────────────────────────────

  private createTables(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS amygdala_evaluations (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp             TEXT NOT NULL,
        situation_json        TEXT NOT NULL,
        serialized            TEXT NOT NULL,
        embedding             BLOB NOT NULL,
        gate_decision         TEXT NOT NULL,
        prudence_combined     TEXT NOT NULL,
        prudence_per_arch     TEXT NOT NULL,
        prediction_set        TEXT NOT NULL,
        ensemble_disagreement REAL NOT NULL DEFAULT 0,
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

  private assertOpen(): void {
    if (!this.db) {
      throw new Error(
        'TrainingLog is not initialized. Call initialize() first.',
      );
    }
  }
}

// ── Utilities ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
