import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

let compactRuntimePromise: Promise<typeof import("./commands-compact.runtime.js")> | null = null;

function loadCompactRuntime(): Promise<typeof import("./commands-compact.runtime.js")> {
  compactRuntimePromise ??= import("./commands-compact.runtime.js");
  return compactRuntimePromise;
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

/**
 * The tinker-bridge's provider id: `PROVIDER_ID` in
 * extensions/tinkerclaw-tinker-bridge/src/defaults.ts. Core does not import extensions, so the id
 * is named here, as session-eviction.ts names it.
 */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md finding F2) — is this session's
 * context owned by the claude CLI rather than by the gateway? On the tinker-bridge lane the model
 * reads the claude CLI's OWN transcript, resumed with `--resume` by a worker keyed on the
 * sessionId, so an embedded compaction here rewrites the gateway's MIRROR: it spends a
 * summarisation call, reports "Compacted (X → Y)", and the very next turn resumes the untouched
 * CLI session at exactly the size it was. A typed `/compact` on that lane must instead reach the
 * agent runner as the turn prompt, so the bridge writes it to the CLI and the CLI compacts its
 * own context.
 *
 * The lane is resolved exactly as the EVICT button's refusal resolves it —
 * `resolveContextOwningRuntime` over `resolveSessionModelRef(entry, agent)` in
 * ../../gateway/session-eviction.ts — so there is ONE definition of the lane, the two doors can
 * never disagree, and the tab's model-picker override decides: the question is where the NEXT
 * call goes, not where the last one ran.
 *
 * Deliberately NARROWED to claude-code rather than to every context-owning runtime the eviction
 * refuses on. A registered CLI backend also keeps its own context, but passing `/compact` through
 * only helps when the runtime on the other end understands it; on any other backend the literal
 * text would simply become a prompt. Those lanes keep today's behaviour until a bridge answers
 * for them.
 *
 * Imported lazily, like the compaction runtime above: the command handlers load eagerly, and
 * gateway/session-utils.js imports back into auto-reply.
 */
async function ownsContextViaClaudeCode(params: {
  cfg: OpenClawConfig;
  entry: import("../../config/sessions.js").SessionEntry | undefined;
  agentId: string;
}): Promise<boolean> {
  const [{ resolveContextOwningRuntime }, { resolveSessionModelRef }] = await Promise.all([
    import("../../gateway/session-eviction.js"),
    import("../../gateway/session-utils.js"),
  ]);
  const { provider } = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveContextOwningRuntime(provider, params.cfg) === CLAUDE_CODE_PROVIDER_ID;
}

function isCompactionSkipReason(reason?: string): boolean {
  const text = normalizeOptionalLowercaseString(reason) ?? "";
  return (
    text.includes("nothing to compact") ||
    text.includes("below threshold") ||
    text.includes("already compacted") ||
    text.includes("no real conversation messages")
  );
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(text);
  if (lower.includes("nothing to compact")) {
    return "nothing compactable in this session yet";
  }
  if (lower.includes("below threshold")) {
    return "context is below the compaction threshold";
  }
  if (lower.includes("already compacted")) {
    return "session was already compacted recently";
  }
  if (lower.includes("no real conversation messages")) {
    return "no real conversation messages yet";
  }
  return text;
}

export const handleCompactCommand: CommandHandler = async (params) => {
  const compactRequested =
    params.command.commandBodyNormalized === "/compact" ||
    params.command.commandBodyNormalized.startsWith("/compact ");
  if (!compactRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : (params.agentId ?? "main");
  // FORK 2026-09-25 (F2) — the claude-code lane owns its own context: hand the command to the
  // runner as the turn prompt instead of compacting the gateway's mirror. `shouldContinue: true`
  // with NO reply is what commands-core hands back to get-reply-inline-actions as kind:"continue"
  // (a reply on THIS branch would be silently dropped there), and nothing rewrites ctx.Body, so
  // the ORIGINAL command text — instruction tail and all — is what the runner sends.
  //
  // Checked BEFORE the session-id guard, which is an embedded-compaction concern (the runner needs
  // the prompt either way), and BEFORE loadCompactRuntime(), so a live embedded run is never
  // interrupted to accomplish nothing — the lesson the EVICT button already learned (F1). Every
  // other lane falls through to the embedded compaction below, unchanged.
  if (
    await ownsContextViaClaudeCode({
      cfg: params.cfg,
      entry: targetSessionEntry,
      agentId: sessionAgentId,
    })
  ) {
    logVerbose(
      `Passing /compact through to the ${CLAUDE_CODE_PROVIDER_ID} runtime for ${params.sessionKey || "<unknown session>"}`,
    );
    return { shouldContinue: true };
  }
  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Compaction unavailable (missing session id)." },
    };
  }
  const runtime = await loadCompactRuntime();
  const sessionId = targetSessionEntry.sessionId;
  if (runtime.isEmbeddedPiRunActive(sessionId)) {
    runtime.abortEmbeddedPiRun(sessionId);
    await runtime.waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);
  const customInstructions = extractCompactInstructions({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: sessionAgentId,
    isGroup: params.isGroup,
  });
  const result = await runtime.compactEmbeddedPiSession({
    sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.command.channel,
    groupId: targetSessionEntry.groupId,
    groupChannel: targetSessionEntry.groupChannel,
    groupSpace: targetSessionEntry.space,
    spawnedBy: targetSessionEntry.spawnedBy,
    senderId: params.command.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    sessionFile: runtime.resolveSessionFilePath(
      sessionId,
      targetSessionEntry,
      runtime.resolveSessionFilePathOptions({
        agentId: sessionAgentId,
        storePath: params.storePath,
      }),
    ),
    workspaceDir: params.workspaceDir,
    agentDir: sessionAgentDir,
    config: params.cfg,
    skillsSnapshot: targetSessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    agentHarnessId:
      targetSessionEntry.sessionId === sessionId ? targetSessionEntry.agentHarnessId : undefined,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    customInstructions,
    trigger: "manual",
    senderIsOwner: params.command.senderIsOwner,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  const compactLabel =
    result.ok || isCompactionSkipReason(result.reason)
      ? result.compacted
        ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
          ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(result.result.tokensAfter)})`
          : result.result?.tokensBefore
            ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} before)`
            : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (result.ok && result.compacted) {
    await runtime.incrementCompactionCount({
      cfg: params.cfg,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
      newSessionId: result.result?.sessionId,
      newSessionFile: result.result?.sessionFile,
    });
  }
  // Use the post-compaction token count for context summary if available
  const tokensAfterCompaction = result.result?.tokensAfter;
  const totalTokens =
    tokensAfterCompaction ?? runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
  const contextSummary = runtime.formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    params.contextTokens ?? targetSessionEntry.contextTokens ?? null,
  );
  const reason = formatCompactionReason(result.reason);
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
};
