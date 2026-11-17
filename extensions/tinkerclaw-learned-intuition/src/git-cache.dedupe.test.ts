/**
 * FORK 2026-10-29: the git cache, counted in `git log` spawns.
 *
 * buildSituation asks for the commits and the authors of one target in the same tick. Both reads
 * used to miss the cache and run two `git log` each: four spawns per cold target, each one blocking
 * the gateway's main thread. Now the reads share one lookup, the lookup runs one `git log`, and a
 * target whose directory is missing answers 0/0 with no spawn.
 *
 * The counts must not move, because the learned gate was trained on them. Each value is checked
 * against the two old commands on the same fixture, and the fixture holds a commit with an empty
 * author name: the one case where the old commands disagree on the number of lines.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCache, type GitCacheConfig } from "./git-cache.js";

// Pass-through spies: git really runs and the spies only count. git-cache.ts calls
// promisify(execFile), which hands back execFile[promisify.custom], so that one must count.
const execFileSpies = vi.hoisted(() => ({ promised: vi.fn(), callback: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  execFileSpies.promised.mockImplementation(promisify(actual.execFile));
  execFileSpies.callback.mockImplementation(actual.execFile);
  Object.assign(execFileSpies.callback, { [promisify.custom]: execFileSpies.promised });
  return { ...actual, execFile: execFileSpies.callback };
});

/** execFile calls since the last clear, in either form. */
function gitSpawns(): number {
  return execFileSpies.promised.mock.calls.length + execFileSpies.callback.mock.calls.length;
}

const TARGET = "a.md";
const CONFIG: GitCacheConfig = { enabled: false, watch_paths: [], ttl_seconds: 300 };

let tmp = "";
let repo = "";
const savedGitEnv: Record<string, string> = {};

/** Fixture writes. No global or system git config: no signing, hooks or identity from the host. */
function git(args: string[], env: Record<string, string> = {}, input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_COMMITTER_NAME: "Committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
      ...env,
    },
  }).trim();
}

async function commit(file: string, content: string, author: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), content);
  git(["add", file]);
  git(["commit", "-q", "-m", `${author} edits ${file}`], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.invalid`,
  });
}

/** `git commit` refuses an empty author name. A commit object written by hand can carry one. */
async function commitWithEmptyAuthorName(file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), content);
  git(["add", file]);
  const tree = git(["write-tree"]);
  const parent = git(["rev-parse", "HEAD"]);
  const when = `${Math.floor(Date.now() / 1000)} +0000`;
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    // Two spaces: an empty name, then the space git expects before the email.
    `author  <nobody@example.invalid> ${when}`,
    `committer Committer <committer@example.invalid> ${when}`,
    "",
    "empty author name",
    "",
  ].join("\n");
  const sha = git(["hash-object", "-t", "commit", "-w", "--stdin", "--literally"], {}, object);
  git(["update-ref", "refs/heads/main", sha, parent]);
}

interface OldCounts {
  commits: number;
  authors: number;
  /** Non-blank `--format=%an` lines: one per commit whose author name is not blank. */
  authorLines: number;
}

/** The two commands git-cache.ts ran before 2026-10-29, counted the way it counted them. */
function oldCounts(filePath: string): OldCounts {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const run = (format: string): string[] =>
    execFileSync("git", ["-C", dir, "log", "--since=72 hours ago", format, "--", file], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\n")
      .filter((line) => line.trim().length > 0);
  const authorLines = run("--format=%an");
  return {
    commits: run("--oneline").length,
    authors: new Set(authorLines).size,
    authorLines: authorLines.length,
  };
}

describe("git cache lookups", () => {
  beforeAll(async () => {
    // A git hook exports GIT_DIR, GIT_INDEX_FILE and more. Inherited, they would aim every command
    // here, the fixture's writes included, at another repository.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("GIT_") && value !== undefined) {
        savedGitEnv[key] = value;
        delete process.env[key];
      }
    }
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-dedupe-"));
    repo = path.join(tmp, "repo");
    await fs.mkdir(repo);
    git(["init", "-q", "-b", "main"]);
    await commit(TARGET, "1\n", "Alpha");
    await commit(TARGET, "2\n", "Alpha");
    await commit("other.md", "1\n", "Gamma");
    await commit(TARGET, "3\n", "Beta");
    await commitWithEmptyAuthorName(TARGET, "4\n");
  });

  afterAll(async () => {
    Object.assign(process.env, savedGitEnv);
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    execFileSpies.promised.mockClear();
    execFileSpies.callback.mockClear();
  });

  it("CONTROL: the fixture holds the commit the two old commands count differently", () => {
    // Four commits touch a.md. The empty name gives a blank %an line, so three author lines and
    // two distinct authors. If this fails the fixture is wrong, not the product.
    expect(oldCounts(path.join(repo, TARGET))).toEqual({ commits: 4, authors: 2, authorLines: 3 });
  });

  it("serves both reads of a cold target from one git spawn, with the old counts", async () => {
    const target = path.join(repo, TARGET);
    const old = oldCounts(target);
    const cache = new GitCache(CONFIG);

    const [commits, authors] = await Promise.all([
      cache.getRecentCommits(target, 72),
      cache.getRecentAuthors(target, 72),
    ]);

    expect({ commits, authors }).toEqual({ commits: old.commits, authors: old.authors });
    expect(gitSpawns()).toBe(1);
    expect(execFileSpies.promised.mock.calls[0]?.slice(0, 2)).toEqual([
      "git",
      ["-C", repo, "log", "--since=72 hours ago", "--format=%H%x09%an", "--", TARGET],
    ]);
  });

  it("empties the in-flight slot once the lookup settles", async () => {
    // ttl 0 serves nothing from the cache, so a read after the first lookup settled must start
    // another one, not join the finished one.
    const target = path.join(repo, TARGET);
    const cache = new GitCache({ ...CONFIG, ttl_seconds: 0 });

    await Promise.all([cache.getRecentCommits(target, 72), cache.getRecentAuthors(target, 72)]);
    expect(gitSpawns()).toBe(1);

    await cache.getRecentCommits(target, 72);
    expect(gitSpawns()).toBe(2);
  });

  it("gives each window its own lookup when two overlap", async () => {
    // Only a read for the same window joins: a 1-hour read never takes a 72-hour count.
    const target = path.join(repo, TARGET);
    const cache = new GitCache(CONFIG);

    const counts = await Promise.all([
      cache.getRecentCommits(target, 72),
      cache.getRecentCommits(target, 1),
    ]);

    expect(counts).toEqual([4, 4]);
    expect(gitSpawns()).toBe(2);
  });

  it("starts a new lookup after invalidate(), even with one in flight", async () => {
    const target = path.join(repo, TARGET);
    const cache = new GitCache(CONFIG);

    const first = cache.getRecentCommits(target, 72);
    cache.invalidate(target);
    const second = cache.getRecentCommits(target, 72);

    expect(await Promise.all([first, second])).toEqual([4, 4]);
    expect(gitSpawns()).toBe(2);
  });

  it("answers 0/0 with no spawn when the directory is missing or not a directory", async () => {
    const missingDir = path.join(tmp, "no-such-dir");
    const targets = [
      path.join(missingDir, TARGET),
      // The live shape: a shell command that classifyTargetType took for a path.
      `cat ${path.join(missingDir, TARGET)} | head -n 1`,
      // The directory part names a file.
      path.join(repo, TARGET, "child.md"),
    ];
    const cache = new GitCache(CONFIG);

    for (const target of targets) {
      // CONTROL: the old command fails on this target, so the old code answered 0/0 too.
      expect(() => oldCounts(target)).toThrow();
      const counts = await Promise.all([
        cache.getRecentCommits(target, 72),
        cache.getRecentAuthors(target, 72),
      ]);
      expect(counts).toEqual([0, 0]);
    }
    expect(gitSpawns()).toBe(0);
  });
});
