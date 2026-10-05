import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutDrift } from "../../scripts/lib/checkout-drift.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

// FORK 2026-10-05 — the Tinker page is built from ~/src/tinkerclaw's working tree. A dead session
// left it on its own branch, 11 commits behind develop, and the page's rebuild said "ok" over a
// build that lacked everything merged into develop since (the Gantt tab among them).

const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
delete env.GIT_DIR;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo(): string {
  const root = makeTempRepoRoot(tempDirs, "checkout-drift-");
  git(root, "init", "-q", "-b", "develop");
  git(root, "commit", "-q", "--allow-empty", "-m", "a");
  return root;
}

describe("checkoutDrift", () => {
  it("says nothing when the checkout is on develop at its tip", () => {
    expect(checkoutDrift(repo())).toBeNull();
  });

  it("names the branch and the develop commits a build from it would lack", () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "fix/someone-else");
    git(root, "checkout", "-q", "develop");
    git(root, "commit", "-q", "--allow-empty", "-m", "b");
    git(root, "commit", "-q", "--allow-empty", "-m", "c");
    git(root, "checkout", "-q", "fix/someone-else");
    const drift = checkoutDrift(root);
    expect(drift).toMatchObject({ branch: "fix/someone-else", behind: 2 });
    expect(drift?.warning).toContain("branch fix/someone-else");
    expect(drift?.warning).toContain("2 commit(s) of develop");
  });

  it("warns on a branch that is level with develop too: it is still not develop", () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "fix/level");
    expect(checkoutDrift(root)).toMatchObject({ branch: "fix/level", behind: 0 });
  });

  it("names a detached HEAD", () => {
    const root = repo();
    git(root, "checkout", "-q", "--detach");
    expect(checkoutDrift(root)?.warning).toContain("a detached HEAD");
  });

  it("stays quiet where there is no git or no develop to compare with", () => {
    expect(checkoutDrift(makeTempRepoRoot(tempDirs, "no-git-"))).toBeNull();
  });
});
