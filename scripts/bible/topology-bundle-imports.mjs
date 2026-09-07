#!/usr/bin/env node
/**
 * topology.md — the `tinkerclaw-round-table` (SYNAPSE/J6) and `tinkerclaw-total-recall` (ENGRAM/J1)
 * Status cells — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md (§Plugin inventory, "Resolved
 * 2026-08-03") and is the authority. In words: a DEPLOYED status for these two plugins asserts two
 * things that must hold TOGETHER — `@sinclair/typebox` resolves from each plugin directory (it is
 * an EXTERNAL import, deliberately not inlined, so the fix is the resolution), and each built dist
 * bundle imports clean under node. Resolution alone does not prove the bundle loads, and a bundle
 * that loads today can stop resolving after the next upstream merge.
 *
 * The failure CLASS is still live even though this instance is fixed: it is the recurring
 * native-deps/hoisting pattern where `pnpm.onlyBuiltDependencies` gets wiped on an upstream merge.
 * This script is the ratchet that turns that silent regression back into a red build instead of a
 * stale Status cell.
 *
 * Each bundle is imported in a THROWAWAY child process on purpose — importing a plugin entry into
 * the checker itself would run its module side effects inside the bible gate.
 *
 * FOUNDATION.md §"Three different jobs, three different homes" is why this encoding lives in
 * scripts/bible/. When this script and topology.md disagree, topology.md is right.
 *
 * Usage:
 *   node scripts/bible/topology-bundle-imports.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

const PLUGINS = ["tinkerclaw-round-table", "tinkerclaw-total-recall"];
const DEPENDENCY = "@sinclair/typebox";

const problems = [];

for (const plugin of PLUGINS) {
  const extDir = path.join(repoRoot, "extensions", plugin);
  if (!existsSync(extDir)) {
    problems.push(`extensions/${plugin} does not exist — topology.md's inventory row is stale`);
    continue;
  }

  try {
    require.resolve(DEPENDENCY, { paths: [extDir] });
  } catch {
    problems.push(
      `${DEPENDENCY} no longer resolves from extensions/${plugin} — the FAILING-to-load status is back. ` +
        "Check whether an upstream merge wiped pnpm.onlyBuiltDependencies; until it resolves, revert that Status cell.",
    );
  }

  const bundle = path.join(repoRoot, "dist", "extensions", plugin, "index.js");
  if (!existsSync(bundle)) {
    problems.push(
      `dist/extensions/${plugin}/index.js is missing — either dist has not been built on this machine, ` +
        "or the plugin no longer produces a bundle. A DEPLOYED Status cell claims a built bundle exists.",
    );
    continue;
  }

  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import(process.argv[1]);", pathToFileURL(bundle).href],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 20_000 },
    );
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err)
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.slice(0, 220);
    problems.push(
      `dist/extensions/${plugin}/index.js no longer imports clean (${detail ?? "no detail"}) — ` +
        "revert its Status cell to FAILING until it does",
    );
  }
}

if (problems.length) {
  console.error("topology.md's plugin Status cells are no longer true:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `round-table + total-recall: ${DEPENDENCY} resolves from both plugin directories and both dist bundles import clean.`,
);
