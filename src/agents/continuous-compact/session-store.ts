/**
 * Per-session SQLite + sqlite-vec vector store for embedded conversation turns.
 * Includes topic graph layer for organizing embeddings by conversation topic.
 *
 * Location on disk: ~/.openclaw/agents/{agentId}/session-vectors/{sessionId}.sqlite
 */

import fs from "node:fs";
import path from "node:path";
import type { TurnChunk } from "./turn-indexer.js";

// ── Types ───────────────────────────────────────────────────────────

export type ScoredTurnChunk = TurnChunk & { score: number; topicId?: number };

export interface Topic {
  id: number;
  label: string;
  centroid: number[];
  turnCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SessionVectorStore {
  insertTurns(turns: TurnChunk[]): void;
  searchSimilar(queryEmbedding: number[], limit: number, minScore?: number): ScoredTurnChunk[];
  searchByTopic(
    topicId: number,
    queryEmbedding: number[],
    limit: number,
    minScore?: number,
  ): ScoredTurnChunk[];
  getRecentTurnPerTopic(excludeTopicIds: number[], limit: number): ScoredTurnChunk[];
  getTurnCount(): number;
  getLastIndexedEndIndex(): number;
  assignTopic(embedding: number[], timestamp: number, similarityThreshold?: number): number;
  getTopics(): Topic[];
  mergeTopics(targetId: number, sourceId: number): void;
  autoMergeTopics(threshold?: number): number;
  close(): void;
  destroy(): void;
  getDiskUsageBytes(): number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
}

function floatsToBuffer(floats: number[]): Buffer {
  const buf = Buffer.alloc(floats.length * 4);
  for (let i = 0; i < floats.length; i++) {
    buf.writeFloatLE(floats[i], i * 4);
  }
  return buf;
}

function bufferToFloats(buf: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    floats.push(buf.readFloatLE(i));
  }
  return floats;
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-10 ? 0 : dot / denom;
}

// ── Store Factory ───────────────────────────────────────────────────

export function openSessionVectorStore(
  agentDir: string,
  sessionId: string,
  embeddingDims = 384,
): SessionVectorStore {
  const storeDir = path.join(agentDir, "session-vectors");
  fs.mkdirSync(storeDir, { recursive: true });
  const dbPath = path.join(storeDir, `${sanitizeId(sessionId)}.sqlite`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);

  let vecReady = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { load: (db: unknown) => void };
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    vecReady = true;
  } catch {
    // sqlite-vec unavailable
  }

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT DEFAULT '',
      centroid BLOB,
      turn_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_turns (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      turn_start_index INTEGER NOT NULL,
      turn_end_index INTEGER NOT NULL,
      roles TEXT NOT NULL,
      tool_names TEXT,
      has_error INTEGER DEFAULT 0,
      user_preview TEXT,
      topic_id INTEGER REFERENCES topics(id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_end ON session_turns(turn_end_index);
    CREATE INDEX IF NOT EXISTS idx_topic_id ON session_turns(topic_id);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  if (vecReady) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_vec USING vec0(embedding float[${embeddingDims}])`,
    );
  }

  function mapRow(r: Record<string, unknown>): ScoredTurnChunk {
    return {
      id: r.id as string,
      sessionId: "",
      text: r.text as string,
      tokenEstimate: r.token_estimate as number,
      timestamp: r.timestamp as number,
      turnStartIndex: r.turn_start_index as number,
      turnEndIndex: r.turn_end_index as number,
      roles: JSON.parse(r.roles as string),
      metadata: {
        toolNames: r.tool_names ? JSON.parse(r.tool_names as string) : undefined,
        hasError: Boolean(r.has_error),
        userMessagePreview: (r.user_preview as string) || undefined,
        topicId: (r.topic_id as number) ?? undefined,
      },
      topicId: (r.topic_id as number) ?? undefined,
      score: 1 - ((r.distance as number) ?? 1),
    };
  }

  const store: SessionVectorStore = {
    insertTurns(turns: TurnChunk[]) {
      db.exec("BEGIN");
      try {
        const insertRow = db.prepare(`
          INSERT OR REPLACE INTO session_turns
          (id, text, token_estimate, timestamp, turn_start_index, turn_end_index,
           roles, tool_names, has_error, user_preview, topic_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertVec = vecReady
          ? db.prepare(`INSERT OR REPLACE INTO session_turns_vec (rowid, embedding) VALUES (?, ?)`)
          : null;

        for (const turn of turns) {
          const info = insertRow.run(
            turn.id,
            turn.text,
            turn.tokenEstimate,
            turn.timestamp,
            turn.turnStartIndex,
            turn.turnEndIndex,
            JSON.stringify(turn.roles),
            turn.metadata?.toolNames ? JSON.stringify(turn.metadata.toolNames) : null,
            turn.metadata?.hasError ? 1 : 0,
            turn.metadata?.userMessagePreview ?? null,
            turn.metadata?.topicId ?? null,
          );
          if (insertVec && turn.embedding) {
            insertVec.run(info.lastInsertRowid, floatsToBuffer(turn.embedding));
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    },

    searchSimilar(queryEmbedding: number[], limit: number, minScore = 0.3): ScoredTurnChunk[] {
      if (!vecReady) {
        return [];
      }
      const maxDistance = 1 - minScore;
      const rows = db
        .prepare(`
          SELECT t.id, t.text, t.token_estimate, t.timestamp,
            t.turn_start_index, t.turn_end_index, t.roles,
            t.tool_names, t.has_error, t.user_preview, t.topic_id,
            v.distance
          FROM session_turns_vec v
          JOIN session_turns t ON t.rowid = v.rowid
          WHERE v.embedding MATCH ? AND k = ? AND v.distance <= ?
          ORDER BY v.distance ASC
        `)
        .all(floatsToBuffer(queryEmbedding), limit, maxDistance) as Array<Record<string, unknown>>;
      return rows.map((r) => mapRow(r));
    },

    searchByTopic(
      topicId: number,
      queryEmbedding: number[],
      limit: number,
      minScore = 0.3,
    ): ScoredTurnChunk[] {
      if (!vecReady) {
        return [];
      }
      const maxDistance = 1 - minScore;
      // Vector search filtered by topic
      const rows = db
        .prepare(`
          SELECT t.id, t.text, t.token_estimate, t.timestamp,
            t.turn_start_index, t.turn_end_index, t.roles,
            t.tool_names, t.has_error, t.user_preview, t.topic_id,
            v.distance
          FROM session_turns_vec v
          JOIN session_turns t ON t.rowid = v.rowid
          WHERE v.embedding MATCH ? AND k = ? AND v.distance <= ?
            AND t.topic_id = ?
          ORDER BY v.distance ASC
        `)
        .all(floatsToBuffer(queryEmbedding), limit * 2, maxDistance, topicId) as Array<
        Record<string, unknown>
      >;
      return rows.slice(0, limit).map((r) => mapRow(r));
    },

    getRecentTurnPerTopic(excludeTopicIds: number[], limit: number): ScoredTurnChunk[] {
      const excludeSet = new Set(excludeTopicIds);
      // Get most recent turn from each topic
      const rows = db
        .prepare(`
          SELECT t.*, 0 as distance
          FROM session_turns t
          INNER JOIN (
            SELECT topic_id, MAX(turn_end_index) as max_idx
            FROM session_turns
            WHERE topic_id IS NOT NULL
            GROUP BY topic_id
          ) latest ON t.topic_id = latest.topic_id AND t.turn_end_index = latest.max_idx
          ORDER BY t.turn_end_index DESC
          LIMIT ?
        `)
        .all(limit + excludeTopicIds.length) as Array<Record<string, unknown>>;

      return rows
        .filter((r) => !excludeSet.has(r.topic_id as number))
        .slice(0, limit)
        .map((r) => ({ ...mapRow(r), score: 0.5 }));
    },

    getTurnCount() {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM session_turns").get() as { cnt: number };
      return row.cnt;
    },

    getLastIndexedEndIndex() {
      const row = db.prepare("SELECT MAX(turn_end_index) as max_idx FROM session_turns").get() as {
        max_idx: number | null;
      };
      return row?.max_idx ?? -1;
    },

    assignTopic(embedding: number[], timestamp: number, similarityThreshold = 0.75): number {
      const topics = store.getTopics();

      let bestTopicId = -1;
      let bestSim = 0;
      for (const topic of topics) {
        if (topic.centroid.length === 0) {
          continue;
        }
        const sim = cosineSimilarity(embedding, topic.centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestTopicId = topic.id;
        }
      }

      if (bestSim >= similarityThreshold && bestTopicId >= 0) {
        // Update centroid as running average
        const topic = topics.find((t) => t.id === bestTopicId)!;
        const newCount = topic.turnCount + 1;
        const newCentroid = topic.centroid.map(
          (v, i) => (v * topic.turnCount + embedding[i]) / newCount,
        );
        db.prepare(
          "UPDATE topics SET centroid = ?, turn_count = ?, last_seen_at = ? WHERE id = ?",
        ).run(floatsToBuffer(newCentroid), newCount, timestamp, bestTopicId);
        return bestTopicId;
      }

      // Create new topic
      const info = db
        .prepare(
          "INSERT INTO topics (centroid, turn_count, first_seen_at, last_seen_at) VALUES (?, 1, ?, ?)",
        )
        .run(floatsToBuffer(embedding), timestamp, timestamp);
      return Number(info.lastInsertRowid);
    },

    getTopics(): Topic[] {
      const rows = db.prepare("SELECT * FROM topics").all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as number,
        label: (r.label as string) || "",
        centroid: r.centroid ? bufferToFloats(r.centroid as Buffer) : [],
        turnCount: r.turn_count as number,
        firstSeenAt: r.first_seen_at as number,
        lastSeenAt: r.last_seen_at as number,
      }));
    },

    mergeTopics(targetId: number, sourceId: number): void {
      db.prepare("UPDATE session_turns SET topic_id = ? WHERE topic_id = ?").run(
        targetId,
        sourceId,
      );
      const target = store.getTopics().find((t) => t.id === targetId);
      const source = store.getTopics().find((t) => t.id === sourceId);
      if (target && source && target.centroid.length > 0 && source.centroid.length > 0) {
        const totalCount = target.turnCount + source.turnCount;
        const merged = target.centroid.map(
          (v, i) => (v * target.turnCount + source.centroid[i] * source.turnCount) / totalCount,
        );
        db.prepare(
          "UPDATE topics SET centroid = ?, turn_count = ?, first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?",
        ).run(floatsToBuffer(merged), totalCount, source.firstSeenAt, source.lastSeenAt, targetId);
      }
      db.prepare("DELETE FROM topics WHERE id = ?").run(sourceId);
    },

    autoMergeTopics(threshold = 0.85): number {
      const topics = store.getTopics();
      let mergeCount = 0;
      const merged = new Set<number>();

      for (let i = 0; i < topics.length; i++) {
        if (merged.has(topics[i].id)) {
          continue;
        }
        for (let j = i + 1; j < topics.length; j++) {
          if (merged.has(topics[j].id)) {
            continue;
          }
          if (topics[i].centroid.length === 0 || topics[j].centroid.length === 0) {
            continue;
          }
          const sim = cosineSimilarity(topics[i].centroid, topics[j].centroid);
          if (sim >= threshold) {
            const [target, source] =
              topics[i].turnCount >= topics[j].turnCount
                ? [topics[i], topics[j]]
                : [topics[j], topics[i]];
            store.mergeTopics(target.id, source.id);
            merged.add(source.id);
            mergeCount++;
          }
        }
      }
      return mergeCount;
    },

    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },

    destroy() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
    },

    getDiskUsageBytes() {
      try {
        return fs.statSync(dbPath).size;
      } catch {
        return 0;
      }
    },
  };

  return store;
}

/**
 * Destroy a session vector store by removing its SQLite file.
 */
export function destroySessionVectorStore(agentDir: string, sessionId: string): void {
  const storeDir = path.join(agentDir, "session-vectors");
  const dbPath = path.join(storeDir, `${sanitizeId(sessionId)}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
}
