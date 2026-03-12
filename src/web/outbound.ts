import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { getChildLogger } from "../logging/logger.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { markdownToWhatsApp } from "../markdown/whatsapp.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "./accounts.js";
import {
  type ActiveWebSendOptions,
  type MessageKey,
  requireActiveWebListener,
} from "./active-listener.js";
import { loadWebMedia } from "./media.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg?: OpenClawConfig;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body.trimStart();
  const jid = toWhatsappJid(to);
  if (!text && !options.mediaUrl) {
    return { messageId: "", toJid: jid };
  }
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
    options.accountId,
  );
  const cfg = options.cfg ?? loadConfig();
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: resolvedAccountId ?? options.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl, {
        maxBytes: resolveWhatsAppMediaMaxBytes(account),
        localRoots: options.mediaLocalRoots,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${redactedJid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ jid: redactedJid, hasMedia: Boolean(options.mediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to: redactedTo, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid: redactedChatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid: redactedChatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo }, "failed to send poll via web session");
    throw err;
  }
}

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

export async function groupUpdateSubjectWhatsApp(
  groupJid: string,
  newSubject: string,
  options?: OutboundOptions,
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupUpdateSubject(groupJid, newSubject);
}

export async function groupUpdateDescriptionWhatsApp(
  groupJid: string,
  description: string,
  options?: OutboundOptions,
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupUpdateDescription(groupJid, description);
}

export async function groupUpdateIconWhatsApp(
  groupJid: string,
  imagePathOrBuffer: string | Buffer,
  options?: OutboundOptions,
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  let buf: Buffer;
  if (typeof imagePathOrBuffer === "string") {
    const media = await loadWebMedia(imagePathOrBuffer);
    buf = media.buffer;
  } else {
    buf = imagePathOrBuffer;
  }
  return listener.groupUpdateIcon(groupJid, buf);
}

export async function groupAddParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options?: OutboundOptions,
): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupAddParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupRemoveParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options?: OutboundOptions,
): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupRemoveParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupPromoteParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options?: OutboundOptions,
): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupPromoteParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupDemoteParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options?: OutboundOptions,
): Promise<{ [jid: string]: string }> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupDemoteParticipants(groupJid, participants.map(toWhatsappJid));
}

export async function groupLeaveWhatsApp(
  groupJid: string,
  options?: OutboundOptions,
): Promise<void> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupLeave(groupJid);
}

export async function groupGetInviteCodeWhatsApp(
  groupJid: string,
  options?: OutboundOptions,
): Promise<string> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupGetInviteCode(groupJid);
}

export async function groupRevokeInviteCodeWhatsApp(
  groupJid: string,
  options?: OutboundOptions,
): Promise<string> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupRevokeInviteCode(groupJid);
}

export async function groupGetMetadataWhatsApp(
  groupJid: string,
  options?: OutboundOptions,
): Promise<{
  id: string;
  subject: string;
  description?: string;
  participants: Array<{ id: string; admin?: string }>;
}> {
  const { listener } = requireActiveWebListener(options?.accountId);
  return listener.groupMetadata(groupJid);
}
