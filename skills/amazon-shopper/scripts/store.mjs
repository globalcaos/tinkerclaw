// store.mjs — per-task SQLite store for amazon-shopper.
// Uses Node's built-in node:sqlite (experimental as of Node 22.5+).
// Runtime flag required at the entry point: --experimental-sqlite.

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const STATES = Object.freeze({
  SEARCHING: "searching",
  AWAITING_QUESTIONS: "awaiting_questions",
  RANKING: "ranking",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  FAILED: "failed",
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  keywords TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  blocked_reason TEXT,
  failed_reason TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asin TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  current_price_eur REAL,
  list_price_eur REAL,
  rating REAL,
  review_count INTEGER,
  is_prime INTEGER,
  is_best_seller INTEGER,
  seller_name TEXT,
  seller_is_amazon INTEGER,
  in_stock INTEGER,
  detail_fetched_at INTEGER,
  active_ingredient TEXT,
  concentration_pct REAL,
  package_size_kg REAL,
  package_size_l REAL,
  active_kg REAL,
  form TEXT,
  spec_status TEXT,
  spec_source TEXT,
  raw_detail_html TEXT,
  normalized_metric REAL,
  rank_position INTEGER,
  image_hash TEXT,
  cluster_id INTEGER,
  cheaper_alternative_asin TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  axis TEXT NOT NULL,
  value TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS pending_questions (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  why_load_bearing TEXT NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS answers (
  question_id TEXT PRIMARY KEY REFERENCES pending_questions(id),
  answer TEXT NOT NULL,
  answered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ladder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  step TEXT NOT NULL,
  outcome TEXT NOT NULL,
  url TEXT,
  notes TEXT,
  attempted_at INTEGER NOT NULL
);
`;

export function generateTaskId() {
  return randomBytes(8).toString("base64url").slice(0, 12);
}

export function openTaskStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);

  const now = () => Date.now();

  const stmts = {
    insertTask: db.prepare(
      "INSERT INTO task (id, keywords, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ),
    getTask: db.prepare("SELECT * FROM task WHERE id = ?"),
    updateState: db.prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?"),
    setBlocked: db.prepare(
      "UPDATE task SET state = ?, blocked_reason = ?, updated_at = ? WHERE id = ?",
    ),
    setFailed: db.prepare(
      "UPDATE task SET state = ?, failed_reason = ?, updated_at = ? WHERE id = ?",
    ),
    insertProduct: db.prepare(
      `INSERT INTO products
         (asin, position, title, url, image_url, current_price_eur, list_price_eur, rating, review_count, is_prime, is_best_seller, seller_name, seller_is_amazon, in_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asin) DO NOTHING`,
    ),
    countProducts: db.prepare("SELECT COUNT(*) AS n FROM products"),
    updateDetail: db.prepare(
      `UPDATE products SET
         detail_fetched_at = ?, active_ingredient = ?, concentration_pct = ?,
         package_size_kg = ?, package_size_l = ?, active_kg = ?, form = ?,
         spec_status = ?, spec_source = ?, raw_detail_html = ?
       WHERE asin = ?`,
    ),
    getProductByAsin: db.prepare("SELECT * FROM products WHERE asin = ?"),
    listProducts: db.prepare("SELECT * FROM products ORDER BY position ASC"),
    insertQuestion: db.prepare(
      "INSERT INTO pending_questions (id, text, options_json, why_load_bearing) VALUES (?, ?, ?, ?)",
    ),
    pendingQuestions: db.prepare(
      "SELECT * FROM pending_questions WHERE resolved_at IS NULL ORDER BY rowid ASC",
    ),
    resolveQuestion: db.prepare("UPDATE pending_questions SET resolved_at = ? WHERE id = ?"),
    insertAnswer: db.prepare(
      "INSERT INTO answers (question_id, answer, answered_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(question_id) DO UPDATE SET answer = excluded.answer, answered_at = excluded.answered_at",
    ),
    getAnswer: db.prepare("SELECT answer FROM answers WHERE question_id = ?"),
    listAnswers: db.prepare("SELECT question_id, answer FROM answers"),
    updateImageCluster: db.prepare(
      "UPDATE products SET image_hash = ?, cluster_id = ?, cheaper_alternative_asin = ? WHERE asin = ?",
    ),
    insertLadderLog: db.prepare(
      "INSERT INTO ladder_log (product_id, step, outcome, url, notes, attempted_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
  };

  function txn(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return {
    createTask({ id, keywords }) {
      const t = now();
      txn(() => stmts.insertTask.run(id, keywords, STATES.SEARCHING, t, t));
    },
    getTask(id) {
      return stmts.getTask.get(id);
    },
    setTaskState(id, state) {
      txn(() => stmts.updateState.run(state, now(), id));
    },
    setTaskBlocked(id, reason) {
      txn(() => stmts.setBlocked.run(STATES.BLOCKED, reason, now(), id));
    },
    setTaskFailed(id, reason) {
      txn(() => stmts.setFailed.run(STATES.FAILED, reason, now(), id));
    },
    insertProducts(_taskId, products) {
      txn(() => {
        for (const p of products) {
          stmts.insertProduct.run(
            p.asin,
            p.position,
            p.title,
            p.url,
            p.image_url ?? null,
            p.current_price_eur ?? null,
            p.list_price_eur ?? null,
            p.rating ?? null,
            p.review_count ?? null,
            p.is_prime ? 1 : 0,
            p.is_best_seller ? 1 : 0,
            p.seller_name ?? null,
            p.seller_is_amazon == null ? null : p.seller_is_amazon ? 1 : 0,
            p.in_stock == null ? null : p.in_stock ? 1 : 0,
          );
        }
      });
    },
    countProducts() {
      return stmts.countProducts.get().n;
    },
    listProducts() {
      return stmts.listProducts.all();
    },
    updateProductDetail(asin, detail) {
      txn(() =>
        stmts.updateDetail.run(
          now(),
          detail.active_ingredient ?? null,
          detail.concentration_pct ?? null,
          detail.package_size_kg ?? null,
          detail.package_size_l ?? null,
          detail.active_kg ?? null,
          detail.form ?? null,
          detail.spec_status,
          detail.spec_source ?? null,
          detail.raw_detail_html ?? null,
          asin,
        ),
      );
    },
    getProductByAsin(asin) {
      return stmts.getProductByAsin.get(asin);
    },
    insertPendingQuestion(_taskId, q) {
      txn(() =>
        stmts.insertQuestion.run(q.id, q.text, JSON.stringify(q.options), q.why_load_bearing),
      );
    },
    pendingQuestions() {
      return stmts.pendingQuestions
        .all()
        .map((row) => ({ ...row, options: JSON.parse(row.options_json) }));
    },
    recordAnswer(_taskId, qId, answer) {
      const t = now();
      txn(() => {
        stmts.insertAnswer.run(qId, answer, t);
        stmts.resolveQuestion.run(t, qId);
      });
    },
    getAnswer(_taskId, qId) {
      const row = stmts.getAnswer.get(qId);
      return row ? row.answer : null;
    },
    listAnswers(_taskId) {
      const rows = stmts.listAnswers.all();
      const out = {};
      for (const r of rows) out[r.question_id] = r.answer;
      return out;
    },
    updateImageCluster(
      asin,
      { image_hash = null, cluster_id = null, cheaper_alternative_asin = null },
    ) {
      txn(() =>
        stmts.updateImageCluster.run(image_hash, cluster_id, cheaper_alternative_asin, asin),
      );
    },
    logLadder(productId, step, outcome, url, notes) {
      txn(() =>
        stmts.insertLadderLog.run(productId, step, outcome, url ?? null, notes ?? null, now()),
      );
    },
    close() {
      db.close();
    },
  };
}
