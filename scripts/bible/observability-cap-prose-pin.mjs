#!/usr/bin/env node
/**
 * FORK 2026-09-07 — pin observability.md's stated cap to the ENFORCED one.
 *
 * Why this exists: on 2026-09-07 §8 asserted the cap was **377** while
 * `BLIND_CAP` had been 358 since dc64e51e436 (2026-08-05). The prose had been
 * wrong for a month and nothing noticed, because every check pointed at the
 * SCRIPT and none at the sentence a human actually reads. FOUNDATION's
 * governance calls a stale optic worse than a missing one — "it is read and
 * believed" — so the number a reader sees now fails the build when it drifts.
 *
 * Scope is deliberately narrow: it pins ONLY §8's bolded `**<N> on <date>**`
 * declaration. observability.md legitimately contains other integers that may
 * coincide with the cap (e.g. "the 145 upstream provider extensions"), and a
 * check that matched any occurrence would be the uniform-probe failure class.
 *
 * Exit 0 = prose and code agree. Exit 1 = they drifted.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(path.join(repoRoot, "scripts/bible/capability-coverage.mjs"), "utf8");
const optic = readFileSync(path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE/observability.md"), "utf8");

const capM = script.match(/export const BLIND_CAP = (\d+);/);
if (!capM) {
  console.error(
    "BLIND_CAP not found in scripts/bible/capability-coverage.mjs — has it been renamed?",
  );
  process.exit(1);
}
const cap = Number(capM[1]);

// The §8 declaration: a bolded "<number> on <YYYY-MM-DD>" naming the measured status quo.
const proseM = optic.match(/\*\*(\d+) on (\d{4}-\d{2}-\d{2})\*\*/);
if (!proseM) {
  console.error(
    "observability.md §8 no longer states the cap as `**<N> on <YYYY-MM-DD>**`.\n" +
      "That sentence is the one a human reads instead of opening the script — keep it, in that shape.",
  );
  process.exit(1);
}
const prose = Number(proseM[1]);

if (prose !== cap) {
  console.error(
    `observability.md §8 says the cap is ${prose} (as of ${proseM[2]}); the enforced BLIND_CAP is ${cap}.\n` +
      "The prose is what a reader believes. Update the sentence in the same commit that moves the cap.",
  );
  process.exit(1);
}
console.log(`ok: observability.md §8 and BLIND_CAP agree (${cap}, stated ${proseM[2]}).`);
