#!/usr/bin/env node
/**
 * INDEX.md — the Files table lists exactly the optics that exist, in BOTH directions.
 *
 * The inventory lives in TINKER_UI_DESIGN_BIBLE/INDEX.md and is the authority; this file is only
 * its executable encoding. It lives here rather than in that file's YAML frontmatter per
 * FOUNDATION.md, "Three different jobs, three different homes": the bible EXPLAINS, the running
 * code ENFORCES, and `scripts/bible/*.mjs` CHECKS that the two still agree. Job 3 is CI — it wants
 * linting, review and its own negative test, none of which YAML frontmatter can give it.
 *
 * DERIVED, NOT FROZEN (design-principles.md #19, #20):
 *   The check this replaced asserted `len(files) >= 18` while 29 optics existed. Eleven of them
 *   could have been deleted and it would still have passed — a floor that reality has outgrown is
 *   a check that cannot fail. The number is not the invariant; the CORRESPONDENCE is, so it is
 *   derived from the directory at every run and both directions are load-bearing:
 *     - an optic on disk with no row is INVISIBLE to every agent that reads INDEX.md to navigate;
 *     - a row naming a file that does not exist is a DANGLING POINTER that sends agents nowhere.
 *
 * Usage: node scripts/bible/index-files-table.mjs
 * Exit 0 = the table matches the directory. Exit 1 = drift, with both lists on stderr.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from THIS file's location, never from $HOME: the check must hold in a git worktree or a
// clone on another machine, which is FOUNDATION #9 (bounded in space) applied to the gate itself.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bibleDir = path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE");

const index = readFileSync(path.join(bibleDir, "INDEX.md"), "utf8");
const parts = index.split("## Files");
if (parts.length < 2) {
  console.error("INDEX.md has no '## Files' section — the live inventory is gone.");
  process.exit(1);
}
const table = parts.slice(1).join("## Files");

// A row is a table line whose first cell is a backticked *.md name.
const listed = new Set(Array.from(table.matchAll(/^\|\s*`([^`]+\.md)`/gm)).map((m) => m[1]));
const onDisk = new Set(readdirSync(bibleDir).filter((f) => f.endsWith(".md")));

const missing = [...onDisk].filter((f) => !listed.has(f)).toSorted(); // exists but undocumented
const phantom = [...listed].filter((f) => !onDisk.has(f)).toSorted(); // documented but absent

if (missing.length || phantom.length) {
  console.error("INDEX.md's Files table no longer matches the optics on disk.\n");
  if (missing.length) {
    console.error(
      `  optics on disk with no INDEX row: ${JSON.stringify(missing)}\n` +
        "    → invisible to every agent that navigates by INDEX.md; add a row.",
    );
  }
  if (phantom.length) {
    console.error(
      `  INDEX rows naming files that do not exist: ${JSON.stringify(phantom)}\n` +
        "    → a dangling pointer; delete the row or restore the optic.",
    );
  }
  process.exit(1);
}

console.log(`INDEX Files table: ${onDisk.size} optic(s) on disk, all listed, no dangling rows.`);
