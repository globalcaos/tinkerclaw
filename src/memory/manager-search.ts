// Intent: clean code refactoring applied (naming, clarity, DRY, magic numbers)
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "../utils.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import type { Backlink, LinkType, SearchResult, VerificationStatus } from "./storage/types.js";

// ---------------------------------------------------------------------------
// Upgrade 3: Bi-temporal validity predicate.
// ---------------------------------------------------------------------------

export type TemporalMode = "current" | "valid-at" | "all";

/**
 * Build the SQL fragment (with a leading space) that filters the chunks table by
 * validity interval, plus the positional params it consumes. The column is qualified
 * by `alias` (e.g. "c") so it can be dropped into a JOINed query.
 *
 * - current  → rows whose interval is open (validity_end IS NULL) or still extends past now.
 * - valid-at → rows that were true at asOfTime (start <= asOf < end).
 * - all      → no predicate.
 *
 * Back-filled rows have validity_end = NULL, so the default 'current' mode is fully
 * backward compatible (they are treated as currently valid).
 */
export function temporalPredicate(
  mode: TemporalMode,
  alias: string,
  asOfTime?: number,
  now: number = Date.now(),
): { sql: string; params: number[] } {
  const col = alias ? `${alias}.` : "";
  switch (mode) {
    case "all":
      return { sql: "", params: [] };
    case "valid-at": {
      const asOf = asOfTime ?? now;
      return {
        sql: ` AND ${col}validity_start <= ? AND (${col}validity_end IS NULL OR ${col}validity_end > ?)`,
        params: [asOf, asOf],
      };
    }
    case "current":
    default:
      return {
        sql: ` AND (${col}validity_end IS NULL OR ${col}validity_end > ?)`,
        params: [now],
      };
  }
}

// ---------------------------------------------------------------------------
// Upgrade 6: rank by verification status / test coverage.
// ---------------------------------------------------------------------------

export const VERIFICATION_BOOST: Record<VerificationStatus, number> = {
  verified: 1.5,
  partial: 1.2,
  unverified: 1.0,
  failed: 0.5,
};

/**
 * Re-rank results by trust. Multiplies each result's score by a per-status boost
 * (verified > partial > unverified > failed) so battle-tested code outranks unreviewed
 * snippets at equal cosine. Optionally hard-filters by verificationRequired/minTestCoverage.
 * Never drops results unless the caller opts in via those filters.
 */
export function rankByVerification<
  T extends {
    score: number;
    verificationStatus?: VerificationStatus;
    testCoveragePercent?: number | null;
  },
>(results: T[], params?: { verificationRequired?: boolean; minTestCoverage?: number }): T[] {
  let out = results;
  if (params?.verificationRequired) {
    out = out.filter((r) => r.verificationStatus === "verified");
  }
  if (params?.minTestCoverage != null) {
    const min = params.minTestCoverage;
    out = out.filter((r) => (r.testCoveragePercent ?? 0) >= min);
  }
  const boosted = out.map((r) => ({
    ...r,
    score: r.score * (VERIFICATION_BOOST[r.verificationStatus ?? "unverified"] ?? 1.0),
  }));
  return boosted.toSorted((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Upgrade 9: Zettelkasten link store + traversal.
// ---------------------------------------------------------------------------

const DUPLICATE_SIMILARITY_THRESHOLD = 0.9;

/**
 * Combine signals into a single [0,1] link strength. Monotonic in each input.
 * Dominated by similarity, lightly nudged by recency and access frequency.
 */
export function computeLinkStrength(sim: number, recencyDays = 0, accessCount = 0): number {
  const simTerm = clamp01(sim);
  const recencyDecay = Math.exp(-Math.max(0, recencyDays) / 30); // ~30-day half-ish life
  const accessTerm = Math.log1p(Math.max(0, accessCount)) / Math.log1p(1000); // saturates ~1000
  const raw = 0.6 * simTerm + 0.2 * recencyDecay + 0.2 * clamp01(accessTerm);
  return clamp01(raw);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) {
    return 0;
  }
  return Math.min(1, Math.max(0, x));
}

/**
 * Persist (upsert) a single directed link from `fromId` to `toId`. Link type is derived
 * from similarity (duplicate above 0.9, related otherwise) unless overridden. Re-linking
 * the same pair updates strength/timestamp instead of creating a duplicate row.
 */
export function linkChunks(
  db: DatabaseSync,
  fromId: string,
  toId: string,
  sim: number,
  opts?: { linkType?: LinkType; recencyDays?: number; accessCount?: number; verified?: boolean },
): void {
  if (fromId === toId) {
    return; // never self-link
  }
  const linkType: LinkType =
    opts?.linkType ?? (sim >= DUPLICATE_SIMILARITY_THRESHOLD ? "duplicate" : "related");
  const strength = computeLinkStrength(sim, opts?.recencyDays ?? 0, opts?.accessCount ?? 0);
  const now = Date.now();
  db.prepare(
    `INSERT INTO backlinks (from_chunk_id, to_chunk_id, link_type, link_strength, created_at, verified)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_chunk_id, to_chunk_id, link_type) DO UPDATE SET
       link_strength = excluded.link_strength,
       created_at = excluded.created_at,
       verified = excluded.verified`,
  ).run(fromId, toId, linkType, strength, now, opts?.verified ? 1 : 0);
  // Maintain the denormalized link_count on the source chunk (best-effort).
  try {
    db.prepare(
      `UPDATE chunks SET link_count = (SELECT COUNT(*) FROM backlinks WHERE from_chunk_id = ?) WHERE id = ?`,
    ).run(fromId, fromId);
  } catch {
    // link_count is a convenience denorm; missing chunk row is non-fatal.
  }
}

/**
 * Return the chunks that link TO `chunkId` (its referrers / backlinks), ordered by
 * link strength. The JOIN against chunks naturally drops orphaned rows whose target
 * chunk was deleted, so a dangling backlink never crashes the caller.
 */
export function getBacklinks(db: DatabaseSync, chunkId: string, limit = 10): Backlink[] {
  const rows = db
    .prepare(
      `SELECT b.from_chunk_id AS id, b.link_type AS linkType, b.link_strength AS linkStrength,
              c.text AS text
         FROM backlinks b
         JOIN chunks c ON c.id = b.from_chunk_id
        WHERE b.to_chunk_id = ?
        ORDER BY b.link_strength DESC
        LIMIT ?`,
    )
    .all(chunkId, limit) as Array<{
    id: string;
    linkType: LinkType;
    linkStrength: number;
    text: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    linkType: r.linkType,
    linkStrength: r.linkStrength,
    snippet: truncateUtf16Safe(r.text, 200),
  }));
}

/**
 * Breadth-first traversal of the (undirected) link graph from `chunkId`. Walks both
 * directions of the backlinks table, carries a visited-set for cycle safety, and caps
 * at `maxDepth`. Returns each reachable neighbour with the depth at which it was found.
 */
export function getBreadthFirstNeighbors(
  db: DatabaseSync,
  chunkId: string,
  maxDepth: number,
  opts?: { limit?: number },
): Array<{ id: string; depth: number }> {
  const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
  const visited = new Set<string>([chunkId]);
  let frontier: string[] = [chunkId];
  const out: Array<{ id: string; depth: number }> = [];
  const neighborStmt = db.prepare(
    `SELECT to_chunk_id AS nbr FROM backlinks WHERE from_chunk_id = ?
       UNION
     SELECT from_chunk_id AS nbr FROM backlinks WHERE to_chunk_id = ?`,
  );
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbours = neighborStmt.all(node, node) as Array<{ nbr: string }>;
      for (const { nbr } of neighbours) {
        if (visited.has(nbr)) {
          continue;
        }
        visited.add(nbr);
        out.push({ id: nbr, depth });
        next.push(nbr);
        if (out.length >= limit) {
          return out;
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Hydrate each result with its top-k backlinks (Upgrade 9, opt-in). Mirrors the
 * post-search trackAccess write-back pattern. Mutates results in place and returns them.
 */
export function hydrateBacklinks(
  db: DatabaseSync,
  results: SearchResult[],
  limitPerResult = 5,
): SearchResult[] {
  for (const r of results) {
    r.backlinks = getBacklinks(db, r.id, limitPerResult);
  }
  return results;
}

/**
 * Update access tracking metadata for a set of chunk IDs.
 * Called after every search that returns results so we can track
 * how frequently each chunk is retrieved (used by Phase 1 metadata).
 */
function trackAccess(db: DatabaseSync, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE chunks SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?`,
  );
  for (const id of ids) {
    stmt.run(now, id);
  }
}

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
  // Upgrade 6: trust metadata threaded through so callers can rank/filter by it.
  verificationStatus?: VerificationStatus;
  testCoveragePercent?: number | null;
};

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
  // Upgrade 3: temporal slice (defaults to 'current').
  temporalMode?: TemporalMode;
  asOfTime?: number;
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  const temporal = temporalPredicate(params.temporalMode ?? "current", "c", params.asOfTime);
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source, c.verification_status, c.test_coverage_percent,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}${temporal.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        ...temporal.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      verification_status: VerificationStatus | null;
      test_coverage_percent: number | null;
      dist: number;
    }>;
    const results = rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
      verificationStatus: row.verification_status ?? "unverified",
      testCoveragePercent: row.test_coverage_percent,
    }));
    trackAccess(
      params.db,
      results.map((r) => r.id),
    );
    return results;
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
    temporalMode: params.temporalMode,
    asOfTime: params.asOfTime,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  const fallbackResults = scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
      verificationStatus: entry.chunk.verificationStatus,
      testCoveragePercent: entry.chunk.testCoveragePercent,
    }));
  trackAccess(
    params.db,
    fallbackResults.map((r) => r.id),
  );
  return fallbackResults;
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
  temporalMode?: TemporalMode;
  asOfTime?: number;
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
  verificationStatus?: VerificationStatus;
  testCoveragePercent?: number | null;
}> {
  const temporal = temporalPredicate(params.temporalMode ?? "current", "", params.asOfTime);
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source,\n` +
        `       verification_status, test_coverage_percent\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}${temporal.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params, ...temporal.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
    verification_status: VerificationStatus | null;
    test_coverage_percent: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
    verificationStatus: row.verification_status ?? "unverified",
    testCoveragePercent: row.test_coverage_percent,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string | undefined;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
  // Upgrade 3: temporal slice (defaults to 'current').
  temporalMode?: TemporalMode;
  asOfTime?: number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  // When providerModel is undefined (FTS-only mode), search all models
  const modelClause = params.providerModel ? ` AND f.model = ?` : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];

  // The FTS virtual table carries no validity/verification columns, so JOIN chunks `c`
  // to apply the temporal filter (Upgrade 3) and surface trust metadata (Upgrade 6).
  // The source filter is applied against the FTS-side source column (alias f).
  const sourceFilterSql = params.sourceFilter.sql.replace(/\bsource\b/g, "f.source");
  const temporal = temporalPredicate(params.temporalMode ?? "current", "c", params.asOfTime);

  const rows = params.db
    .prepare(
      `SELECT f.id AS id, f.path AS path, f.source AS source,\n` +
        `       f.start_line AS start_line, f.end_line AS end_line, f.text AS text,\n` +
        `       c.verification_status AS verification_status,\n` +
        `       c.test_coverage_percent AS test_coverage_percent,\n` +
        `       bm25(f) AS rank\n` +
        `  FROM ${params.ftsTable} f\n` +
        `  JOIN chunks c ON c.id = f.id\n` +
        ` WHERE f MATCH ?${modelClause}${sourceFilterSql}${temporal.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(
      ftsQuery,
      ...modelParams,
      ...params.sourceFilter.params,
      ...temporal.params,
      params.limit,
    ) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    verification_status: VerificationStatus | null;
    test_coverage_percent: number | null;
    rank: number;
  }>;

  const keywordResults = rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
      verificationStatus: row.verification_status ?? "unverified",
      testCoveragePercent: row.test_coverage_percent,
    };
  });
  trackAccess(
    params.db,
    keywordResults.map((r) => r.id),
  );
  return keywordResults;
}
