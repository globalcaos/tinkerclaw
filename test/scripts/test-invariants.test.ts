import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBibleDir } from "../../scripts/test-invariants.mjs";

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
