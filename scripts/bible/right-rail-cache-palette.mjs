#!/usr/bin/env node
/**
 * right-rail-interaction.md §7 + context-window-panel.md P4 — the modules that put the
 * per-segment colours on screen hold NO local palette: the colours are imported from the one
 * module that owns them (SEGMENT_COLORS, context-timeline.ts), so the two bars, the call
 * timeline and the context timeline can never drift apart.
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
 * WHAT CHANGED 2026-09-24 (wave 2b). The gate scanned ONE file while context-window-panel.md
 * P4 already said "the call-timeline modules inherit the same rule" — asserted in prose,
 * enforced nowhere. Measured before this change: a hex planted in call-timeline-canvas.ts left
 * the gate green. SRC_REL became TARGETS, and every listed module gets the hex scan above,
 * unchanged. The positive half now comes in two strengths:
 *   - `painter: true` — the module draws segment colours, so it must import the palette, always.
 *     This keeps the 2026-08-04 fix: an EMPTY painter still fails.
 *   - `painter: false` — the import is required only once the module's CODE names a palette
 *     identifier (PALETTE_VOCAB, outside comments and imports). Derived from the source rather
 *     than hand-flagged, so it re-arms by itself: `const TOAST_COLOR = "red"` in
 *     context-buttons.ts fails, while a module that touches no colour is not forced into a dead
 *     import. The exemption is printed, never silent.
 *
 * Two hardenings rode along. The import is looked for in COMMENT-STRIPPED source — a
 * commented-out import used to satisfy the positive half. And the script now self-tests on
 * every run, which right-rail-interaction.md §8 already claimed of all three right-rail
 * scripts but was false for this one.
 *
 * The list is explicit on purpose: discovering targets by "imports the palette" would exempt
 * exactly the module that re-declares hex INSTEAD of importing. A listed file that is missing
 * fails loudly, so a rename cannot silently drop a module from the gate.
 *
 * Usage:
 *   node scripts/bible/right-rail-cache-palette.mjs
 *   node scripts/bible/right-rail-cache-palette.mjs --self-test
 *   node scripts/bible/right-rail-cache-palette.mjs --root <dir>   # check another copy of the tree
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The modules the rule guards, repo-relative. `painter`: see the 2026-09-24 note above. */
export const TARGETS = [
  // Both cache bars and their legends.
  { rel: "tinker-ui/src/panels/context-cache.ts", painter: true },
  // Hands the painter SEGMENT_COLORS keys; its own header says "Colours: none here".
  { rel: "tinker-ui/src/panels/call-timeline.ts", painter: false },
  // The canvas painter: every segment and output colour.
  { rel: "tinker-ui/src/panels/call-timeline-canvas.ts", painter: true },
  // The EVICT / COMPACT availability model: pure logic, no DOM, no colour.
  { rel: "tinker-ui/src/panels/context-buttons.ts", painter: false },
];

/** Unchanged from the inline version: any 6-digit hex literal, anywhere in the file. */
const HEX = /#[0-9a-fA-F]{6}\b/g;

/**
 * The palette must arrive by import. Matched on the BINDING name rather than the module
 * path so relocating the owner module is not a gate failure — freezing the path here would
 * be the frozen-list bug design-principles.md #19 forbids.
 */
const PALETTE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
const PALETTE_BINDING = /(COLOR|COLOUR|PALETTE)/i;

/**
 * Palette VOCABULARY in code, for the `painter: false` half only. PALETTE_BINDING stays loose
 * because it only ever sees import binding names; run over a whole module it would read the word
 * "colour" in a tooltip string as a colour table, and then NO fix passes (importing is a dead
 * line, and `painter: true` still demands the import). So this matches only identifier shapes:
 * an UPPER_SNAKE token (SEGMENT_COLORS, TOAST_COLOR) or a camelCase hump (backgroundColor,
 * getPalette). A bare lowercase `color` variable is not seen; the hex scan still is.
 */
const PALETTE_VOCAB =
  /\b[A-Z0-9_]*(?:COLOR|COLOUR|PALETTE)[A-Z0-9_]*\b|[a-z0-9](?:Color|Colour|Palette)/;

/**
 * Blank `//` and block comments, preserving newlines (the lexer right-rail-cache-legends.mjs
 * uses). Feeds ONLY the positive half; the hex scan stays on the raw text. A string that merely
 * looks like a comment opener can only REMOVE text here, i.e. hide a real import and turn the
 * gate red: the safe direction.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          out += "\n";
        }
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

/**
 * The whole verdict for one module's source, pure so the self-test can drive it.
 *   hex         — every 6-digit hex in the RAW source, comments included
 *   imported    — palette bindings that arrive by a real (uncommented) import
 *   usesPalette — the CODE names a palette binding outside its import statements
 */
export function auditPalette(source) {
  const hex = source.match(HEX) ?? [];
  const code = stripComments(source);
  const imported = [];
  for (const m of code.matchAll(PALETTE_IMPORT)) {
    for (const binding of m[1].split(",")) {
      const name = binding
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name && PALETTE_BINDING.test(name)) {
        imported.push(name);
      }
    }
  }
  const usesPalette = PALETTE_VOCAB.test(code.replace(PALETTE_IMPORT, " "));
  return { hex, imported, usesPalette };
}

/** One module's failure message, or null when it passes. */
export function judge(rel, source, painter) {
  const { hex, imported, usesPalette } = auditPalette(source);
  if (hex.length) {
    return `local hex in ${rel} (the palette must be imported, never re-declared): ${hex.join(", ")}`;
  }
  if (!imported.length && (painter || usesPalette)) {
    return (
      `${rel} declares no local hex, but it does not IMPORT a palette binding either —\n` +
      (painter ? "" : "and its code names one (a COLOR / COLOUR / PALETTE identifier) —\n") +
      "so 'palette imported' was an unverified claim. Import the colours from the module that\n" +
      "owns them (right-rail-interaction.md §7); a panel with no palette source cannot stay in\n" +
      "step with the context timeline."
    );
  }
  return null;
}

function selfTest() {
  const imp = 'import { SEGMENT_COLORS as SC, SEGMENT_LABELS } from "./context-timeline.js";\n';
  const cases = [
    // [label, source, painter, expectPass]
    ["planted hex in code", `${imp}const PLANT = "#1a2b3c";\n`, true, false],
    ["hex only in a comment", `${imp}// was #1a2b3c before the palette moved\n`, true, false],
    ["hex in a non-painter", 'const c = "#abcdef";\n', false, false],
    ["import only in a line comment", `// ${imp}const c = SEGMENT_COLORS.free;\n`, true, false],
    [
      "import only in a block comment",
      `/* ${imp} */\nconst c = SEGMENT_COLORS.free;\n`,
      false,
      false,
    ],
    ["empty painter (the 2026-08-04 bug)", "", true, false],
    ["non-painter names a colour, no import", 'const TOAST_COLOR = "red";\n', false, false],
    ["non-painter sets a camelCase colour", 'el.style.backgroundColor = "red";\n', false, false],
    [
      "non-painter, colour only in a comment",
      "// Colours: none here.\nconst x = 1;\n",
      false,
      true,
    ],
    ["non-painter, 'colour' in a string", 'const tip = "the segment colour table";\n', false, true],
    ["empty non-painter", "", false, true],
    [
      "multi-line real import",
      'import {\n  fmtTokens,\n  SEGMENT_COLORS,\n} from "./x.js";\n',
      true,
      true,
    ],
  ];
  for (const [label, source, painter, expectPass] of cases) {
    const pass = judge("<fixture>", source, painter) === null;
    if (pass !== expectPass) {
      throw new Error(
        `self-test FAILED on "${label}": pass=${pass}, expected ${expectPass}. ` +
          "The palette guard is broken — refusing to run the real check.",
      );
    }
  }
  const names = auditPalette(imp).imported.join(",");
  if (names !== "SEGMENT_COLORS") {
    throw new Error(
      `self-test FAILED: aliased import resolved to [${names}], not [SEGMENT_COLORS]`,
    );
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
  console.log(
    "ok: cache-palette self-test (planted hex, hex in a comment, commented-out import, empty painter and a named colour all rejected)",
  );
  process.exit(0);
}

selfTest();

const rootAt = argv.indexOf("--root");
if (rootAt >= 0 && !argv[rootAt + 1]) {
  console.error("--root needs a directory");
  process.exit(2);
}
const repoRoot = rootAt >= 0 ? path.resolve(argv[rootAt + 1]) : scriptRoot;

const failures = [];
const passed = [];
for (const { rel, painter } of TARGETS) {
  let source;
  try {
    source = readFileSync(path.join(repoRoot, rel), "utf8");
  } catch (err) {
    failures.push(`cannot read ${rel}: ${err.message}`);
    continue;
  }
  const failure = judge(rel, source, painter);
  if (failure) {
    failures.push(failure);
    continue;
  }
  const { imported } = auditPalette(source);
  passed.push(
    `${path.basename(rel)} (${imported.length ? imported.join(", ") : "no palette use, hex-scanned only"})`,
  );
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`ok: no local hex, palette imported — ${passed.join(", ")}`);
