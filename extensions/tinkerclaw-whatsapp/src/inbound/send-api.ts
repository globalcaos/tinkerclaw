import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAPresence,
} from "@whiskeysockets/baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
// FORK 2026-05-04: shared persona-prefix helper (used by both the explicit
// send path here and the auto-reply path in deliver-reply.ts).
import { applyOutboundPrefix } from "../outbound-prefix.js";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import { toWhatsappJid } from "../text-runtime.js";
// FORK 2026-05-01: trackSentMessageId is called at line 98 below but the
// import was missing — same regression class as the setGroupMetadataFetcher
// import gap. Surfaced once the whatsmeow outbound path actually reached the
// echo-tracking step.
import { trackSentMessageId } from "./sent-ids.js";
import type { ActiveWebSendOptions } from "./types.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? ((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

// FORK 2026-05-04: applyOutboundPrefix moved to ../outbound-prefix.ts as a
// shared helper used by both the explicit-send path (this file) and the
// auto-reply path (deliver-reply.ts).

export function createWebSendApi(params: {
  sock: {
    sendMessage: (
      jid: string,
      content: AnyMessageContent,
      options?: MiscMessageGenerationOptions,
    ) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    presenceSubscribe: (jid: string) => Promise<void>;
  };
  defaultAccountId: string;
  // FORK 2026-05-02: programmatic outbound prefix resolver. Returns the
  // configured prefix (per-account → channel → global) for the given account,
  // or undefined to skip. Optional for backward compat with the existing
  // send-api.test.ts harness — when omitted, no prefix is applied.
  resolveOutboundPrefix?: (accountId: string) => string | undefined;
}) {
  const prefixFor = (accountId: string): string | undefined =>
    params.resolveOutboundPrefix?.(accountId);
  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      // FORK 2026-05-02: apply the persona prefix to the text body BEFORE
      // building the payload so it covers caption-bearing media too. Audio
      // (no caption) gets the prefix on the trailing text payload below.
      const decoratedText = applyOutboundPrefix(text, prefixFor(accountId));
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: decoratedText || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: decoratedText || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: decoratedText || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text: decoratedText };
      }
      const quotedOpts = buildQuotedMessageOptions({
        messageId: sendOptions?.quotedMessageKey?.id,
        remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
        fromMe: sendOptions?.quotedMessageKey?.fromMe,
        participant: sendOptions?.quotedMessageKey?.participant,
        messageText: sendOptions?.quotedMessageKey?.messageText,
      });
      const result = quotedOpts
        ? await params.sock.sendMessage(jid, payload, quotedOpts)
        : await params.sock.sendMessage(jid, payload);
      if (mediaBuffer && mediaType?.startsWith("audio/") && text.trim()) {
        // FORK 2026-05-02: audio-with-trailing-text path also gets the prefix.
        const textPayload: AnyMessageContent = { text: decoratedText };
        if (quotedOpts) {
          await params.sock.sendMessage(jid, textPayload, quotedOpts);
        } else {
          await params.sock.sendMessage(jid, textPayload);
        }
      }
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      if (messageId !== "unknown") {
        trackSentMessageId(messageId);
      }
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      // FORK 2026-05-02: poll question gets the prefix (it's text the
      // recipient sees as the prompt). Options stay untouched.
      const decoratedQuestion = applyOutboundPrefix(
        poll.question,
        prefixFor(params.defaultAccountId),
      );
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: decoratedQuestion,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      // WhatsApp requires presence subscription before composing works in groups.
      // Without this, sendPresenceUpdate("composing") silently fails for group JIDs.
      if (jid.endsWith("@g.us")) {
        try {
          await params.sock.presenceSubscribe(jid);
        } catch {
          // Non-fatal: composing may still work in some cases
        }
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
