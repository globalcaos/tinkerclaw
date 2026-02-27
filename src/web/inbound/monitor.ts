import type { AnyMessageContent, proto, WAMessage } from "@whiskeysockets/baileys";
import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { formatLocationText } from "../../channels/location.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { getChildLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { jidToE164, resolveJidToE164 } from "../../utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";
import { wasSentByBot, forgetSentMessageId } from "./sent-ids.js"; // fork: sent-id tracking
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// FORK: Watermark persistence — tracks the timestamp of the last processed message
// Stored as a plain text file alongside the Baileys auth state.
const WATERMARK_FILENAME = ".openclaw-watermark-ms";

function watermarkPath(authDir: string): string {
  return join(authDir, WATERMARK_FILENAME);
}

function readWatermarkMs(authDir: string): number {
  try {
    const raw = readFileSync(watermarkPath(authDir), "utf-8").trim();
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0; // file doesn't exist yet
  }
}

let watermarkWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWatermarkMs = 0;

/** Debounced write — avoids thrashing disk on every message. Flushes at most once per second. */
function writeWatermarkMs(authDir: string, ms: number): void {
  pendingWatermarkMs = ms;
  if (watermarkWriteTimer) {return;}
  watermarkWriteTimer = setTimeout(() => {
    watermarkWriteTimer = null;
    try {
      mkdirSync(dirname(watermarkPath(authDir)), { recursive: true });
      writeFileSync(watermarkPath(authDir), String(pendingWatermarkMs), "utf-8");
    } catch {
      // best-effort; don't crash on write failure
    }
  }, 1000);
}

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Request full history sync from WhatsApp (OPT-IN, default false). */
  syncFullHistory?: boolean;
  /** Max age (ms) for recovering messages received while offline. Append-type messages
   *  newer than this window are processed on reconnect instead of being discarded.
   *  Default: 6 hours. Set to 0 to disable offline recovery. */
  offlineRecoveryMs?: number;
  /** Callback for history sync events. */
  onHistorySync?: (data: {
    chats: number;
    contacts: number;
    messages: number;
    isLatest?: boolean;
    progress?: number | null;
    syncType?: number | null;
  }) => void;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    syncFullHistory: options.syncFullHistory,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();
  let lastSeenTimestampMs = readWatermarkMs(options.authDir);

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey =
        msg.chatType === "group"
          ? (msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      // DEBUG: Log every message received from Baileys
      const debugRemoteJid = msg.key?.remoteJid ?? "unknown";
      const debugFromMe = msg.key?.fromMe ?? false;
      inboundLogger.info(
        { remoteJid: debugRemoteJid, fromMe: debugFromMe, type: upsert.type },
        "DEBUG: Baileys message received",
      );
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const id = msg.key?.id ?? undefined;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) {
        continue;
      }
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
        continue;
      }

      const group = isJidGroup(remoteJid) === true;
      if (id) {
        // Skip messages we sent ourselves (echo prevention for media/voice notes)
        if (wasSentByBot(id)) {
          forgetSentMessageId(id);
          continue;
        }
        const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
        if (isRecentInboundMessage(dedupeKey)) {
          continue;
        }
      }
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : await resolveInboundJid(remoteJid);
      if (!from) {
        continue;
      }
      // Fix: When fromMe is true, the sender is US (selfE164), not the chat's remoteJid
      // For groups: resolve participantJid if present; fallback to selfE164 when fromMe
      // (LID participants may not resolve to E164, so fromMe fallback is essential)
      let resolvedParticipant: string | null = null;
      if (participantJid) {
        if (msg.key?.fromMe) {
          // Skip LID resolution for our own messages — we know who we are
          resolvedParticipant = selfE164;
        } else {
          resolvedParticipant = await resolveInboundJid(participantJid);
        }
      }
      const senderE164 = group
        ? resolvedParticipant ?? (msg.key?.fromMe ? selfE164 : null)
        : msg.key?.fromMe
          ? selfE164
          : from;
      if (group) {
      }

      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
      }
      const messageTimestampMs = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      // Extract message body early for access control (triggerPrefix check on outbound DMs).
      const earlyBody = extractText(msg.message ?? undefined) ?? "";

      const access = await checkInboundAccessControl({
        accountId: options.accountId,
        from,
        selfE164,
        senderE164,
        group,
        pushName: msg.pushName ?? undefined,
        isFromMe: Boolean(msg.key?.fromMe),
        messageTimestampMs,
        connectedAtMs,
        sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
        remoteJid,
        messageBody: earlyBody,
      });
      if (!access.allowed) {
        continue;
      }

      if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([{ remoteJid, id, participant, fromMe: false }]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && access.isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // Offline message recovery: "append" messages are history/catch-up delivered on
      // reconnect. Instead of discarding them all, recover messages newer than the last
      // processed message watermark. Falls back to a fixed window (default 6h) when no
      // watermark exists yet.
      if (upsert.type === "append") {
        if (messageTimestampMs == null) {
          continue; // no timestamp, can't evaluate
        }
        // Use in-memory watermark (initialized from disk at connect time)
        if (lastSeenTimestampMs > 0) {
          // Dynamic recovery: only process messages newer than our last-processed watermark
          if (messageTimestampMs <= lastSeenTimestampMs) {
            continue; // already seen (older than watermark)
          }
        } else {
          // No watermark yet (first run): recover everything Baileys delivers.
          // This lets us pick up all available messages on the initial connection.
        }
        const ageMin = Math.round((Date.now() - messageTimestampMs) / 60_000);
        inboundLogger.info(
          { from, messageTimestampMs, ageMinutes: ageMin, watermarkMs: lastSeenTimestampMs },
          "Recovering offline message (append)",
        );
      }

      // Update watermark: track the newest message we've processed
      if (messageTimestampMs != null && messageTimestampMs > lastSeenTimestampMs) {
        lastSeenTimestampMs = messageTimestampMs;
        writeWatermarkMs(options.authDir, lastSeenTimestampMs);
      }

      const location = extractLocationData(msg.message ?? undefined);
      const locationText = location ? formatLocationText(location) : undefined;
      let body = extractText(msg.message ?? undefined);
      if (locationText) {
        body = [body, locationText].filter(Boolean).join("\n").trim();
      }
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) {
          continue;
        }
      }
      const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let mediaFileName: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
        if (inboundMedia) {
          const maxMb =
            typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
              ? options.mediaMaxMb
              : 50;
          const maxBytes = maxMb * 1024 * 1024;
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
            "inbound",
            maxBytes,
            inboundMedia.fileName,
          );
          mediaPath = saved.path;
          mediaType = inboundMedia.mimetype;
          mediaFileName = inboundMedia.fileName;
        }
      } catch (err) {
        logVerbose(`Inbound media download failed: ${String(err)}`);
      }

      const chatJid = remoteJid;
      let presenceSubscribed = false;
      const sendComposing = async () => {
        try {
          // WhatsApp requires presence subscription before composing works in groups
          if (!presenceSubscribed && chatJid.endsWith("@g.us")) {
            await sock.presenceSubscribe(chatJid);
            presenceSubscribed = true;
          }
          // Ensure bot appears "available" before composing — WhatsApp may
          // not relay typing indicators from devices that appear offline.
          await sock.sendPresenceUpdate("available");
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch (err) {
          inboundLogger.warn({ chatJid, error: String(err) }, "[TYPING] Presence update failed");
        }
      };
      const reply = async (text: string) => {
        await sock.sendMessage(chatJid, { text });
      };
      const sendMedia = async (payload: AnyMessageContent) => {
        await sock.sendMessage(chatJid, payload);
      };
      const timestamp = messageTimestampMs;
      const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
      const senderName = msg.pushName ?? undefined;

      inboundLogger.info(
        { from, to: selfE164 ?? "me", body, mediaPath, mediaType, mediaFileName, timestamp },
        "inbound message",
      );
      const inboundMessage: WebInboundMessage = {
        id,
        from,
        conversationId: from,
        to: selfE164 ?? "me",
        accountId: access.resolvedAccountId,
        body,
        pushName: senderName,
        timestamp,
        chatType: group ? "group" : "direct",
        chatId: remoteJid,
        senderJid: participantJid,
        senderE164: senderE164 ?? undefined,
        senderName,
        replyToId: replyContext?.id,
        replyToBody: replyContext?.body,
        replyToSender: replyContext?.sender,
        replyToSenderJid: replyContext?.senderJid,
        replyToSenderE164: replyContext?.senderE164,
        groupSubject,
        groupParticipants,
        mentionedJids: mentionedJids ?? undefined,
        selfJid,
        selfE164,
        location: location ?? undefined,
        sendComposing,
        reply,
        sendMedia,
        mediaPath,
        mediaType,
        mediaFileName,
        isOfflineRecovery: upsert.type === "append",
      };
      try {
        const task = Promise.resolve(debouncer.enqueue(inboundMessage));
        void task.catch((err) => {
          inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
          inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      }
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);

  // History sync handler (only active when syncFullHistory is enabled)
  if (options.syncFullHistory) {
    const handleHistorySet = (data: {
      chats: Array<unknown>;
      contacts: Array<unknown>;
      messages: Array<unknown>;
      isLatest?: boolean;
      progress?: number | null;
      syncType?: number | null;
    }) => {
      const chatCount = data.chats?.length ?? 0;
      const contactCount = data.contacts?.length ?? 0;
      const messageCount = data.messages?.length ?? 0;

      inboundLogger.info(
        {
          chats: chatCount,
          contacts: contactCount,
          messages: messageCount,
          isLatest: data.isLatest,
          progress: data.progress,
          syncType: data.syncType,
        },
        "history sync received",
      );
      inboundConsoleLog.info(
        `📜 History sync: ${messageCount} messages, ${chatCount} chats, ${contactCount} contacts` +
          (data.progress != null ? ` (${Math.round(data.progress * 100)}%)` : "") +
          (data.isLatest ? " [latest]" : ""),
      );

      // Call the optional callback
      options.onHistorySync?.({
        chats: chatCount,
        contacts: contactCount,
        messages: messageCount,
        isLatest: data.isLatest,
        progress: data.progress,
        syncType: data.syncType,
      });
    };
    sock.ev.on("messaging-history.set", handleHistorySet);
  }

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === DisconnectReason.loggedOut,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid?: string) => sock.sendPresenceUpdate(presence, jid),
    },
    defaultAccountId: options.accountId,
  });

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const messagesUpsertHandler = handleMessagesUpsert as unknown as (
          ...args: unknown[]
        ) => void;
        const connectionUpdateHandler = handleConnectionUpdate as unknown as (
          ...args: unknown[]
        ) => void;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
    // FORK: expanded ActiveWebListener surface for group management + message editing
    createGroup: async (subject: string, participants: string[]) => {
      const meta = await sock.groupCreate(subject, participants);
      return { groupId: meta.id, subject: meta.subject };
    },
    editMessage: async (chatJid: string, messageId: string, newText: string, fromMe?: boolean, participant?: string) => {
      await sock.sendMessage(chatJid, { text: newText, edit: { remoteJid: chatJid, id: messageId, fromMe: fromMe ?? true, participant } as unknown as import("@whiskeysockets/baileys").WAMessageKey });
    },
    deleteMessage: async (chatJid: string, messageId: string, fromMe?: boolean, participant?: string) => {
      await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, id: messageId, fromMe: fromMe ?? true, participant } as unknown as import("@whiskeysockets/baileys").WAMessageKey });
    },
    replyMessage: async (to: string, text: string, quotedKey: import("../active-listener.js").MessageKey, mediaBuffer?: Buffer, mediaType?: string) => {
      const jid = (await import("../../utils.js")).toWhatsappJid(to);
      const content: import("@whiskeysockets/baileys").AnyMessageContent = mediaBuffer && mediaType
        ? mediaType.startsWith("image/") ? { image: mediaBuffer, caption: text || undefined, mimetype: mediaType } as any
        : mediaType.startsWith("audio/") ? { audio: mediaBuffer, ptt: true, mimetype: mediaType } as any
        : { document: mediaBuffer, caption: text || undefined, mimetype: mediaType } as any
        : { text };
      const result = await sock.sendMessage(jid, content, { quoted: quotedKey } as any);
      const mid = (result as any)?.key?.id ?? "unknown";
      return { messageId: String(mid) };
    },
    sendSticker: async (to: string, stickerBuffer: Buffer) => {
      const jid = (await import("../../utils.js")).toWhatsappJid(to);
      const result = await sock.sendMessage(jid, { sticker: stickerBuffer } as any);
      const mid = (result as any)?.key?.id ?? "unknown";
      return { messageId: String(mid) };
    },
    groupUpdateSubject: async (groupJid: string, newSubject: string) => { await sock.groupUpdateSubject(groupJid, newSubject); },
    groupUpdateDescription: async (groupJid: string, description: string) => { await sock.groupUpdateDescription(groupJid, description); },
    groupUpdateIcon: async (groupJid: string, imageBuffer: Buffer) => { await sock.updateProfilePicture(groupJid, imageBuffer); },
    groupAddParticipants: async (groupJid: string, participants: string[]) => {
      const result = await sock.groupParticipantsUpdate(groupJid, participants, "add");
      return Object.fromEntries(result.map(r => [r.jid ?? "", r.status]));
    },
    groupRemoveParticipants: async (groupJid: string, participants: string[]) => {
      const result = await sock.groupParticipantsUpdate(groupJid, participants, "remove");
      return Object.fromEntries(result.map(r => [r.jid ?? "", r.status]));
    },
    groupPromoteParticipants: async (groupJid: string, participants: string[]) => {
      const result = await sock.groupParticipantsUpdate(groupJid, participants, "promote");
      return Object.fromEntries(result.map(r => [r.jid ?? "", r.status]));
    },
    groupDemoteParticipants: async (groupJid: string, participants: string[]) => {
      const result = await sock.groupParticipantsUpdate(groupJid, participants, "demote");
      return Object.fromEntries(result.map(r => [r.jid ?? "", r.status]));
    },
    groupLeave: async (groupJid: string) => { await sock.groupLeave(groupJid); },
    groupGetInviteCode: async (groupJid: string) => (await sock.groupInviteCode(groupJid)) ?? "",
    groupRevokeInviteCode: async (groupJid: string) => (await sock.groupRevokeInvite(groupJid)) ?? "",
    groupMetadata: async (groupJid: string) => {
      const meta = await sock.groupMetadata(groupJid);
      return {
        id: meta.id,
        subject: meta.subject,
        description: meta.desc ?? undefined,
        participants: meta.participants.map(p => ({ id: p.id, admin: p.admin ?? undefined })),
      };
    },
  } as const;
}
