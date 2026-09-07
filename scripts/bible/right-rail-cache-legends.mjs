#!/usr/bin/env node
/**
 * right-rail-interaction.md §7 — the two context-cache bars have DIFFERENT denominators
 * on purpose, which is exactly why each one must carry its own title row and its own
 * legend. A shared legend is how the WINDOW bar and the THIS CALL bar get misread as the
 * same scale.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/right-rail-interaction.md; this file is
 * one encoding of it, kept out of the markdown per FOUNDATION.md, "Three different jobs,
 * three different homes".
 *
 * WHAT CHANGED WHEN IT MOVED (2026-08-04). The inline version asserted
 * `source.includes("cache-legend--window")` — a raw substring test over the whole file.
 * Measured on a copy of the real tree: dropping the class from the emitted markup and
 * leaving the trailing comment `// cache-legend--window removed` kept the old gate GREEN,
 * and a dead constant does the same. The check now blanks comments first and only accepts
 * a class token that is actually EMITTED inside a `class="…"` attribute, which is the
 * thing the user sees.
 *
 * The anti-vacuity property is proven on every run: `selfTest()` executes first against a
 * fixture whose only mention of a required class is in a comment. A test that never fires
 * is a defect (design-principles.md #20).
 *
 * Usage:
 *   node scripts/bible/right-rail-cache-legends.mjs
 *   node scripts/bible/right-rail-cache-legends.mjs --self-test
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_REL = "tinker-ui/src/panels/context-cache.ts";

/** One legend per bar, plus the title row each bar stamps above itself. */
const REQUIRED = ["cache-legend--window", "cache-legend--split", "cache-meta--title"];

/**
 * Blank `//` and block comments, preserving newlines. String literals are KEPT — unlike
 * the funnel check, here the markup we are asserting on LIVES inside template strings.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every class token actually emitted in a `class="…"` / `class='…'` attribute. */
export function emittedClassTokens(src) {
  const tokens = new Set();
  for (const m of stripComments(src).matchAll(/\bclass\s*=\s*(["'])([\s\S]*?)\1/g)) {
    for (const t of m[2].replace(/\$\{[\s\S]*?\}/g, " ").split(/\s+/)) {
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

function selfTest() {
  const fixture = `
    // cache-legend--window used to be rendered here
    const dead = "cache-legend--split";
    return \`<div class="cache-legend cache-meta--title">x</div>\`;
  `;
  const tokens = emittedClassTokens(fixture);
  const expect = [
    ["cache-meta--title", true],
    ["cache-legend", true],
    ["cache-legend--window", false],
    ["cache-legend--split", false],
  ];
  for (const [token, want] of expect) {
    if (tokens.has(token) !== want) {
      throw new Error(
        `self-test FAILED: ${token} emitted=${tokens.has(token)}, expected ${want}. ` +
          "The vacuity guard is broken — refusing to run the real check.",
      );
    }
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
  console.log("ok: cache-legend self-test (comment and dead-constant mentions both rejected)");
  process.exit(0);
}

selfTest();

const file = path.join(repoRoot, SRC_REL);
let source;
try {
  source = readFileSync(file, "utf8");
} catch (err) {
  console.error(`cannot read ${SRC_REL}: ${err.message}`);
  process.exit(1);
}

const tokens = emittedClassTokens(source);
const missing = REQUIRED.filter((c) => !tokens.has(c));
if (missing.length) {
  console.error(
    `not EMITTED in any class attribute of ${SRC_REL}: ${missing.join(", ")}\n` +
      "The WINDOW bar and the THIS CALL bar have different denominators, so each needs its own\n" +
      "title row and its own legend — see TINKER_UI_DESIGN_BIBLE/right-rail-interaction.md §7.",
  );
  for (const c of missing) {
    if (source.includes(c)) {
      console.error(`  note: "${c}" appears in the file but only outside a class attribute`);
    }
  }
  process.exit(1);
}

console.log(`ok: both bars labelled and legended (${REQUIRED.length} classes emitted)`);
