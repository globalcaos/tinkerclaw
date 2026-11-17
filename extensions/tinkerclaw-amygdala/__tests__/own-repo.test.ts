import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allInRepos, ownRepoRoots } from "../src/own-repo.js";
import type { ResolvedTarget } from "../src/types.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "amy-own-")));
  made.push(d);
  return d;
};
const file = (path: string): ResolvedTarget => ({ path, kind: "file", resolvedFrom: path });

describe("ownRepoRoots", () => {
  it("finds the repository above the plugin, and its linked worktrees", () => {
    const main = tmp();
    const linked = tmp();
    mkdirSync(join(main, ".git", "worktrees", "w1"), { recursive: true });
    mkdirSync(join(main, "extensions", "amy"), { recursive: true });
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(main, ".git", "worktrees", "w1", "gitdir"), `${linked}/.git\n`);
    expect(ownRepoRoots(join(main, "extensions", "amy")).sort()).toEqual([main, linked].sort());
  });

  it("from inside a linked worktree it still finds the main checkout", () => {
    const main = tmp();
    const linked = tmp();
    mkdirSync(join(main, ".git", "worktrees", "w1"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "w1", "gitdir"), `${linked}/.git\n`);
    writeFileSync(join(linked, ".git"), `gitdir: ${main}/.git/worktrees/w1\n`);
    expect(ownRepoRoots(linked).sort()).toEqual([main, linked].sort());
  });

  it("outside any repository: no roots", () => {
    expect(ownRepoRoots(tmp())).toEqual([]);
  });
});

describe("allInRepos", () => {
  it("needs every target inside, and at least one target", () => {
    expect(allInRepos([file("/r/a.ts")], ["/r"])).toBe(true);
    expect(allInRepos([file("/r/a.ts"), file("/x/b.ts")], ["/r"])).toBe(false);
    expect(allInRepos([file("/rest/a.ts")], ["/r"])).toBe(false);
    expect(allInRepos([], ["/r"])).toBe(false);
    expect(allInRepos([{ path: "/r", kind: "url", resolvedFrom: "x" }], ["/r"])).toBe(false);
  });
});
