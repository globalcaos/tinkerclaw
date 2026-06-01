/**
 * ENGRAM Upgrade 3 (J14): Bi-temporal SUPERSEDE-WRITER.
 *
 * The bi-temporal READ path is already live (manager-search.ts temporalPredicate +
 * SearchParams.temporalMode 'current'|'valid-at'|'all'), and the interval-closing
 * primitive `invalidate()` / `supersede()` lives in temporal-invalidation.ts. The
 * MISSING piece this module supplies is the WRITER: when a contradicting fact is
 * written, do not leave BOTH the old and new rows open — close the prior fact's
 * validity interval (stamp validity_end + superseded_by) so the corpus carries the
 * full history while every default 'current'-mode read sees only the live fact.
 *
 * Semantics (the J14 contradiction-gate-becomes-validity-writer upgrade, plan §3.1):
 *   - The §6 contradiction gate stops being an allow/warn/block JUDGE and becomes a
 *     validity-interval WRITER. Instead of returning {action:'warn'}, on a detected
 *     conflict it can return {action:'supersede', supersedes: ChunkId[], reason}.
 *   - applySupersede() executes that decision against the live chunks table by calling
 *     the existing invalidate() once per superseded chunk. This is NON-LOSSY: the prior
 *     row is retained (no DELETE), only its validity_end is stamped, so it stays
 *     queryable in 'all'/'valid-at' mode. That non-lossiness is why supersede defaults
 *     ON (it is strictly safer than the lossy 'block' the gate could otherwise pick).
 *
 * GRANULARITY: PER-CHUNK (the harvested fork decision), not SPO triples. A chunk's
 * (source, path, start_line, end_line) span is its fact identity; a new chunk written
 * to the same identity supersedes the prior currently-valid chunk(s) at that identity.
 * This matches the live chunks-table schema (no fact-level triple table exists yet).
 *
 * FORK-ISOLATED + ADDITIVE: this module only READS the chunks table to find the prior
 * open-interval rows and calls the existing invalidate() — it never alters the schema,
 * the read-path, or the storage layer. Default-OFF detectors are not introduced: the
 * supersede decision is the new default for the gate when a conflict is detected.
 */
import type { DatabaseSync } from "node:sqlite";
import { invalidate } from "../temporal-invalidation.js";

/**
 * The write decision the contradiction gate emits for a candidate chunk write.
 *
 * - allow     → no conflict, persist the candidate as-is.
 * - supersede → the candidate contradicts one or more currently-valid prior chunks; close
 *               their intervals (NON-LOSSY) as of the candidate's validity_start. NEW, the
 *               J14 default once a conflict is detected.
 * - warn      → legacy passive behaviour (log a warning, keep both rows open). Preserved so
 *               callers can opt out of the writer.
 * - block     → legacy lossy behaviour (refuse the candidate). Preserved for completeness.
 */
export type SupersedeMode = "supersede" | "warn" | "block";

export type WriteDecision =
  | { action: "allow" }
  | { action: "supersede"; supersedes: string[]; reason: string }
  | { action: "warn"; supersedes: string[]; reason: string }
  | { action: "block"; supersedes: string[]; reason: string };

/** Result of applying a supersede decision to the live store. */
export interface SupersedeApplyResult {
  /** chunk ids whose interval was actually closed (a row already-closed is skipped). */
  closed: string[];
  /** chunk ids that were targeted but already had a closed interval (no-op). */
  skipped: string[];
}

/**
 * Find the currently-valid (validity_end IS NULL) prior chunk(s) that a candidate chunk
 * contradicts under PER-CHUNK identity: same source + path + line span, same embedding
 * model, but a DIFFERENT content hash (a genuinely new revision of the same fact). The
 * candidate itself is excluded by id so re-indexing an unchanged chunk is never treated
 * as a self-contradiction.
 *
 * Read-only. Uses the idx_chunks_validity / idx_chunks_path indexes already on the table.
 */
export function findSupersededChunkIds(
  db: DatabaseSync,
  candidate: {
    id: string;
    source: string;
    path: string;
    startLine: number;
    endLine: number;
    model: string;
    hash: string;
  },
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM chunks
        WHERE source = ?
          AND path = ?
          AND start_line = ?
          AND end_line = ?
          AND model = ?
          AND hash <> ?
          AND id <> ?
          AND validity_end IS NULL`,
    )
    .all(
      candidate.source,
      candidate.path,
      candidate.startLine,
      candidate.endLine,
      candidate.model,
      candidate.hash,
      candidate.id,
    ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * The contradiction gate's decision, parameterised by mode. When prior contradicting
 * chunks exist:
 *   - 'supersede' (DEFAULT) → return the supersede decision (the writer will close them).
 *   - 'warn'                → return a non-acting warn decision (legacy passive behaviour).
 *   - 'block'               → return a block decision (legacy lossy behaviour).
 * When no prior chunk contradicts, always returns {action:'allow'}.
 */
export function decideSupersede(
  db: DatabaseSync,
  candidate: {
    id: string;
    source: string;
    path: string;
    startLine: number;
    endLine: number;
    model: string;
    hash: string;
  },
  mode: SupersedeMode = "supersede",
): WriteDecision {
  const supersedes = findSupersededChunkIds(db, candidate);
  if (supersedes.length === 0) {
    return { action: "allow" };
  }
  const reason =
    `candidate ${candidate.id} supersedes ${supersedes.length} prior fact(s) ` +
    `at ${candidate.source}:${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
  return { action: mode, supersedes, reason };
}

/**
 * Execute a supersede decision against the live chunks table by closing each prior
 * chunk's validity interval as of `validAt` (the candidate's validity_start). NON-LOSSY:
 * delegates to invalidate(), which only stamps validity_end + superseded_by on rows that
 * are still open and never deletes. Returns which ids were closed vs already-closed.
 *
 * For non-'supersede' decisions this is a no-op (returns empty result) so the legacy
 * warn/block paths keep both rows open exactly as before.
 */
export function applySupersede(
  db: DatabaseSync,
  decision: WriteDecision,
  candidate: { id: string; validityStart: number },
  opts?: {
    log?: (msg: string) => void;
    /**
     * Producer hook fired ONCE, after the apply, only when ≥1 prior interval was actually
     * closed. Carries the closed chunk ids + the supersede reason. The caller wires this to
     * emit a fork.prefrontal.trailEvent kind='recipe-supersede' so the UI's supersede icon
     * renders. Kept as injected DI (not a direct event-bus call) so this module stays in the
     * pure memory layer and unit-testable with a spy. Never throws into the write path.
     */
    onClosed?: (closedIds: string[], reason: string) => void;
  },
): SupersedeApplyResult {
  const result: SupersedeApplyResult = { closed: [], skipped: [] };
  if (decision.action !== "supersede") {
    return result;
  }
  for (const priorId of decision.supersedes) {
    const res = invalidate(db, priorId, candidate.id, decision.reason, {
      validAt: candidate.validityStart,
      log: opts?.log,
    });
    if (res.closed) {
      result.closed.push(priorId);
    } else {
      result.skipped.push(priorId);
    }
  }
  if (result.closed.length > 0) {
    opts?.log?.(
      `[supersede-writer] candidate=${candidate.id} closed ${result.closed.length} prior interval(s): ` +
        result.closed.join(", "),
    );
    try {
      opts?.onClosed?.(result.closed, decision.reason);
    } catch (err) {
      // The intervals are already closed; the producer emit is best-effort and must
      // never break the write path. Full object to devtools.
      console.error("[supersede-writer] onClosed hook threw (non-fatal)", err);
    }
  }
  return result;
}

/**
 * Convenience one-shot: detect + (in 'supersede' mode) close prior contradicting intervals
 * for a chunk that has ALREADY been inserted (currently-valid, validity_end IS NULL).
 *
 * This is the writer the contradiction gate calls once a candidate has been persisted:
 * it finds the prior open-interval revisions of the same fact identity and closes them as
 * of the candidate's validity_start, leaving the candidate as the sole 'current' row.
 *
 * Returns the decision that was taken plus the apply result, so callers can log/emit it.
 */
export function supersedeContradictions(
  db: DatabaseSync,
  candidate: {
    id: string;
    source: string;
    path: string;
    startLine: number;
    endLine: number;
    model: string;
    hash: string;
    validityStart: number;
  },
  opts?: {
    mode?: SupersedeMode;
    log?: (msg: string) => void;
    /** Producer hook (see applySupersede.onClosed) — fires only when an interval is closed. */
    onClosed?: (closedIds: string[], reason: string) => void;
  },
): { decision: WriteDecision; applied: SupersedeApplyResult } {
  const mode = opts?.mode ?? "supersede";
  const decision = decideSupersede(db, candidate, mode);
  const applied = applySupersede(db, decision, candidate, {
    log: opts?.log,
    onClosed: opts?.onClosed,
  });
  return { decision, applied };
}
