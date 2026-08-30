import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-types";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "../media.js";
import {
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
  prepareWhatsAppOutboundMedia,
  sendWhatsAppOutboundWithRetry,
} from "../outbound-media-contract.js";
// FORK 2026-05-04: shared persona-prefix helper. Auto-reply path was missing
// the icon (only the architect/CLI send path applied it). Both paths now use
// the same module so cloners can change the icon/name in one place.
import {
  applyOutboundPrefix,
  resolveDoneSeparator,
  resolveOutboundPrefix,
} from "../outbound-prefix.js";
import { buildQuotedMessageOptions, lookupInboundMessageMeta } from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { convertMarkdownTables } from "../text-runtime.js";
import { markdownToWhatsApp } from "../text-runtime.js";
import { getRuntimeConfig } from "./config.runtime.js";
import { whatsappOutboundLog } from "./loggers.js";
import { stripHtmlRenderBlocks } from "./strip-html-render.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}) {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const replyStarted = Date.now();
  // FORK 2026-05-03: dichotomic marker — confirm we entered deliverWebReply
  // and check msg.reply existence.
  console.log(
    `[DELIVERY-DICHOTOMY] deliverWebReply entry: msg.from=${msg.from} chatType=${msg.chatType} hasMsgReply=${typeof msg.reply === "function"} textLen=${(replyResult.text ?? "").length}`,
  );
  if (isReasoningReplyPayload(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
    console.log(`[DELIVERY-DICHOTOMY] deliverWebReply: suppressed reasoning`);
    return;
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const normalizedReply = normalizeWhatsAppOutboundPayload(replyResult, {
    normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
  });
  // FORK 2026-05-04: prepend persona prefix BEFORE markdown conversion +
  // chunking so the prefix counts toward chunk-size budget and survives the
  // markdown→WA conversion. Idempotent — already-prefixed text stays as-is.
  // The prefix is read fresh from runtime config (per-account → channel →
  // global → DEFAULT_OUTBOUND_PREFIX) so config edits land without restart.
  const personaPrefix = resolveOutboundPrefix(getRuntimeConfig(), msg.accountId);
  const decoratedText = applyOutboundPrefix(normalizedReply.text, personaPrefix);
  // FORK 2026-08-30: ```html-render is a Tinker-chat-only fence — on WhatsApp it
  // arrives as raw tags. Convert it to plain text BEFORE the markdown→WA pass so
  // the card's words survive but no markup ever ships.
  const renderSafeText = stripHtmlRenderBlocks(decoratedText);
  const convertedText = markdownToWhatsApp(convertMarkdownTables(renderSafeText, tableMode));
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = normalizedReply.mediaUrls ?? [];

  const getQuote = () => {
    if (!replyResult.replyToId) {
      return undefined;
    }
    // Use replyToId (not msg.id) so batched payloads quote the correct
    // per-message target.  Look up cached metadata for the specific
    // message being quoted — msg.body may be a combined batch body.
    const cached = lookupInboundMessageMeta(msg.accountId, msg.chatId, replyResult.replyToId);
    return buildQuotedMessageOptions({
      messageId: replyResult.replyToId,
      remoteJid: msg.chatId,
      fromMe: cached?.fromMe ?? false,
      participant: cached?.participant ?? (msg.chatType === "group" ? msg.senderJid : undefined),
      messageText: cached?.body ?? "",
    });
  };

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string, maxAttempts = 3) => {
    return await sendWhatsAppOutboundWithRetry({
      send: fn,
      maxAttempts,
      onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`,
        );
      },
    });
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    console.log(
      `[DELIVERY-DICHOTOMY] deliverWebReply: about to send ${totalChunks} text chunk(s) to ${msg.from}`,
    );
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuote();
      console.log(
        `[DELIVERY-DICHOTOMY] deliverWebReply: chunk ${index + 1}/${totalChunks} preview=${JSON.stringify(chunk.slice(0, 60))}`,
      );
      try {
        await sendWithRetry(() => msg.reply(chunk, quote), "text");
        console.log(
          `[DELIVERY-DICHOTOMY] deliverWebReply: chunk ${index + 1}/${totalChunks} sendWithRetry RESOLVED ok in ${Date.now() - chunkStarted}ms`,
        );
      } catch (err) {
        console.log(
          `[DELIVERY-DICHOTOMY] deliverWebReply: chunk ${index + 1}/${totalChunks} sendWithRetry THREW: ${String(err).slice(0, 240)}`,
        );
        throw err;
      }
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: elide(replyResult.text, 240),
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    // FORK 2026-05-04: send the done-separator (default ⚡) as a SEPARATE
    // plain text message right after the last reply chunk. Bypasses the
    // persona-prefix pipeline (we call msg.reply directly with the raw
    // separator) so the wire payload is just the bare emoji — visual marker
    // that the turn is over. Configurable: set
    // `channels.whatsapp.doneSeparator: ""` to disable, or to any other
    // string to replace the default.
    const doneSeparator = resolveDoneSeparator(getRuntimeConfig(), msg.accountId);
    if (doneSeparator) {
      try {
        await sendWithRetry(() => msg.reply(doneSeparator), "done-separator");
        console.log(
          `[DELIVERY-DICHOTOMY] deliverWebReply: done-separator ${JSON.stringify(doneSeparator)} sent to ${msg.from}`,
        );
      } catch (err) {
        console.log(
          `[DELIVERY-DICHOTOMY] deliverWebReply: done-separator send failed: ${String(err).slice(0, 200)}`,
        );
        // Non-fatal: the main reply already landed.
      }
    }
    return;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await prepareWhatsAppOutboundMedia(
        await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        }),
        mediaUrl,
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      if (media.kind === "image") {
        const quote = getQuote();
        await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                image: media.buffer,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:image",
        );
      } else if (media.kind === "audio") {
        const quote = getQuote();
        await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                audio: media.buffer,
                ptt: true,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:audio",
        );
        if (caption) {
          await sendWithRetry(() => msg.reply(caption, quote), "media:audio-text");
        }
      } else if (media.kind === "video") {
        const quote = getQuote();
        await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                video: media.buffer,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:video",
        );
      } else {
        const quote = getQuote();
        await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                document: media.buffer,
                fileName: media.fileName,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:document",
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(error)}`);
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      if (!isFirst) {
        return;
      }
      const warning = "⚠️ Media failed.";
      const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
      await msg.reply(fallbackText, getQuote());
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    await msg.reply(chunk, getQuote());
  }
}
