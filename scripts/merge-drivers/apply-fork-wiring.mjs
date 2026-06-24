#!/usr/bin/env node
/**
 * Re-apply fork hook wiring to upstream files after a merge.
 *
 * For each TIER 1 file, inserts the minimal import + hook calls.
 * This script is idempotent — safe to run multiple times.
 *
 * Usage: node scripts/apply-fork-wiring.mjs
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TINKERCLAW_DIR || resolve(process.env.HOME, "src/tinkerclaw");

function readFile(rel) {
  return readFileSync(resolve(ROOT, rel), "utf-8");
}
function writeFile(rel, content) {
  writeFileSync(resolve(ROOT, rel), content, "utf-8");
  console.log(`  ✏️  Patched: ${rel}`);
}

// ---------------------------------------------------------------------------
// Helpers: insert text before/after a regex anchor
// ---------------------------------------------------------------------------
function insertBeforeAnchor(src, anchorRegex, insertion, label) {
  const match = anchorRegex.exec(src);
  if (!match) {
    console.warn(`    Could not find anchor for: ${label}`);
    return null;
  }
  return src.slice(0, match.index) + insertion + "\n" + src.slice(match.index);
}

function insertAfterAnchor(src, anchorRegex, insertion, label) {
  const match = anchorRegex.exec(src);
  if (!match) {
    console.warn(`    Could not find anchor for: ${label}`);
    return null;
  }
  const end = match.index + match[0].length;
  return src.slice(0, end) + "\n" + insertion + src.slice(end);
}

// ---------------------------------------------------------------------------
// 1. attempt.ts — add fork hooks import + replace persona block
// ---------------------------------------------------------------------------
function patchAttempt() {
  const file = "src/agents/embedded-agent-runner/run/attempt.ts";
  let src = readFile(file);

  const FORK_IMPORT =
    'import * as _forkAttemptHooks from "../../../fork/attempt-hooks.js"; // FORK: single hook entry point';

  // Add fork hooks import if missing. Historically also added a retrieval-runtime
  // import, but that import was dead code (never called inline) — dropped 2026-04-18.
  if (!src.includes("fork/attempt-hooks")) {
    // Insert after the last import line
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx > -1) {
      const lineEnd = src.indexOf("\n", lastImportIdx + 1);
      src = src.slice(0, lineEnd + 1) + FORK_IMPORT + "\n" + src.slice(lineEnd + 1);
    }
  }

  // Hook 1: personaBlock — before buildEmbeddedSystemPrompt
  if (!src.includes("getPersonaBlock")) {
    let r = insertBeforeAnchor(
      src,
      /const appendPrompt = buildEmbeddedSystemPrompt\(\{/,
      `    // FORK: persona block injection from CORTEX/SOUL.md
    const personaBlock = _forkAttemptHooks.getPersonaBlock(effectiveWorkspace);\n`,
      "personaBlock hook",
    );
    if (r) {
      src = r;
      // Also add personaBlock param to the buildEmbeddedSystemPrompt call
      src = src.replace(
        /memoryCitationsMode:\s*params\.config\?\.\s*memory\?\.\s*citations,\s*\n(\s*)\}\)/,
        `memoryCitationsMode: params.config?.memory?.citations,
$1  personaBlock, // FORK: Tier 1 persona block from CORTEX runtime
$1})`,
      );
    }
  }

  // Hook 2: mid-context reinject — before prompt call
  if (!src.includes("applyMidContextReinjectHook")) {
    const r = insertBeforeAnchor(
      src,
      /\/\/ Only pass images option/,
      `          // FORK: mid-context persona re-injection when SyncScore drops
          {
            const reinjectResult = _forkAttemptHooks.applyMidContextReinjectHook(
              activeSession as unknown as import("@mariozechner/pi-coding-agent").SessionManager,
              systemPromptText ?? "",
              log,
            );
            if (reinjectResult.reinjected && systemPromptText != null) {
              systemPromptText = reinjectResult.systemPromptText;
            }
          }\n`,
      "mid-context reinject hook",
    );
    if (r) {
      src = r;
    }
  }

  // Hook 3: text-tool-call interception — after agent_end hook
  if (!src.includes("interceptTextToolCalls")) {
    const r = insertAfterAnchor(
      src,
      /log\.warn\(`agent_end hook failed: \$\{err\}`\);\s*\n\s*\}\);\s*\n\s*\}/,
      `
        // FORK: text-tool-call interception for local providers (ollama/lmstudio/vllm)
        if (!promptError && !aborted && tools.length > 0) {
          const ttcResult = await _forkAttemptHooks.interceptTextToolCalls({
            provider: params.provider,
            activeSession: activeSession as never,
            tools: tools as never,
            toolMetas: toolMetas as never,
            promptError,
            aborted,
            abortSignal: params.abortSignal,
            abortable,
            log,
          });
          if (ttcResult.promptError) {
            promptError = ttcResult.promptError;
          }
        }`,
      "text-tool-call interception hook",
    );
    if (r) {
      src = r;
    }
  }

  // Hook 4: onTurnComplete — before final return
  if (!src.includes("onTurnComplete")) {
    const r = insertBeforeAnchor(
      src,
      // Anchor updated 2026-06-19: the return object gained replayMetadata/itemLifecycle
      // before `aborted,`, which silently broke the old `return {\n aborted,` anchor and
      // left onTurnComplete unwired (anatomy DB + EEG trace dead since 2026-05-25). Anchor
      // on the stable leading fields instead. runId is REQUIRED by PostTurnParams.
      /return \{\s*\n\s*replayMetadata,\s*\n\s*itemLifecycle:/,
      `      // FORK: fire-and-forget post-turn processing (context anatomy, ENGRAM, SyncScore, observations)
      _forkAttemptHooks.onTurnComplete({
        runId: params.runId,
        sessionManager: activeSession as unknown as import("@mariozechner/pi-coding-agent").SessionManager,
        sessionKey: params.sessionKey,
        messagesSnapshot,
        assistantTexts,
        systemPromptReport,
        provider: params.provider,
        modelId: params.modelId,
        contextWindowTokens: params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
        getCompactionCount,
        getUsageTotals,
        log,
      }).catch((err) => {
        log.warn(\`fork onTurnComplete failed: \${String(err)}\`);
      });\n`,
      "onTurnComplete hook",
    );
    if (r) {
      src = r;
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
      "$1\n  /** Tier 1 persona block from CORTEX runtime — injected near the top, always cached. */\n  personaBlock?: string;",
    );
  }

  // Inject personaBlock into output lines
  if (!src.includes("params.personaBlock")) {
    src = src.replace(
      /const lines = \[\s*\n\s*"You are a personal assistant running inside OpenClaw\.",\s*\n\s*"",\s*\n\s*"## Tooling"/,
      `const lines = [
    "You are a personal assistant running inside OpenClaw.",
    "",
    // FORK: Tier 1 persona block from CORTEX runtime — injected near the top for identity reinforcement.
    ...(params.personaBlock ? [params.personaBlock, ""] : []),
    "## Tooling"`,
    );
  }

  // Add isMinimal to buildSkillsSection if missing
  if (!src.includes("isMinimal") && src.includes("buildSkillsSection")) {
    src = src.replace(
      /function buildSkillsSection\(params: \{\s*skillsPrompt\?: string;\s*readToolName: string\s*\}\)/,
      "function buildSkillsSection(params: { skillsPrompt?: string; isMinimal: boolean; readToolName: string })",
    );
    // Add early return for isMinimal
    const skillsFnBody = src.indexOf("function buildSkillsSection");
    if (skillsFnBody > -1) {
      const bodyStart = src.indexOf("{", src.indexOf(")", skillsFnBody));
      if (bodyStart > -1 && !src.slice(bodyStart, bodyStart + 200).includes("isMinimal")) {
        src =
          src.slice(0, bodyStart + 1) +
          "\n  if (params.isMinimal) {\n    return [];\n  }" +
          src.slice(bodyStart + 1);
      }
    }
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 3. process-message.ts — REMOVED (2026-04-12, Task 11)
// Hooks now live in extensions/tinkerclaw-whatsapp/src/auto-reply/process-message-hooks.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. sessions.ts — webchat delete bypass
// ---------------------------------------------------------------------------
function patchSessions() {
  const file = "src/gateway/server-methods/sessions.ts";
  let src = readFile(file);
  let changed = false;

  if (!src.includes("Allow webchat delete")) {
    const r = insertBeforeAnchor(
      src,
      /  params\.respond\(\s*\n?\s*false,\s*\n?\s*undefined,\s*\n?\s*errorShape\(\s*\n?\s*ErrorCodes\.INVALID_REQUEST,\s*\n?\s*`webchat clients cannot/,
      `  // Allow webchat delete — handler already prevents deleting the main session\n  if (params.action === "delete") {\n    return false;\n  }\n`,
      "Allow webchat delete",
    );
    if (r) {
      src = r;
      changed = true;
    }
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — webchat delete bypass already present`);
  }
}

// ---------------------------------------------------------------------------
// 5. REMOVED 2026-04-13: patchTsdownConfig (native addon externalization)
//    Upstream migrated from `external:` to `deps.neverBundle:` in tsdown 0.21.7,
//    which REJECTS mixing the two. better-sqlite3 and bindings are already in
//    the neverBundle array (fork-added, persists across merges as a plain
//    list edit, not a patch). Running the old patch on top re-introduced the
//    conflict and broke every build. Function body and call site deleted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. REMOVED 2026-04-13: patchOutbound (send.ts group/edit/reply wrappers)
//    Had zero consumers, and its single-line-import regex mangled send.ts
//    on re-run. Call site + function body deleted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. embedded-agent-subscribe.types.ts — authProfileId field
// ---------------------------------------------------------------------------
function patchSubscribeTypes() {
  const file = "src/agents/embedded-agent-subscribe.types.ts";
  let src = readFile(file);

  if (src.includes("authProfileId")) {
    console.log(`  ✅ ${file} — authProfileId already present`);
    return;
  }

  // Insert before the closing }; of SubscribeEmbeddedAgentSessionParams
  const typeMatch = src.match(/export type SubscribeEmbeddedAgentSessionParams\s*=\s*\{/);
  if (!typeMatch) {
    console.warn(`  ⚠️  Could not find SubscribeEmbeddedAgentSessionParams in ${file}`);
    return;
  }

  // Find the closing }; after the type start
  const startIdx = typeMatch.index + typeMatch[0].length;
  let depth = 1;
  let i = startIdx;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") {
      depth++;
    }
    if (src[i] === "}") {
      depth--;
    }
    i++;
  }
  // i is now just past the closing }
  const insertPos = i - 1; // before the closing }
  src =
    src.slice(0, insertPos) +
    "  /** Auth profile ID for lifecycle event tracking. */\n  authProfileId?: string;\n" +
    src.slice(insertPos);

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 8. monitor.ts — syncFullHistory spread + ActiveWebListener cast
// ---------------------------------------------------------------------------
function patchMonitor() {
  const file = "extensions/tinkerclaw-whatsapp/src/auto-reply/monitor.ts";
  let src = readFile(file);
  let changed = false;

  // 8a. Replace syncFullHistory direct assignment with conditional spread
  if (!src.includes("syncFullHistory != null")) {
    const replaced = src.replace(
      /syncFullHistory:\s*account\.syncFullHistory,?/,
      "...(account.syncFullHistory != null ? { syncFullHistory: account.syncFullHistory } : {}),",
    );
    if (replaced !== src) {
      src = replaced;
      changed = true;
    }
  }

  // 8b. Replace setActiveWebListener with cast version
  if (!src.includes("unknown as ActiveWebListener") && !src.includes("unknown as import")) {
    const replaced = src.replace(
      /setActiveWebListener\(account\.accountId,\s*listener\)/,
      'setActiveWebListener(\n      account.accountId,\n      listener as unknown as import("../active-listener.js").ActiveWebListener,\n    )',
    );
    if (replaced !== src) {
      src = replaced;
      changed = true;
    }
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — monitor patches already present`);
  }
}

// ---------------------------------------------------------------------------
// 9. package.json — ensure @types/better-sqlite3 in devDependencies
// ---------------------------------------------------------------------------
function patchDevDeps() {
  const file = "package.json";
  let src = readFile(file);
  const pkg = JSON.parse(src);

  if (pkg.devDependencies?.["@types/better-sqlite3"]) {
    console.log(`  ✅ ${file} — @types/better-sqlite3 already in devDependencies`);
    return;
  }

  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies["@types/better-sqlite3"] = "^7.6.12";
  writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// 10. run.ts — per-profile fallback error events
// ---------------------------------------------------------------------------
function patchRun() {
  const file = "src/agents/embedded-agent-runner/run.ts";
  let src = readFile(file);

  // Add emitAgentEvent import
  if (!src.includes("agent-events")) {
    src = src.replace(
      /import { generateSecureToken }/,
      'import { emitAgentEvent } from "../../infra/agent-events.js"; // FORK: per-profile fallback error events\nimport { generateSecureToken }',
    );
  }

  // Emission site 1: cooldown skip in advanceAuthProfile
  if (!src.includes("fallback-profile-error")) {
    // Cooldown skip emission
    src = src.replace(
      /(const candidate = profileCandidates\[nextIndex\];\s*\n\s*if \(candidate && isProfileInCooldown\(authStore, candidate\)\) \{)\s*\n\s*(nextIndex \+= 1;\s*\n\s*continue;)/,
      `$1
            // FORK: emit per-profile fallback error for cooldown skip
            emitAgentEvent({
              runId: params.runId,
              sessionKey: params.sessionKey,
              stream: "lifecycle",
              data: {
                phase: "fallback-profile-error",
                profileId: candidate,
                profileIndex: nextIndex,
                totalProfiles: profileCandidates.length,
                reason: "cooldown",
              },
            });
            $2`,
    );

    // Catch block emission
    src = src.replace(
      /(if \(candidate && candidate === lockedProfileId\) \{\s*\n\s*throw err;\s*\n\s*\})\s*\n\s*(nextIndex \+= 1;\s*\n\s*\}\s*\n\s*\}\s*\n\s*return false;)/,
      `$1
            // FORK: emit per-profile fallback error for key resolution failure
            emitAgentEvent({
              runId: params.runId,
              sessionKey: params.sessionKey,
              stream: "lifecycle",
              data: {
                phase: "fallback-profile-error",
                profileId: candidate,
                profileIndex: nextIndex,
                totalProfiles: profileCandidates.length,
                reason: "auth",
                message: String(err),
              },
            });
            $2`,
    );
  }

  // FORK 2026-04-28: createEmbeddedRunAuthController gained required runId +
  // sessionKey params upstream. Inject them after the `log,` line if missing.
  // The auto-merge tends to drift the surrounding lines, so this patch
  // re-applies on every chunk.
  if (
    !/runId: params\.runId,\s*\n\s*sessionKey: params\.sessionKey \?\? params\.sessionId/.test(src)
  ) {
    const before = src;
    src = src.replace(
      /(setThinkLevel: \(next\) => \{\s*\n\s*thinkLevel = next;\s*\n\s*\},\s*\n\s*log,\s*\n)(\s*\}\);)/,
      `$1        runId: params.runId,
        sessionKey: params.sessionKey ?? params.sessionId,
$2`,
    );
    if (src === before) {
      console.warn(
        `  ⚠️  ${file} — could not find createEmbeddedRunAuthController call site for runId/sessionKey injection`,
      );
    } else {
      console.log(`  ✏️  Patched: ${file} (createEmbeddedRunAuthController runId/sessionKey)`);
    }
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 11. failover-matches.ts — billing patterns for Anthropic spending cap
// ---------------------------------------------------------------------------
function patchFailoverMatches() {
  const file = "src/agents/embedded-agent-helpers/failover-matches.ts";
  let src = readFile(file);

  if (src.includes("regain access")) {
    console.log(`  ✅ ${file} — billing patterns already present`);
    return;
  }

  src = src.replace(
    /"insufficient balance",/,
    `"insufficient balance",
    /regain access/i, // FORK: Anthropic spending cap message
    /specified.*usage limits/i, // FORK: Anthropic API usage limit message`,
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 12. errors.ts — early billing check for Anthropic spending cap
// ---------------------------------------------------------------------------
function patchErrors() {
  const file = "src/agents/embedded-agent-helpers/errors.ts";
  let src = readFile(file);

  if (src.includes("regain access")) {
    console.log(`  ✅ ${file} — early billing check already present`);
    return;
  }

  src = src.replace(
    /if \(isRateLimitErrorMessage\(raw\)\) \{/,
    '// FORK: Early billing check for Anthropic spending cap — must come BEFORE\n  // rateLimit because "usage limits" also matches rate_limit patterns.\n  if (/regain access/i.test(raw) || /specified.*usage limits/i.test(raw)) {\n    return "billing";\n  }\n  if (isRateLimitErrorMessage(raw)) {',
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 13. message-handler.ts — scope-clearing fix for authenticated operators
// ---------------------------------------------------------------------------
function patchMessageHandlerScopes() {
  const file = "src/gateway/server/ws-connection/message-handler.ts";
  let src = readFile(file);

  // Upstream has: if (!device && (!isControlUi || decision.kind !== "allow"))
  // Fork needs:  if (!device && decision.kind !== "allow")
  // This allows ANY authenticated operator (not just control-ui) to keep declared scopes.
  const upstream = /if \(!device && \(!isControlUi \|\| decision\.kind !== "allow"\)\)/;
  const forkLine = 'if (!device && decision.kind !== "allow")';

  if (src.includes(forkLine) && !upstream.test(src)) {
    console.log(`  ✅ ${file} — scope-clearing fix already applied`);
    return;
  }

  if (!upstream.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find upstream scope-clearing pattern to patch`);
    return;
  }

  src = src.replace(
    upstream,
    `// FORK: extended from control-ui-only to all authenticated operators (#scope-fix).
          ${forkLine}`,
  );

  // Also update the comment block above if the old upstream comment exists
  src = src.replace(
    /\/\/ device-less backend clients must not self-declare scopes\.\s*Only\s*control[\s\S]*?(?=\n\s*(?:\/\/ FORK|if \(!device))/,
    '// device-less backend clients must not self-declare scopes. Any operator\n          // that passed auth checks (decision === "allow") keeps its declared scopes;\n          ',
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 14. session.ts — fix live-capture import (default→named) for tsdown bundling
// ---------------------------------------------------------------------------
function patchWhatsAppSession() {
  const file = "extensions/tinkerclaw-whatsapp/src/session.ts";
  let src = readFile(file);

  // Guard: already using named import
  if (
    src.includes(
      'import { bindHistoryCapture } from "../../../src/whatsapp-history/live-capture.js"',
    )
  ) {
    console.log(`  ✅ ${file} — already patched`);
    return;
  }

  // Replace default import + fallback chain with direct named import
  // Upstream pattern: import _liveCapture from "..." + const bindHistoryCapture = _liveCapture?.bindHistoryCapture ?? ...
  const defaultImportPattern =
    /\/\/.*(?:FORK|live.?capture|jiti|SQLite).*\n\s*import\s+_liveCapture\s+from\s+["']\.\.\/\.\.\/\.\.\/src\/whatsapp-history\/live-capture\.js["'];?\s*\nconst\s+bindHistoryCapture[^;]+;/;

  if (defaultImportPattern.test(src)) {
    src = src.replace(
      defaultImportPattern,
      '// FORK: SQLite history capture\nimport { bindHistoryCapture } from "../../../src/whatsapp-history/live-capture.js";',
    );
    writeFile(file, src);
    return;
  }

  // Fallback: try without preceding comment
  const barePattern =
    /import\s+_liveCapture\s+from\s+["']\.\.\/\.\.\/\.\.\/src\/whatsapp-history\/live-capture\.js["'];?\s*\nconst\s+bindHistoryCapture[^;]+;/;

  if (barePattern.test(src)) {
    src = src.replace(
      barePattern,
      '// FORK: SQLite history capture\nimport { bindHistoryCapture } from "../../../src/whatsapp-history/live-capture.js";',
    );
    writeFile(file, src);
    return;
  }

  // If neither pattern found, the file might not have the import at all (new upstream version)
  console.warn(`    ⚠️  ${file}: Could not find _liveCapture import pattern to patch`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("🔌 Applying fork hook wiring...\n");

try {
  patchAttempt();
} catch (err) {
  console.warn(`  ⚠️  attempt.ts: ${err.message}`);
}
try {
  patchSystemPrompt();
} catch (err) {
  console.warn(`  ⚠️  system-prompt.ts: ${err.message}`);
}
// patchProcessMessage removed 2026-04-12 (Task 11) — hooks moved to tinkerclaw-whatsapp plugin
try {
  patchSessions();
} catch (err) {
  console.warn(`  ⚠️  sessions.ts: ${err.message}`);
}
try {
  patchSubscribeTypes();
} catch (err) {
  console.warn(`  ⚠️  subscribe.types.ts: ${err.message}`);
}
try {
  patchMonitor();
} catch (err) {
  console.warn(`  ⚠️  monitor.ts: ${err.message}`);
}
try {
  patchDevDeps();
} catch (err) {
  console.warn(`  ⚠️  package.json devDeps: ${err.message}`);
}
try {
  patchRun();
} catch (err) {
  console.warn(`  ⚠️  run.ts: ${err.message}`);
}
try {
  patchFailoverMatches();
} catch (err) {
  console.warn(`  ⚠️  failover-matches.ts: ${err.message}`);
}
try {
  patchErrors();
} catch (err) {
  console.warn(`  ⚠️  errors.ts: ${err.message}`);
}
try {
  patchMessageHandlerScopes();
} catch (err) {
  console.warn(`  ⚠️  message-handler.ts scopes: ${err.message}`);
}
try {
  patchWhatsAppSession();
} catch (err) {
  console.warn(`  ⚠️  whatsapp session.ts: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 2026-04-03: WhatsApp accounts.ts — rootCfg initialization
// ---------------------------------------------------------------------------
try {
  patchWhatsAppAccounts();
} catch (err) {
  console.warn(`  ⚠️  whatsapp accounts.ts: ${err.message}`);
}
function patchWhatsAppAccounts() {
  const file = "extensions/tinkerclaw-whatsapp/src/accounts.ts";
  let src = readFile(file);

  if (src.includes("const rootCfg = params.cfg.channels?.whatsapp")) {
    console.log(`  ✅ ${file} — rootCfg already present`);
    return;
  }

  // Insert rootCfg before the merged config call inside resolveWhatsAppAccount
  src = src.replace(
    /(export function resolveWhatsAppAccount\([^)]*\)[^{]*\{[^]*?)(const merged = resolveMergedWhatsAppAccountConfig)/,
    "$1const rootCfg = params.cfg.channels?.whatsapp;\n  $2",
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-03: WhatsApp channel.ts — direct imports (not runtime seam)
// ---------------------------------------------------------------------------
try {
  patchWhatsAppChannel();
} catch (err) {
  console.warn(`  ⚠️  whatsapp channel.ts: ${err.message}`);
}
function patchWhatsAppChannel() {
  const file = "extensions/tinkerclaw-whatsapp/src/channel.ts";
  let src = readFile(file);

  if (src.includes('import { chunkText } from "openclaw/plugin-sdk/reply-runtime"')) {
    console.log(`  ✅ ${file} — chunkText import already present`);
    return;
  }

  // Add chunkText import after resolveReactionMessageId import
  src = src.replace(
    /import { resolveReactionMessageId } from "openclaw\/plugin-sdk\/channel-actions";/,
    'import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";\nimport { chunkText } from "openclaw/plugin-sdk/reply-runtime";',
  );

  // Replace runtime seam calls with direct function calls
  src = src.replace(
    /getWhatsAppRuntime\(\)\.channel\.whatsapp\.handleWhatsAppAction\(/g,
    "handleWhatsAppAction(",
  );
  src = src.replace(
    /getWhatsAppRuntime\(\)\.channel\.whatsapp\.sendMessageWhatsApp\(/g,
    "sendMessageWhatsApp(",
  );
  src = src.replace(
    /getWhatsAppRuntime\(\)\.channel\.whatsapp\.sendPollWhatsApp\(/g,
    "sendPollWhatsApp(",
  );
  src = src.replace(/getWhatsAppRuntime\(\)\.channel\.text\.chunkText\(/g, "chunkText(");
  src = src.replace(
    /getWhatsAppRuntime\(\)\.channel\.whatsapp\.webAuthExists\(/g,
    "(await loadWhatsAppChannelRuntime()).webAuthExists(",
  );
  src = src.replace(
    /getWhatsAppRuntime\(\)\.channel\.whatsapp\.createLoginTool\(\)/g,
    "createWhatsAppLoginTool()",
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-03: message-channel.ts — webchat-ui in isOperatorUiClient
// ---------------------------------------------------------------------------
try {
  patchWebchatUiScope();
} catch (err) {
  console.warn(`  ⚠️  message-channel.ts webchat-ui: ${err.message}`);
}
function patchWebchatUiScope() {
  const file = "src/utils/message-channel.ts";
  let src = readFile(file);

  if (src.includes("GATEWAY_CLIENT_NAMES.WEBCHAT_UI")) {
    console.log(`  ✅ ${file} — WEBCHAT_UI already in isOperatorUiClient`);
    return;
  }

  src = src.replace(
    /return clientId === GATEWAY_CLIENT_NAMES\.CONTROL_UI \|\| clientId === GATEWAY_CLIENT_NAMES\.TUI;/,
    "return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI || clientId === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;",
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-03: anthropic-vertex-stream.ts — rate limit capturing fetch
// ---------------------------------------------------------------------------
try {
  patchRateLimitCapture();
} catch (err) {
  console.warn(`  ⚠️  anthropic-vertex-stream.ts ratelimit: ${err.message}`);
}
function patchRateLimitCapture() {
  const file = "src/agents/anthropic-vertex-stream.ts";
  let src = readFile(file);

  if (src.includes("createRateLimitCapturingFetch")) {
    console.log(`  ✅ ${file} — rate limit capture already present`);
    return;
  }

  // Add import
  src = src.replace(
    /import { AnthropicVertex } from "@anthropic-ai\/vertex-sdk";/,
    'import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";\nimport { updateRateLimitSnapshot } from "./anthropic-ratelimit-store.js";',
  );

  // Add fetch wrapper function before createAnthropicVertexStreamFn
  src = src.replace(
    /export function createAnthropicVertexStreamFn\(/,
    `function createRateLimitCapturingFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const h5Raw = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
    const d7Raw = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
    if (h5Raw != null || d7Raw != null) {
      const h5 = h5Raw != null ? parseFloat(h5Raw) : 0;
      const d7 = d7Raw != null ? parseFloat(d7Raw) : 0;
      const d7SonnetRaw = response.headers.get("anthropic-ratelimit-unified-7d-sonnet-utilization");
      const claim = response.headers.get("anthropic-ratelimit-unified-representative-claim") || "five_hour";
      updateRateLimitSnapshot({
        h5: Number.isFinite(h5) ? h5 : 0,
        d7: Number.isFinite(d7) ? d7 : 0,
        d7Sonnet: d7SonnetRaw != null ? parseFloat(d7SonnetRaw) || 0 : undefined,
        claim,
        ts: Date.now(),
      });
    }
    return response;
  };
}

export function createAnthropicVertexStreamFn(`,
  );

  // Add fetch option to AnthropicVertex constructor
  src = src.replace(
    /const client = new AnthropicVertex\(\{[\s\n]*region,/,
    "const client = new AnthropicVertex({\n    region,\n    fetch: createRateLimitCapturingFetch(),",
  );

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-03: lifecycle handlers — rate limit in end event
// ---------------------------------------------------------------------------
try {
  patchLifecycleRateLimit();
} catch (err) {
  console.warn(`  ⚠️  lifecycle handlers ratelimit: ${err.message}`);
}
function patchLifecycleRateLimit() {
  const file = "src/agents/embedded-agent-subscribe.handlers.lifecycle.ts";
  let src = readFile(file);

  const hasImport = src.includes("getRateLimitSnapshot");
  const hasDecl =
    /const rateLimit\s*=\s*\n?\s*ctx\.params\.modelProvider === "anthropic" \? getRateLimitSnapshot\(\)/.test(
      src,
    );
  const hasSpread = /\.\.\.\(rateLimit \? \{ rateLimit \} : \{\}\)/.test(src);

  if (hasImport && hasDecl && hasSpread) {
    console.log(`  ✅ ${file} — rate limit snapshot already present`);
    return;
  }

  // Add import
  if (!hasImport) {
    src = src.replace(
      /import { emitAgentEvent } from/,
      'import { getRateLimitSnapshot } from "./anthropic-ratelimit-store.js";\nimport { emitAgentEvent } from',
    );
  }

  // Upstream restructured handleAgentEnd to use an emitLifecycleTerminal closure.
  // Declare rateLimit just before the closure so both branches can reference it.
  if (!hasDecl) {
    src = src.replace(
      /(\n  )(const emitLifecycleTerminal = \(\) => \{)/,
      '$1const rateLimit =\n    ctx.params.modelProvider === "anthropic" ? getRateLimitSnapshot() : undefined;\n  $2',
    );
  }

  // Add rateLimit spread to the "end" data object (idempotent)
  if (!hasSpread) {
    src = src.replace(
      /(phase: "end",[\s\S]*?sessionKey: ctx\.params\.sessionKey,)/,
      "$1\n        ...(rateLimit ? { rateLimit } : {}),",
    );
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-15: tools handler — FORK emitToolExec for timeline round tracking
// ---------------------------------------------------------------------------
try {
  patchToolsHandlerEmitToolExec();
} catch (err) {
  console.warn(`  ⚠️  tools handler emitToolExec: ${err.message}`);
}
function patchToolsHandlerEmitToolExec() {
  const file = "src/agents/embedded-agent-subscribe.handlers.tools.ts";
  let src = readFile(file);

  const hasImport = /from "\.\.\/fork\/attempt-hooks\.js"/.test(src);
  const hasCall = /emitToolExec\(\{[\s\S]*?phase: "tool-exec-start"/.test(src);

  if (hasImport && hasCall) {
    console.log(`  ✅ ${file} — emitToolExec already wired`);
    return;
  }

  if (!hasImport) {
    src = src.replace(
      /import type \{ PluginHookAfterToolCallEvent \} from "\.\.\/plugins\/types\.js";/,
      'import { emitToolExec } from "../fork/attempt-hooks.js";\nimport type { PluginHookAfterToolCallEvent } from "../plugins/types.js";',
    );
  }

  // Insert emitToolExec call right after the tool-start itemData emission
  if (!hasCall) {
    src = src.replace(
      /(emitTrackedItemEvent\(ctx, itemData\);\n)(\s*\/\/ Best-effort typing signal)/,
      '$1    // FORK: emit tool-exec-start for timeline round-level tracking\n    emitToolExec({\n      runId: ctx.params.runId,\n      sessionKey: ctx.params.sessionKey,\n      roundNumber: 0, // round number not available in subscription context\n      phase: "tool-exec-start",\n      toolName,\n      toolCallId,\n      inputChars: typeof args === "object" ? JSON.stringify(args).length : 0,\n    });\n$2',
    );
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-03: failover-matches.ts — OAuth rejection auth pattern
// ---------------------------------------------------------------------------
try {
  patchOAuthRejectionPattern();
} catch (err) {
  console.warn(`  ⚠️  failover-matches.ts oauth pattern: ${err.message}`);
}
function patchOAuthRejectionPattern() {
  const file = "src/agents/embedded-agent-helpers/failover-matches.ts";
  let src = readFile(file);

  if (src.includes("not supported|disabled|rejected")) {
    console.log(`  ✅ ${file} — OAuth rejection pattern already present`);
    return;
  }

  src = src.replace(
    /"re-authenticate",/,
    '"re-authenticate",\n    /oauth.*(?:not supported|disabled|rejected)/i, // FORK: OAuth API rejection',
  );

  writeFile(file, src);
}

// ===========================================================================
// 2026-04-14: Nine merge-damage patches restored after the 2026-04-06 sync.
// Each function is idempotent and emits a ⚠️ warning on anchor mismatch
// (caught by cron-fork-sync-prompt.txt's FAILED_PATCHES gate).
// Source commits: 9223a3cb9e e06283b94e 62ae6c6ab3 fbd5b51e20 39d331ac8a 88d361e8fa
// ===========================================================================

// ---------------------------------------------------------------------------
// 15. types.auth.ts — AuthProfileConfig.displayName
// ---------------------------------------------------------------------------
function patchAuthProfileDisplayName() {
  const file = "src/config/types.auth.ts";
  let src = readFile(file);

  if (src.includes("displayName?: string")) {
    console.log(`  ✅ ${file} — displayName already present`);
    return;
  }

  // Anchor: the line `email?: string;` inside AuthProfileConfig
  const anchor = /(\n\s*email\?: string;)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find email?: string anchor for displayName patch`);
    return;
  }

  src = src.replace(anchor, "$1\n  displayName?: string; // FORK: 2026-04-14 restored after merge");
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 16. bash-tools.exec-host-shared.ts — obfuscationDetected param (2 functions)
// ---------------------------------------------------------------------------
function patchObfuscationDetected() {
  const file = "src/agents/bash-tools.exec-host-shared.ts";
  let src = readFile(file);
  let changed = false;

  // 16a. resolveBaseExecApprovalDecision param + denial branch
  if (!src.includes("obfuscationDetected")) {
    const fnAnchor =
      /export function resolveBaseExecApprovalDecision\(params: \{\s*\n\s*decision: string \| null;\s*\n\s*askFallback: ResolvedExecApprovals\["agent"\]\["askFallback"\];\s*\n(\s*)\}\):/;
    if (!fnAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find resolveBaseExecApprovalDecision params anchor`);
      return;
    }
    src = src.replace(fnAnchor, (m, indent) =>
      m.replace(
        `askFallback: ResolvedExecApprovals["agent"]["askFallback"];\n${indent}}`,
        `askFallback: ResolvedExecApprovals["agent"]["askFallback"];\n${indent}/** FORK: Obfuscation gating — fork restores host-level obfuscation denial. */\n${indent}obfuscationDetected?: boolean;\n${indent}}`,
      ),
    );

    // Inject denial branch before the askFallback === "full" check
    const denyAnchor =
      /  if \(!params\.decision\) \{\s*\n(\s*)if \(params\.askFallback === "full"\)/;
    if (!denyAnchor.test(src)) {
      console.warn(
        `  ⚠️  ${file} — could not find !params.decision branch anchor for obfuscation denial`,
      );
      return;
    }
    src = src.replace(
      denyAnchor,
      `  if (!params.decision) {\n$1if (params.obfuscationDetected) {\n$1  return {\n$1    approvedByAsk: false,\n$1    deniedReason: "approval-timeout (obfuscation-detected)",\n$1    timedOut: true,\n$1  };\n$1}\n$1if (params.askFallback === "full")`,
    );
    changed = true;
  }

  // 16b. createExecApprovalDecisionState — accept + forward obfuscationDetected
  if (!/createExecApprovalDecisionState\(params: \{[^}]*obfuscationDetected/.test(src)) {
    const stateAnchor =
      /(export function createExecApprovalDecisionState\(params: \{\s*\n\s*decision: string \| null \| undefined;\s*\n\s*askFallback: ResolvedExecApprovals\["agent"\]\["askFallback"\];\s*\n)(\s*)\}\)/;
    if (!stateAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find createExecApprovalDecisionState params anchor`);
      return;
    }
    src = src.replace(
      stateAnchor,
      `$1$2/** FORK: Obfuscation gating — fork restores host-level obfuscation denial. */\n$2obfuscationDetected?: boolean;\n$2})`,
    );
    // Forward into the resolveBase call
    src = src.replace(
      /(const baseDecision = resolveBaseExecApprovalDecision\(\{\s*\n\s*decision: params\.decision \?\? null,\s*\n\s*askFallback: params\.askFallback,)(\s*\n\s*)(\}\);)/,
      `$1$2obfuscationDetected: params.obfuscationDetected,$2$3`,
    );
    changed = true;
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — obfuscationDetected already wired`);
  }
}

// ---------------------------------------------------------------------------
// 17. heartbeat-runner.ts — hasFractalHook in HeartbeatPromptResolution +
//      return statement + runner destructure
// ---------------------------------------------------------------------------
function patchHeartbeatFractalHook() {
  const file = "src/infra/heartbeat-runner.ts";
  let src = readFile(file);

  if (
    /HeartbeatPromptResolution = \{[^}]*hasFractalHook/s.test(src) &&
    /return \{ prompt, hasExecCompletion, hasCronEvents, hasFractalHook \}/.test(src) &&
    /const \{ prompt, hasExecCompletion, hasCronEvents, hasFractalHook \} = resolveHeartbeatRunPrompt/.test(
      src,
    )
  ) {
    console.log(`  ✅ ${file} — hasFractalHook already wired`);
    return;
  }

  // Type field
  if (!/HeartbeatPromptResolution = \{[^}]*hasFractalHook/s.test(src)) {
    const typeAnchor =
      /(type HeartbeatPromptResolution = \{\s*\n\s*prompt: string;\s*\n\s*hasExecCompletion: boolean;\s*\n\s*hasCronEvents: boolean;)(\s*\n\})/;
    if (!typeAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find HeartbeatPromptResolution anchor`);
      return;
    }
    src = src.replace(
      typeAnchor,
      `$1\n  /** FORK: Fractal reflection hook — true when pending events include FRACTAL REFLECTION. */\n  hasFractalHook: boolean;$2`,
    );
  }

  // Return statement
  if (!/return \{ prompt, hasExecCompletion, hasCronEvents, hasFractalHook \}/.test(src)) {
    const retAnchor = /return \{ prompt, hasExecCompletion, hasCronEvents \};/;
    if (!retAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find resolver return anchor`);
      return;
    }
    src = src.replace(
      retAnchor,
      "return { prompt, hasExecCompletion, hasCronEvents, hasFractalHook };",
    );
  }

  // Destructure in runner
  if (
    !/const \{ prompt, hasExecCompletion, hasCronEvents, hasFractalHook \} = resolveHeartbeatRunPrompt/.test(
      src,
    )
  ) {
    const destAnchor =
      /const \{ prompt, hasExecCompletion, hasCronEvents \} = resolveHeartbeatRunPrompt/;
    if (!destAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find runner destructure anchor`);
      return;
    }
    src = src.replace(
      destAnchor,
      "const { prompt, hasExecCompletion, hasCronEvents, hasFractalHook } = resolveHeartbeatRunPrompt",
    );
  }

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 18. system-prompt.ts — amygdalaNudge param + assembly block
// ---------------------------------------------------------------------------
function patchAmygdalaNudge() {
  const file = "src/agents/system-prompt.ts";
  let src = readFile(file);
  let changed = false;

  // 18a. param on buildAgentSystemPrompt
  if (!src.includes("amygdalaNudge?: string[]")) {
    const personaAnchor = /(personaBlock\?: string;)/;
    if (!personaAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find personaBlock anchor for amygdalaNudge param`);
      return;
    }
    src = src.replace(
      personaAnchor,
      `$1\n  /** FORK: AMYGDALA personality nudge — behavioural adjustments from the thermostat. */\n  amygdalaNudge?: string[];`,
    );
    changed = true;
  }

  // 18b. assembly block — inject personaBlock + amygdalaNudge at the top of the
  // `lines` array. Upstream removed the personaBlock spread during a 2026-04-15
  // refactor, so the anchor now targets the opening line of the `lines` array
  // and re-adds BOTH the personaBlock and amygdalaNudge spreads.
  if (!src.includes("AMYGDALA Personality Nudge")) {
    const linesAnchor =
      /(const lines = \[\n\s*"You are a personal assistant (?:operating|running) inside OpenClaw\.",\n\s*"",\n)/;
    if (!linesAnchor.test(src)) {
      console.warn(`  ⚠️  ${file} — could not find lines-array anchor for amygdalaNudge`);
      return;
    }
    src = src.replace(
      linesAnchor,
      `$1    // FORK: Tier 1 persona block from CORTEX runtime — injected near the top, always cached.\n    ...(params.personaBlock ? [params.personaBlock, ""] : []),\n    // FORK: AMYGDALA personality thermostat — behavioural nudges from the Personality networks.\n    ...(params.amygdalaNudge?.length\n      ? [\n          "## AMYGDALA Personality Nudge (active)",\n          "The Personality networks detected drift from your target personality. Adjustments:",\n          ...params.amygdalaNudge.map((a) => \`- \${a}\`),\n          "",\n        ]\n      : []),\n`,
    );
    changed = true;
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — amygdalaNudge already wired`);
  }
}

// ---------------------------------------------------------------------------
// 19. embedded-agent-subscribe.types.ts — modelId + modelProvider
// ---------------------------------------------------------------------------
function patchSubscribeModelFields() {
  const file = "src/agents/embedded-agent-subscribe.types.ts";
  let src = readFile(file);

  if (src.includes("modelId?: string") && src.includes("modelProvider?: string")) {
    console.log(`  ✅ ${file} — modelId/modelProvider already present`);
    return;
  }

  const anchor = /(authProfileId\?: string;)/;
  if (!anchor.test(src)) {
    console.warn(
      `  ⚠️  ${file} — could not find authProfileId anchor for modelId/modelProvider patch`,
    );
    return;
  }
  src = src.replace(
    anchor,
    `$1\n  /** FORK: Model ID for lifecycle event tracking (e.g. "claude-sonnet-4-6"). */\n  modelId?: string;\n  /** FORK: Provider name for lifecycle event tracking (e.g. "anthropic"). */\n  modelProvider?: string;`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 20. embedded-agent-subscribe.handlers.types.ts — emitBlockReply on context
// ---------------------------------------------------------------------------
function patchEmitBlockReply() {
  const file = "src/agents/embedded-agent-subscribe.handlers.types.ts";
  let src = readFile(file);

  if (src.includes("emitBlockReply:")) {
    console.log(`  ✅ ${file} — emitBlockReply already present`);
    return;
  }

  const anchor = /(resetResponseBreakdown: \(\) => void;)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find resetResponseBreakdown anchor for emitBlockReply`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n  /** FORK: Direct emit a block reply (consumes pending tool media into the payload). */\n  emitBlockReply: (\n    payload: BlockReplyPayload,\n    options?: { assistantMessageIndex?: number },\n  ) => void;`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 21. agent-runner.ts — resetTriggered param
// ---------------------------------------------------------------------------
function patchResetTriggered() {
  const file = "src/auto-reply/reply/agent-runner.ts";
  let src = readFile(file);

  if (src.includes("resetTriggered?: boolean")) {
    console.log(`  ✅ ${file} — resetTriggered already present`);
    return;
  }

  const anchor = /(typingMode: TypingMode;)\s*\n(\}\): Promise<ReplyPayload)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find typingMode anchor for resetTriggered patch`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n  // FORK: resetTriggered flows through from session-reset detection in\n  // get-reply-run.ts so downstream reply-operation/reset hooks can react.\n  resetTriggered?: boolean;\n$2`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 22. get-reply.ts — applyMergePatch import
// (logIngressStage was deleted 2026-04-14: upstream removed the full ingress-
//  timing system and only one vestigial call site remained in the fork. We
//  accept upstream's removal rather than restoring a stub helper.)
// ---------------------------------------------------------------------------
function patchGetReplyHelpers() {
  const file = "src/auto-reply/reply/get-reply.ts";
  let src = readFile(file);

  if (/from "\.\.\/\.\.\/config\/merge-patch\.js"/.test(src)) {
    console.log(`  ✅ ${file} — applyMergePatch already wired`);
    return;
  }

  const anchor =
    /(import \{ type OpenClawConfig, loadConfig \} from "\.\.\/\.\.\/config\/config\.js";)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find config.js import anchor for applyMergePatch`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n// FORK: applyMergePatch supports the \`configOverride\` parameter on\n// getReplyFromConfig, allowing callers (tests, harness) to deep-merge over\n// the on-disk config without mutating it.\nimport { applyMergePatch } from "../../config/merge-patch.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 23. read-response-with-limit.ts — onIdleTimeout optional param
// ---------------------------------------------------------------------------
function patchOnIdleTimeout() {
  const file = "src/media/read-response-with-limit.ts";
  let src = readFile(file);

  if (src.includes("onIdleTimeout")) {
    console.log(`  ✅ ${file} — onIdleTimeout already present`);
    return;
  }

  const anchor =
    /(async function readChunkWithIdleTimeout\(\s*\n\s*reader: ReadableStreamDefaultReader<Uint8Array>,\s*\n\s*chunkTimeoutMs: number,)\s*\n(\): Promise<ReadableStreamReadResult<Uint8Array>>)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find readChunkWithIdleTimeout signature anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n  // FORK: optional caller-supplied error factory so download stalls produce\n  // a domain-specific error (e.g. media-fetch retry classification) instead\n  // of the generic "Media download stalled" string.\n  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,\n$2`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// PRESERVE GUARD — verify fork-only paths survived the merge
// ---------------------------------------------------------------------------
function checkPreservePaths() {
  const required = [
    "extensions/tinkerclaw-whatsapp/src/backfill/index.ts",
    "extensions/tinkerclaw-whatsapp/src/history",
  ];
  let ok = true;
  for (const rel of required) {
    const abs = resolve(ROOT, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      console.warn(
        `  ⚠️  PRESERVE missing: ${rel} — restore from preserve/tinkerclaw-whatsapp-* tag, do not stub`,
      );
      ok = false;
      continue;
    }
    if (stat.isFile() && stat.size === 0) {
      console.warn(`  ⚠️  PRESERVE empty file: ${rel} — restore from preserve tag`);
      ok = false;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(abs);
      } catch {
        /* ignore */
      }
      if (entries.length === 0) {
        console.warn(`  ⚠️  PRESERVE empty dir: ${rel} — restore from preserve tag`);
        ok = false;
      }
    }
  }
  if (ok) {
    console.log("  ✅ PRESERVE paths all present");
  }
  return ok;
}

// ---------------------------------------------------------------------------
// CROSS-PACKAGE PATH GUARD — memory-host-sdk imports into src/
// Climb depth from packages/memory-host-sdk/src/host/<sub>/ is 5 levels.
// Verify any `../..`-style import resolving into src/agents/ or src/infra/
// actually points at an existing file.
// ---------------------------------------------------------------------------
function checkCrossPackageImports() {
  // Walk every workspace package under packages/ that contains a src/
  // directory and verify every relative `../..` climb resolves to a real
  // file. As of 2026-04-15 the active set is memory-host-sdk and
  // plugin-sdk; the others (clawdbot, localclaw, moltbot,
  // plugin-package-contract) currently have zero cross-package imports
  // but are auto-included if they grow any.
  const packagesRoot = resolve(ROOT, "packages");
  let pkgEntries = [];
  try {
    pkgEntries = readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    console.log("  ✅ packages/ not present — skipping cross-package guard");
    return true;
  }

  const packageRoots = [];
  for (const e of pkgEntries) {
    if (!e.isDirectory()) continue;
    const srcDir = resolve(packagesRoot, e.name, "src");
    try {
      if (statSync(srcDir).isDirectory()) {
        packageRoots.push({ name: e.name, srcDir });
      }
    } catch {
      /* ignore packages without src/ */
    }
  }

  if (packageRoots.length === 0) {
    console.log("  ✅ no workspace packages with src/ — skipping cross-package guard");
    return true;
  }

  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
        files.push(full);
      }
    }
  };
  for (const { srcDir } of packageRoots) {
    walk(srcDir);
  }

  // Match any `../..` (or deeper) climb into src/{agents,infra,memory,...}
  // — the "src/" segment is optional because some climbs land directly in
  // a top-level src subdir without the literal "src" in the path.
  const importRe =
    /from\s+["'](\.\.(?:\/\.\.)+\/(?:src\/)?(?:agents|infra|memory|config|web|gateway|fork|auto-reply|media)\/[^"']+?)\.js["']/g;
  let ok = true;
  for (const f of files) {
    const text = readFileSync(f, "utf-8");
    let m;
    while ((m = importRe.exec(text)) !== null) {
      const spec = m[1];
      const fileDir = dirname(f);
      const tsCandidate = resolve(fileDir, spec + ".ts");
      const tsxCandidate = resolve(fileDir, spec + ".tsx");
      let exists = false;
      try {
        statSync(tsCandidate);
        exists = true;
      } catch {
        /* ignore */
      }
      if (!exists) {
        try {
          statSync(tsxCandidate);
          exists = true;
        } catch {
          /* ignore */
        }
      }
      if (!exists) {
        console.warn(`  ⚠️  cross-package broken: ${f.replace(ROOT + "/", "")} → ${spec}.js`);
        ok = false;
      }
    }
  }
  if (ok) {
    const names = packageRoots.map((p) => p.name).join(", ");
    console.log(`  ✅ cross-package imports resolve in: ${names}`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 24. system-prompt.ts — scope HEARTBEAT_OK strictly to heartbeat polls
// Prevents the 2026-04-14 bug where the model replied HEARTBEAT_OK to
// fractal reflection prompts because the generic wording let the sentinel
// leak to non-heartbeat messages. This patch rewrites the Heartbeats
// section to say AND ONLY IF. Fractal prompt side of the fix lives at
// extensions/tinkerclaw-fractal-reflection/fractal-prompt.md — no wiring
// needed there because it is a fork-only file.
// ---------------------------------------------------------------------------
function patchHeartbeatScope() {
  const file = "src/agents/system-prompt.ts";
  let src = readFile(file);

  if (src.includes("AND ONLY IF")) {
    console.log(`  ✅ ${file} — heartbeat scope tightened already`);
    return;
  }

  // Upstream 2026-04-18 refactor: Heartbeats section moved to buildHeartbeatSection helper
  // with a terser single-sentence form. We re-introduce the strict scope wording below.
  const oldBlock =
    /"If the current user message is a heartbeat poll and nothing needs attention, reply exactly:",\s*\n\s*"HEARTBEAT_OK",\s*\n\s*'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead\.',/;

  if (!oldBlock.test(src)) {
    console.warn(
      `  ⚠️  ${file} — could not find Heartbeats section anchor for HEARTBEAT_OK scope tightening`,
    );
    return;
  }

  src = src.replace(
    oldBlock,
    `// FORK: HEARTBEAT_OK must be scoped STRICTLY to heartbeat polls — the model\n    // otherwise generalizes it to fractal reflection prompts and system injections.\n    'If AND ONLY IF the current user message is a heartbeat poll (matches the heartbeat prompt text above) and nothing needs attention, reply exactly "HEARTBEAT_OK".',\n    'Do NOT emit "HEARTBEAT_OK" in response to any other kind of message — in particular NOT to fractal reflection prompts, system injections, skill invocations, or ordinary user turns. The sentinel is scoped exclusively to heartbeat polls that match the heartbeat prompt text above.',\n    'OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',\n    'If a heartbeat poll arrives and something actually needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// assistant-failover.ts — surface_error must throw, not silently continue.
//
// When the assistant loop decides to "surface_error" (no more profiles, no
// fallback model, timeout/auth/rate_limit), the original upstream code logs
// the decision and returns `continue_normal`, which causes the runner to fall
// through without emitting a user-visible error. This patch replaces the
// no-op branch with the same FailoverError construction used by the
// `fallback_model` branch, so the UI always sees an error bubble instead of
// silent failure.
// ---------------------------------------------------------------------------
function patchSurfaceErrorThrow() {
  const file = "src/agents/embedded-agent-runner/run/assistant-failover.ts";
  let src = readFile(file);

  if (src.includes("FORK: surface_error used to fall through to continue_normal")) {
    console.log(`  ✅ ${file} — surface_error already throws`);
    return;
  }

  // Upstream 2026-04-18 added an idle-timeout retry branch inside surface_error.
  // We preserve that retry branch by anchoring to its tail.
  const oldBlock =
    /\s*if \(decision\.action === "surface_error"\) \{\s*\n\s*if \(!params\.externalAbort && params\.idleTimedOut && params\.allowSameModelIdleTimeoutRetry\) \{\s*\n\s*return sameModelIdleTimeoutRetry\(\);\s*\n\s*\}\s*\n\s*params\.logAssistantFailoverDecision\("surface_error"\);\s*\n\s*\}\s*\n/;

  if (!oldBlock.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find surface_error no-op block anchor`);
    return;
  }

  const replacement = `
  if (decision.action === "surface_error") {
    if (!params.externalAbort && params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }
    // FORK: surface_error used to fall through to continue_normal, which swallowed
    // timeouts silently — the UI saw nothing when no profile rotation and no
    // fallback model were available. Now it throws a FailoverError mirroring the
    // fallback_model branch so the error reaches the user-facing emission path.
    const message =
      (params.lastAssistant
        ? formatAssistantErrorText(params.lastAssistant, {
            cfg: params.config,
            sessionKey: params.sessionKey,
            provider: params.activeErrorContext.provider,
            model: params.activeErrorContext.model,
          })
        : undefined) ||
      params.lastAssistant?.errorMessage?.trim() ||
      (params.timedOut
        ? "LLM request timed out."
        : params.rateLimitFailure
          ? "LLM request rate limited."
          : params.billingFailure
            ? formatBillingErrorMessage(
                params.activeErrorContext.provider,
                params.activeErrorContext.model,
              )
            : params.authFailure
              ? "LLM request unauthorized."
              : "LLM request failed.");
    const surfaceErrorReason: FailoverReason =
      decision.reason ?? (params.timedOut ? "timeout" : "unknown");
    const status =
      resolveFailoverStatus(surfaceErrorReason) ??
      (isTimeoutErrorMessage(message) ? 408 : undefined);
    params.logAssistantFailoverDecision("surface_error", { status });
    return {
      action: "throw",
      overloadProfileRotations,
      error: new FailoverError(message, {
        reason: surfaceErrorReason,
        provider: params.activeErrorContext.provider,
        model: params.activeErrorContext.model,
        profileId: params.lastProfileId,
        status,
      }),
    };
  }
`;

  src = src.replace(oldBlock, replacement);
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// proactive-refresh.ts — always prefer credential file when present.
//
// Original upstream flow: if the store's own `expires` timestamp is still in
// the future, the tick returns early without ever checking the credential
// file. This means when Claude Code (Zen) rotates its tokens, the gateway
// holds a locally-valid-looking-but-server-revoked access token for up to
// 15 minutes. Anthropic then stalls API calls made with that token (hang,
// not 401), producing silent 60s timeouts. This patch inserts a drift-sync
// block at the top of refreshProfileProactively so the credential file wins
// whenever it differs from the store, regardless of store expiry.
// ---------------------------------------------------------------------------
function patchProactiveRefreshDriftSync() {
  const file = "src/agents/auth-profiles/proactive-refresh.ts";
  let src = readFile(file);

  if (src.includes("FORK: Always consult the credential file first when it exists")) {
    console.log(`  ✅ ${file} — drift sync already present`);
    return;
  }

  const oldBlock =
    /    const now = Date\.now\(\);\s*\n    const timeUntilExpiry = cred\.expires - now;\s*\n\s*\n    \/\/ Still valid and not near expiry — nothing to do\.\s*\n    if \(timeUntilExpiry > EXTERNAL_CLI_NEAR_EXPIRY_MS\) \{\s*\n      return true;\s*\n    \}\s*\n\s*\n    const isExpired = timeUntilExpiry <= 0;\s*\n    log\.info\(`proactive refresh: \$\{profileId\} token \$\{isExpired \? "expired" : "near expiry"\}`, \{\s*\n      profileId,\s*\n      expiresInMin: Math\.round\(timeUntilExpiry \/ 60_000\),\s*\n    \}\);\s*\n\s*\n    const cfg = loadConfig\(\);\s*\n    const credFilePath = resolveCredentialFilePath\(profileId, cfg\);/;

  if (!oldBlock.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find proactive-refresh expiry anchor for drift sync`);
    return;
  }

  const replacement = `    const now = Date.now();
    const cfg = loadConfig();
    const credFilePath = resolveCredentialFilePath(profileId, cfg);

    // FORK: Always consult the credential file first when it exists, BEFORE
    // checking the store's own expiry. Claude Code (Zen) is the single-writer
    // for credential files and rotates tokens independently of the gateway's
    // 15-minute tick. If we trust only the store's \`expires\` field, we can
    // keep a locally-valid-looking-but-server-revoked access token for up to
    // 15 minutes — which manifests as hanging API calls (Anthropic stalls on
    // the stale token instead of 401'ing) until the next proactive tick.
    // Syncing from the credential file whenever it has a *different* token
    // or a *fresher* expiry keeps the store in lock-step with Claude Code.
    if (credFilePath) {
      const fresh = readCredentialFile(credFilePath, cred.provider);
      if (
        fresh &&
        now < fresh.expires &&
        fresh.expires - now > EXTERNAL_CLI_NEAR_EXPIRY_MS &&
        (fresh.access !== cred.access || fresh.expires > cred.expires)
      ) {
        store.profiles[profileId] = {
          ...cred,
          access: fresh.access,
          refresh: fresh.refresh,
          expires: fresh.expires,
          type: "oauth",
        };
        saveAuthProfileStore(store, undefined);
        log.info("proactive refresh: synced from credential file (drift sync)", {
          profileId,
          expiresInMin: Math.round((fresh.expires - now) / 60_000),
          reason: fresh.access !== cred.access ? "access_token_rotated" : "expires_bumped",
        });
        return true;
      }
    }

    const timeUntilExpiry = cred.expires - now;

    // Still valid and not near expiry — nothing to do.
    if (timeUntilExpiry > EXTERNAL_CLI_NEAR_EXPIRY_MS) {
      return true;
    }

    const isExpired = timeUntilExpiry <= 0;
    log.info(\`proactive refresh: \${profileId} token \${isExpired ? "expired" : "near expiry"}\`, {
      profileId,
      expiresInMin: Math.round(timeUntilExpiry / 60_000),
    });`;

  src = src.replace(oldBlock, replacement);
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// stage-bundled-plugin-runtime.mjs — copy .md/.txt/.yaml runtime assets.
//
// The upstream staging script's shouldCopyRuntimeFile only copies manifest
// files (package.json, openclaw.plugin.json, etc.). Any extension that ships
// a runtime asset (e.g. tinkerclaw-fractal-reflection reads fractal-prompt.md
// from extensionDir at load time) has its asset silently dropped, and the
// extension falls back to a hard-coded stub. This patch extends the allowlist
// to cover text-based runtime assets.
// ---------------------------------------------------------------------------
function patchStagingRuntimeAssets() {
  const file = "scripts/stage-bundled-plugin-runtime.mjs";
  let src = readFile(file);

  if (src.includes("FORK: Extensions may ship runtime assets next to their entrypoint")) {
    console.log(`  ✅ ${file} — runtime asset allowlist already extended`);
    return;
  }

  const oldBlock =
    /function shouldCopyRuntimeFile\(sourcePath\) \{\s*\n\s*const relativePath = sourcePath\.replace\(\/\\\\\/g, "\/"\);\s*\n\s*return \(\s*\n\s*relativePath\.endsWith\("\/package\.json"\) \|\|\s*\n\s*relativePath\.endsWith\("\/openclaw\.plugin\.json"\) \|\|\s*\n\s*relativePath\.endsWith\("\/\.codex-plugin\/plugin\.json"\) \|\|\s*\n\s*relativePath\.endsWith\("\/\.claude-plugin\/plugin\.json"\) \|\|\s*\n\s*relativePath\.endsWith\("\/\.cursor-plugin\/plugin\.json"\)\s*\n\s*\);\s*\n\}/;

  if (!oldBlock.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find shouldCopyRuntimeFile anchor for asset allowlist`);
    return;
  }

  const replacement = `function shouldCopyRuntimeFile(sourcePath) {
  const relativePath = sourcePath.replace(/\\\\/g, "/");
  if (
    relativePath.endsWith("/package.json") ||
    relativePath.endsWith("/openclaw.plugin.json") ||
    relativePath.endsWith("/.codex-plugin/plugin.json") ||
    relativePath.endsWith("/.claude-plugin/plugin.json") ||
    relativePath.endsWith("/.cursor-plugin/plugin.json")
  ) {
    return true;
  }
  // FORK: Extensions may ship runtime assets next to their entrypoint that the
  // compiled JS reads at load time (e.g. tinkerclaw-fractal-reflection reads
  // \`fractal-prompt.md\` via readFileSync from extensionDir). Without this, the
  // staging step silently drops those files and the extension falls back to a
  // hard-coded stub — which is how the fractal reflection regressed to a
  // one-line fallback and broke UI formatting + HEARTBEAT_OK ban.
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".yaml" || ext === ".yml") {
    return true;
  }
  return false;
}`;

  src = src.replace(oldBlock, replacement);
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// runtime-postbuild.mjs — fix static-asset staging order + register fractal.
//
// Upstream's runRuntimePostBuild calls copyStaticExtensionAssets AFTER
// stageBundledPluginRuntime. That means any asset declared in
// STATIC_EXTENSION_ASSETS lands in dist/extensions/ only — never mirrored
// into dist-runtime/extensions/, which is what the gateway actually loads.
// This silently breaks acpx's mcp-proxy.mjs, diffs's viewer-runtime.js, and
// the fractal reflection prompt. This patch reorders the calls and adds the
// fractal-prompt.md entry to STATIC_EXTENSION_ASSETS.
// ---------------------------------------------------------------------------
function patchRuntimePostbuildStaticAssets() {
  const file = "scripts/runtime-postbuild.mjs";
  let src = readFile(file);

  const reorderMarker = "FORK: copyStaticExtensionAssets must run BEFORE stageBundledPluginRuntime";
  const fractalMarker = "FORK: tinkerclaw-fractal-reflection reads fractal-prompt.md";

  let changed = false;

  if (!src.includes(fractalMarker)) {
    const fractalAnchor =
      /  \{\s*\n\s*src: "extensions\/diffs\/assets\/viewer-runtime\.js",\s*\n\s*dest: "dist\/extensions\/diffs\/assets\/viewer-runtime\.js",\s*\n\s*\},\s*\n\];/;
    if (!fractalAnchor.test(src)) {
      console.warn(
        `  ⚠️  ${file} — could not find STATIC_EXTENSION_ASSETS diffs entry to append fractal`,
      );
      return;
    }
    src = src.replace(
      fractalAnchor,
      `  {
    src: "extensions/diffs/assets/viewer-runtime.js",
    dest: "dist/extensions/diffs/assets/viewer-runtime.js",
  },
  // FORK: tinkerclaw-fractal-reflection reads fractal-prompt.md via
  // readFileSync(join(extensionDir, "fractal-prompt.md")) at load time. Without
  // this entry the staging pipeline silently drops the prompt and the plugin
  // falls back to a one-line hard-coded stub that breaks the UI formatting and
  // lets HEARTBEAT_OK leak into fractal responses.
  {
    src: "extensions/tinkerclaw-fractal-reflection/fractal-prompt.md",
    dest: "dist/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md",
  },
];`,
    );
    changed = true;
  }

  if (!src.includes(reorderMarker)) {
    const orderAnchor =
      /export function runRuntimePostBuild\(params = \{\}\) \{\s*\n\s*copyPluginSdkRootAlias\(params\);\s*\n\s*copyBundledPluginMetadata\(params\);\s*\n\s*writeOfficialChannelCatalog\(params\);\s*\n\s*stageBundledPluginRuntimeDeps\(params\);\s*\n\s*stageBundledPluginRuntime\(params\);\s*\n\s*writeStableRootRuntimeAliases\(params\);\s*\n\s*copyStaticExtensionAssets\(params\);\s*\n\}/;
    if (!orderAnchor.test(src)) {
      // The reordered form may already be in place but missing the marker;
      // bail out loudly rather than corrupt.
      console.warn(`  ⚠️  ${file} — could not find runRuntimePostBuild anchor to reorder`);
      if (changed) writeFile(file, src);
      return;
    }
    src = src.replace(
      orderAnchor,
      `export function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  writeOfficialChannelCatalog(params);
  stageBundledPluginRuntimeDeps(params);
  // FORK: copyStaticExtensionAssets must run BEFORE stageBundledPluginRuntime,
  // not after. Upstream ordering placed it at the end, which meant assets in
  // STATIC_EXTENSION_ASSETS landed in dist/extensions/ but were never mirrored
  // into dist-runtime/extensions/ — silently breaking every extension that
  // relies on a runtime asset (acpx/mcp-proxy.mjs, diffs/viewer-runtime.js,
  // tinkerclaw-fractal-reflection/fractal-prompt.md). Moving it up fixes all
  // three through a single code path.
  copyStaticExtensionAssets(params);
  stageBundledPluginRuntime(params);
  writeStableRootRuntimeAliases(params);
}`,
    );
    changed = true;
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — static-asset ordering + fractal entry already present`);
  }
}

// ---------------------------------------------------------------------------
// get-reply.ts — restore session-resume helpers import.
//
// The fork's get-reply.ts has three call sites to clearSessionResume and
// writeSessionResume (session persistence across gateway restarts). Upstream
// doesn't use these helpers, so when upstream touches get-reply.ts imports,
// the auto-merge may drop the fork's import line, leaving the call sites
// referencing undeclared names. The helpers themselves still live at
// src/infra/session-resume.ts — only the import disappears.
// ---------------------------------------------------------------------------
function patchGetReplySessionResumeImport() {
  const file = "src/auto-reply/reply/get-reply.ts";
  let src = readFile(file);

  if (/from "\.\.\/\.\.\/infra\/session-resume\.js"/.test(src)) {
    console.log(`  ✅ ${file} — session-resume import already wired`);
    return;
  }

  const anchor = /(import \{ defaultRuntime \} from "\.\.\/\.\.\/runtime\.js";)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find runtime.js import anchor for session-resume`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n// FORK: session resume helpers persist gateway state across restarts.\nimport { clearSessionResume, writeSessionResume } from "../../infra/session-resume.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// memory-core manager.ts — restore DatabaseSync + createSubsystemLogger
// imports and `const log` binding (upstream merges strip these)
// ---------------------------------------------------------------------------
function patchMemoryCoreManagerImports() {
  const file = "extensions/memory-core/src/memory/manager.ts";
  let src = readFile(file);
  let changed = false;

  if (!src.includes(`import type { DatabaseSync } from "node:sqlite"`)) {
    src = src.replace(
      /^(import \{ type FSWatcher \} from "chokidar";)/m,
      `import type { DatabaseSync } from "node:sqlite";\n$1`,
    );
    changed = true;
  }

  if (!/createSubsystemLogger,/.test(src)) {
    src = src.replace(
      /(import \{\s*\n)(\s*)(resolveAgentDir,)/,
      `$1$2createSubsystemLogger,\n$2$3`,
    );
    changed = true;
  }

  if (!/const log = createSubsystemLogger\("memory"\);/.test(src)) {
    src = src.replace(
      /(const BATCH_FAILURE_LIMIT = 2;\n)/,
      `$1\nconst log = createSubsystemLogger("memory");\n`,
    );
    changed = true;
  }

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — memory-core manager imports already wired`);
  }
}

// ---------------------------------------------------------------------------
// Run new patches + structural guards
// ---------------------------------------------------------------------------
const NEW_PATCHES = [
  ["types.auth displayName", patchAuthProfileDisplayName],
  ["bash-tools obfuscationDetected", patchObfuscationDetected],
  ["heartbeat hasFractalHook", patchHeartbeatFractalHook],
  ["system-prompt amygdalaNudge", patchAmygdalaNudge],
  ["system-prompt HEARTBEAT_OK scope", patchHeartbeatScope],
  ["subscribe.types modelId/modelProvider", patchSubscribeModelFields],
  ["subscribe.handlers.types emitBlockReply", patchEmitBlockReply],
  ["agent-runner resetTriggered", patchResetTriggered],
  ["get-reply applyMergePatch", patchGetReplyHelpers],
  ["get-reply session-resume import", patchGetReplySessionResumeImport],
  ["read-response onIdleTimeout", patchOnIdleTimeout],
  ["assistant-failover surface_error throws", patchSurfaceErrorThrow],
  ["proactive-refresh drift sync", patchProactiveRefreshDriftSync],
  ["staging runtime asset allowlist", patchStagingRuntimeAssets],
  ["runtime-postbuild static asset ordering", patchRuntimePostbuildStaticAssets],
  ["memory-core manager imports", patchMemoryCoreManagerImports],
  ["runs sessionIdsByKey singleton field", patchRunsSessionIdsByKey],
  ["followup-runner emitAgentEvent import", patchFollowupRunnerEmitAgentEvent],
  ["heartbeat-runner resolveEmbeddedSessionLane import", patchHeartbeatResolveLane],
  ["auth-controller emitAgentEvent import", patchAuthControllerEmitAgentEvent],
  ["agent-runner replyOperation destructure", patchAgentRunnerReplyOperation],
  ["commands-core fork imports", patchCommandsCoreImports],
  ["model-catalog rank field", patchModelCatalogRank],
  ["model-fallback billing-gate import", patchModelFallbackBillingGateImport],
  ["run/types ContextAnatomyEvent import", patchRunTypesContextAnatomyImport],
  ["bundled provider plugin id aliases", patchBundledProviderPluginIdAliases],
  ["errors regain-access billing wrap", patchRegainAccessBillingWrap],
  ["heartbeat-runner tasks/isTaskDue/transcriptState", patchHeartbeatRunnerTasksAndTranscript],
  ["embedded-agent extensions engram imports", patchExtensionsEngramImports],
  ["tool-policy dedupe local declarations", patchToolPolicyDedupeLocals],
  ["attempt.ts getLastCompactionTokensAfter stub", patchAttemptCompactionTokensStub],
  ["agent-command.ts drop onFallbackStep arg", patchAgentCommandDropOnFallbackStep],
  ["anthropic-vertex-stream updateRateLimitSnapshot import", patchAnthropicVertexRateLimitImport],
  ["isLoopbackAddress re-exports (3 sites)", patchIsLoopbackAddressReExports],
  [
    "engine-storage detectGranularity/detectTopicCluster re-export",
    patchEngineStorageDetectExports,
  ],
  [
    "embedded-agent extensions listEmbeddedExtensionFactories stub",
    patchExtensionsListFactoriesStub,
  ],
  ["hippocampus emptyPluginConfigSchema import path", patchHippocampusEmptyPluginConfigSchema],
  ["tsdown.config.ts native addons in neverBundle list", patchTsdownNativeAddons],
];

// ---------------------------------------------------------------------------
// heartbeat-runner.ts — post-merge guards for fork additions that erode
// during stratified upstream merges (2026-04-15):
//   1. HeartbeatPreflight.tasks field + parseHeartbeatTasks import + isTaskDue
//   2. drainSystemEventEntries/enqueueSystemEvent imports from ./system-events
//   3. transcriptState capture before replyFn (drives pruneHeartbeatTranscript)
//   4. Removal of stale early `runSessionKey/runStorePath` duplicate block
// These are structural presence checks only — they warn (don't rewrite) if the
// erosion pattern matches, so human review restores the fork code.
// ---------------------------------------------------------------------------
function patchHeartbeatRunnerTasksAndTranscript() {
  const file = "src/infra/heartbeat-runner.ts";
  const src = readFile(file);
  const checks = [
    ["parseHeartbeatTasks import", /parseHeartbeatTasks/],
    ["isTaskDue import", /\bisTaskDue\b/],
    ["HeartbeatPreflight.tasks field", /tasks:\s*HeartbeatTask\[\]/],
    ["drainSystemEventEntries import", /drainSystemEventEntries,/],
    ["enqueueSystemEvent import", /enqueueSystemEvent,/],
    ["transcriptState capture", /const transcriptState = await captureTranscriptState/],
    [
      "resolveSessionFilePath import",
      /resolveSessionFilePath.*from "\.\.\/config\/sessions\/paths\.js"/,
    ],
  ];
  for (const [label, re] of checks) {
    if (!re.test(src)) {
      console.warn(`  ⚠️  ${file} — heartbeat fork erosion: ${label} missing`);
    }
  }
  console.log(`  ✅ ${file} — heartbeat-runner tasks/transcript guards checked`);
}

// ---------------------------------------------------------------------------
// embedded-agent-runner/extensions.ts — engram/hybrid-retrieval runtime imports
// (createEventStore, createIngestionPipeline, globalFtsSearch,
// createOllamaEmbeddingProvider, createEmbeddingCache, createEmbeddingWorker)
// + resolveCompactionMode must return `"engram"` for the fork cognitive path.
// ---------------------------------------------------------------------------
function patchExtensionsEngramImports() {
  const file = "src/agents/embedded-agent-runner/extensions.ts";
  const src = readFile(file);
  const required = [
    "createEventStore",
    "createIngestionPipeline",
    "globalFtsSearch",
    "createOllamaEmbeddingProvider",
    "createEmbeddingCache",
    "createEmbeddingWorker",
  ];
  for (const name of required) {
    if (!new RegExp(`import.*\\b${name}\\b.*from`).test(src)) {
      console.warn(`  ⚠️  ${file} — missing import: ${name}`);
    }
  }
  if (!/"default" \| "safeguard" \| "engram"/.test(src)) {
    console.warn(`  ⚠️  ${file} — resolveCompactionMode missing "engram" branch`);
  }
  console.log(`  ✅ ${file} — extensions engram imports checked`);
}

// ---------------------------------------------------------------------------
// tool-policy.ts — upstream extracted TOOL_GROUPS/normalizeToolName/etc into
// tool-policy-shared.ts. Fork must re-export these and NOT keep local dupes.
// ---------------------------------------------------------------------------
function patchToolPolicyDedupeLocals() {
  const file = "src/agents/tool-policy.ts";
  const src = readFile(file);
  if (!/from "\.\/tool-policy-shared\.js"/.test(src)) {
    console.warn(`  ⚠️  ${file} — tool-policy-shared import missing`);
  }
  const dupes = [
    [/^export const TOOL_GROUPS: Record/m, "TOOL_GROUPS"],
    [/^export function normalizeToolName\(/m, "normalizeToolName"],
    [/^export function normalizeToolList\(/m, "normalizeToolList"],
    [/^export function expandToolGroups\(/m, "expandToolGroups"],
    [/^export function resolveToolProfilePolicy\(/m, "resolveToolProfilePolicy"],
  ];
  for (const [re, label] of dupes) {
    if (re.test(src)) {
      console.warn(`  ⚠️  ${file} — duplicate local declaration: ${label}`);
    }
  }
  console.log(`  ✅ ${file} — tool-policy dedupe guards checked`);
}

// ---------------------------------------------------------------------------
// auth-controller.ts — restore FORK emitAgentEvent import for per-profile
// fallback-error lifecycle events in advanceAuthProfile().
// ---------------------------------------------------------------------------
function patchAuthControllerEmitAgentEvent() {
  const file = "src/agents/embedded-agent-runner/run/auth-controller.ts";
  let src = readFile(file);
  if (/from "\.\.\/\.\.\/\.\.\/infra\/agent-events\.js"/.test(src)) {
    console.log(`  ✅ ${file} — emitAgentEvent already imported`);
    return;
  }
  const anchor = /import \{ formatErrorMessage \} from "\.\.\/\.\.\/\.\.\/infra\/errors\.js";/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find errors.js import anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `import { emitAgentEvent } from "../../../infra/agent-events.js";\nimport { formatErrorMessage } from "../../../infra/errors.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// agent-runner.ts — restore replyOperation destructure + reply-run-registry
// imports. Upstream #61267 added replyOperation to runReplyAgent params; the
// merge drops the destructuring and import on the fork side.
// ---------------------------------------------------------------------------
function patchAgentRunnerReplyOperation() {
  const file = "src/auto-reply/reply/agent-runner.ts";
  let src = readFile(file);
  let changed = false;

  if (!/from "\.\/reply-run-registry\.js"/.test(src)) {
    const anchor = /import \{ createFollowupRunner \} from "\.\/followup-runner\.js";/;
    if (anchor.test(src)) {
      src = src.replace(
        anchor,
        `import { createFollowupRunner } from "./followup-runner.js";\nimport {\n  createReplyOperation,\n  type ReplyOperation,\n  ReplyRunAlreadyActiveError,\n} from "./reply-run-registry.js";`,
      );
      changed = true;
    } else {
      console.warn(`  ⚠️  ${file} — could not find followup-runner import anchor`);
    }
  }

  if (!/replyOperation\?: ReplyOperation;/.test(src)) {
    src = src.replace(
      /resetTriggered\?: boolean;\n\}\): Promise<ReplyPayload \| ReplyPayload\[\] \| undefined> \{/,
      `resetTriggered?: boolean;\n  replyOperation?: ReplyOperation;\n}): Promise<ReplyPayload | ReplyPayload[] | undefined> {`,
    );
    changed = true;
  }

  if (!/replyOperation: providedReplyOperation,/.test(src)) {
    src = src.replace(
      /    typingMode,\n  \} = params;/,
      `    typingMode,\n    resetTriggered,\n    replyOperation: providedReplyOperation,\n  } = params;`,
    );
    changed = true;
  }

  if (changed) writeFile(file, src);
  else console.log(`  ✅ ${file} — replyOperation wiring already in place`);
}

// ---------------------------------------------------------------------------
// commands-core.ts — restore fork imports (fs, path, logVerbose, internal
// hooks, hook runner, session-key helpers, binding targets). Upstream merges
// strip these when resolving conflicts in the heavily-rewritten file.
// ---------------------------------------------------------------------------
function patchCommandsCoreImports() {
  const file = "src/auto-reply/reply/commands-core.ts";
  let src = readFile(file);
  if (/from "\.\.\/\.\.\/hooks\/internal-hooks\.js"/.test(src)) {
    console.log(`  ✅ ${file} — fork imports already in place`);
    return;
  }
  const anchor = /import \{ shouldHandleTextCommands \} from "\.\.\/commands-registry\.js";/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find commands-registry import anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `import fs from "node:fs/promises";\nimport path from "node:path";\nimport { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";\nimport { logVerbose } from "../../globals.js";\nimport { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";\nimport { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";\nimport { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";\nimport { shouldHandleTextCommands } from "../commands-registry.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// runs.ts — restore sessionIdsByKey on the embeddedRunState singleton.
// ---------------------------------------------------------------------------
function patchRunsSessionIdsByKey() {
  const file = "src/agents/embedded-agent-runner/runs.ts";
  let src = readFile(file);

  if (/sessionIdsByKey: new Map<string, string>\(\)/.test(src)) {
    console.log(`  ✅ ${file} — sessionIdsByKey already in singleton`);
    return;
  }

  const anchor =
    /(const embeddedRunState = resolveGlobalSingleton\(EMBEDDED_RUN_STATE_KEY, \(\) => \(\{\s*\n\s*activeRuns: new Map<string, EmbeddedPiQueueHandle>\(\),\s*\n\s*snapshots: new Map<string, ActiveEmbeddedRunSnapshot>\(\),)/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find embeddedRunState initializer anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `$1\n  // FORK: session-key → sessionId map for cross-session run resolution.\n  sessionIdsByKey: new Map<string, string>(),`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// followup-runner.ts — restore emitAgentEvent in the agent-events import.
// ---------------------------------------------------------------------------
function patchFollowupRunnerEmitAgentEvent() {
  const file = "src/auto-reply/reply/followup-runner.ts";
  let src = readFile(file);

  if (
    /import \{ emitAgentEvent, registerAgentRunContext \} from "\.\.\/\.\.\/infra\/agent-events\.js"/.test(
      src,
    )
  ) {
    console.log(`  ✅ ${file} — emitAgentEvent already in import`);
    return;
  }

  const anchor = /import \{ registerAgentRunContext \} from "\.\.\/\.\.\/infra\/agent-events\.js";/;
  if (!anchor.test(src)) {
    console.warn(
      `  ⚠️  ${file} — could not find registerAgentRunContext import anchor for emitAgentEvent`,
    );
    return;
  }
  src = src.replace(
    anchor,
    `import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// heartbeat-runner.ts — restore resolveEmbeddedSessionLane import.
// ---------------------------------------------------------------------------
function patchHeartbeatResolveLane() {
  const file = "src/infra/heartbeat-runner.ts";
  let src = readFile(file);

  if (/from "\.\.\/agents\/embedded-agent-runner\/lanes\.js"/.test(src)) {
    console.log(`  ✅ ${file} — resolveEmbeddedSessionLane already wired`);
    return;
  }

  const anchor =
    /(import \{ resolveCronSession \} from "\.\.\/cron\/isolated-agent\/session\.js";)/;
  if (!anchor.test(src)) {
    console.warn(
      `  ⚠️  ${file} — could not find resolveCronSession import anchor for lanes helper`,
    );
    return;
  }
  src = src.replace(
    anchor,
    `$1\n// FORK: route heartbeat runs into the same embedded lane as interactive runs.\nimport { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// model-catalog.types.ts — restore FORK `rank?: number` field used by model
// panel sorting + openclaw.json rank-based ordering.
// ---------------------------------------------------------------------------
function patchModelCatalogRank() {
  const file = "src/agents/model-catalog.types.ts";
  let src = readFile(file);
  if (/rank\?: number/.test(src)) {
    console.log(`  ✅ ${file} — rank field already wired`);
    return;
  }
  if (!/input\?: ModelInputType\[\];\n\};/.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find input field anchor`);
    return;
  }
  src = src.replace(
    /input\?: ModelInputType\[\];\n\};/,
    `input?: ModelInputType[];\n  /** FORK: optional display ordering rank from openclaw.json — lower = earlier. */\n  rank?: number;\n};`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// model-fallback.ts — restore FORK isCandidateAllowed import for billing gate.
// ---------------------------------------------------------------------------
function patchModelFallbackBillingGateImport() {
  const file = "src/agents/model-fallback.ts";
  let src = readFile(file);
  if (/from "\.\/billing-gate\.js"/.test(src)) {
    console.log(`  ✅ ${file} — billing-gate import already wired`);
    return;
  }
  const anchor =
    /import \{ hasAnyAuthProfileStoreSource \} from "\.\/auth-profiles\/source-check\.js";/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find source-check import anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";\n// FORK: cost-aware model routing billing gate.\nimport { isCandidateAllowed } from "./billing-gate.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// run/types.ts — restore ContextAnatomyEvent import for EmbeddedRunAttemptState.
// ---------------------------------------------------------------------------
function patchRunTypesContextAnatomyImport() {
  const file = "src/agents/embedded-agent-runner/run/types.ts";
  let src = readFile(file);
  if (/from "\.\.\/\.\.\/context-anatomy\.js"/.test(src)) {
    console.log(`  ✅ ${file} — ContextAnatomyEvent import already wired`);
    return;
  }
  const anchor =
    /import type \{ ContextEngine, ContextEnginePromptCacheInfo \} from "\.\.\/\.\.\/\.\.\/context-engine\/types\.js";/;
  if (!anchor.test(src)) {
    console.warn(`  ⚠️  ${file} — could not find context-engine import anchor`);
    return;
  }
  src = src.replace(
    anchor,
    `import type { ContextAnatomyEvent } from "../../context-anatomy.js";\nimport type { ContextEngine, ContextEnginePromptCacheInfo } from "../../../context-engine/types.js";`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// bundled-capability-metadata.ts — FORK BUNDLED_PROVIDER_PLUGIN_ID_ALIASES
// must use BUNDLED_CAPABILITY_MANIFESTS (no wrapper) after upstream rename.
// ---------------------------------------------------------------------------
function patchBundledProviderPluginIdAliases() {
  const file = "src/plugins/contracts/inventory/bundled-capability-metadata.ts";
  let src = readFile(file);
  if (!/BUNDLED_PROVIDER_PLUGIN_ID_ALIASES/.test(src)) {
    console.warn(`  ⚠️  ${file} — BUNDLED_PROVIDER_PLUGIN_ID_ALIASES block missing`);
    return;
  }
  if (/BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES/.test(src)) {
    src = src.replace(
      /export const BUNDLED_PROVIDER_PLUGIN_ID_ALIASES = Object\.fromEntries\([\s\S]*?\) as Readonly<Record<string, string>>;/,
      `export const BUNDLED_PROVIDER_PLUGIN_ID_ALIASES = Object.fromEntries(\n  BUNDLED_CAPABILITY_MANIFESTS.flatMap((manifest: BundledCapabilityManifest) =>\n    (manifest.providers ?? []).map(\n      (providerId: string) => [providerId, manifest.id] as [string, string],\n    ),\n  ).toSorted((a, b) => a[0].localeCompare(b[0])),\n) as Readonly<Record<string, string>>;`,
    );
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — BUNDLED_PROVIDER_PLUGIN_ID_ALIASES already wired`);
  }
}

// ---------------------------------------------------------------------------
// errors.ts — FORK "regain access" billing classification must wrap
// toReasonClassification (upstream return type disallows bare string).
// ---------------------------------------------------------------------------
function patchRegainAccessBillingWrap() {
  const file = "src/agents/embedded-agent-helpers/errors.ts";
  let src = readFile(file);
  if (!/regain access/.test(src)) {
    console.warn(`  ⚠️  ${file} — regain access branch missing`);
    return;
  }
  if (/regain access[\s\S]{0,200}return toReasonClassification\("billing"\);/.test(src)) {
    console.log(`  ✅ ${file} — regain access billing wrap already wired`);
    return;
  }
  src = src.replace(
    /(\/regain access\/i\.test\(raw\) \|\| \/specified\.\*usage limits\/i\.test\(raw\)\) \{\n\s*)return "billing";/,
    `$1return toReasonClassification("billing");`,
  );
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 2026-04-28 chunk-21+ recurring drift patches.
// Each of these compensates for a specific upstream API removal/rename that
// the merge auto-merge can't reconcile because the fork still has call sites.
// Idempotent — they no-op when the fix is already applied.
// ---------------------------------------------------------------------------

// attempt.ts: createEmbeddedRunAuthController subscription destructure no longer
// exposes `getLastCompactionTokensAfter`. Stub it in-place so the fork's
// compaction-tokens-after telemetry code path keeps compiling until the new
// telemetry surface lands.
function patchAttemptCompactionTokensStub() {
  const file = "src/agents/embedded-agent-runner/run/attempt.ts";
  const src = readFile(file);
  if (!src.includes("getLastCompactionTokensAfter,")) {
    console.log(`  ✅ ${file} — getLastCompactionTokensAfter destructure already absent`);
    return;
  }
  const patched = src.replace(
    /(getCompactionCount,\s*\n)\s*getLastCompactionTokensAfter,(\s*\n\s*\} = subscription;)/,
    (_match, before, after) =>
      `${before}${after}\n      const getLastCompactionTokensAfter = (): number | undefined => undefined;`,
  );
  if (patched === src) {
    console.warn(`  ⚠️  ${file} — could not find getLastCompactionTokensAfter destructure anchor`);
    return;
  }
  console.log(`  ✏️  Patched: ${file} (getLastCompactionTokensAfter stub)`);
  writeFile(file, patched);
}

// agent-command.ts: runWithModelFallback signature dropped onFallbackStep.
function patchAgentCommandDropOnFallbackStep() {
  const file = "src/agents/agent-command.ts";
  const src = readFile(file);
  if (!/onFallbackStep:/.test(src)) {
    console.log(`  ✅ ${file} — onFallbackStep already removed`);
    return;
  }
  const patched = src.replace(
    /\s*onFallbackStep: \(step\) => \{\s*\n\s*fallbackTrajectoryRecorder\?\.recordEvent\("model\.fallback_step", step\);\s*\n\s*\},\n/,
    "\n          // FORK: onFallbackStep arg dropped from runWithModelFallback (chunk-23).\n",
  );
  if (patched === src) {
    console.warn(`  ⚠️  ${file} — could not find onFallbackStep anchor`);
    return;
  }
  console.log(`  ✏️  Patched: ${file} (onFallbackStep drop)`);
  writeFile(file, patched);
}

// anthropic-vertex-stream.ts: fork uses updateRateLimitSnapshot to capture
// Anthropic rate-limit headers; upstream's --theirs version of this file drops
// the import. Re-add it.
function patchAnthropicVertexRateLimitImport() {
  const file = "src/agents/anthropic-vertex-stream.ts";
  const src = readFile(file);
  if (!src.includes("updateRateLimitSnapshot(")) {
    console.log(`  ✅ ${file} — updateRateLimitSnapshot not used (no need to import)`);
    return;
  }
  if (/import\s*\{\s*updateRateLimitSnapshot\s*\}/.test(src)) {
    console.log(`  ✅ ${file} — updateRateLimitSnapshot import already present`);
    return;
  }
  const patched = src.replace(
    /(import type \{ StreamFn \} from "@mariozechner\/pi-agent-core";\n)/,
    `$1// FORK: rate-limit snapshot capture used by anthropic header inspection.\nimport { updateRateLimitSnapshot } from "./anthropic-ratelimit-store.js";\n`,
  );
  if (patched === src) {
    console.warn(`  ⚠️  ${file} — could not find import anchor`);
    return;
  }
  console.log(`  ✏️  Patched: ${file} (updateRateLimitSnapshot import)`);
  writeFile(file, patched);
}

// Three sites need to re-export isLoopbackAddress alongside isLoopbackHost.
function patchIsLoopbackAddressReExports() {
  const sites = [
    {
      file: "extensions/browser/src/gateway/net.ts",
      from: 'export { isLoopbackHost } from "../sdk-node-runtime.js";',
      to: 'export { isLoopbackAddress, isLoopbackHost } from "../sdk-node-runtime.js";',
    },
    {
      file: "src/plugin-sdk/gateway-runtime.ts",
      from: 'export { isLoopbackHost } from "../gateway/net.js";',
      to: 'export { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";',
    },
  ];
  for (const { file, from, to } of sites) {
    const src = readFile(file);
    if (src.includes("isLoopbackAddress")) {
      console.log(`  ✅ ${file} — isLoopbackAddress already re-exported`);
      continue;
    }
    if (!src.includes(from)) {
      console.warn(`  ⚠️  ${file} — could not find isLoopbackHost re-export anchor`);
      continue;
    }
    writeFile(file, src.replace(from, to));
    console.log(`  ✏️  Patched: ${file} (isLoopbackAddress re-export)`);
  }
  // sdk-node-runtime.ts is a longer multi-export block; insert the symbol in place.
  const sdkFile = "extensions/browser/src/sdk-node-runtime.ts";
  const sdkSrc = readFile(sdkFile);
  if (sdkSrc.includes("isLoopbackAddress,")) {
    console.log(`  ✅ ${sdkFile} — isLoopbackAddress already in re-export`);
  } else if (!/isLoopbackHost,\n/.test(sdkSrc)) {
    console.warn(`  ⚠️  ${sdkFile} — could not find isLoopbackHost line`);
  } else {
    writeFile(
      sdkFile,
      sdkSrc.replace(/(\s*)isLoopbackHost,\n/, `$1isLoopbackAddress,\n$1isLoopbackHost,\n`),
    );
    console.log(`  ✏️  Patched: ${sdkFile} (isLoopbackAddress added)`);
  }
}

// engine-storage.ts: re-export the granularity/topic-cluster detectors that
// the fork ports into host/internal.ts.
function patchEngineStorageDetectExports() {
  const file = "packages/memory-host-sdk/src/engine-storage.ts";
  const src = readFile(file);
  if (src.includes("detectGranularity,")) {
    console.log(`  ✅ ${file} — detectGranularity already re-exported`);
    return;
  }
  if (!src.includes("chunkMarkdown,\n  cosineSimilarity,\n  ensureDir,")) {
    console.warn(`  ⚠️  ${file} — could not find re-export anchor`);
    return;
  }
  writeFile(
    file,
    src.replace(
      "chunkMarkdown,\n  cosineSimilarity,\n  ensureDir,",
      "chunkMarkdown,\n  cosineSimilarity,\n  detectGranularity,\n  detectTopicCluster,\n  ensureDir,",
    ),
  );
  console.log(`  ✏️  Patched: ${file} (detectGranularity/detectTopicCluster re-export)`);
}

// embedded-agent-runner/extensions.ts: upstream removed the embedded-extension-factory
// module. Stub listEmbeddedExtensionFactories inline until apply-fork-wiring grows
// a patch for the new lookup path.
function patchExtensionsListFactoriesStub() {
  const file = "src/agents/embedded-agent-runner/extensions.ts";
  const src = readFile(file);
  const importLine =
    'import { listEmbeddedExtensionFactories } from "../../plugins/embedded-extension-factory.js";';
  if (!src.includes(importLine)) {
    console.log(`  ✅ ${file} — listEmbeddedExtensionFactories import already absent`);
    return;
  }
  writeFile(
    file,
    src.replace(
      importLine,
      "// FORK: listEmbeddedExtensionFactories source removed upstream. Stubbed inline.\nfunction listEmbeddedExtensionFactories(): never[] {\n  return [];\n}",
    ),
  );
  console.log(`  ✏️  Patched: ${file} (listEmbeddedExtensionFactories stub)`);
}

// tsdown.config.ts: ensure better-sqlite3 + bindings are in the
// explicitNeverBundleDependencies list. Native addons reference __filename
// which is undefined in ESM bundles; if tsdown inlines them, gateway boot
// crashes immediately. Upstream merges sometimes wipe this list.
function patchTsdownNativeAddons() {
  const file = "tsdown.config.ts";
  const src = readFile(file);
  if (src.includes('"better-sqlite3"') && src.includes('"bindings"')) {
    console.log(`  ✅ ${file} — better-sqlite3 + bindings already in neverBundle list`);
    return;
  }
  const anchor = '"matrix-js-sdk",';
  if (!src.includes(anchor)) {
    console.warn(`  ⚠️  ${file} — could not find neverBundle list anchor`);
    return;
  }
  writeFile(
    file,
    src.replace(
      anchor,
      `${anchor}\n  // FORK 2026-03-03: native addons must NEVER be inlined — they reference\n  // __filename which is undefined in ESM bundles. better-sqlite3 + bindings\n  // crash gateway boot if bundled.\n  "better-sqlite3",\n  "bindings",`,
    ),
  );
  console.log(`  ✏️  Patched: ${file} (better-sqlite3 + bindings added to neverBundle list)`);
}

// hippocampus/index.ts: emptyPluginConfigSchema moved out of memory-core.
function patchHippocampusEmptyPluginConfigSchema() {
  const file = "extensions/hippocampus/index.ts";
  const src = readFile(file);
  if (!src.includes('"openclaw/plugin-sdk/memory-core"')) {
    console.log(`  ✅ ${file} — already on the new import path`);
    return;
  }
  writeFile(
    file,
    src.replace(
      'import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/memory-core";',
      'import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/channel-plugin-common";',
    ),
  );
  console.log(`  ✏️  Patched: ${file} (emptyPluginConfigSchema import path)`);
}

for (const [label, fn] of NEW_PATCHES) {
  try {
    fn();
  } catch (err) {
    console.warn(`  ⚠️  ${label}: ${err.message}`);
  }
}

let structuralOk = true;
try {
  if (!checkPreservePaths()) structuralOk = false;
} catch (err) {
  console.warn(`  ⚠️  preserve guard: ${err.message}`);
  structuralOk = false;
}
try {
  if (!checkCrossPackageImports()) structuralOk = false;
} catch (err) {
  console.warn(`  ⚠️  cross-package guard: ${err.message}`);
  structuralOk = false;
}

console.log("\n✅ Fork wiring applied. Run: pnpm build");
if (!structuralOk) {
  process.exitCode = 1;
}
