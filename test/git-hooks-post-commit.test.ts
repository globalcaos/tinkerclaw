import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const tempDirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

// A stand-in for the real formatter hook: rewrite each staged file and re-stage it, which is what
// oxfmt + `git add` do in git-hooks/pre-commit.
const FORMATTER =
  '#!/usr/bin/env bash\nfor f in $(git diff --cached --name-only); do sed -i s/ugly/pretty/ "$f"; git add -- "$f"; done\n';

function repo(): string {
  const dir = makeTempRepoRoot(tempDirs, "post-commit-phantoms-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  writeFileSync(path.join(dir, "git-hooks", "pre-commit"), FORMATTER, { mode: 0o755 });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "post-commit"),
    path.join(dir, "git-hooks", "post-commit"),
  );
  git(dir, "config", "core.hooksPath", "git-hooks");
  writeFileSync(path.join(dir, "f.txt"), "a\n");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("git-hooks/post-commit (integration)", () => {
  it("leaves no phantom staged entry after a pathspec commit the formatter rewrote", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "f.txt"), "ugly\n");
    git(dir, "commit", "-qm", "c1", "--", "f.txt");
    expect(git(dir, "show", "HEAD:f.txt")).toBe("pretty");
    expect(readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("pretty\n");
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("keeps another file that was staged but not part of the commit", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "g.txt"), "someone else's work\n");
    git(dir, "add", "g.txt");
    writeFileSync(path.join(dir, "h.txt"), "ugly\n");
    git(dir, "add", "h.txt");
    git(dir, "commit", "-qm", "c2", "--", "h.txt");
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("A  g.txt");
  });
});
