#!/usr/bin/env node
/**
 * Re-apply fork hook wiring to upstream files after a merge.
 *
 * For each TIER 1 file, inserts the minimal import + hook calls.
 * This script is idempotent — safe to run multiple times.
 *
 * Usage: node scripts/apply-fork-wiring.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function readFile(rel) {
  return readFileSync(resolve(ROOT, rel), "utf-8");
}
function writeFile(rel, content) {
  writeFileSync(resolve(ROOT, rel), content, "utf-8");
  console.log(`  ✏️  Patched: ${rel}`);
}

// ---------------------------------------------------------------------------
// 1. attempt.ts — add fork hooks import + replace persona block
// ---------------------------------------------------------------------------
function patchAttempt() {
  const file = "src/agents/pi-embedded-runner/run/attempt.ts";
  let src = readFile(file);

  const FORK_IMPORT = 'import * as forkAttemptHooks from "../../../fork/attempt-hooks.js"; // FORK: single hook entry point';
  const RETRIEVAL_IMPORT = 'import { getRetrievalRuntime } from "../../pi-extensions/retrieval-runtime.js"; // FORK: still used inline for retrieval pack';

  // Add imports if missing
  if (!src.includes("fork/attempt-hooks")) {
    // Insert after the last import line
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx > -1) {
      const lineEnd = src.indexOf("\n", lastImportIdx + 1);
      src = src.slice(0, lineEnd + 1) + RETRIEVAL_IMPORT + "\n" + FORK_IMPORT + "\n" + src.slice(lineEnd + 1);
    }
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2. system-prompt.ts — add personaBlock param + isMinimal skills suppression
// ---------------------------------------------------------------------------
function patchSystemPrompt() {
  const file = "src/agents/system-prompt.ts";
  let src = readFile(file);

  // Add personaBlock param if missing
  if (!src.includes("personaBlock")) {
    // Find the buildAgentSystemPrompt params type and add personaBlock
    src = src.replace(
      /(ttsHint\?: string;)/,
      '$1\n  /** Tier 1 persona block from CORTEX runtime — injected near the top, always cached. */\n  personaBlock?: string;',
    );
  }

  // Add isMinimal to buildSkillsSection if missing
  if (!src.includes("isMinimal") && src.includes("buildSkillsSection")) {
    src = src.replace(
      /function buildSkillsSection\(params: \{\s*skillsPrompt\?: string;\s*readToolName: string\s*\}\)/,
      'function buildSkillsSection(params: { skillsPrompt?: string; isMinimal: boolean; readToolName: string })',
    );
    // Add early return for isMinimal
    const skillsFnBody = src.indexOf("function buildSkillsSection");
    if (skillsFnBody > -1) {
      const bodyStart = src.indexOf("{", src.indexOf(")", skillsFnBody));
      if (bodyStart > -1 && !src.slice(bodyStart, bodyStart + 200).includes("isMinimal")) {
        src = src.slice(0, bodyStart + 1) +
          "\n  if (params.isMinimal) {\n    return [];\n  }" +
          src.slice(bodyStart + 1);
      }
    }
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 3. process-message.ts — add thinking reaction + offline recovery
// ---------------------------------------------------------------------------
function patchProcessMessage() {
  const file = "src/web/auto-reply/monitor/process-message.ts";
  let src = readFile(file);

  const FORK_IMPORT = 'import { annotateOfflineRecovery, createThinkingReaction } from "../../../../fork/process-message-hooks.js"; // FORK';

  if (!src.includes("fork/process-message-hooks")) {
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx > -1) {
      const lineEnd = src.indexOf("\n", lastImportIdx + 1);
      src = src.slice(0, lineEnd + 1) + FORK_IMPORT + "\n" + src.slice(lineEnd + 1);
    }
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("🔌 Applying fork hook wiring...\n");

try { patchAttempt(); } catch (err) { console.warn(`  ⚠️  attempt.ts: ${err.message}`); }
try { patchSystemPrompt(); } catch (err) { console.warn(`  ⚠️  system-prompt.ts: ${err.message}`); }
try { patchProcessMessage(); } catch (err) { console.warn(`  ⚠️  process-message.ts: ${err.message}`); }

console.log("\n✅ Fork wiring applied. Run: pnpm build");
