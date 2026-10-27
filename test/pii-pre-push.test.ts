import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

// FORK 2026-10-27 — the leak grep matched `^\+[^+].*(PII_RE)`, and `[^+]` spent the first character
// of every added line, so a private token at column 0 ("+<FirstName> said …") never matched. These run the
// real script against a scratch repo with a private list holding one made-up token.

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "pii-pre-push.sh");
const TOKEN = "Zqxvwplk";
const tempDirs: string[] = [];
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
delete baseEnv.GIT_DIR;
delete baseEnv.GIT_WORK_TREE;
delete baseEnv.GIT_INDEX_FILE;
delete baseEnv.PII_GUARD;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: baseEnv }).trim();

afterEach(() => cleanupTempDirs(tempDirs));

function pushOf(fileBody: string, fileName = "notes.md"): number {
  const root = makeTempRepoRoot(tempDirs, "pii-pre-push-");
  const list = path.join(root, "private.re");
  writeFileSync(list, `# test list\n${TOKEN}\n`);
  const repo = path.join(root, "repo");
  git(root, ["init", "-q", "repo"]);
  writeFileSync(path.join(repo, "base.md"), "base\n");
  git(repo, ["add", "base.md"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, fileName), fileBody);
  git(repo, ["add", fileName]);
  git(repo, ["commit", "-q", "-m", "change"]);
  const tip = git(repo, ["rev-parse", "HEAD"]);
  const run = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    input: `refs/heads/develop ${tip} refs/heads/develop ${base}\n`,
    encoding: "utf8",
    env: { ...baseEnv, HOME: root, TINKERCLAW_PII_FILE: list },
  });
  return run.status ?? -1;
}

describe("scripts/pii-pre-push.sh", () => {
  it("blocks a private token at the very start of an added line", () => {
    expect(pushOf(`${TOKEN} said this\n`)).toBe(1);
  });

  it("blocks a private token in the middle of an added line", () => {
    expect(pushOf(`and then ${TOKEN} said this\n`)).toBe(1);
  });

  it("passes a clean change, and a token only in the file name is not a content hit", () => {
    expect(pushOf("nothing private here\n")).toBe(0);
    expect(pushOf("nothing private here\n", `${TOKEN}.md`)).toBe(0);
  });
});
