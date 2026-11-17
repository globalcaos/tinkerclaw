import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBibleDir, selectBibleFiles } from "../../scripts/test-invariants.mjs";

// FORK 2026-09-24 (final fix brief F14) — the bible gate read only the SHARED checkout's bible,
// so a worktree's bible edits could not be gated before a merge. BIBLE_DIR overrides it.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("test-invariants BIBLE_DIR", () => {
  const sharedBible = path.resolve(os.homedir(), "src/tinkerclaw/TINKER_UI_DESIGN_BIBLE");

  it("defaults to the shared checkout's bible, as before", () => {
    expect(resolveBibleDir({})).toBe(sharedBible);
    expect(resolveBibleDir({ BIBLE_DIR: "   " })).toBe(sharedBible);
  });

  it("BIBLE_DIR points the gate at another checkout's bible (absolute or relative)", () => {
    const dir = path.join(os.tmpdir(), "wt", "TINKER_UI_DESIGN_BIBLE");
    expect(resolveBibleDir({ BIBLE_DIR: dir })).toBe(dir);
    expect(resolveBibleDir({ BIBLE_DIR: "TINKER_UI_DESIGN_BIBLE" })).toBe(
      path.resolve("TINKER_UI_DESIGN_BIBLE"),
    );
  });

  it("the runner reads the overridden directory (an empty one is a runner error, exit 2)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bible-dir-"));
    tmpDirs.push(dir);
    const run = spawnSync(process.execPath, ["scripts/test-invariants.mjs"], {
      env: { ...process.env, BIBLE_DIR: dir },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`no .md files in ${dir}`);
  });
});

// FORK 2026-11-14 — named files narrow the per-file run, the bible-currency gate's check of the
// optics a change touched: one call, the real bible folder, no scope folder to make and remove.
describe("test-invariants named files", () => {
  const bibleWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bible-named-"));
    tmpDirs.push(dir);
    for (const [name, cmd] of Object.entries(files)) {
      writeFileSync(
        path.join(dir, name),
        `---\nverify:\n  - name: ${name} holds\n    cmd: ${cmd}\n---\n\n# ${name}\n`,
      );
    }
    return dir;
  };
  const run = (dir: string, args: string[]) =>
    spawnSync(process.execPath, ["scripts/test-invariants.mjs", ...args], {
      env: { ...process.env, BIBLE_DIR: dir },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("runs the verify blocks of the named files only", () => {
    const dir = bibleWith({ "alpha.md": "exit 0", "beta.md": "exit 1" });
    const out = run(dir, ["alpha.md"]).stdout;
    expect(out).toMatch(/alpha\.md \(1\/1\)/);
    expect(out).not.toMatch(/beta\.md \(/);
    const all = run(dir, []).stdout;
    expect(all).toMatch(/alpha\.md \(1\/1\)/);
    expect(all).toMatch(/beta\.md \(0\/1\)/);
    // The meta-verify reads the whole bible either way.
    const meta = (s: string) => s.match(/bible meta-verify \(\d+\/\d+\)/)?.[0];
    expect(meta(out)).toBeDefined();
    expect(meta(out)).toBe(meta(all));
  });

  it("a name that is not a bible file is a runner error (exit 2), never a pass", () => {
    const dir = bibleWith({ "alpha.md": "exit 0" });
    const r = run(dir, ["nope.md"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nope.md");
  });

  it("selectBibleFiles keeps the bible's order and takes a path or a bare name", () => {
    const all = ["a.md", "b.md", "c.md"];
    expect(selectBibleFiles(all, ["TINKER_UI_DESIGN_BIBLE/c.md", "a.md"])).toEqual({
      files: ["a.md", "c.md"],
      missing: [],
    });
    expect(selectBibleFiles(all, [])).toEqual({ files: all, missing: [] });
    expect(selectBibleFiles(all, ["x.md"]).missing).toEqual(["x.md"]);
  });
});
