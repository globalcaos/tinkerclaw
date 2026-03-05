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
  const file = "src/agents/pi-embedded-runner/run/attempt.ts";
  let src = readFile(file);

  const FORK_IMPORT =
    'import * as forkAttemptHooks from "../../../fork/attempt-hooks.js"; // FORK: single hook entry point';
  const RETRIEVAL_IMPORT =
    'import { getRetrievalRuntime } from "../../pi-extensions/retrieval-runtime.js"; // FORK: still used inline for retrieval pack';

  // Add imports if missing
  if (!src.includes("fork/attempt-hooks")) {
    // Insert after the last import line
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx > -1) {
      const lineEnd = src.indexOf("\n", lastImportIdx + 1);
      src =
        src.slice(0, lineEnd + 1) +
        RETRIEVAL_IMPORT +
        "\n" +
        FORK_IMPORT +
        "\n" +
        src.slice(lineEnd + 1);
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
      /return \{\s*\n\s*aborted,\s*\n\s*timedOut,\s*\n\s*timedOutDuringCompaction,/,
      `      // FORK: fire-and-forget post-turn processing (context anatomy, ENGRAM, SyncScore, observations)
      _forkAttemptHooks.onTurnComplete({
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
// 3. process-message.ts — add thinking reaction + offline recovery
// ---------------------------------------------------------------------------
function patchProcessMessage() {
  const file = "src/web/auto-reply/monitor/process-message.ts";
  let src = readFile(file);

  const FORK_IMPORT =
    'import { annotateOfflineRecovery, createThinkingReaction } from "../../../fork/process-message-hooks.js"; // FORK';

  if (!src.includes("fork/process-message-hooks")) {
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx > -1) {
      const lineEnd = src.indexOf("\n", lastImportIdx + 1);
      src = src.slice(0, lineEnd + 1) + FORK_IMPORT + "\n" + src.slice(lineEnd + 1);
    }
  }

  // Add offline recovery annotation call site
  if (!src.includes("_annotateOfflineRecovery")) {
    const r = insertBeforeAnchor(
      src,
      /\/\/ Echo detection uses combined body/,
      `  // FORK: annotate offline recovery messages for agent awareness
  combinedBody = _annotateOfflineRecovery(
    combinedBody,
    params.msg.isOfflineRecovery,
    params.msg.timestamp,
  );\n`,
      "offline recovery annotation",
    );
    if (r) {
      src = r;
    }
  }

  // Add thinking reaction lifecycle
  if (!src.includes("_createThinkingReaction")) {
    // Start before dispatch
    const r1 = insertBeforeAnchor(
      src,
      /const \{ queuedFinal \} = await dispatchReplyWithBufferedBlockDispatcher/,
      `  // FORK: thinking reaction (WhatsApp progress indicator)
  const thinkingReaction = _createThinkingReaction({
    messageId: params.msg.id,
    chatId: conversationId,
    senderJid: params.msg.senderJid,
    accountId: params.route.accountId,
  });
  thinkingReaction.start();\n`,
      "thinking reaction start",
    );
    if (r1) {
      src = r1;
    }

    // Stop after dispatch
    const r2 = insertBeforeAnchor(
      src,
      /if \(!queuedFinal\) \{/,
      `  // FORK: stop thinking reaction after dispatch completes
  thinkingReaction.stop();\n`,
      "thinking reaction stop",
    );
    if (r2) {
      src = r2;
    }
  }

  writeFile(file, src);
}

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
// 5. tsdown.config.ts — externalize native addons in all entry blocks
// ---------------------------------------------------------------------------
function patchTsdownConfig() {
  const file = "tsdown.config.ts";
  let src = readFile(file);

  if (src.includes('external: ["better-sqlite3"')) {
    // Check if ALL platform: "node" entries have it
    const nodeEntries = [...src.matchAll(/platform:\s*"node"/g)];
    const externalEntries = [...src.matchAll(/external:\s*\["better-sqlite3"/g)];
    if (externalEntries.length >= nodeEntries.length) {
      console.log(`  ✅ ${file} — native addon externalization already present in all entries`);
      return;
    }
  }

  // Add external array after each `platform: "node"` that doesn't have one
  let changed = false;
  src = src.replace(/platform:\s*"node",?\s*\n(?!\s*external:)/g, (match) => {
    changed = true;
    return (
      match.trimEnd() +
      '\n    external: ["better-sqlite3", "bindings"], // FORK: native addons must stay external\n'
    );
  });

  if (changed) {
    writeFile(file, src);
  } else {
    console.log(`  ✅ ${file} — native addon externalization already present`);
  }
}

// ---------------------------------------------------------------------------
// 6. outbound.ts — WhatsApp group/edit/delete/reply/sticker wrappers
// ---------------------------------------------------------------------------
function patchOutbound() {
  const file = "src/web/outbound.ts";
  let src = readFile(file);

  // Guard: check if group wrappers already exist
  if (src.includes("Group & Extended Message Operations")) {
    console.log(`  ✅ ${file} — group wrappers already present`);
    return;
  }

  // Ensure MessageKey is imported
  if (!src.includes("MessageKey")) {
    src = src.replace(
      /from "\.\/active-listener\.js";/,
      'type MessageKey,\n  requireActiveWebListener,\n} from "./active-listener.js";',
    );
  }

  // Append group wrappers after sendPollWhatsApp
  const BLOCK = `
// ─── Group & Extended Message Operations ───
// Upstream added ActiveWebListener interface + whatsapp-actions handler but
// outbound wrappers were not implemented yet. These delegate to the active listener.

type OutboundOptions = { verbose?: boolean; accountId?: string };

export async function createGroupWhatsApp(
  subject: string,
  participants: string[],
  options?: OutboundOptions,
): Promise<{ groupId: string; subject: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.createGroup(subject, participants.map(toWhatsappJid));
}

export async function editMessageWhatsApp(
  chatJid: string,
  messageId: string,
  newText: string,
  options?: OutboundOptions & { fromMe?: boolean; participant?: string },
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.editMessage(chatJid, messageId, newText, options?.fromMe, options?.participant);
}

export async function deleteMessageWhatsApp(
  chatJid: string,
  messageId: string,
  options?: OutboundOptions & { fromMe?: boolean; participant?: string },
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.deleteMessage(chatJid, messageId, options?.fromMe, options?.participant);
}

export async function replyMessageWhatsApp(
  to: string,
  text: string,
  quotedKey: MessageKey,
  options?: OutboundOptions & { mediaUrl?: string; mediaLocalRoots?: readonly string[] },
): Promise<{ messageId: string; toJid: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  let mediaBuffer: Buffer | undefined;
  let mediaType: string | undefined;
  if (options?.mediaUrl) {
    const media = await loadWebMedia(options.mediaUrl, { localRoots: options.mediaLocalRoots });
    mediaBuffer = media.buffer;
    mediaType = media.contentType;
  }
  const jid = toWhatsappJid(to);
  const result = await listener.replyMessage(jid, text, quotedKey, mediaBuffer, mediaType);
  return { messageId: result.messageId, toJid: jid };
}

export async function sendStickerWhatsApp(
  to: string,
  stickerPathOrBuffer: string | Buffer,
  options?: OutboundOptions,
): Promise<{ messageId: string; toJid: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  const jid = toWhatsappJid(to);
  let buf: Buffer;
  if (typeof stickerPathOrBuffer === "string") {
    const media = await loadWebMedia(stickerPathOrBuffer);
    buf = media.buffer;
  } else {
    buf = stickerPathOrBuffer;
  }
  const result = await listener.sendSticker(jid, buf);
  return { messageId: result.messageId, toJid: jid };
}

export async function groupUpdateSubjectWhatsApp(groupJid: string, newSubject: string, options?: OutboundOptions): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupUpdateSubject(groupJid, newSubject);
}

export async function groupUpdateDescriptionWhatsApp(groupJid: string, description: string, options?: OutboundOptions): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupUpdateDescription(groupJid, description);
}

export async function groupUpdateIconWhatsApp(groupJid: string, imagePathOrBuffer: string | Buffer, options?: OutboundOptions): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  let buf: Buffer;
  if (typeof imagePathOrBuffer === "string") { const media = await loadWebMedia(imagePathOrBuffer); buf = media.buffer; } else { buf = imagePathOrBuffer; }
  return listener.groupUpdateIcon(groupJid, buf);
}

export async function groupAddParticipantsWhatsApp(groupJid: string, participants: string[], options?: OutboundOptions): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupAddParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupRemoveParticipantsWhatsApp(groupJid: string, participants: string[], options?: OutboundOptions): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupRemoveParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupPromoteParticipantsWhatsApp(groupJid: string, participants: string[], options?: OutboundOptions): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupPromoteParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupDemoteParticipantsWhatsApp(groupJid: string, participants: string[], options?: OutboundOptions): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupDemoteParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupLeaveWhatsApp(groupJid: string, options?: OutboundOptions): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupLeave(groupJid);
}

export async function groupGetInviteCodeWhatsApp(groupJid: string, options?: OutboundOptions): Promise<string> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupGetInviteCode(groupJid);
}

export async function groupRevokeInviteCodeWhatsApp(groupJid: string, options?: OutboundOptions): Promise<string> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupRevokeInviteCode(groupJid);
}

export async function groupGetMetadataWhatsApp(groupJid: string, options?: OutboundOptions): Promise<{ id: string; subject: string; description?: string; participants: Array<{ id: string; admin?: string }> }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupMetadata(groupJid);
}
`;

  src = src.trimEnd() + "\n" + BLOCK;
  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 7. pi-embedded-subscribe.types.ts — authProfileId field
// ---------------------------------------------------------------------------
function patchSubscribeTypes() {
  const file = "src/agents/pi-embedded-subscribe.types.ts";
  let src = readFile(file);

  if (src.includes("authProfileId")) {
    console.log(`  ✅ ${file} — authProfileId already present`);
    return;
  }

  // Insert before the closing }; of SubscribeEmbeddedPiSessionParams
  const typeMatch = src.match(/export type SubscribeEmbeddedPiSessionParams\s*=\s*\{/);
  if (!typeMatch) {
    console.warn(`  ⚠️  Could not find SubscribeEmbeddedPiSessionParams in ${file}`);
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
  const file = "src/web/auto-reply/monitor.ts";
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
  const file = "src/agents/pi-embedded-runner/run.ts";
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

  writeFile(file, src);
}

// ---------------------------------------------------------------------------
// 11. failover-matches.ts — billing patterns for Anthropic spending cap
// ---------------------------------------------------------------------------
function patchFailoverMatches() {
  const file = "src/agents/pi-embedded-helpers/failover-matches.ts";
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
  const file = "src/agents/pi-embedded-helpers/errors.ts";
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
try {
  patchProcessMessage();
} catch (err) {
  console.warn(`  ⚠️  process-message.ts: ${err.message}`);
}
try {
  patchSessions();
} catch (err) {
  console.warn(`  ⚠️  sessions.ts: ${err.message}`);
}
try {
  patchTsdownConfig();
} catch (err) {
  console.warn(`  ⚠️  tsdown.config.ts: ${err.message}`);
}
try {
  patchOutbound();
} catch (err) {
  console.warn(`  ⚠️  outbound.ts: ${err.message}`);
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

console.log("\n✅ Fork wiring applied. Run: pnpm build");
