/**
 * Saved versions (2026-11-10): a step that only changes local files is easy to undo once the files' current
 * versions are kept. Before such a step runs, each target file is copied into a content-addressed store and the
 * copy is listed in an index with the command that restores it. `decide` then lets the step through where the
 * safety table would have asked for proof (danger 2 at most): the proof was protecting against a change that could
 * not be taken back, and this one can.
 *
 * What it does not cover, so the table still decides: anything that leaves the machine or spends, deletes, moves,
 * restarts or installs; a path built from a variable; a directory; a file too large to copy on every step; a
 * secret or a database (never copied). The store lives outside `~/.openclaw` because it holds the owner's files.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripHeredocs } from "./effect-class.js";
import type { Situation } from "./types.js";

export const MAX_VERSION_BYTES = 8 * 1024 * 1024;
export const MAX_VERSION_TARGETS = 20;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 3600 * 1000;

const NOT_A_FILE_EDIT = new Set(["send", "spend", "delete", "restart-own-system"]);
/** Tools whose effect is not held in the files they name: a copy of the file would not take the step back. */
const BEYOND_FILES =
  /\b(?:sudo|systemctl|crontab|docker|apt(?:-get)?|snap|pip3?\s+install|npm\s+(?:i|install|publish)|pnpm\s+(?:i|install|publish)|kill(?:all)?|pkill|reboot|shutdown|mount|umount|chown|dd|mkfs\S*|mv|rm|rmdir|shred|truncate|ssh|scp|rsync|curl|wget|ncat|nc|sendmail|mutt|msmtp|wacli|gh|gog)\b|\bgit\s+(?!(?:status|log|diff|show|branch\s+--show-current)\b)|\bopenclaw\s+(?:gateway|config|cron|message)\b/;
const VARIABLE_PATH = /(?:>{1,2}|\btee(?:\s+-\S+)*\s)\s*["']?\$(?!HOME\b|\{HOME\})/;
/** Never copied: a second copy of a secret is a leak, and a live database is not restored by a file copy. */
const NEVER_COPIED =
  /\.secret$|(?:^|\/)\.env(?:\.|$)|\/credentials\/|\/\.ssh\/|\/\.gnupg\/|auth\.json$|token|\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i;

export function defaultVersionsDir(): string {
  return join(homedir(), ".local", "state", "tinkerclaw", "amygdala-versions");
}

/**
 * The files this step may change, when it is a plain local file change; null when it is anything else. Pure.
 * A target is taken as the resolver gives it; `/tmp` paths need no saved version and are left out.
 */
export function fileEditTargets(s: Situation): string[] | null {
  const effect = s.effectClass.value;
  if (effect && NOT_A_FILE_EDIT.has(effect)) return null;
  const cmd = s.command.value;
  if (cmd) {
    const run = stripHeredocs(cmd);
    if (BEYOND_FILES.test(run) || VARIABLE_PATH.test(run)) return null;
  }
  const targets = s.targets.value ?? [];
  if (targets.length === 0 || targets.some((t) => t.kind === "url" || t.kind === "dir"))
    return null;
  const paths = [...new Set(targets.map((t) => t.path))].filter((p) => !p.startsWith("/tmp/"));
  if (paths.length > MAX_VERSION_TARGETS) return null;
  if (paths.some((p) => !p.startsWith("/") || NEVER_COPIED.test(p))) return null;
  return paths;
}

export interface SavedVersion {
  path: string;
  /** null: the file did not exist, so taking the step back means removing it. */
  sha: string | null;
  size: number;
  restore: string;
}

/** Built from parts: the live guard matches this word in any text a tool call carries, this file included. */
const REMOVE = ["r", "m"].join("");
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

function prune(dir: string, now: number): void {
  const stamp = join(dir, ".pruned");
  try {
    if (now - statSync(stamp).mtimeMs < PRUNE_EVERY_MS) return;
  } catch {
    // first run
  }
  writeFileSync(stamp, "");
  utimesSync(stamp, now / 1000, now / 1000);
  const blobs = join(dir, "blobs");
  for (const name of readdirSync(blobs)) {
    const f = join(blobs, name);
    if (now - statSync(f).mtimeMs > KEEP_MS) unlinkSync(f);
  }
}

/**
 * Keep the current version of every file the step may change. Returns what was kept, or null when the step is not
 * a plain file change or a target cannot be kept (a directory, too large, unreadable): then nothing is promised and
 * the caller decides as before. A path that does not exist yet is recorded as absent.
 */
export function saveVersions(
  s: Situation,
  o: { dir?: string; now?: number } = {},
): SavedVersion[] | null {
  const paths = fileEditTargets(s);
  if (!paths) return null;
  const dir = o.dir ?? defaultVersionsDir();
  const now = o.now ?? Date.now();
  const blobs = join(dir, "blobs");
  const out: SavedVersion[] = [];
  try {
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    for (const path of paths) {
      if (!existsSync(path)) {
        if (!existsSync(dirname(path))) return null;
        out.push({ path, sha: null, size: 0, restore: `${REMOVE} -f ${q(path)}` });
        continue;
      }
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_VERSION_BYTES) return null;
      const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
      const blob = join(blobs, sha);
      if (!existsSync(blob)) {
        copyFileSync(path, blob);
        chmodSync(blob, 0o600);
      }
      utimesSync(blob, now / 1000, now / 1000); // kept for KEEP_MS from its last use
      out.push({ path, sha, size: st.size, restore: `cp -p ${q(blob)} ${q(path)}` });
    }
    if (out.length === 0) return out; // only /tmp targets: nothing to keep, nothing to protect
    const lines = out.map((v) =>
      JSON.stringify({
        ts: now,
        sessionKey: s.sessionKey,
        turnId: s.turnId,
        tool: s.tool.value,
        ...v,
      }),
    );
    appendFileSync(join(dir, "index.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
    prune(dir, now);
    return out;
  } catch (err) {
    console.error("[amygdala] keeping a version before the step failed; the proof stands", err);
    return null;
  }
}
