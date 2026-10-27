/**
 * Where a fact can live, as folders to sweep, and which line of the receipt each file belongs to.
 *
 * The receipt has the seven places the post names: the note, old versions, the search index,
 * summaries, the chat record, backups and the AI provider's copy. A root gives every file under it
 * a default place; the file's own path can move it (an `archive/` folder or a `.bak` copy is an old
 * version, `.dreams/` or a consolidation log is a summary, a binary store is a search index).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PLACES = [
  "note",
  "old_versions",
  "search_index",
  "summaries",
  "chat_record",
  "backups",
  "provider",
] as const;

export type PlaceId = (typeof PLACES)[number];

export const PLACE_TITLES: Record<PlaceId, string> = {
  note: "The notes",
  old_versions: "Old versions",
  search_index: "The search index",
  summaries: "Summaries",
  chat_record: "The chat record",
  backups: "Backups",
  provider: "The AI provider's copy",
};

export type Root = {
  /** A folder, or one file. */
  path: string;
  place: PlaceId;
  /** Folders only: walk sub-folders too (default true). */
  recurse?: boolean;
  /** Only files whose path relative to the root passes. */
  include?: (rel: string) => boolean;
  /** Folders swept at the top level only: the same filter as a git glob, for the history search. */
  topGlob?: string;
  /** A place for this file other than the root's, or undefined to keep the root's. */
  classify?: (rel: string) => PlaceId | undefined;
};

const OLD_VERSION_RE =
  /(^|\/)archive(\/|$)|ARCHIVE|\.bak($|[-._\d])|\.orig$|\.checkpoint\.|\.reset\.|\.deleted\.|~$/i;
const SUMMARY_RE =
  /(^|\/)(\.dreams|dreams?|consolidation[^/]*|digests?|summaries|reflections)(\/|$)|(^|\/)DREAMS\.md$/i;
/** Files that hold no searchable text: media, vectors, model weights. Never read. */
export const SKIP_EXT_RE =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp3|mp4|m4a|wav|ogg|opus|webm|mov|pdf|npz|npy|vec|onnx|bin|pt|safetensors|woff2?|ttf|so|node|wasm)$/i;
/** Archives and encrypted bundles: they can hold the fact, and nothing here can open them. */
export const ARCHIVE_EXT_RE = /\.(tar|tgz|gz|zip|7z|xz|zst|bz2|gpg|age|enc|asc|kdbx)$/i;
/** Folders never walked. The forget receipts hold no fact and must not be rewritten. */
export const SKIP_DIRS = new Set([".git", "node_modules"]);

export function placeOf(root: Root, rel: string, kind: "text" | "binary"): PlaceId {
  if (root.place === "backups") {
    return "backups";
  }
  if (kind === "binary") {
    return "search_index";
  }
  const own = root.classify?.(rel);
  if (own) {
    return own;
  }
  const posix = rel.split(sep).join("/");
  if (OLD_VERSION_RE.test(posix)) {
    return "old_versions";
  }
  if (root.place === "note" && SUMMARY_RE.test(posix)) {
    return "summaries";
  }
  return root.place;
}

export type RootInputs = {
  stateDir: string;
  home: string;
  /** Each agent's workspace (MEMORY.md, memory/, the always-read *.md files). */
  workspaceDirs: string[];
  /** memorySearch.extraPaths, as configured (relative ones resolve against each workspace). */
  memoryExtraPaths: string[];
  /** Claude Code's autoMemoryDirectory, when set. */
  autoMemoryDir: string | null;
  engramBaseDir: string;
  /** Sweep Claude Code's own transcripts and prompt history (~/.claude/projects, history.jsonl). */
  claudeCode: boolean;
  extraRoots: string[];
  backupDirs: string[];
};

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

const DATED_JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Every root that exists, most specific first, so a nested root claims its own files. */
export function resolveRoots(inp: RootInputs): Root[] {
  const roots: Root[] = [];
  const add = (r: Root) => {
    if (existsSync(r.path)) {
      roots.push({ ...r, path: resolve(r.path) });
    }
  };
  for (const ws of inp.workspaceDirs) {
    add({
      path: ws,
      place: "note",
      recurse: false,
      include: (rel) => /\.md$/i.test(rel),
      topGlob: "*.md",
    });
    add({ path: join(ws, "memory"), place: "note" });
    for (const extra of inp.memoryExtraPaths) {
      const p = expandHome(extra, inp.home);
      add({ path: isAbsolute(p) ? p : join(ws, p), place: "note" });
    }
  }
  if (inp.autoMemoryDir) {
    add({ path: expandHome(inp.autoMemoryDir, inp.home), place: "note" });
  }
  add({ path: join(inp.stateDir, "memory"), place: "note" });
  add({ path: join(inp.stateDir, "wiki"), place: "summaries" });
  add({
    path: join(inp.stateDir, "agents"),
    place: "chat_record",
    include: (rel) => /^[^/\\]+[/\\]sessions[/\\]/.test(rel),
  });
  add({ path: join(inp.stateDir, "sessions"), place: "chat_record" });
  add({
    path: inp.engramBaseDir,
    place: "summaries",
    // Events and externalized tool results are the chat itself; packs and reflections are derived.
    classify: (rel) =>
      rel.startsWith(`events${sep}`) ||
      rel.startsWith(`artifacts${sep}`) ||
      DATED_JSONL_RE.test(rel)
        ? "chat_record"
        : undefined,
  });
  if (inp.claudeCode) {
    add({
      path: join(inp.home, ".claude", "projects"),
      place: "chat_record",
      classify: (rel) => (/^[^/\\]+[/\\]memory([/\\]|$)/.test(rel) ? "note" : undefined),
    });
    add({ path: join(inp.home, ".claude", "history.jsonl"), place: "chat_record" });
  }
  for (const extra of inp.extraRoots) {
    add({ path: expandHome(extra, inp.home), place: "note" });
  }
  for (const dir of inp.backupDirs) {
    add({ path: expandHome(dir, inp.home), place: "backups" });
  }
  const seen = new Set<string>();
  return roots
    .filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)))
    .toSorted((a, b) => b.path.length - a.path.length);
}

/** The root that owns `file`: the most specific one it sits under. */
export function ownerRoot(roots: readonly Root[], file: string): Root | undefined {
  return roots.find((r) => {
    const rel = relative(r.path, file);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Where total-recall keeps its engram stores: its own discovery file, else the default. */
export function resolveEngramBaseDir(stateDir: string): string {
  try {
    const raw = JSON.parse(
      readFileSync(join(stateDir, "cognitive", "total-recall.json"), "utf8"),
    ) as { baseDir?: unknown };
    if (typeof raw.baseDir === "string" && raw.baseDir.trim()) {
      return raw.baseDir;
    }
  } catch {
    /* no discovery file: total-recall never ran here */
  }
  return join(stateDir, "engram");
}

/** A path for people to read: under the home folder it starts with "~". */
export function displayPath(p: string, home: string): string {
  const rel = relative(home, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel}` : p;
}
