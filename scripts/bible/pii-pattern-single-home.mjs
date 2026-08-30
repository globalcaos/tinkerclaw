#!/usr/bin/env node
/**
 * pii-boundary.md — the leak-grep pattern is DEFINED in exactly one place.
 *
 * Counts DEFINITIONS, never the literal: this file must not hold a copy of the pattern any
 * more than the optic may, and if it did it would become the second definition it exists
 * to forbid. A second copy is how the pre-push hook and the bible's own check start
 * disagreeing about what counts as private — and the stale copy is the one that fails
 * open.
 *
 * The INTENT lives in TINKER_UI_DESIGN_BIBLE/pii-boundary.md and is the authority. The
 * program lives here per FOUNDATION.md, "Three different jobs, three different homes".
 *
 * The pruned directories are all git-ignored build/coverage output, so pruning them cannot
 * hide a TRACKED second definition — checked, not assumed.
 *
 * WHAT CHANGED WHEN IT MOVED (2026-08-04). The inline version was
 * `grep -rl '^PII_RE=' --include='*.sh' … | wc -l`, and `-l` counts FILES THAT MATCH, not
 * matches. So a file defining `PII_RE` TWICE — the exact drift this gate exists to catch,
 * and the case where the second definition silently wins in bash — passed it. Verified by
 * negative test before the fix. It now counts DEFINITIONS, per file and in total, which is
 * what the check has always claimed in its own name.
 *
 * Usage: node scripts/bible/pii-pattern-single-home.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRUNE = new Set(["node_modules", "dist", "dist-runtime", ".git", "coverage"]);
const DEFINITION = /^PII_RE=/gm;

function shellScripts(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) shellScripts(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith(".sh")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** [relative path, number of `PII_RE=` definitions in it] for every file that has any. */
const defining = shellScripts(repoRoot)
  .map((f) => {
    let n = 0;
    try {
      n = (readFileSync(f, "utf8").match(DEFINITION) ?? []).length;
    } catch {
      n = 0;
    }
    return [path.relative(repoRoot, f), n];
  })
  .filter(([, n]) => n > 0)
  .sort(([a], [b]) => a.localeCompare(b));

const total = defining.reduce((sum, [, n]) => sum + n, 0);

if (total !== 1) {
  console.error(
    `expected exactly 1 definition of PII_RE, found ${total} — the pattern has been ` +
      (total === 0 ? "removed or renamed" : "duplicated"),
  );
  for (const [f, n] of defining) console.error(`  ${f} (${n})`);
  console.error(
    "\nThe leak-grep pattern has ONE executable home. Two copies drift, and the stale one fails\n" +
      "open — and two definitions in ONE file are worse still, because bash silently keeps the\n" +
      "last one. See TINKER_UI_DESIGN_BIBLE/pii-boundary.md, 'Don't regress'.",
  );
  process.exit(1);
}

console.log(`ok: PII_RE defined in exactly one place (${defining[0][0]})`);
