/**
 * The repository this plugin runs from, with its linked worktrees (2026-11-01). `selfModification: "unlocked"` lifts the
 * weakens-own-check hold only for files here: the agent's own code, never a project it happens to be working on.
 * A plugin installed outside a checkout finds no repository, so nothing counts as its own and the hold stays.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedTarget } from "./types.js";

/** A `.git` file (linked worktree) or a `.git` folder with a HEAD. An empty `.git` folder is not a repository. */
function isRepo(dir: string): boolean {
  const dotGit = path.join(dir, ".git");
  if (!existsSync(dotGit)) return false;
  return statSync(dotGit).isFile() || existsSync(path.join(dotGit, "HEAD"));
}

function repoOf(start: string): string | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (isRepo(dir)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The path sits in a git checkout or a linked worktree. A look that fails counts as yes, which keeps the step asked. */
export function inCheckout(p: string): boolean {
  try {
    return repoOf(p) !== null;
  } catch {
    return true;
  }
}

/** The main checkout of a repo root that may itself be a linked worktree (`.git` is then a file naming the real one). */
function commonGitDir(root: string): string {
  const dotGit = path.join(root, ".git");
  if (statSync(dotGit).isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return dotGit;
  // <main>/.git/worktrees/<name> -> <main>/.git
  return path.resolve(root, m[1].trim(), "..", "..");
}

export function ownRepoRoots(start = path.dirname(fileURLToPath(import.meta.url))): string[] {
  try {
    const root = repoOf(start);
    if (!root) return [];
    const git = commonGitDir(root);
    const roots = new Set([root, path.dirname(git)]);
    const worktrees = path.join(git, "worktrees");
    if (existsSync(worktrees)) {
      for (const name of readdirSync(worktrees)) {
        const file = path.join(worktrees, name, "gitdir");
        if (existsSync(file)) roots.add(path.dirname(readFileSync(file, "utf8").trim()));
      }
    }
    return [...roots];
  } catch {
    return [];
  }
}

/** Every target of the step is a file inside `roots`. No target, or any target elsewhere, is not own code. */
export function allInRepos(targets: readonly ResolvedTarget[], roots: readonly string[]): boolean {
  if (targets.length === 0 || roots.length === 0) return false;
  return targets.every(
    (t) =>
      (t.kind === "file" || t.kind === "dir" || t.kind === "unknown") &&
      roots.some((r) => t.path === r || t.path.startsWith(r + path.sep)),
  );
}
