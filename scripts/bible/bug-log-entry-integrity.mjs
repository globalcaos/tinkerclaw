#!/usr/bin/env node
/**
 * Entry integrity for TINKER_UI_DESIGN_BIBLE/bug-log.md.
 *
 * The bug-log EXPLAINS; this file CHECKS. They are deliberately separate artefacts — FOUNDATION.md,
 * "Three different jobs, three different homes": a program pasted into YAML frontmatter cannot be
 * linted, reviewed, or negative-tested, and the bug-log's own 2026-08-04 META entries are about
 * gates that were wrong in exactly that way. When this script and bug-log.md disagree, bug-log.md
 * is right and this file is the bug.
 *
 * The two things worth enforcing about an entry, both cheap:
 *
 *   --check=chips  Every `[tag+tag]` chip in an entry header is DEFINED in the taxonomy table.
 *                  The table's own instruction is "pick from this list — extend it only if no tag
 *                  fits", and the way that instruction fails is silently: someone invents a chip,
 *                  nobody adds the row, and the table stops being the index it claims to be. This
 *                  is the `auth-scope` entry's reflex #1 applied to the document — a registry keyed
 *                  by an ENUMERABLE set needs a gate asserting the registry COVERS the set.
 *
 *   --check=shas   Every commit SHA an entry cites still RESOLVES to a commit in this repo. A
 *                  bug-log whose fix pointers have rotted is a story, not a forensic record.
 *
 *   --self-test    Negative-tests both checks against synthetic bad input: break the thing, watch
 *                  it go red, restore, watch it go green. A check nobody has ever seen FAIL is
 *                  indistinguishable from a check that cannot fail.
 *
 * The bible file is resolved relative to THIS script, not to ~/src/tinkerclaw, so the gate tests
 * whatever checkout it lives in — including a git worktree. (scripts/test-invariants.mjs pins
 * BIBLE_DIR to ~/src/tinkerclaw, so the runner alone cannot see worktree edits.)
 *
 * Usage:
 *   node scripts/bible/bug-log-entry-integrity.mjs              # both checks
 *   node scripts/bible/bug-log-entry-integrity.mjs --check=chips
 *   node scripts/bible/bug-log-entry-integrity.mjs --check=shas
 *   node scripts/bible/bug-log-entry-integrity.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUG_LOG = path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "bug-log.md");

/**
 * Pre-existing citations that do NOT resolve, recorded rather than silently tolerated.
 * Both sit on one "Commits: Phase 1 … Phase 7" line whose other six SHAs resolve fine, so they
 * were most likely rebased away or mistranscribed long before this gate existed. They are exempt
 * so the gate is born GREEN — a gate introduced red is not a gate (see the 2026-08-04 META entry).
 * Do not add to this set to make a NEW failure go away; fix the citation instead.
 */
const KNOWN_UNRESOLVABLE = new Set(["25552c1b40", "9e444add28"]);

/** `| \`tag\` | meaning |` rows of the failure-class taxonomy table. */
const TAXONOMY_ROW = /^\| `([a-z][a-z-]*)`/gm;

/**
 * Entry headers, e.g. `### FIXED [dist-gap+bundler-trap]: …` or `### OPEN [plugin-load]: …`.
 * FOLLOW-UP headers carry a parenthetical before the chip, so the status word is matched loosely
 * and only the FIRST bracket group on the line is read.
 */
const ENTRY_HEADER = /^### (?:~~)?(?:FIXED|OPEN|META|FOLLOW-UP)\b[^[\n]*\[([^\]\n]+)\]/gm;

/** A cited commit SHA is always in backticks in this file. */
const CITED_SHA = /`([0-9a-f]{10,40})`/g;

function definedChips(text) {
  return new Set(Array.from(text.matchAll(TAXONOMY_ROW), (m) => m[1]));
}

function usedChips(text) {
  const out = new Set();
  for (const m of text.matchAll(ENTRY_HEADER)) {
    for (const chip of m[1].split("+")) {
      const t = chip.trim();
      // Chips are lowercase-kebab; a bracket holding prose (a codename, a quoted phrase) is not
      // a chip and is not the taxonomy's business.
      if (/^[a-z][a-z-]*$/.test(t)) out.add(t);
    }
  }
  return out;
}

function checkChips(text) {
  const defined = definedChips(text);
  const used = usedChips(text);
  const missing = [...used].filter((c) => !defined.has(c)).sort();
  if (missing.length) {
    return {
      ok: false,
      message:
        `bug-log.md: ${missing.length} chip(s) used in an entry header but absent from the ` +
        `failure-class taxonomy table: ${missing.join(", ")}.\n` +
        `Add a row to the table (it is the index an AI scans instead of re-reading every entry), ` +
        `or reuse an existing chip.`,
    };
  }
  return { ok: true, message: `chips: ${used.size} used, all defined among ${defined.size} rows.` };
}

function resolves(sha) {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkShas(text) {
  const cited = [...new Set(Array.from(text.matchAll(CITED_SHA), (m) => m[1]))].sort();
  const rotted = cited.filter((s) => !KNOWN_UNRESOLVABLE.has(s) && !resolves(s));
  if (rotted.length) {
    return {
      ok: false,
      message:
        `bug-log.md cites ${rotted.length} commit SHA(s) that do not resolve in this repo: ` +
        `${rotted.join(", ")}.\n` +
        `A fix pointer that no longer resolves turns a forensic record back into a story. ` +
        `Correct the SHA — do not add it to KNOWN_UNRESOLVABLE.`,
    };
  }
  return {
    ok: true,
    message:
      `shas: ${cited.length} cited, ${cited.length - KNOWN_UNRESOLVABLE.size} resolve ` +
      `(${KNOWN_UNRESOLVABLE.size} pre-existing exemptions).`,
  };
}

/** Break the thing, see it go red; restore, see it go green. */
function selfTest() {
  const good = readFileSync(BUG_LOG, "utf8");
  const cases = [
    {
      name: "chips: an undefined chip in an entry header fails",
      text: good.replace(
        "### FIXED [dist-gap+bundler-trap]:",
        "### FIXED [dist-gap+not-a-real-chip]:",
      ),
      run: checkChips,
    },
    {
      name: "shas: a rotted citation fails",
      // 9bf4ec00e26 -> 9bf4ec00e2f, same shape, not a commit.
      text: good.replace("`9bf4ec00e26`", "`9bf4ec00e2f`"),
      run: checkShas,
    },
  ];
  let failed = false;
  for (const c of cases) {
    if (c.text === good) {
      failed = true;
      console.error(`  SELF-TEST INERT: ${c.name} — the mutation changed nothing, so it proves`);
      console.error("    nothing. Its anchor moved; re-derive it against the current file.");
      continue;
    }
    const red = c.run(c.text);
    const green = c.run(good);
    if (red.ok) {
      failed = true;
      console.error(`  SELF-TEST FAILED (no red): ${c.name}`);
    } else if (!green.ok) {
      failed = true;
      console.error(`  SELF-TEST FAILED (not green when restored): ${c.name} — ${green.message}`);
    } else {
      console.log(`  ok: ${c.name}`);
    }
  }
  return !failed;
}

const argv = process.argv.slice(2);
const which = (argv.find((a) => a.startsWith("--check=")) ?? "").slice(8);
const text = readFileSync(BUG_LOG, "utf8");
let failed = false;

if (argv.includes("--self-test")) {
  console.log("bug-log-entry-integrity --self-test");
  if (!selfTest()) failed = true;
} else {
  for (const [name, fn] of [
    ["chips", checkChips],
    ["shas", checkShas],
  ]) {
    if (which && which !== name) continue;
    const r = fn(text);
    if (r.ok) console.log(`bug-log.md ${r.message}`);
    else {
      failed = true;
      console.error(r.message);
    }
  }
}

process.exit(failed ? 1 : 0);
