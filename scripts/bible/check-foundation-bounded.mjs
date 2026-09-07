#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * FOUNDATION #9 — "bounded, replicable, recoverable" — made executable.
 *
 * The PRINCIPLE lives in TINKER_UI_DESIGN_BIBLE/FOUNDATION.md and is the authority. This file is
 * only one ENCODING of it, deliberately kept out of the markdown:
 *
 *   - a principle is a point of reflection and carries useful ambiguity ("which axis of
 *     boundedness is this protecting?"). A predicate cannot hold ambiguity, so the two must not
 *     be the same artefact or the narrower one silently becomes the rule;
 *   - code embedded in YAML frontmatter cannot be unit-tested, linted or reviewed as code. Both
 *     bugs in the first version of this check (a recursive glob that walked node_modules and hung
 *     the whole bible gate, and a regex that could not tell the repo's src/ from an extension's
 *     own src/) came from a copy that was awkward to exercise in place;
 *   - FOUNDATION.md is meant to be short. It had 86 lines of frontmatter before its first
 *     sentence of prose.
 *
 * When this script and FOUNDATION.md disagree, FOUNDATION.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/check-foundation-bounded.mjs          # both axes
 *   node scripts/bible/check-foundation-bounded.mjs --axis=1 # published artefacts only
 *   node scripts/bible/check-foundation-bounded.mjs --axis=2 # backup/tracking only
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_SRC = path.join(repoRoot, "src") + path.sep;
const PRUNE = new Set(["node_modules", "dist", "dist-runtime", ".git", "coverage"]);
const SKIP_FILE = /\.test\.ts$|\.spec\.ts$|__tests__|test-harness|test-support/;

// Import/export specifiers that are RELATIVE (leading "."). Non-relative ones resolve through the
// package exports map and are bounded by construction.
const SPEC =
  /(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) walkTs(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".ts") && !SKIP_FILE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Extensions this repo actually distributes — the ones whose tarball must stand alone. */
function publishedExtensions() {
  const extDir = path.join(repoRoot, "extensions");
  const out = [];
  for (const name of readdirSync(extDir)) {
    const pkg = path.join(extDir, name, "package.json");
    if (!existsSync(pkg)) continue;
    let rel;
    try {
      rel = (JSON.parse(readFileSync(pkg, "utf8")).openclaw ?? {}).release ?? {};
    } catch {
      continue;
    }
    if (rel.publishToNpm || rel.publishToClawHub) out.push(name);
  }
  return out;
}

/**
 * AXIS 1 — bounded in SPACE. Resolve each relative specifier and ask whether it lands in the
 * repo's src/ tree, which a published tarball does not ship. Note this RESOLVES rather than
 * pattern-matches: `../src/x` from extensions/foo/fork/ is the extension's OWN src/ and is
 * perfectly bounded, while `../../src/x` escapes into the host.
 */
function axis1() {
  const violations = [];
  for (const ext of publishedExtensions()) {
    for (const file of walkTs(path.join(repoRoot, "extensions", ext))) {
      let src;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const m of src.matchAll(SPEC)) {
        const spec = m[1] ?? m[2];
        const target = path.normalize(path.join(path.dirname(file), spec));
        if (target.startsWith(REPO_SRC)) {
          violations.push({ ext, file: path.relative(repoRoot, file), spec });
        }
      }
    }
  }
  return violations;
}

/**
 * AXIS 2 — bounded in TIME. Structure is asserted (there must be somewhere to recover FROM); the
 * backlog SIZE is only reported. A frozen "max N unpushed" would be the hard-quantity-threshold
 * bug FOUNDATION #2/#19 forbids.
 */
function axis2() {
  const git = (...a) => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" }).trim();
  const remotes = git("remote").split("\n").filter(Boolean);
  if (!remotes.includes("origin")) {
    throw new Error(
      `no 'origin' remote — the fork has nowhere to be backed up to (have: ${remotes})`,
    );
  }
  let upstream = "";
  try {
    upstream = git("rev-parse", "--abbrev-ref", "develop@{u}");
  } catch {
    /* falls through to the throw below */
  }
  if (!upstream)
    throw new Error("branch 'develop' has no upstream tracking ref — unpushed work is invisible");
  const [behind, ahead] = git("rev-list", "--left-right", "--count", `${upstream}...develop`).split(
    /\s+/,
  );
  return { upstream, behind, ahead };
}

const which = (process.argv.find((a) => a.startsWith("--axis=")) ?? "").slice(7);
let failed = false;

if (which !== "2") {
  const v = axis1();
  if (v.length) {
    failed = true;
    console.error(
      "FOUNDATION #9 (bounded in space): a PUBLISHED extension reaches the repo's src/ tree.\n" +
        "Its tarball ships only its own directory, so this cannot resolve on the user's disk —\n" +
        "a lint allowlist would hide it, not fix it. Cross via a plugin-sdk subpath instead\n" +
        "(see canonical-derivations.md, 'Which crossing is correct').\n",
    );
    for (const x of v) console.error(`  ${x.file} -> ${x.spec}`);
  } else {
    console.log(
      `#9 axis 1: ${publishedExtensions().length} published extension(s), 0 unbounded imports.`,
    );
  }
}

if (which !== "1") {
  const { upstream, behind, ahead } = axis2();
  console.log(`#9 axis 2: develop vs ${upstream} — behind=${behind} ahead=${ahead}`);
  if (Number(ahead) > 0) {
    console.log(
      `  NOTE: ${ahead} commit(s) exist only on this machine. Reported, never thresholded —\n` +
        "  publish with the clean-public-push recipe when the PII leak-grep is green.",
    );
  }
}

process.exit(failed ? 1 : 0);
