import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCache, historyFor } from "../src/git-cache.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "amygdala-git-"));
  dirs.push(d);
  return d;
}

function git(dir: string, author: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      `user.name=${author}`,
      "-c",
      `user.email=${author}@example.com`,
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdio: "ignore" },
  );
}

describe("historyFor", () => {
  it("counts edits and authors over 72 h in a temp repo", async () => {
    const d = tmp();
    git(d, "alice", "init", "-q");
    const f = join(d, "a.txt");
    writeFileSync(f, "one\n");
    git(d, "alice", "add", "a.txt");
    git(d, "alice", "commit", "-q", "-m", "first");
    writeFileSync(f, "one\ntwo\n");
    git(d, "bob", "add", "a.txt");
    git(d, "bob", "commit", "-q", "-m", "second");

    const h = await new GitCache({ enabled: false, watch_paths: [], ttl_seconds: 30 }).historyFor(
      f,
    );
    expect(h).not.toBeNull();
    expect(h?.edits72h).toBe(2);
    expect(h?.authors72h).toBe(2);
    expect(h?.sizeB).toBe(8);
    expect(h?.ageH).toBeGreaterThanOrEqual(0);
    expect(h?.lastMentionedByUser).toBeNull();
  });

  it("returns null outside a git repo and for a missing path", async () => {
    const d = tmp();
    const f = join(d, "plain.txt");
    writeFileSync(f, "x");
    expect(await historyFor(f)).toBeNull();
    expect(await historyFor(join(d, "nope.txt"))).toBeNull();
  });

  it("passes a path with backticks and $(...) as one argv element and never runs it", async () => {
    const d = tmp();
    git(d, "alice", "init", "-q");
    const name = `amygdala-pwned-${process.pid}-${Date.now()}`;
    const marker = join(process.cwd(), name);
    const sub = join(d, `\`touch ${name}\` $(touch ${name})`);
    mkdirSync(sub);
    const f = join(sub, "f.txt");
    writeFileSync(f, "x");
    const h = await new GitCache({ enabled: false, watch_paths: [], ttl_seconds: 30 }).historyFor(
      f,
    );
    expect(h).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(d, name))).toBe(false);
  });
});
