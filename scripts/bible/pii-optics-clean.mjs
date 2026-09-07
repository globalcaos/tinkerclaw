#!/usr/bin/env node
/**
 * pii-boundary.md — no bible optic matches the leak-grep regex.
 *
 * This is the most load-bearing gate in the bible. The fork has had real leak incidents
 * where private data reached the PUBLIC GitHub repo, and a pushed blob cannot be
 * unpublished. The INTENT lives in TINKER_UI_DESIGN_BIBLE/pii-boundary.md and is the
 * authority; the executable pattern has exactly ONE home, `PII_RE` in
 * scripts/pii-pre-push.sh, and this file SOURCES it — it never holds a copy. Keeping the
 * program out of the markdown follows FOUNDATION.md, "Three different jobs, three
 * different homes"; keeping the pattern out of BOTH is pii-boundary.md's own rule, and it
 * is self-enforcing here: a literal pasted into this file would be scanned by the very
 * gate it implements and would block the next push.
 *
 * Three properties, all of which the moved version keeps and now PROVES:
 *
 *   1. COVERAGE — every TINKER_UI_DESIGN_BIBLE/*.md is scanned, by glob. A frozen file
 *      list is what once left 17 optics unscanned; never reintroduce one.
 *   2. SINGLE DERIVATION — the pattern is read out of the gate at run time, so this check
 *      and the pre-push hook can never disagree.
 *   3. FAIL CLOSED — if the pattern cannot be sourced, is empty, is defined twice, cannot
 *      be compiled, or turns out not to match its own literal, this exits NON-ZERO. An
 *      empty regex matches nothing and would report success: for this gate that is the
 *      worst possible failure, so the negative test runs on EVERY invocation rather than
 *      living in a test file someone can forget to run (design-principles.md #20 — a
 *      declared instrument that never fires is a defect).
 *
 * Matches are counted and their FILE is named, never their text: echoing the matched
 * string would copy the private data into CI logs, which is the leak this gate exists to
 * stop.
 *
 * Usage:
 *   node scripts/bible/pii-optics-clean.mjs               # fail-closed proof, then the scan
 *   node scripts/bible/pii-optics-clean.mjs --self-test   # fail-closed proof only
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..", "..");
const PATTERN_SOURCE_REL = "scripts/pii-pre-push.sh";
const OPTICS_REL = "TINKER_UI_DESIGN_BIBLE";

/**
 * Read the ONE definition of the leak-grep pattern. Same shape the shell gate uses
 * (`sed -n "s/^PII_RE='\(.*\)'$/\1/p"`): a line starting with PII_RE=' and ending with '.
 * Throws — never returns a fallback — on anything unexpected.
 */
export function readPattern(sourceAbs) {
  let text;
  try {
    text = readFileSync(sourceAbs, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${sourceAbs}: ${err.message} — the single source of truth for the ` +
        "leak-grep pattern moved, was renamed, or is not on disk.",
    );
  }
  const hits = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = /^PII_RE='(.*)'$/.exec(line);
    if (m) hits.push(m[1]);
  }
  if (hits.length === 0) {
    throw new Error(
      `no \`PII_RE='…'\` definition in ${sourceAbs} — the single source of truth moved or ` +
        "was renamed. This check refuses to pass silently: a privacy gate that cannot find " +
        "its pattern is not a gate.",
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `${hits.length} \`PII_RE='…'\` definitions in ${sourceAbs} — ambiguous. Exactly one ` +
        "wins, or the gate and the hook can disagree about what counts as private.",
    );
  }
  const pattern = hits[0];
  if (!pattern.trim()) {
    throw new Error(
      `\`PII_RE\` in ${sourceAbs} is EMPTY. An empty pattern matches nothing and would ` +
        "report a clean scan — the single worst failure mode for this gate.",
    );
  }
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(`\`PII_RE\` does not compile as a regex: ${err.message}`);
  }
  return { pattern, re };
}

/**
 * Prove the compiled regex actually FIRES, without writing a protected literal into this
 * public file (which would duplicate the pattern AND block the next push). Take the plain
 * literal alternatives of the pattern just sourced and assert each matches itself.
 */
export function proveItFires({ pattern, re }) {
  const plain = pattern.split("|").filter((a) => /^[A-Za-z0-9 _./@-]+$/.test(a));
  if (!plain.length) {
    throw new Error(
      "no plain-literal alternative left in `PII_RE`, so this check can no longer prove the " +
        "regex fires. Editing the canonical pattern is a reviewed change (pii-boundary.md, " +
        "Don't regress) — update the liveness probe deliberately rather than dropping it.",
    );
  }
  for (const [i, candidate] of plain.entries()) {
    if (!re.test(candidate)) {
      throw new Error(
        `alternative #${i + 1} of \`PII_RE\` does not match itself — the pattern was ` +
          "extracted wrong, so the scan below would be meaningless.",
      );
    }
  }
  return plain.length;
}

/** Every optic, by GLOB. Never a list — the frozen list is what broke this gate before. */
function optics(dirAbs) {
  return readdirSync(dirAbs)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** Fixtures proving the gate fails CLOSED. Each child must exit NON-ZERO. */
function selfTest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pii-gate-selftest-"));
  const cases = [
    ["missing-file.sh", null, "source file absent"],
    ["no-definition.sh", "#!/usr/bin/env bash\necho hello\n", "no PII_RE line"],
    ["empty-pattern.sh", "PII_RE=''\n", "PII_RE defined but empty"],
    ["two-definitions.sh", "PII_RE='a'\nPII_RE='b'\n", "PII_RE defined twice"],
  ];
  for (const [name, body, why] of cases) {
    const fixture = path.join(dir, name);
    if (body !== null) writeFileSync(fixture, body);
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [thisFile, `--source=${fixture}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      code = err.status ?? 1;
    }
    if (code === 0) {
      console.error(
        `FAIL-CLOSED SELF-TEST FAILED (${why}): the gate exited 0 with no usable pattern.\n` +
          `  child stdout: ${stdout.trim()}\n` +
          "  An unsourceable pattern must BLOCK — never scan with an empty regex and report clean.",
      );
      process.exit(1);
    }
  }
}

// `--source=` exists only so the fail-closed self-test can point a child at a broken
// fixture. It is confined to the temp dir so it can never be used to aim the real gate at
// a benign file.
const override = (process.argv.find((a) => a.startsWith("--source=")) ?? "").slice(9);
if (override && !path.resolve(override).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  console.error("--source= is restricted to the fail-closed self-test fixtures under the temp dir");
  process.exit(1);
}

if (!override) selfTest();

if (process.argv.includes("--self-test")) {
  console.log("ok: the leak-grep gate fails CLOSED on missing / empty / ambiguous PII_RE");
  process.exit(0);
}

let sourced;
try {
  sourced = readPattern(override || path.join(repoRoot, PATTERN_SOURCE_REL));
  proveItFires(sourced);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const dirAbs = path.join(repoRoot, OPTICS_REL);
const files = optics(dirAbs);
if (!files.length) {
  console.error(
    `no optics found under ${OPTICS_REL}/ — the glob matched nothing, so nothing was scanned`,
  );
  process.exit(1);
}

let leaks = 0;
for (const f of files) {
  // Fresh regex per file: a future pattern carrying /g would otherwise keep lastIndex.
  const re = new RegExp(sourced.pattern);
  if (re.test(readFileSync(path.join(dirAbs, f), "utf8"))) {
    console.error(`LEAK in ${OPTICS_REL}/${f}`);
    leaks++;
  }
}
if (leaks) {
  console.error(
    `\n${leaks} optic(s) match the leak-grep pattern. Sanitize before any push to the public\n` +
      "fork — see TINKER_UI_DESIGN_BIBLE/pii-boundary.md, 'Sanitization workflow'. The matched\n" +
      "text is deliberately not printed: echoing it would copy the private data into CI logs.",
  );
  process.exit(1);
}

console.log(
  `ok: ${files.length} optics scanned by glob, 0 matches ` +
    `(pattern sourced from ${PATTERN_SOURCE_REL})`,
);
