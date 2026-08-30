#!/usr/bin/env node
/**
 * canonical-derivations.md — THE LEDGER RATCHET, made executable.
 *
 * The LEDGER, the incidents that paid for each row, and the policy live in
 * TINKER_UI_DESIGN_BIBLE/canonical-derivations.md, and THAT OPTIC IS THE AUTHORITY. This file is
 * only one ENCODING of it, deliberately kept out of the markdown (FOUNDATION.md, "Three different
 * jobs, three different homes"): EXPLAIN belongs in the bible, CHECK belongs in scripts/bible/
 * behind a one-line `cmd:` pointer — because a program pasted into YAML frontmatter cannot be
 * linted, reviewed, or tested, and this is the most load-bearing gate the bible has.
 *
 * When this script and canonical-derivations.md disagree, the OPTIC is right and THIS FILE is the bug.
 *
 * THE RULE, in one line: a concept's implementation count may FALL, never RISE.
 *
 * The caps below are the measured status quo, not a target. Collapsing 12 token estimators is not a
 * session's work, and a gate that demanded it on day one would be switched off — which is exactly
 * how a tree gets to 12. So the gate asserts only that the number never grows. Collapse two and
 * LOWER the cap in the same commit; RAISING a cap is not a fix, it is the bug recorded as policy.
 *
 * Usage:
 *   node scripts/bible/canonical-ledger-ratchet.mjs              # enforce (exit 1 when a count rose)
 *   node scripts/bible/canonical-ledger-ratchet.mjs --list       # measured vs cap, never fails
 *   node scripts/bible/canonical-ledger-ratchet.mjs --self-test  # prove the ratchet actually trips
 *   node scripts/bible/canonical-ledger-ratchet.mjs --check-table # optic's counts table == LEDGER
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * THE LEDGER — the enforced numbers. Kept as a plain, visible, editable table because this is the
 * artefact a maintainer edits when they collapse a duplicate.
 *
 * `pattern` matches DEFINITION sites and is POSIX ERE (it is handed to `grep -rnE`), not a JS
 * RegExp — do not "modernise" it into `new RegExp(...)`; `\s` and the `(export )?` groups behave
 * as GNU grep parses them and the counts were measured that way.
 *
 * `cap` is the count measured when the row was added. It may only ever be edited DOWNWARD, in the
 * same commit that removes an implementation. Mirror every change into the counts table in
 * canonical-derivations.md so a reader sees it without opening this file — `--check-table` fails
 * the build if you forget.
 */
export const LEDGER = [
  {
    concept: "cosineSimilarity",
    cap: 8,
    pattern: String.raw`^\s*(export )?function cosineSimilarity`,
  },
  {
    concept: "estimateTokens",
    cap: 12,
    pattern: String.raw`^\s*(export )?(function|const) estimateTokens`,
  },
  {
    concept: "assembleRetrievalPack",
    cap: 1,
    pattern: String.raw`^\s*export (async )?function assembleRetrievalPack`,
  },
  {
    concept: "deliverWebReply",
    cap: 3,
    pattern: String.raw`^\s*export (async )?function deliverWebReply`,
  },
  {
    concept: "movePathToTrash",
    cap: 2,
    pattern: String.raw`^\s*export (async )?function movePathToTrash`,
  },
  {
    // TWO retrieval-pack assemblers under DIFFERENT NAMES, which is why the existing
    // `assembleRetrievalPack` row (cap 1) reads green while two of them ship:
    //   src/memory/engram/retrieval-integration.ts    assembleRetrievalPack (live via total-recall:404,407)
    //   src/agents/pi-extensions/retrieval-runtime.ts buildDefaultAssemble  (live via injectRetrievalPack)
    // A name-keyed ratchet cannot see a concept re-derived under a NEW NAME — the rename IS the
    // evasion and it needs no intent. Keyed on the concept, matching both spellings.
    concept: "retrieval-pack assembler",
    cap: 2,
    pattern: String.raw`^\s*(export )?(async )?function (assembleRetrievalPack|buildDefaultAssemble)`,
  },
  {
    // Three, and the two exported ones are a DIVERGED twin (215 vs 250 lines, same 9 exported
    // symbols). Whichever caller you read, the other copy is the one that got the fix.
    concept: "mmrRerank",
    cap: 3,
    pattern: String.raw`^\s*(export )?function mmrRerank`,
  },
  {
    // A deliberate SUB-LEDGER of `estimateTokens` (which also matches these two). It is here on its
    // own because this pair does not merely duplicate — it DISAGREES: at chars=5 one returns 2 and
    // the other 1. A narrower cap on a numerically-inconsistent pair is worth the redundant count.
    concept: "estimateTokensFromChars",
    cap: 2,
    pattern: String.raw`^\s*(export )?function estimateTokensFromChars`,
  },
];

/** Where an implementation can live. Anything outside these trees is not shipped code. */
const SEARCH_DIRS = ["src", "extensions", "tinker-ui/src"];

/** A hit that is generated, built, or a test double is not a derivation of the concept. */
const NOT_A_DEFINITION = (line) =>
  line.includes("node_modules") ||
  line.includes("/dist") ||
  line.includes(".test.") ||
  line.includes("__tests__") ||
  line.includes(".d.ts");

const cache = new Map();

/** @returns {string[]} repo-relative paths, one per definition site (a file may appear twice). */
export function countImplementations(pattern) {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const res = spawnSync(
    "grep",
    ["-rnE", pattern, ...SEARCH_DIRS.map((d) => path.join(repoRoot, d)), "--include=*.ts"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw res.error;
  // grep exits 1 for "no matches" — that is a legitimate zero, not a failure. >1 is a real error.
  if (res.status > 1) throw new Error(`grep failed for /${pattern}/: ${(res.stderr || "").trim()}`);
  const sites = (res.stdout || "")
    .split("\n")
    .filter(Boolean)
    .filter((l) => !NOT_A_DEFINITION(l))
    .map((l) => path.relative(repoRoot, l.slice(0, l.indexOf(":"))));
  cache.set(pattern, sites);
  return sites;
}

/**
 * The ratchet itself, kept pure so the self-test can drive it with synthetic counts.
 * `count` is injected: (pattern, concept) => string[].
 */
export function evaluate(ledger, count = countImplementations) {
  return ledger.map(({ concept, cap, pattern }) => {
    const sites = count(pattern, concept);
    return { concept, cap, sites, over: sites.length > cap };
  });
}

function assert(ok, msg) {
  if (!ok) {
    console.error(`ratchet self-test FAILED: ${msg}`);
    process.exit(1);
  }
}

/**
 * A gate nobody has ever seen fail is a gate nobody knows works. This proves three things:
 * the boundary arithmetic, that a simulated extra implementation trips EVERY row against the real
 * tree, and that no ledger regex has rotted into matching nothing (a silently-vacuous cap).
 */
function selfTest() {
  const fake = [{ concept: "widget", cap: 2, pattern: "IGNORED" }];
  assert(
    evaluate(fake, () => ["a.ts", "b.ts"]).every((r) => !r.over),
    "exactly at the cap must pass",
  );
  assert(
    evaluate(fake, () => ["a.ts"]).every((r) => !r.over),
    "below the cap must pass — counts are allowed to fall",
  );
  assert(
    evaluate(fake, () => ["a.ts", "b.ts", "c.ts"]).some((r) => r.over),
    "one over the cap must fail",
  );

  // Against the REAL tree: hand every concept one implementation more than its cap allows. Every
  // row must trip. This is what proves the WIRING (a broken grep would make the real run pass
  // vacuously), not just the arithmetic.
  const simulated = evaluate(LEDGER, (pattern, concept) => {
    const real = countImplementations(pattern);
    const { cap } = LEDGER.find((e) => e.concept === concept);
    const extra = Math.max(1, cap + 1 - real.length);
    return [
      ...real,
      ...Array.from({ length: extra }, (_, i) => `simulated/${concept}-copy-${i + 1}.ts`),
    ];
  });
  const missed = simulated.filter((r) => !r.over).map((r) => r.concept);
  assert(
    missed.length === 0,
    `a simulated extra implementation did not trip: ${missed.join(", ")}`,
  );

  const dead = LEDGER.filter((e) => countImplementations(e.pattern).length === 0).map(
    (e) => e.concept,
  );
  assert(
    dead.length === 0,
    `ledger regex matches nothing (renamed or fully removed concept — drop the row or fix the ` +
      `regex, a cap that can never be exceeded is a gate that can never fire): ${dead.join(", ")}`,
  );

  console.log(
    `ratchet self-test: ${LEDGER.length} concepts — boundary arithmetic, a simulated extra ` +
      `implementation, and regex liveness all behave.`,
  );
}

/**
 * The caps live in two places on purpose — here, where the build reads them, and in the optic's
 * counts table, where a human reads them. Two homes for one fact is exactly the failure this optic
 * is about, so the split is only tolerable if drift is impossible: this asserts they agree.
 */
const OPTIC = "TINKER_UI_DESIGN_BIBLE/canonical-derivations.md";
const TABLE_ROW = /^\|\s*`([^`]+)`\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/;

function checkTable() {
  const md = readFileSync(path.join(repoRoot, OPTIC), "utf8");
  const documented = new Map();
  for (const line of md.split("\n")) {
    const m = TABLE_ROW.exec(line);
    if (m) documented.set(m[1], Number(m[2]));
  }
  const problems = [];
  for (const { concept, cap } of LEDGER) {
    if (!documented.has(concept)) {
      problems.push(
        `${concept}: enforced at cap ${cap} but absent from the counts table in ${OPTIC}`,
      );
    } else if (documented.get(concept) !== cap) {
      problems.push(
        `${concept}: ${OPTIC} says ${documented.get(concept)}, LEDGER enforces ${cap} — ` +
          "move both in the same commit",
      );
    }
  }
  for (const concept of documented.keys()) {
    if (!LEDGER.some((e) => e.concept === concept)) {
      problems.push(
        `${concept}: documented in ${OPTIC} but nothing enforces it — add it to LEDGER`,
      );
    }
  }
  if (problems.length) {
    console.error(`The counts table in ${OPTIC} and the enforced LEDGER have drifted.`);
    console.error(
      "The optic is the authority; this script is the gate. They must say the same thing.\n",
    );
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`counts table: ${documented.size} concepts, table and enforced caps agree.`);
}

const argv = process.argv.slice(2);

if (argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

if (argv.includes("--check-table")) {
  checkTable();
  process.exit(0);
}

const rows = evaluate(LEDGER);

if (argv.includes("--list")) {
  for (const r of rows) {
    console.log(`${r.concept.padEnd(24)} ${String(r.sites.length).padStart(3)} / cap ${r.cap}`);
  }
  process.exit(0);
}

const bad = rows.filter((r) => r.over);
if (bad.length) {
  console.error("A concept in canonical-derivations.md gained another implementation.");
  console.error("Call the existing one, or collapse and LOWER the cap in the same commit.\n");
  for (const r of bad) {
    console.error(`${r.concept}: ${r.sites.length} implementations, ledger cap ${r.cap}`);
    for (const s of r.sites) console.error(`    ${s}`);
  }
  console.error(
    "\nCaps move DOWN only. Raising one in the LEDGER at the top of this file is not a fix —\n" +
      "it is the bug being recorded as policy (canonical-derivations.md, 'Don't regress').",
  );
  process.exit(1);
}

console.log(
  `ratchet: ${rows.length} concepts, none above cap (` +
    rows.map((r) => `${r.concept} ${r.sites.length}/${r.cap}`).join(", ") +
    ").",
);
