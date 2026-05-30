// Upgrade 6: map test-coverage output back onto indexed code chunks.
//
// This is a BATCH job meant to run inside the nightly rebuild/consolidation cycle, never
// at search time — coverage maps change on every test run, so applying them on the hot
// path would churn the index. It parses an Istanbul/c8/vitest `coverage-final.json`
// shape, computes the covered fraction of each chunk's [start_line, end_line] range, and
// writes verification_status / test_coverage_percent / verified_by / verification_timestamp.
//
// Design choices (from the plan's open questions):
//  - v1 status is COVERAGE-derived ("a passing test touches this line"), not a human
//    "reviewed-and-blessed" flag. The two can disagree; the reviewed-flag is future work.
//  - Absence of coverage for a file's chunk DOWNGRADES it to 'unverified' rather than
//    leaving a stale 'verified' (handles renamed/deleted test files).
//  - Transcript code (no coverage map) simply never appears in the coverage JSON, so it
//    stays at its existing status (default 'unverified').
import type { DatabaseSync } from "node:sqlite";

const VERIFIED_THRESHOLD = 80; // >= 80% covered → 'verified'

export type VerificationStatusValue = "unverified" | "partial" | "verified" | "failed";

// Istanbul/c8 coverage-final.json: { [absPath]: { path, statementMap: { id: {start:{line},end:{line}} }, s: { id: hitCount } } }
export type IstanbulFileCoverage = {
  path: string;
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
};
export type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

/**
 * Compute the fraction (0..100) of lines in [startLine, endLine] that are covered by at
 * least one hit statement. A statement covers every line in its own line span.
 */
export function coveredFraction(
  file: IstanbulFileCoverage,
  startLine: number,
  endLine: number,
): number {
  if (endLine < startLine) {
    return 0;
  }
  const total = endLine - startLine + 1;
  const coveredLines = new Set<number>();
  for (const [id, stmt] of Object.entries(file.statementMap)) {
    const hits = file.s[id] ?? 0;
    if (hits <= 0) {
      continue;
    }
    const lo = Math.max(startLine, stmt.start.line);
    const hi = Math.min(endLine, stmt.end.line);
    for (let ln = lo; ln <= hi; ln++) {
      coveredLines.add(ln);
    }
  }
  return Math.round((coveredLines.size / total) * 100);
}

export function statusForCoverage(pct: number): VerificationStatusValue {
  if (pct >= VERIFIED_THRESHOLD) {
    return "verified";
  }
  if (pct > 0) {
    return "partial";
  }
  return "unverified";
}

/**
 * Apply a coverage report to the chunk table. For every file in the coverage JSON, find
 * the chunks indexed for that path and stamp their verification metadata. `pathFor`
 * normalizes an absolute coverage path to the path stored on chunks (default identity;
 * callers can strip a workspace prefix). Returns the number of chunks updated.
 */
export function mapCoverageToChunks(
  db: DatabaseSync,
  coverage: IstanbulCoverage,
  opts?: {
    pathFor?: (absPath: string) => string;
    testFileFor?: (absPath: string) => string;
    now?: number;
  },
): number {
  const now = opts?.now ?? Date.now();
  const pathFor = opts?.pathFor ?? ((p: string) => p);
  const selectChunks = db.prepare(
    `SELECT id, start_line AS startLine, end_line AS endLine FROM chunks WHERE path = ?`,
  );
  const update = db.prepare(
    `UPDATE chunks
        SET verification_status = ?, test_coverage_percent = ?,
            verified_by = ?, verification_timestamp = ?
      WHERE id = ?`,
  );
  let updated = 0;
  for (const file of Object.values(coverage)) {
    const chunkPath = pathFor(file.path);
    const chunks = selectChunks.all(chunkPath) as Array<{
      id: string;
      startLine: number;
      endLine: number;
    }>;
    const verifiedBy = opts?.testFileFor ? opts.testFileFor(file.path) : file.path;
    for (const chunk of chunks) {
      const pct = coveredFraction(file, chunk.startLine, chunk.endLine);
      const status = statusForCoverage(pct);
      update.run(status, pct, verifiedBy, now, chunk.id);
      updated++;
    }
  }
  return updated;
}
