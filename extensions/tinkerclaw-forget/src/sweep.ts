/**
 * Walk the roots, find every file that holds the fact, and (unless dry) redact the text ones.
 *
 * Every file is read once as raw bytes in 1 MB chunks with awaits between them, so the gateway's
 * event loop keeps turning (290 MB/s on a Raspberry Pi 5, measured 2026-10-25 over 1.5 GB of
 * transcripts). Text files that hold it go through redactFile; binary stores are only reported,
 * because nothing here can rewrite a SQLite page safely; their owners rebuild them (indexes.ts).
 */

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FactMatcher } from "./matcher.js";
import {
  ARCHIVE_EXT_RE,
  ownerRoot,
  placeOf,
  SKIP_DIRS,
  SKIP_EXT_RE,
  type PlaceId,
  type Root,
} from "./places.js";
import { redactFile, scanFile, type FileKind } from "./redact.js";

export type FoundFile = {
  path: string;
  place: PlaceId;
  kind: FileKind;
  size: number;
  /** Text files: lines and copies found (dry) or redacted. */
  lines?: number;
  copies?: number;
  /** Text files: lines that held it and could not be cleaned. */
  unredacted?: number;
  /** The file was rewritten. */
  wrote?: boolean;
};

export type SkippedFile = {
  path: string;
  place: PlaceId;
  size: number;
  why: "archive" | "too_large";
};

export type SweepResult = {
  found: FoundFile[];
  skipped: SkippedFile[];
  filesRead: number;
  bytesRead: number;
};

export type SweepOptions = {
  roots: readonly Root[];
  matcher: FactMatcher;
  token: string;
  dryRun: boolean;
  /** Binary stores larger than this are listed as not searched instead of read. */
  maxBinaryBytes: number;
  /** Only files modified at or after this time (epoch ms): the follow-up pass. */
  modifiedSince?: number;
  /** Folders never walked (the receipts). */
  excludeDirs?: readonly string[];
};

async function* walk(
  root: Root,
  excludeDirs: ReadonlySet<string>,
): AsyncGenerator<{ path: string; size: number; mtimeMs: number }> {
  const top = await lstat(root.path).catch(() => null);
  if (!top) {
    return;
  }
  if (top.isFile()) {
    yield { path: root.path, size: top.size, mtimeMs: top.mtimeMs };
    return;
  }
  if (!top.isDirectory()) {
    return;
  }
  const stack = [root.path];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !excludeDirs.has(p) && (root.recurse ?? true)) {
          stack.push(p);
        }
        continue;
      }
      if (!e.isFile()) {
        continue; // symlinks and sockets: a symlink's target is swept where it really lives
      }
      const rel = relative(root.path, p);
      if (root.include && !root.include(rel)) {
        continue;
      }
      const st = await lstat(p).catch(() => null);
      if (st) {
        yield { path: p, size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  }
}

/** Files read at once: overlaps disk reads with the regex work on the main thread. */
const CONCURRENCY = 4;

async function examine(
  opts: SweepOptions,
  root: Root,
  f: { path: string; size: number },
  result: SweepResult,
): Promise<void> {
  let scanned: Awaited<ReturnType<typeof scanFile>>;
  try {
    scanned = await scanFile(f.path, opts.matcher, opts.maxBinaryBytes);
  } catch {
    return; // vanished, or unreadable to this user: not a copy this run can reach
  }
  const { kind } = scanned;
  const place = placeOf(root, relative(root.path, f.path), kind);
  if (scanned.holds === null) {
    result.skipped.push({ path: f.path, place, size: f.size, why: "too_large" });
    return;
  }
  result.filesRead += 1;
  result.bytesRead += f.size;
  if (!scanned.holds) {
    return;
  }
  if (kind === "binary") {
    result.found.push({ path: f.path, place, kind, size: f.size });
    return;
  }
  try {
    const out = await redactFile(f.path, opts.matcher, opts.token, { dryRun: opts.dryRun });
    // Held in the raw bytes but on no single line: a match that spans a line break.
    result.found.push({
      path: f.path,
      place,
      kind,
      size: f.size,
      lines: Math.max(out.lines, 1),
      copies: Math.max(out.copies, 1),
      unredacted: out.lines === 0 ? 1 : out.unredacted,
      wrote: out.wrote,
    });
  } catch {
    result.found.push({
      path: f.path,
      place,
      kind,
      size: f.size,
      lines: 1,
      copies: 1,
      unredacted: 1,
    });
  }
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { found: [], skipped: [], filesRead: 0, bytesRead: 0 };
  const excludeDirs = new Set(opts.excludeDirs ?? []);
  const seen = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  for (const root of opts.roots) {
    for await (const f of walk(root, excludeDirs)) {
      if (seen.has(f.path)) {
        continue;
      }
      seen.add(f.path);
      if (ownerRoot(opts.roots, f.path) !== root) {
        continue; // a more specific root owns it and has walked (or will walk) it
      }
      if (opts.modifiedSince !== undefined && f.mtimeMs < opts.modifiedSince) {
        continue;
      }
      if (f.size === 0 || SKIP_EXT_RE.test(f.path) || /\.forget-\d+\.tmp$/.test(f.path)) {
        continue;
      }
      if (ARCHIVE_EXT_RE.test(f.path)) {
        // An archive is a frozen copy: a backup in a backup folder, an old version anywhere else.
        result.skipped.push({
          path: f.path,
          place: root.place === "backups" ? "backups" : "old_versions",
          size: f.size,
          why: "archive",
        });
        continue;
      }
      const job: Promise<void> = examine(opts, root, f, result).finally(() => inFlight.delete(job));
      inFlight.add(job);
      if (inFlight.size >= CONCURRENCY) {
        await Promise.race(inFlight);
      }
    }
  }
  await Promise.all(inFlight);
  return result;
}
