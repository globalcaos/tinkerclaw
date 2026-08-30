#!/usr/bin/env node
/**
 * right-rail-interaction.md I1 — "every viewed-session surface is a DIRECT member of
 * `refreshViewedSessionIndicators()`, never a tail call behind another panel's early
 * return" — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/right-rail-interaction.md and is the
 * authority; this file is one encoding of it, deliberately kept out of the markdown
 * (FOUNDATION.md, "Three different jobs, three different homes": explaining is the
 * bible's job, checking that the bible still matches the code is `scripts/bible/`'s).
 *
 * WHAT CHANGED WHEN IT MOVED (2026-08-04). The inline version asserted
 * `body.includes(name + "(")` over the RAW function body. That is satisfied by a comment
 * or a log string. Measured on a copy of the real tree: deleting `renderEegPanel();` and
 * leaving behind the sentence `// renderEegPanel() moved into updateBudgetPanel` kept the
 * old gate GREEN, and so did wrapping the real call in an `if` — which I1 forbids in so
 * many words. The check now blanks comments and string literals first, and requires each
 * surface to be called as a TOP-LEVEL statement of the body (brace depth 0, paren depth
 * 0), which is what "DIRECT member" means.
 *
 * The anti-vacuity property is proven on every run: `selfTest()` executes first against
 * synthetic fixtures. A test that never fires is a defect (design-principles.md #20).
 *
 * Usage:
 *   node scripts/bible/right-rail-funnel.mjs              # self-test, then the real check
 *   node scripts/bible/right-rail-funnel.mjs --self-test  # fixtures only
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_REL = "tinker-ui/src/app.ts";
const FN = "refreshViewedSessionIndicators";

/** The viewed-session surfaces the funnel owns — right-rail-interaction.md §4. */
const SURFACES = [
  "updateChat",
  "updateBtn",
  "updateSessionsPanel",
  "updateBudgetPanel",
  "updatePrefrontalTree",
  "renderCachePanel",
  "renderEegPanel",
  "renderAmygdalaPanel",
  "refreshTreemap",
  "updateResponseMap",
];

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "typeof",
  "await",
  "new",
  "do",
]);

/**
 * Replace every comment and string/template literal with spaces, preserving length and
 * newlines so brace matching stays honest. Only what the engine would EXECUTE survives.
 */
export function blankNonCode(src) {
  const keep = (ch) => (ch === "\n" ? "\n" : " ");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += keep(src[i]);
        i++;
      }
      out += i < src.length ? "  " : "";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += " ";
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === c) {
          out += " ";
          i++;
          break;
        }
        out += keep(src[i]);
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract the brace-balanced body of `function <name>()` from already-blanked code. */
function funcBody(blanked, name) {
  const header = blanked.indexOf(`function ${name}(`);
  if (header < 0) return null;
  const open = blanked.indexOf("{", header);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === "{") depth++;
    else if (blanked[i] === "}") {
      depth--;
      if (depth === 0) return blanked.slice(open + 1, i);
    }
  }
  return null;
}

/** Names invoked as a top-level statement of the body: brace depth 0 AND paren depth 0. */
export function directCalls(body) {
  const found = new Set();
  let brace = 0;
  let paren = 0;
  const ident = /[A-Za-z_$][\w$]*/y;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (brace === 0 && paren === 0 && /[A-Za-z_$]/.test(c)) {
      ident.lastIndex = i;
      const m = ident.exec(body);
      if (m) {
        const end = i + m[0].length;
        // A member call (`a.b()`) is not this funnel's own statement call.
        const prev = body.slice(0, i).trimEnd().slice(-1);
        if (body[end] === "(" && !KEYWORDS.has(m[0]) && prev !== ".") found.add(m[0]);
        i = end - 1;
      }
    }
  }
  return found;
}

/** Fixtures that prove the check cannot be satisfied by prose. */
function selfTest() {
  const fixture = `
function refreshViewedSessionIndicators() {
  realCall();
  // commentOnlyCall() is named here but never invoked
  const s = "stringOnlyCall()";
  if (cond()) {
    nestedCall();
  }
}
`;
  const body = funcBody(blankNonCode(fixture), FN);
  if (body === null) throw new Error("self-test: funcBody failed to find the fixture funnel");
  const direct = directCalls(body);
  const expect = [
    ["realCall", true],
    ["commentOnlyCall", false],
    ["stringOnlyCall", false],
    ["nestedCall", false],
    ["cond", false],
  ];
  for (const [name, want] of expect) {
    if (direct.has(name) !== want) {
      throw new Error(
        `self-test FAILED: ${name} direct=${direct.has(name)}, expected ${want}. ` +
          "The vacuity guard is broken — refusing to run the real check.",
      );
    }
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
  console.log("ok: right-rail funnel self-test (comment/string/nested calls all rejected)");
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

const body = funcBody(blankNonCode(source), FN);
if (body === null) {
  console.error(`funnel not found: no brace-balanced \`function ${FN}()\` in ${SRC_REL}`);
  process.exit(1);
}

const direct = directCalls(body);
const missing = SURFACES.filter((s) => !direct.has(s));
if (missing.length) {
  const demoted = missing.filter((s) => body.includes(s));
  console.error(
    `I1 VIOLATED — not a DIRECT member of ${FN}(): ${missing.join(", ")}\n` +
      "Every viewed-session surface re-derives in this one funnel. A surface that is only a\n" +
      "tail call of another panel silently keeps the PREVIOUS tab's content whenever that\n" +
      "panel takes its early return. See TINKER_UI_DESIGN_BIBLE/right-rail-interaction.md §4.",
  );
  if (demoted.length) {
    console.error(
      "  present in the body but NOT at statement level (nested, or only in a\n" +
        `  comment/string): ${demoted.join(", ")}`,
    );
  }
  process.exit(1);
}

console.log(`ok: ${SURFACES.length} surfaces are DIRECT members of ${FN}()`);
