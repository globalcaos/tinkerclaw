#!/usr/bin/env node
/**
 * ENGRAM Sleep Consolidation runner — called by the nightly cron.
 *
 * Uses jiti to load TypeScript source directly (same approach as the main CLI).
 * Usage: node scripts/engram-sleep.mjs [--base-dir ~/.openclaw/engram] [--session-key live]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

// Parse args
const args = process.argv.slice(2);
const baseDir = args.includes("--base-dir")
  ? args[args.indexOf("--base-dir") + 1]
  : join(process.env.HOME ?? "~", ".openclaw", "engram");
const sessionKey = args.includes("--session-key")
  ? args[args.indexOf("--session-key") + 1]
  : "live";

// Use jiti for TypeScript imports (same as OpenClaw CLI)
let jiti;
try {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  jiti = createJiti(import.meta.url, { interopDefault: true });
} catch {
  console.error("jiti not available — install deps first: pnpm install");
  process.exit(1);
}

const { createEventStore } = jiti(join(repoRoot, "src/memory/engram/event-store.ts"));
const { createArtifactStore } = jiti(join(repoRoot, "src/memory/engram/artifact-store.ts"));
const { createInitialConsolidationState } = jiti(join(repoRoot, "src/memory/engram/episode-detection.ts"));
const { runSleepConsolidation } = jiti(join(repoRoot, "src/memory/engram/sleep-consolidation.ts"));

// Ensure dirs exist
mkdirSync(baseDir, { recursive: true });

const stateFile = join(baseDir, "consolidation-state.json");

let state;
if (existsSync(stateFile)) {
  state = JSON.parse(readFileSync(stateFile, "utf-8"));
} else {
  state = createInitialConsolidationState();
}

const store = createEventStore({ baseDir, sessionKey });
const artifactStore = createArtifactStore({ baseDir });

try {
  const result = await runSleepConsolidation(store, artifactStore, state);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("ENGRAM sleep consolidation failed:", err.message);
  process.exit(1);
}
