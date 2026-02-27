import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import type { loadConfig } from "../../../config/config.js";
import { normalizeE164 } from "../../../utils.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor, resolveGroupPolicyFor } from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
}

function recordPendingGroupHistoryEntry(params: {
  msg: WebInboundMsg;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  groupHistoryLimit: number;
}) {
  const sender =
    params.msg.senderName && params.msg.senderE164
      ? `${params.msg.senderName} (${params.msg.senderE164})`
      : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
  recordPendingHistoryEntryIfEnabled({
    historyMap: params.groupHistories,
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      id: params.msg.id,
      senderJid: params.msg.senderJid,
    },
  });
}

export function applyGroupGating(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
}) {
  // ──────────────────────────────────────────────────────────────────
  // STRICT 3-RULE GROUP GATE (no bypasses, no exceptions)
  //
  // Rule 1: Is the message from an ALLOWED CHAT?
  // Rule 2: Is the message from an AUTHORIZED SENDER?
  // Rule 3: Does the message text start with the triggerPrefix ("Jarvis")?
  //
  // ALL three must pass. Media without caption = no prefix = REJECT.
  // allowFrom ≠ owner. Only explicit owner numbers are owners.
  // ──────────────────────────────────────────────────────────────────

  // — Rule 1: Allowed Chat —
  const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
  if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
    params.logVerbose(`[group-gate] REJECT: chat not in allowlist → ${params.conversationId}`);
    return { shouldProcess: false };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    params.msg.senderE164,
    params.msg.senderName,
  );

  // — Rule 2: Authorized Sender —
  const senderE164 = normalizeE164(params.msg.senderE164 ?? "");
  const configuredGroupAllowFrom =
    params.cfg.channels?.whatsapp?.groupAllowFrom ??
    params.cfg.channels?.whatsapp?.allowFrom ??
    [];
  const normalizedAllowFrom = configuredGroupAllowFrom
    .map((entry: string | number) => String(entry).trim())
    .filter((entry: string) => entry && entry !== "*")
    .map((entry: string) => normalizeE164(entry))
    .filter((entry: string | null): entry is string => Boolean(entry));
  const senderAuthorized = senderE164 ? normalizedAllowFrom.includes(senderE164) : false;

  if (!senderAuthorized) {
    console.log(`[GROUP-GATE] REJECT: sender not authorized → sender=${params.msg.senderE164} normalized=${senderE164} chat=${params.conversationId}`);
    params.logVerbose(
      `[group-gate] REJECT: sender not authorized → ${params.msg.senderE164} in ${params.conversationId}`,
    );
    recordPendingGroupHistoryEntry({
      msg: params.msg,
      groupHistories: params.groupHistories,
      groupHistoryKey: params.groupHistoryKey,
      groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
  }

  // — Rule 3: Trigger Prefix —
  const triggerPrefix =
    params.cfg.channels?.whatsapp?.triggerPrefix ?? params.cfg.channels?.defaults?.triggerPrefix;
  const bodyTrimmed = (params.msg.body ?? "").trim().toLowerCase();
  const triggerPrefixMatched = triggerPrefix
    ? bodyTrimmed.startsWith(triggerPrefix.toLowerCase())
    : false;

  // Also allow @mention as equivalent to prefix (standard WhatsApp behavior)
  const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
  const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
  const wasMentioned = mentionDebug.wasMentioned || triggerPrefixMatched;

  // Allow reply-to-bot as implicit trigger (user replied to one of our messages)
  const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
  const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
  const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
  const replySenderE164 = params.msg.replyToSenderE164
    ? normalizeE164(params.msg.replyToSenderE164)
    : null;
  const repliedToBot = Boolean(
    (selfJid && replySenderJid && selfJid === replySenderJid) ||
    (selfE164 && replySenderE164 && selfE164 === replySenderE164),
  );

  // Owner slash commands (e.g. /new, /status) always pass rule 3
  const owner = isOwnerSender(params.baseMentionConfig, params.msg);
  const commandBody = stripMentionsForCommand(
    params.msg.body,
    mentionConfig.mentionRegexes,
    params.msg.selfE164,
  );
  const ownerSlashCommand = owner && hasControlCommand(commandBody, params.cfg);

  // Audio messages: let through to dispatch-from-config which handles
  // audio preflight (transcribe → prefix check) downstream.
  // Only audio — images/video/docs stay gated (no bypass for non-audio media).
  const isAudioMessage = (params.msg.body ?? "").trim().toLowerCase().startsWith("<media:audio");

  const prefixPassed = wasMentioned || repliedToBot || ownerSlashCommand || isAudioMessage;

  params.replyLogger.debug(
    {
      conversationId: params.conversationId,
      senderAuthorized,
      triggerPrefixMatched,
      wasMentioned: mentionDebug.wasMentioned,
      repliedToBot,
      ownerSlashCommand,
      prefixPassed,
      triggerPrefix,
      ...mentionDebug.details,
    },
    "group gate debug",
  );

  if (!prefixPassed) {
    console.log(`[GROUP-GATE] REJECT: no prefix/mention/reply → sender=${params.msg.senderE164} chat=${params.conversationId} body=${params.msg.body?.substring(0, 60)} triggerPrefix=${triggerPrefix} triggerPrefixMatched=${triggerPrefixMatched} wasMentioned=${mentionDebug.wasMentioned} repliedToBot=${repliedToBot}`);
    params.logVerbose(
      `[group-gate] REJECT: no prefix/mention/reply → ${params.msg.senderE164} in ${params.conversationId}: ${params.msg.body?.substring(0, 80)}`,
    );
    recordPendingGroupHistoryEntry({
      msg: params.msg,
      groupHistories: params.groupHistories,
      groupHistoryKey: params.groupHistoryKey,
      groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
  }

  // Block non-owner /activation commands
  const activationCommand = parseActivationCommand(commandBody);
  if (activationCommand.hasCommand && !owner) {
    params.logVerbose(`[group-gate] REJECT: /activation from non-owner in ${params.conversationId}`);
    recordPendingGroupHistoryEntry({
      msg: params.msg,
      groupHistories: params.groupHistories,
      groupHistoryKey: params.groupHistoryKey,
      groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
  }

  // Set wasMentioned for downstream context
  params.msg.wasMentioned = wasMentioned || repliedToBot;

  console.log(`[GROUP-GATE] ACCEPT: all 3 rules passed → sender=${params.msg.senderE164} chat=${params.conversationId}`);
  params.logVerbose(
    `[group-gate] ACCEPT: all 3 rules passed → ${params.msg.senderE164} in ${params.conversationId}`,
  );
  return { shouldProcess: true };
}
