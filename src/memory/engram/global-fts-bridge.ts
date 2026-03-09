/**
 * ENGRAM: Bridge between the global FTS5 SQLite index and the retrieval runtime.
 *
 * The per-session event store only contains events from the current session,
 * which is too narrow for meaningful retrieval. This bridge queries the global
 * FTS5 database (878K+ events across all sessions) and adapts results into
 * the SearchResult format expected by the retrieval runtime.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import type { SearchResult, SearchFilters } from "./search-index.js";

const FTS_DB_PATH = join(process.env.HOME ?? "~", ".openclaw", "engram", "engram-fts.db");

/**
 * Query the global FTS5 database and return results in SearchResult format.
 * Falls back to empty array if the database doesn't exist or query fails.
 */
export function globalFtsSearch(
  _store: EventStore,
  query: string,
  topN: number = 40,
  _filters?: SearchFilters,
): SearchResult[] {
  console.log(`[ENGRAM] globalFtsSearch called, query="${query.slice(0, 80)}", dbExists=${existsSync(FTS_DB_PATH)}`);
  if (!existsSync(FTS_DB_PATH)) {
    return [];
  }

  // Sanitize query for FTS5: remove special chars, keep words
  const sanitized = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .join(" ");
  if (!sanitized) {
    return [];
  }

  try {
    // Dynamic import to avoid hard dependency on better-sqlite3 at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(FTS_DB_PATH, { readonly: true });

    const rows = db
      .prepare(
        `SELECT id, timestamp, kind, session_key, content, rank
				FROM events_fts
				WHERE events_fts MATCH ?
				ORDER BY rank
				LIMIT ?`,
      )
      .all(sanitized, topN) as Array<{
      id: string;
      timestamp: string;
      kind: string;
      session_key: string;
      content: string;
      rank: number;
    }>;

    db.close();

    return rows.map((row) => ({
      event: {
        id: row.id,
        timestamp: row.timestamp,
        kind: row.kind as MemoryEvent["kind"],
        content: row.content,
        turnId: 0,
        metadata: { sessionKey: row.session_key },
      } as MemoryEvent,
      // BM25 rank is negative (more negative = more relevant); normalize to positive score
      score: Math.abs(row.rank),
      matchType: "fts" as const,
    }));
  } catch (err) {
    // Log but don't crash — retrieval is best-effort
    console.log(`[ENGRAM] global FTS query failed: ${String(err)}`);
    return [];
  }
}
