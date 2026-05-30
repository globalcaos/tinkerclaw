// Upgrade 3: Bi-temporal invalidation. A new fact that contradicts an existing one
// CLOSES the old fact's validity interval (stamps validity_end + superseded_by) instead
// of deleting it, so history is preserved and "what did we believe as of X" queries work.
//
// This module deliberately exposes only the mechanical interval-closing primitive. The
// contradiction DETECTOR (deciding *that* fact B supersedes fact A) belongs to the
// nightly reflection/consolidation layer (J5), which calls invalidate() once it has
// decided. There is no cascade in v1 — invalidating a fact does not invalidate facts
// that depend on it (deferred to avoid a topological-sort hazard).
import type { DatabaseSync } from "node:sqlite";

export type InvalidateResult = {
  /** true if a currently-valid row was closed; false if the chunk was missing or already closed. */
  closed: boolean;
  /** the validity_end timestamp that was written (only meaningful when closed). */
  validityEnd: number;
};

/**
 * Close the validity interval of `chunkId` as of `validAt` (default now), recording the
 * chunk that superseded it. Idempotent-ish: a row that already has a validity_end is left
 * untouched (returns { closed: false }) so re-running reflection does not rewrite history.
 *
 * @param db                  open sqlite handle (single-writer init path)
 * @param chunkId             the fact being retired
 * @param supersededByChunkId the new fact that replaced it (or null if simply retracted)
 * @param reason              free-text reason, logged via the optional logger
 * @param opts.validAt        when the old fact stopped being true (default Date.now())
 * @param opts.log            optional log sink
 */
export function invalidate(
  db: DatabaseSync,
  chunkId: string,
  supersededByChunkId: string | null,
  reason: string,
  opts?: { validAt?: number; log?: (msg: string) => void },
): InvalidateResult {
  const validAt = opts?.validAt ?? Date.now();
  // Only close rows that are currently open (validity_end IS NULL). Never resurrect or
  // rewrite an already-closed interval, and never delete the row.
  const info = db
    .prepare(
      `UPDATE chunks
          SET validity_end = ?, superseded_by = ?
        WHERE id = ? AND validity_end IS NULL`,
    )
    .run(validAt, supersededByChunkId, chunkId);
  const closed = Number(info.changes) > 0;
  if (closed) {
    opts?.log?.(
      `[temporal-invalidation] closed chunk=${chunkId} validity_end=${validAt}` +
        (supersededByChunkId ? ` superseded_by=${supersededByChunkId}` : " (retracted)") +
        ` reason=${reason}`,
    );
  }
  return { closed, validityEnd: validAt };
}

/**
 * Convenience for the common supersession case: insert/point at a new chunk B that
 * replaces an existing chunk A, closing A's interval as of B's validity_start.
 * Assumes B is already inserted (currently valid). Returns the invalidation result for A.
 */
export function supersede(
  db: DatabaseSync,
  oldChunkId: string,
  newChunkId: string,
  reason: string,
  opts?: { validAt?: number; log?: (msg: string) => void },
): InvalidateResult {
  let validAt = opts?.validAt;
  if (validAt == null) {
    const row = db
      .prepare(`SELECT validity_start AS vs FROM chunks WHERE id = ?`)
      .get(newChunkId) as { vs: number } | undefined;
    validAt = row?.vs ?? Date.now();
  }
  return invalidate(db, oldChunkId, newChunkId, reason, { validAt, log: opts?.log });
}
