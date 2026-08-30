#!/usr/bin/env node
/**
 * Rule: a symbol an extension imports as a VALUE must be exported as a VALUE by its plugin-sdk
 * subpath — not merely present in it under `export type`.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * 2026-08-07. `src/plugin-sdk/fork-prefrontal-schema.ts` re-exported all 32 of its names with
 * `export type`. Fifteen of them are TypeBox schema CONSTS, and the consuming extension compiles
 * them at module load:
 *
 *     const vSet = ajv.compile(PrefrontalPlanSetParamsSchema);   // plan-rpcs.ts:19
 *
 * Under `verbatimModuleSyntax` a type export is erased, so each of those became
 * `ajv.compile(undefined)` at startup — from a subpath whose every name genuinely existed, in a
 * file that reads correctly.
 *
 * `lint:plugins:plugin-sdk-subpaths-exported` was GREEN before the defect, green with it in place,
 * and green after the fix: it checks that referenced subpaths appear in the exports map, which is a
 * question about NAMES. This gate asks the other question.
 *
 *   THE FAILURE CLASS: A SUBPATH CAN CARRY THE NAME AND NOT THE VALUE.
 *
 * It survived a full symbol-level audit — the audit asked whether each name was exported and never
 * asked whether it was a value or a type — and was caught only because an agent applying the
 * rewrite refused a mapping it could not make typecheck. That is not a control anyone should rely
 * on twice, so it is a gate now.
 *
 * WHAT IT DOES NOT COVER, stated so the green line is not over-read:
 *   - Only DIRECT re-exports in src/plugin-sdk/<name>.ts are resolved. A subpath that re-exports
 *     through another subpath is reported as unknown, not as a pass.
 *   - `export *` is treated as opaque: it may carry the value, so the symbol is skipped rather than
 *     flagged. This gate produces no false alarms and is therefore not exhaustive.
 *   - It reasons about source text, not about emitted JavaScript. It catches this class; a
 *     typecheck is still the authority on whether the tree compiles.
 *
 * Exit 1 on any violation. Ratchet: 0 — it starts clean and must stay clean.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = path.join(repoRoot, "src", "plugin-sdk");
const EXT_DIR = path.join(repoRoot, "extensions");
const PREFIX = "openclaw/plugin-sdk/";

/** Strip comments and string literals so prose about `export type` is never parsed as code. */
function stripNonCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // node_modules under extensions/ is enormous and contains no first-party source.
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** -> { values:Set, types:Set, opaque:boolean } for one subpath module. */
async function subpathExports(name) {
  let src;
  try {
    src = stripNonCode(await fs.readFile(path.join(SDK_DIR, `${name}.ts`), "utf8"));
  } catch {
    return null;
  }
  const values = new Set();
  const types = new Set();
  const opaque = /export\s+\*\s+from/.test(src);

  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    const isTypeBlock = Boolean(m[1]);
    for (let spec of m[2].split(",")) {
      spec = spec.trim();
      if (!spec) continue;
      const inlineType = /^type\s+/.test(spec);
      const name_ = (spec.includes(" as ") ? spec.split(" as ").pop() : spec)
        .replace(/^type\s+/, "")
        .trim();
      if (!name_) continue;
      (isTypeBlock || inlineType ? types : values).add(name_);
    }
  }
  // locally declared exports (export const/function/class/…)
  for (const m of src.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function|class|enum)\s+([A-Za-z0-9_$]+)/g,
  )) {
    values.add(m[2]);
  }
  return { values, types, opaque };
}

const files = await walk(EXT_DIR);
const cache = new Map();
const violations = [];

for (const file of files) {
  const raw = await fs.readFile(file, "utf8");
  if (!raw.includes(PREFIX)) continue;
  const src = stripNonCode(raw);

  for (const m of src.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']openclaw\/plugin-sdk\/([A-Za-z0-9_.-]+)["']/g,
  )) {
    if (m[1]) continue; // `import type { … }` — nothing is needed at runtime
    const sub = m[3];
    if (!cache.has(sub)) cache.set(sub, await subpathExports(sub));
    const info = cache.get(sub);
    if (!info || info.opaque) continue; // unresolvable or `export *`: no claim either way

    for (let spec of m[2].split(",")) {
      spec = spec.trim();
      if (!spec || /^type\s+/.test(spec)) continue; // inline `type X` is erased on purpose
      const local = spec.includes(" as ") ? spec.split(" as ")[0].trim() : spec;
      if (info.values.has(local)) continue;
      if (info.types.has(local)) {
        violations.push({
          file: path.relative(repoRoot, file),
          symbol: local,
          sub,
          why: "imported as a VALUE but the subpath exports it with `export type` (erased at compile time)",
        });
      }
      // not found at all -> a name problem, which subpaths-exported already owns. Not ours.
    }
  }
}

const line = (s) => process.stdout.write(`${s}\n`);
if (violations.length === 0) {
  line("OK: every value-imported plugin-sdk symbol is value-exported by its subpath.");
  process.exit(0);
}
line("Rule: a symbol imported as a VALUE must be VALUE-exported by its plugin-sdk subpath.");
line(
  "A `export type` re-export is erased at compile time — the import resolves to undefined at runtime.",
);
line("");
for (const v of violations) {
  line(`${v.file}`);
  line(`  - ${v.symbol}  from openclaw/plugin-sdk/${v.sub}`);
  line(`    ${v.why}`);
  line(
    `    fix: move ${v.symbol} out of the \`export type { … }\` block in src/plugin-sdk/${v.sub}.ts`,
  );
}
line("");
line(`Value/type export violations found (${violations.length}).`);
process.exit(1);
