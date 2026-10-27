import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

// FORK 2026-10-05 — git hands a hook GIT_DIR, and on a push from a linked worktree that is the
// worktree's gitdir, which shares the main repository's config. A gate the hook runs (bible
// invariants run test suites; several create scratch repos with `git init`) inherited it, so its
// `git init` in a temp folder re-initialised the MAIN repository instead and set core.bare = true.
// Every git command in the main checkout then failed with "this operation must be run in a work
// tree", twice in 21 minutes during one publish push. The hook now drops git's environment before
// its gates run.

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

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...baseEnv, ...env } }).trim();

afterEach(() => cleanupTempDirs(tempDirs));

describe("git-hooks/pre-push", () => {
  it("does not leak GIT_DIR into its gates: a gate's git init leaves the main repo non-bare", () => {
    const root = makeTempRepoRoot(tempDirs, "pre-push-gitdir-");
    const main = path.join(root, "main");
    mkdirSync(path.join(main, "git-hooks"), { recursive: true });
    mkdirSync(path.join(main, "scripts"), { recursive: true });
    git(root, ["init", "-q", "main"]);
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-push"),
      path.join(main, "git-hooks", "pre-push"),
    );
    // Gate 1 stand-in: the PII script reads the push lines from stdin and passes.
    writeFileSync(
      path.join(main, "scripts", "pii-pre-push.sh"),
      "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n",
      {
        mode: 0o755,
      },
    );
    // Gate 3 stand-in: what a test suite run by a gate does, a scratch repo in a temp folder.
    const scratch = makeTempRepoRoot(tempDirs, "pre-push-gate-scratch-");
    writeFileSync(
      path.join(main, "scripts", "lint-recurring-patterns.mjs"),
      `#!/usr/bin/env node\nimport { execFileSync } from "node:child_process";\n` +
        `execFileSync("git", ["init", "-q"], { cwd: ${JSON.stringify(scratch)} });\n`,
      { mode: 0o755 },
    );
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "fixture"]);
    git(main, ["config", "core.hooksPath", "git-hooks"]);
    git(root, ["init", "-q", "--bare", "remote.git"]);
    git(main, ["remote", "add", "origin", path.join(root, "remote.git")]);
    const wt = path.join(root, "publish-wt");
    git(main, ["worktree", "add", "-q", "--detach", wt]);
    expect(git(main, ["config", "--get", "core.bare"])).toBe("false");

    git(wt, ["push", "-q", "origin", "HEAD:refs/heads/develop"], {
      BIBLE_GUARD: "off",
      SDK_EXPORTS_GUARD: "off",
    });

    expect(git(path.join(root, "remote.git"), ["rev-parse", "develop"])).toBe(
      git(wt, ["rev-parse", "HEAD"]),
    );
    expect(git(main, ["config", "--get", "core.bare"])).toBe("false");
    expect(git(main, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  });

  // FORK 2026-10-05 — the invariant gate judged the SHARED checkout (BIBLE_DIR unset falls back to
  // ~/src/tinkerclaw), so a push from a clean publish worktree was blocked by another session's
  // uncommitted edit there. The hook now points the gate at the tree being pushed.
  it("runs the bible invariants against the tree being pushed, not the shared checkout", () => {
    const root = makeTempRepoRoot(tempDirs, "pre-push-bibledir-");
    const main = path.join(root, "main");
    mkdirSync(path.join(main, "git-hooks"), { recursive: true });
    mkdirSync(path.join(main, "scripts"), { recursive: true });
    git(root, ["init", "-q", "main"]);
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-push"),
      path.join(main, "git-hooks", "pre-push"),
    );
    writeFileSync(
      path.join(main, "scripts", "pii-pre-push.sh"),
      "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n",
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(main, "scripts", "lint-recurring-patterns.mjs"),
      "#!/usr/bin/env node\n",
      { mode: 0o755 },
    );
    const seen = path.join(root, "bible-dir-seen.txt");
    writeFileSync(
      path.join(main, "scripts", "record-bible-dir.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, process.env.BIBLE_DIR ?? "");\n`,
    );
    // A stand-in pnpm: the test home has no pnpm of its own, and only the env the gate receives matters.
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "pnpm"),
      `#!/usr/bin/env bash\n[ "$1" = "bible:invariants" ] && exec node scripts/record-bible-dir.mjs\nexit 0\n`,
      { mode: 0o755 },
    );
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "fixture"]);
    git(main, ["config", "core.hooksPath", "git-hooks"]);
    git(root, ["init", "-q", "--bare", "remote.git"]);
    git(main, ["remote", "add", "origin", path.join(root, "remote.git")]);
    const wt = path.join(root, "publish-wt");
    git(main, ["worktree", "add", "-q", "--detach", wt]);

    const env: NodeJS.ProcessEnv = { SDK_EXPORTS_GUARD: "off" };
    delete (env as Record<string, unknown>).BIBLE_DIR;
    git(wt, ["push", "-q", "origin", "HEAD:refs/heads/develop"], {
      ...env,
      BIBLE_DIR: "",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(readFileSync(seen, "utf8")).toBe(path.join(wt, "TINKER_UI_DESIGN_BIBLE"));
  });
});
