import { existsSync, renameSync, statSync } from "node:fs";

/**
 * Guard against a canonical SQLite state file being renamed aside by a foreign
 * tool, which would otherwise cause the next open to silently create an empty
 * database and orphan every existing row.
 *
 * Real incident (2026-07-29): a Node upgrade installed upstream OpenClaw into
 * the active nvm bin dir, where it shadowed this fork on PATH. Running
 * `openclaw gateway restart` invoked UPSTREAM's doctor, which "migrated" the
 * fork's live task + flow registries into its own consolidated state and
 * archived the originals as `runs.sqlite.migrated` / `registry.sqlite.migrated`.
 * The running gateway held open fds, so nothing broke at the time — the loss
 * would have detonated on the NEXT restart, when `new DatabaseSync(pathname)`
 * found no `runs.sqlite` and happily created a fresh empty one. 258 task runs,
 * 114 delivery rows and 20 flow runs were one restart away from being orphaned.
 *
 * The rule this encodes is deliberately narrow:
 *
 *   Only ever FILL A HOLE. Never overwrite a file that already exists.
 *
 * If the canonical path is present we do nothing at all, no matter what
 * archived twins are lying around — a stale `.bak` must never clobber live
 * state. We act only in the one situation where the alternative is silent data
 * loss: canonical file absent, non-empty archived twin present.
 */

/**
 * Suffixes that foreign tooling (and our own older migrations) append when
 * archiving a state file aside. Ordered by how strongly they imply "this was
 * the live database until very recently".
 */
export const ARCHIVED_STATE_SUFFIXES = [".migrated", ".moved", ".old", ".bak"] as const;

/** SQLite writes these alongside the main database in WAL mode. */
export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export interface ArchivedStateTwin {
  /** The canonical path the application expects, e.g. `.../tasks/runs.sqlite`. */
  canonicalPath: string;
  /** The archived file found next to it, e.g. `.../tasks/runs.sqlite.migrated`. */
  archivedPath: string;
  /** Which suffix matched. */
  suffix: string;
  /** Size of the archived main database, in bytes. */
  bytes: number;
}

export interface StateFileGuardFs {
  exists: (path: string) => boolean;
  sizeOf: (path: string) => number;
  rename: (from: string, to: string) => void;
}

export const nodeStateFileGuardFs: StateFileGuardFs = {
  exists: (p) => existsSync(p),
  sizeOf: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  },
  rename: (from, to) => renameSync(from, to),
};

/**
 * Detect a canonical state file that has been archived aside.
 *
 * Returns `null` — meaning "nothing to do" — whenever the canonical file
 * exists. That is the common case and the safe one: a live database is never
 * a candidate for replacement.
 */
export function detectArchivedStateTwin(
  canonicalPath: string,
  fs: StateFileGuardFs = nodeStateFileGuardFs,
): ArchivedStateTwin | null {
  if (fs.exists(canonicalPath)) {
    return null;
  }
  for (const suffix of ARCHIVED_STATE_SUFFIXES) {
    const archivedPath = `${canonicalPath}${suffix}`;
    if (!fs.exists(archivedPath)) {
      continue;
    }
    const bytes = fs.sizeOf(archivedPath);
    if (bytes <= 0) {
      // An empty archive is worth no more than the empty database we would
      // otherwise create, so restoring it buys nothing.
      continue;
    }
    return { canonicalPath, archivedPath, suffix, bytes };
  }
  return null;
}

/**
 * Restore an archived state file (and its WAL/SHM sidecars) to the canonical
 * name. Sidecars are renamed BEFORE the main database so that at the instant
 * the canonical database name appears, its sidecars are already correctly
 * named for any connection that opens it.
 *
 * Renaming preserves the inode, so a process that already holds the file open
 * keeps writing to the very same bytes — restoring the name mid-flight is safe
 * and is exactly how the 2026-07-29 incident was recovered without downtime.
 */
export function restoreArchivedStateTwin(
  twin: ArchivedStateTwin,
  fs: StateFileGuardFs = nodeStateFileGuardFs,
): void {
  if (fs.exists(twin.canonicalPath)) {
    // Someone won the race and created it. Filling a hole is the whole remit;
    // overwriting is not.
    return;
  }
  for (const sidecar of SQLITE_SIDECAR_SUFFIXES) {
    const from = `${twin.canonicalPath}${sidecar}${twin.suffix}`;
    const to = `${twin.canonicalPath}${sidecar}`;
    if (!fs.exists(from) || fs.exists(to)) {
      continue;
    }
    fs.rename(from, to);
  }
  fs.rename(twin.archivedPath, twin.canonicalPath);
}

/**
 * Full guard: detect and repair in one call, returning what was restored so the
 * caller can log it. Returns `null` when nothing needed doing.
 *
 * This must be loud when it fires. A silent auto-repair of live state is how
 * the next person loses a day to the same puzzle.
 */
export function guardArchivedStateFile(
  canonicalPath: string,
  fs: StateFileGuardFs = nodeStateFileGuardFs,
): ArchivedStateTwin | null {
  const twin = detectArchivedStateTwin(canonicalPath, fs);
  if (!twin) {
    return null;
  }
  restoreArchivedStateTwin(twin, fs);
  return fs.exists(twin.canonicalPath) ? twin : null;
}

/** Human-readable one-liner for the warning log. */
export function describeArchivedStateTwin(twin: ArchivedStateTwin): string {
  return (
    `Restored ${twin.canonicalPath} from ${twin.archivedPath} (${twin.bytes} bytes). ` +
    `A foreign tool archived this database aside; opening without it would have ` +
    `created an empty one and orphaned the existing rows.`
  );
}
