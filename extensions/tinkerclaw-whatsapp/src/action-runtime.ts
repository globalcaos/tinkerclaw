import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import type { WhatsAppGroupChange } from "./inbound/types.js";
import { resolveWhatsAppMessageSentAtMs } from "./message-sent-at.js";
import { lookupInboundMessageMetaForTarget } from "./quoted-message.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import {
  editMessageWhatsApp,
  revokeMessageWhatsApp,
  sendMessageWhatsApp,
  sendReactionWhatsApp,
  updateGroupWhatsApp,
} from "./send.js";
import { toWhatsappJid } from "./text-runtime.js";

export const whatsAppActionRuntime = {
  resolveAuthorizedWhatsAppOutboundTarget,
  sendReactionWhatsApp,
  revokeMessageWhatsApp,
  editMessageWhatsApp,
  sendMessageWhatsApp,
  updateGroupWhatsApp,
  resolveWhatsAppMessageSentAtMs,
};

/** WhatsApp applies an edit only within this long of the original send. */
export const WHATSAPP_EDIT_WINDOW_MS = 15 * 60_000;

function editWindowError(ageMs: number): Error {
  const minutes = Math.floor(ageMs / 60_000);
  return new Error(
    `WhatsApp only allows edits within 15 minutes; this message is ${minutes} min old — unsend and resend instead.`,
  );
}

function readGroupChange(action: string, params: Record<string, unknown>): WhatsAppGroupChange {
  if (action === "renameGroup") {
    return { kind: "subject", subject: readStringParam(params, "newName", { required: true }) };
  }
  if (action === "setGroupIcon") {
    return { kind: "icon", imagePath: readStringParam(params, "imagePath", { required: true }) };
  }
  return { kind: "leave" };
}

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const whatsAppConfig = cfg.channels?.whatsapp;
  const isActionEnabled = createActionGate(whatsAppConfig?.actions);

  if (action === "react") {
    const accountId = readStringParam(params, "accountId");
    if (!whatsAppConfig) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const reactionLevelInfo = resolveWhatsAppReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      throw new Error(
        `WhatsApp agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
          `Set channels.whatsapp.reactionLevel to "minimal" or "extensive" to enable.`,
      );
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;

    // Resolve account + allowFrom via shared account logic so auth and routing stay aligned.
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "reaction",
    });

    const resolvedEmoji = remove ? "" : emoji;
    await whatsAppActionRuntime.sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: resolved.accountId,
      cfg,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "unsend") {
    const accountId = readStringParam(params, "accountId");
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "unsend",
    });
    await whatsAppActionRuntime.revokeMessageWhatsApp(resolved.to, messageId, {
      fromMe: typeof params.fromMe === "boolean" ? params.fromMe : true,
      participant: readStringParam(params, "participant") ?? undefined,
      accountId: resolved.accountId,
      cfg,
    });
    return jsonResult({ ok: true, deleted: messageId });
  }

  if (action === "edit") {
    const accountId = readStringParam(params, "accountId");
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const newText = readStringParam(params, "newText", { required: true });
    if (params.fromMe === false) {
      throw new Error("WhatsApp only lets you edit your own messages.");
    }
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "edit",
    });
    // WhatsApp accepts a late edit on the wire and the other phones drop it, so the window is
    // checked here: past it, the edit would report success and change nothing.
    const sentAtMs = whatsAppActionRuntime.resolveWhatsAppMessageSentAtMs(messageId);
    const ageMs = sentAtMs === undefined ? undefined : Date.now() - sentAtMs;
    if (ageMs !== undefined && ageMs > WHATSAPP_EDIT_WINDOW_MS) {
      throw editWindowError(ageMs);
    }
    const options = { accountId: resolved.accountId, cfg };
    try {
      await whatsAppActionRuntime.editMessageWhatsApp(resolved.to, messageId, newText, options);
    } catch (err) {
      if (ageMs !== undefined) {
        throw err;
      }
      throw new Error(
        `WhatsApp rejected the edit (${String(err)}). WhatsApp only allows edits within 15 minutes and this message's send time is unknown — if it is older, unsend and resend instead.`,
        { cause: err },
      );
    }
    if (ageMs === undefined) {
      return jsonResult({
        ok: true,
        edited: messageId,
        warning:
          "Send time unknown: WhatsApp drops edits to messages older than 15 minutes without an error, so check the chat.",
      });
    }
    return jsonResult({ ok: true, edited: messageId, ageMinutes: Math.floor(ageMs / 60_000) });
  }

  if (action === "reply") {
    const accountId = readStringParam(params, "accountId");
    const to = readStringParam(params, "to", { required: true });
    const text = readStringParam(params, "text", { required: true });
    const replyToId = readStringParam(params, "replyToId", { required: true });
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid: to,
      accountId,
      actionLabel: "reply",
    });
    const chatJid = toWhatsappJid(resolved.to);
    const cached = lookupInboundMessageMetaForTarget(resolved.accountId, chatJid, replyToId);
    const result = await whatsAppActionRuntime.sendMessageWhatsApp(resolved.to, text, {
      verbose: false,
      cfg,
      accountId: resolved.accountId,
      mediaUrl: readStringParam(params, "mediaUrl") ?? undefined,
      quotedMessageKey: {
        id: replyToId,
        remoteJid: cached?.remoteJid ?? chatJid,
        fromMe:
          typeof params.quotedFromMe === "boolean"
            ? params.quotedFromMe
            : (cached?.fromMe ?? false),
        participant: readStringParam(params, "quotedParticipant") ?? cached?.participant,
        messageText: cached?.body,
      },
    });
    return jsonResult({ ok: true, messageId: result.messageId, repliedTo: replyToId });
  }

  if (action === "renameGroup" || action === "setGroupIcon" || action === "leaveGroup") {
    const accountId = readStringParam(params, "accountId");
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid: groupJid,
      accountId,
      actionLabel: action,
    });
    if (!resolved.to.endsWith("@g.us")) {
      throw new Error(`WhatsApp ${action} needs a group JID (…@g.us), got "${groupJid}".`);
    }
    await whatsAppActionRuntime.updateGroupWhatsApp(resolved.to, readGroupChange(action, params), {
      accountId: resolved.accountId,
      cfg,
    });
    return jsonResult({ ok: true, action, groupJid: resolved.to });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
