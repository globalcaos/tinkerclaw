/**
 * The agent's own files (2026-11-16, the owner's order: the agent can always delete the files it created, also the
 * ones he does not know of).
 *
 * What it is for. Until this day a file counted as the agent's own for a deletion in three cases only: it sat under
 * /tmp, it was under five minutes old, or (judge layer only, in memory, lost at a restart) a tool call of the same
 * chat spelled its path in a write. Eight copies a wildcard `cp` put into a new folder were refused 46 minutes later.
 *
 * How it works. Before a tool call the folders the call names are listed; after it they are listed again. A path
 * that was not there before and whose birth time lies inside the call is the agent's own, and one line goes to
 * `own-files.jsonl` in the guard's data folder: path, inode, birth time, last change time. Both guard layers read
 * that list (the hard-rule hook has its own small reader, `ownFileStatus` in hooks/hard-rules.mjs: keep the two
 * equal). The list is shared by every chat and every subagent, and it survives a restart.
 *
 * What still holds. A listed path is the agent's own only while the file on disk is the same one (inode and birth
 * time) and nobody else changed it since the agent's last write (change time equal to the recorded one). A file the
 * owner then edited is his again. A path that existed before the call is never recorded, so an in-place rewrite of
 * his file (`sed -i`, an atomic save) does not hand it over. Read-only calls record nothing.
 *
 * Known gap, accepted. Another program that creates a file inside a named folder during the call is not told apart
 * (the five-minute rule has the same gap, wider in place and shorter in time).
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import * as path from "node:path";

export const OWN_FILES_NAME = "own-files.jsonl";

/** Folders listed per call, levels below each, and entries read in all: enough for a task folder, bounded for a tree. */
const MAX_ROOTS = 8;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 3000;
const SKIP_NAMES = new Set([".git", "node_modules"]);
/** /tmp is scratch already (every delete there passes); the rest are not places a task writes files. */
export const SKIP_ROOTS: readonly string[] = ["/tmp", "/proc", "/sys", "/dev", "/run"];
/** A folder of the agent's own counts whole only when it is this small and holds nothing but its own plain files. */
const OWN_DIR_MAX = 64;
const CLOCK_SLACK_MS = 1000;
const COMPACT_BYTES = 256 * 1024;

export interface OwnRecord {
  p: string;
  ino: number;
  born: number;
  mtime: number;
  dir: boolean;
  ts: number;
}

export interface TreeListing {
  /** Every path seen. */
  paths: Set<string>;
  /** The folders whose entries were all read: a new path counts only under one of these. */
  listed: Set<string>;
  roots: string[];
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** The folders worth listing for a call: each named path that is a folder, else its parent; never home or above it. */
export function candidateRoots(
  paths: readonly string[],
  home: string,
  skip: readonly string[] = SKIP_ROOTS,
): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw || !path.isAbsolute(raw)) continue;
    let dir = path.normalize(raw).replace(/\/+$/, "") || "/";
    try {
      if (!lstatSync(dir).isDirectory()) dir = path.dirname(dir);
    } catch {
      dir = path.dirname(dir);
    }
    if (!existsSync(dir)) continue;
    if (under(home, dir)) continue; // home itself, /home, /
    if (skip.some((r) => under(dir, r))) continue;
    if (out.some((o) => under(dir, o))) continue; // already inside a listed root
    out.push(dir);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

/** Breadth first, so the level a command works on is read before the budget runs out. */
export function listTree(roots: readonly string[]): TreeListing {
  const paths = new Set<string>();
  const listed = new Set<string>();
  let queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
  let budget = MAX_ENTRIES;
  while (queue.length > 0 && budget > 0) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      if (names.length > budget) {
        budget = 0;
        break;
      }
      budget -= names.length;
      listed.add(dir);
      for (const n of names) {
        const p = path.join(dir, n);
        paths.add(p);
        if (depth + 1 > MAX_DEPTH || SKIP_NAMES.has(n)) continue;
        try {
          if (lstatSync(p).isDirectory()) next.push({ dir: p, depth: depth + 1 });
        } catch {
          // gone between the two reads
        }
      }
    }
    queue = next;
  }
  return { paths, listed, roots: [...roots] };
}

function statOwn(p: string): Stats | null {
  try {
    const st = lstatSync(p);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    if (!st.isFile() && !st.isDirectory()) return null;
    return st.birthtimeMs > 0 ? st : null;
  } catch {
    return null;
  }
}

function recordOf(p: string, st: Stats, ts: number): OwnRecord {
  return { p, ino: st.ino, born: st.birthtimeMs, mtime: st.mtimeMs, dir: st.isDirectory(), ts };
}

/** True while the file on disk is the recorded one and nobody changed it after the agent's last write. */
function matches(rec: OwnRecord, st: Stats): boolean {
  if (st.ino !== rec.ino || st.birthtimeMs !== rec.born) return false;
  return st.isDirectory() ? rec.dir : !rec.dir && st.mtimeMs === rec.mtime;
}

export class OwnFiles {
  private readonly file: string;
  private readonly map = new Map<string, OwnRecord>();

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as OwnRecord;
        if (r && typeof r.p === "string" && typeof r.ino === "number") this.map.set(r.p, r);
      } catch {
        // a torn line: skip it
      }
    }
    if (text.length < COMPACT_BYTES) return;
    // Drop the lines of files that are gone or replaced, and the older lines of one path.
    for (const [p, r] of this.map) {
      const st = statOwn(p);
      if (!st || st.ino !== r.ino || st.birthtimeMs !== r.born) this.map.delete(p);
    }
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, [...this.map.values()].map((r) => `${JSON.stringify(r)}\n`).join(""));
      renameSync(tmp, this.file);
    } catch {
      // the list stays as it was
    }
  }

  private put(recs: OwnRecord[]): void {
    if (recs.length === 0) return;
    for (const r of recs) this.map.set(r.p, r);
    try {
      appendFileSync(this.file, recs.map((r) => `${JSON.stringify(r)}\n`).join(""));
    } catch {
      // in memory only until the next start
    }
  }

  /**
   * After a tool call: record what it gave birth to. `before` is the listing taken at its pre-tool seam, `absent` the
   * paths its text writes that did not exist then, `written` every path its text writes, `t0` the time of that seam.
   */
  noteCall(o: {
    before: TreeListing | null;
    absent: readonly string[];
    written: readonly string[];
    t0: number;
    now: number;
  }): void {
    const lo = o.t0 - CLOCK_SLACK_MS;
    const hi = o.now + CLOCK_SLACK_MS;
    const inCall = (ms: number): boolean => ms >= lo && ms <= hi;
    const recs = new Map<string, OwnRecord>();
    const born = (p: string): void => {
      const st = statOwn(p);
      if (st && inCall(st.birthtimeMs)) recs.set(p, recordOf(p, st, o.now));
    };
    // The agent's own later write to a file it owns keeps it its own.
    const rewritten = (p: string): void => {
      const rec = this.map.get(p);
      if (!rec || rec.dir || recs.has(p)) return;
      const st = statOwn(p);
      if (!st || st.ino !== rec.ino || st.birthtimeMs !== rec.born) return;
      if (st.mtimeMs !== rec.mtime && inCall(st.mtimeMs)) recs.set(p, recordOf(p, st, o.now));
    };
    o.absent.forEach(born);
    o.written.forEach(rewritten);
    if (o.before) {
      const after = listTree(o.before.roots);
      for (const p of after.paths) {
        if (o.before.paths.has(p)) {
          rewritten(p);
          continue;
        }
        const parent = path.dirname(p);
        // New here: its folder was read whole before the call, or the folder itself was born in this call.
        if (o.before.listed.has(parent) || recs.has(parent)) born(p);
      }
    }
    this.put([...recs.values()]);
  }

  /** True when `p` is a file the agent created and nobody else changed, or a small folder of only such files. */
  isOwn(p: string, inFolder = false): boolean {
    const rec = this.map.get(p);
    if (!rec) return false;
    const st = statOwn(p);
    if (!st || !matches(rec, st)) return false;
    if (!st.isDirectory()) return true;
    if (inFolder) return false;
    try {
      const names = readdirSync(p);
      return names.length <= OWN_DIR_MAX && names.every((n) => this.isOwn(path.join(p, n), true));
    } catch {
      return false;
    }
  }
}
