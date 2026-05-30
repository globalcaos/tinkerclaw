// Intent: clean code refactoring applied (naming, clarity, DRY, magic numbers)
import type { DatabaseSync } from "node:sqlite";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  cacheEnabled: boolean;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (params.cacheEnabled) {
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
    `);
    params.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
    );
  }

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  // Phase 1: granularity, topic clustering, and access tracking columns
  ensureColumn(params.db, "chunks", "granularity", "TEXT DEFAULT 'detail'");
  ensureColumn(params.db, "chunks", "topic_cluster", "TEXT DEFAULT ''");
  ensureColumn(params.db, "chunks", "last_accessed", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "access_count", "INTEGER DEFAULT 0");
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_granularity ON chunks(granularity);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_topic_cluster ON chunks(topic_cluster);`);

  // Upgrade 3: Bi-temporal graph edges. A fact has a validity interval
  // (validity_start..validity_end) describing when it was true in the world, and an
  // ingestion_time describing when the system learned it. New facts that contradict old
  // ones CLOSE the old interval (set validity_end) and stamp superseded_by — history is
  // preserved, never overwritten. validity_end IS NULL == currently valid / unbounded.
  ensureColumn(params.db, "chunks", "validity_start", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "validity_end", "INTEGER DEFAULT NULL");
  ensureColumn(params.db, "chunks", "ingestion_time", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "superseded_by", "TEXT DEFAULT NULL");
  // Covering index so the hot-path "current" filter (validity_end IS NULL OR >now)
  // does not table-scan.
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_validity ON chunks(validity_end);`);

  // Upgrade 6: Retrieve verified code by embedding. Each chunk carries a trust
  // dimension so retrieval can weight battle-tested code above unreviewed snippets.
  ensureColumn(params.db, "chunks", "verification_status", "TEXT DEFAULT 'unverified'");
  ensureColumn(params.db, "chunks", "test_coverage_percent", "INTEGER DEFAULT NULL");
  ensureColumn(params.db, "chunks", "verified_by", "TEXT DEFAULT NULL");
  ensureColumn(params.db, "chunks", "verification_timestamp", "INTEGER DEFAULT NULL");
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunks_verification ON chunks(verification_status);`,
  );

  // Upgrade 9: Zettelkasten auto-linking. Inter-chunk relatedness (previously ephemeral,
  // computed during enhancement and thrown away) becomes durable. The backlinks table is
  // the authoritative store; related_chunks JSON on the chunk row is a rebuildable cache.
  ensureColumn(params.db, "chunks", "related_chunks", "TEXT DEFAULT NULL");
  ensureColumn(params.db, "chunks", "link_count", "INTEGER DEFAULT 0");
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS backlinks (
      from_chunk_id TEXT NOT NULL,
      to_chunk_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'related',
      link_strength REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (from_chunk_id, to_chunk_id, link_type)
    );
  `);
  // Index both directions: getBacklinks walks to_chunk_id, k-hop walks from_chunk_id.
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_backlinks_to ON backlinks(to_chunk_id);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_backlinks_from ON backlinks(from_chunk_id);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
