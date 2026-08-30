#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * FORK GUARD — a production module must not import a relative path that does not exist.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/memory/integration.ts` was a 517-line "Cognitive Orchestrator" importing seven modules
 * from `src/memory/{cortex,limbic,synapse}/` — directories that were deleted when those
 * subsystems were extracted into `extensions/tinkerclaw-*`. The file could not be imported at
 * all. Its test WAS collected by the unit project (`src/**‍/*.test.ts`, with no exclusion for
 * `src/memory/**`) and failed with `Cannot find module './cortex/behavioral-probes.js'`.
 *
 * Nothing caught it, because:
 *   - `tsdown` only bundles what is reachable from a declared entry point, so an orphan does not
 *     break the build;
 *   - `tsgo` runs against tsconfigs that did not reach it;
 *   - the unit suite failure was one red file among many and nobody was reading the tail.
 *
 * A relative specifier that resolves to nothing is the one form of dead code that needs no
 * judgement: no plugin manifest, no tsconfig alias, no string dispatch and no host convention can
 * rescue it. That makes it worth a dedicated, fast gate.
 *
 * RATCHET, not a wall. There are pre-existing breakages in upstream-derived trees
 * (`src/line/` imports 15 modules that do not exist; `src/media-understanding/providers/*` import
 * a `../image.js` and `../shared.js` that were never brought across a merge). Deleting upstream
 * files invites merge conflicts, so that is the architect's call, not this gate's. The gate
 * asserts only that the count NEVER RISES — same discipline as
 * TINKER_UI_DESIGN_BIBLE/canonical-derivations.md.
 *
 * Usage:
 *   node scripts/check-broken-relative-imports.mjs           # enforce the ratchet
 *   node scripts/check-broken-relative-imports.mjs --list    # print every offender
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The measured status quo on 2026-08-03, after removing src/memory/integration.ts.
// Lower this when you fix one. Never raise it.
const BASELINE = 28;

const SKIP = /node_modules|[/\\]dist|\.d\.ts$|chrome-extension|\.disabled-hostver|[/\\]\.git[/\\]/;

// Test files are excluded: several guardrail specs embed fixture SOURCE inside template
// literals, and a line-anchored `import` inside a backtick string is indistinguishable from a
// real one without a full parse. Production files carry the signal.
const IS_TEST =
  /\.test\.ts$|\.spec\.ts$|__tests__|test-utils|test-helpers|test-harness|test-support|shared-test|test-setup|\.mocks\.ts$/;

const IMPORT_RE = new RegExp(
  [
    String.raw`(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from\s*['"](\.[^'"]+)['"]`,
    String.raw`(?:^|\n)[ \t]*import\s*['"](\.[^'"]+)['"]`,
    String.raw`import\s*\(\s*['"](\.[^'"]+)['"]\s*\)`,
    String.raw`require\s*\(\s*['"](\.[^'"]+)['"]\s*\)`,
  ].join("|"),
  "g",
);

function resolves(importerAbs, spec) {
  const base = path.normalize(path.join(path.dirname(importerAbs), spec));
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${base}.d.ts`,
    `${stem}.d.ts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return true;
  }
  return false;
}

function listFiles() {
  const out = execFileSync(
    "find",
    [
      path.join(repoRoot, "src"),
      path.join(repoRoot, "extensions"),
      path.join(repoRoot, "packages"),
      "-type",
      "f",
      "-name",
      "*.ts",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\n").filter((f) => f && !SKIP.test(f) && !IS_TEST.test(f));
}

const offenders = [];
for (const abs of listFiles()) {
  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  const missing = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec && !resolves(abs, spec)) missing.add(spec);
  }
  if (missing.size > 0) {
    offenders.push({ file: path.relative(repoRoot, abs), missing: [...missing].sort() });
  }
}

offenders.sort((a, b) => b.missing.length - a.missing.length || a.file.localeCompare(b.file));

if (process.argv.includes("--list")) {
  for (const o of offenders) {
    console.log(`${o.file}  (${o.missing.length})`);
    for (const s of o.missing) console.log(`    -> ${s}`);
  }
}

const count = offenders.length;
if (count > BASELINE) {
  console.error(
    `A production module gained a relative import that resolves to nothing.\n` +
      `  now: ${count}   baseline: ${BASELINE}\n` +
      `Such a module cannot be imported at ALL — no manifest, alias or string dispatch can\n` +
      `rescue a missing relative path. Fix the import, or delete the module and LOWER the\n` +
      `BASELINE in this file in the same commit.\n`,
  );
  for (const o of offenders.slice(0, 12)) {
    console.error(`  ${o.file}`);
    for (const s of o.missing.slice(0, 4)) console.error(`      -> ${s}`);
  }
  process.exit(1);
}

if (count < BASELINE) {
  console.log(
    `broken relative imports: ${count} (baseline ${BASELINE}) — ratchet can be LOWERED to ${count}.`,
  );
} else {
  console.log(`broken relative imports: ${count} (at baseline).`);
}
