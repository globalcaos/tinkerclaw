#!/usr/bin/env node
/**
 * right-rail-interaction.md §7 — the context-cache panel holds NO local palette: the
 * per-segment colours are imported from the one module that owns them, so the two bars
 * and the context timeline can never drift apart.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/right-rail-interaction.md; this file is
 * one encoding of it, kept out of the markdown per FOUNDATION.md, "Three different jobs,
 * three different homes".
 *
 * WHAT CHANGED WHEN IT MOVED (2026-08-04). The negative half is preserved EXACTLY,
 * comments and all: a six-digit hex anywhere in the file fails, including inside a
 * comment. That over-strictness is deliberate — for this check the false-positive
 * direction is the safe one, and a hex written in a comment is still a second copy of a
 * value the palette owns. What was ADDED is the positive half: the old check PRINTED
 * "ok: palette imported" without ever checking that anything was imported. Measured: run
 * against an EMPTY file it reports success. A claim the check does not verify is exactly
 * the dead instrument design-principles.md #20 forbids.
 *
 * Usage: node scripts/bible/right-rail-cache-palette.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_REL = "tinker-ui/src/panels/context-cache.ts";

/** Unchanged from the inline version: any 6-digit hex literal, anywhere in the file. */
const HEX = /#[0-9a-fA-F]{6}\b/g;

/**
 * The palette must arrive by import. Matched on the BINDING name rather than the module
 * path so relocating the owner module is not a gate failure — freezing the path here would
 * be the frozen-list bug design-principles.md #19 forbids.
 */
const PALETTE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
const PALETTE_BINDING = /(COLOR|COLOUR|PALETTE)/i;

const file = path.join(repoRoot, SRC_REL);
let source;
try {
  source = readFileSync(file, "utf8");
} catch (err) {
  console.error(`cannot read ${SRC_REL}: ${err.message}`);
  process.exit(1);
}

const hex = source.match(HEX) ?? [];
if (hex.length) {
  console.error(
    `local hex in ${SRC_REL} (the palette must be imported, never re-declared): ${hex.join(", ")}`,
  );
  process.exit(1);
}

const imported = [];
for (const m of source.matchAll(PALETTE_IMPORT)) {
  for (const binding of m[1].split(",")) {
    const name = binding
      .trim()
      .split(/\s+as\s+/)[0]
      .trim();
    if (name && PALETTE_BINDING.test(name)) imported.push(name);
  }
}
if (!imported.length) {
  console.error(
    `${SRC_REL} declares no local hex, but it does not IMPORT a palette binding either —\n` +
      "so 'palette imported' was an unverified claim. Import the colours from the module that\n" +
      "owns them (right-rail-interaction.md §7); a panel with no palette source cannot stay in\n" +
      "step with the context timeline.",
  );
  process.exit(1);
}

console.log(`ok: no local hex, palette imported (${imported.join(", ")})`);
