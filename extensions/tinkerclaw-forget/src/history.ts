/**
 * Old versions in git, and the copies git has already sent elsewhere.
 *
 * A redacted note is clean at HEAD, but every commit that once held the fact still holds it, and
 * a remote keeps whatever was pushed. Rewriting history is a separate, deliberate act (it changes
 * every later commit id and needs a force-push), so this module only counts: which commits still
 * hold it, which remotes have them. The receipt lists both as out of reach.
 *
 * `git log -S` takes the fact as an argument, so for the few seconds the search runs it is visible
 * to `ps` on this machine. `--no-renames` matters: with rename detection, one repo took 112 s;
 * without it, 11 s (measured 2026-10-25, 583 commits).
 */

import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 << 20;

export type RepoHistory = {
  repo: string;
  /** Commits whose diff adds or removes the fact; null when the search did not finish. */
  commits: number | null;
  remotes: string[];
  error?: string;
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

async function toplevel(path: string, isFile: boolean): Promise<string | null> {
  try {
    return (
      (await git(isFile ? dirname(path) : path, ["rev-parse", "--show-toplevel"])).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The repos that hold any of `paths`, each with its pathspecs. A folder swept only at its top
 * level (`topGlob`, e.g. the workspace's `*.md`) becomes a glob pathspec: as "." it would make
 * git search the whole repository (60 s and still running on 28,618 commits, 2026-10-25).
 */
export async function reposOf(
  paths: ReadonlyArray<{ path: string; isFile: boolean; topGlob?: string }>,
): Promise<Map<string, string[]>> {
  const repos = new Map<string, string[]>();
  for (const p of paths) {
    const top = await toplevel(p.path, p.isFile);
    if (!top) {
      continue;
    }
    const rel = relative(top, p.path);
    const spec = p.topGlob ? `:(glob)${rel ? `${rel}/` : ""}${p.topGlob}` : rel || ".";
    repos.set(top, [...(repos.get(top) ?? []), spec]);
  }
  return repos;
}

export async function searchHistory(args: {
  repos: ReadonlyMap<string, string[]>;
  literals: readonly string[];
}): Promise<RepoHistory[]> {
  const out: RepoHistory[] = [];
  for (const [repo, pathspecs] of args.repos) {
    const commits = new Set<string>();
    let error: string | undefined;
    for (const lit of args.literals) {
      try {
        const stdout = await git(repo, [
          "log",
          "--all",
          "--no-renames",
          "--regexp-ignore-case",
          "--format=%H",
          `-S${lit}`,
          "--",
          ...pathspecs,
        ]);
        for (const line of stdout.split("\n")) {
          if (line.trim()) {
            commits.add(line.trim());
          }
        }
      } catch (err) {
        error = (err as { killed?: boolean }).killed
          ? `the history search did not finish in ${GIT_TIMEOUT_MS / 1000} s`
          : `git log failed: ${(err as Error).message.split("\n")[0]}`;
        break;
      }
    }
    let remotes: string[] = [];
    try {
      remotes = (await git(repo, ["remote"]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* no remotes */
    }
    out.push({ repo, commits: error ? null : commits.size, remotes, error });
  }
  return out;
}
