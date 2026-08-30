#!/usr/bin/env node
/**
 * topology.md — "tinker-bridge plugin discoverable + manifest valid" — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md (§Plugin inventory) and is the
 * authority. In words: the fork's provider plugin ships a runtime manifest whose `id` matches its
 * directory, a loadable stub beside it, and — because tinker-bridge is LAZY-loaded — an
 * `activation.onProviders` list containing `claude-code`. That last key is the entire activation
 * gate. Delete it and the provider never loads, with no error anywhere, because nothing asked for
 * it. That is the failure class this check exists for: absence, not breakage.
 *
 * This file is only one ENCODING of that invariant. FOUNDATION.md §"Three different jobs, three
 * different homes" is why it lives here rather than pasted into the optic's YAML frontmatter: a
 * program embedded in frontmatter cannot be linted, reviewed, or exercised as code.
 *
 * Source-only by construction — it reads files on disk and never contacts a gateway.
 *
 * When this script and topology.md disagree, topology.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/topology-plugin-manifest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "tinkerclaw-tinker-bridge";
const REQUIRED_PROVIDER = "claude-code";

const pluginDir = path.join(repoRoot, "dist-runtime", "extensions", PLUGIN_ID);
const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
const stubPath = path.join(pluginDir, "index.js");

function fail(message) {
  console.error(`topology.md §Plugin inventory is stale: ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail(
    `missing ${path.relative(repoRoot, manifestPath)} — the plugin is not discoverable at runtime.\n` +
      "  If dist-runtime has simply not been built on this machine, build it; if the manifest was\n" +
      "  renamed or moved, the inventory row above is wrong.",
  );
}
if (!existsSync(stubPath)) {
  fail(
    `missing ${path.relative(repoRoot, stubPath)} — the manifest points at a stub that is not there.`,
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail(`${path.relative(repoRoot, manifestPath)} is not valid JSON (${String(err)})`);
}

if (manifest.id !== PLUGIN_ID) {
  fail(
    `manifest id mismatch: expected ${JSON.stringify(PLUGIN_ID)}, got ${JSON.stringify(manifest.id)}.\n` +
      "  topology.md states four places the id must match: index.ts, openclaw.plugin.json, the\n" +
      "  dist-runtime manifest, and the openclaw.json config key. One of them drifted.",
  );
}

const onProviders = manifest.activation?.onProviders ?? [];
if (!Array.isArray(onProviders) || !onProviders.includes(REQUIRED_PROVIDER)) {
  fail(
    `manifest is missing activation.onProviders containing ${JSON.stringify(REQUIRED_PROVIDER)}.\n` +
      "  tinker-bridge is LAZY-loaded, so this key is what gates activation. Without it the provider\n" +
      "  never loads and nothing errors — the symptom is a silently absent provider, not a crash.\n" +
      `  Got: ${JSON.stringify(onProviders)}`,
  );
}

console.log(
  `${PLUGIN_ID}: manifest + stub discoverable, id matches its directory, lazy-activation wired to ${REQUIRED_PROVIDER}.`,
);
