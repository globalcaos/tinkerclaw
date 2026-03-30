/**
 * Live Message Capture — whatsmeow-node variant.
 * Bridges whatsmeow-node events to the SQLite history database.
 */

import type { WhatsmeowClient } from "@whatsmeow-node/whatsmeow-node";
import { getChildLogger } from "../../../src/logging.js";
import { insertMessage, upsertChat, type MessageRecord } from "./db.js";

const logger = getChildLogger({ module: "wa-history-wm" });

/**
 * Extract text from a whatsmeow-node message payload.
 */
function extractText(msg: Record<string, unknown>): { text: string | null; type: string } {
  if (typeof msg.conversation === "string") {
    return { text: msg.conversation, type: "text" };
  }

  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string") {
    return { text: ext.text, type: "text" };
  }

  if (msg.imageMessage) {
    const im = msg.imageMessage as Record<string, unknown>;
    return { text: (im.caption as string) || null, type: "image" };
  }
  if (msg.videoMessage) {
    const vm = msg.videoMessage as Record<string, unknown>;
    return { text: (vm.caption as string) || null, type: "video" };
  }
  if (msg.documentMessage) {
    const dm = msg.documentMessage as Record<string, unknown>;
    return { text: (dm.caption as string) || (dm.fileName as string) || null, type: "document" };
  }
  if (msg.audioMessage) {
    const am = msg.audioMessage as Record<string, unknown>;
    return { text: null, type: am.ptt ? "voice" : "audio" };
  }
  if (msg.stickerMessage) {
    return { text: null, type: "sticker" };
  }
  if (msg.locationMessage) {
    const lm = msg.locationMessage as Record<string, unknown>;
    return {
      text: (lm.name as string) || `${lm.degreesLatitude},${lm.degreesLongitude}`,
      type: "location",
    };
  }
  if (msg.reactionMessage) {
    const rm = msg.reactionMessage as Record<string, unknown>;
    return { text: (rm.text as string) || null, type: "reaction" };
  }
  if (msg.contactMessage) {
    const cm = msg.contactMessage as Record<string, unknown>;
    return { text: (cm.displayName as string) || null, type: "contact" };
  }
  if (msg.protocolMessage) {
    return { text: null, type: "protocol" };
  }

  return { text: null, type: "unknown" };
}

/**
 * Extract quoted message info from contextInfo.
 */
function extractQuotedInfo(msg: Record<string, unknown>): {
  quotedId: string | null;
  quotedText: string | null;
} {
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  const ctx = ext?.contextInfo as Record<string, unknown> | undefined;
  if (!ctx?.quotedMessage) {
    return { quotedId: null, quotedText: null };
  }

  const quotedId = (ctx.stanzaId as string) || null;
  const qm = ctx.quotedMessage as Record<string, unknown>;
  let quotedText: string | null = null;
  if (typeof qm.conversation === "string") {
    quotedText = qm.conversation;
  } else if ((qm.extendedTextMessage as Record<string, unknown>)?.text) {
    quotedText = (qm.extendedTextMessage as Record<string, unknown>).text as string;
  }

  return { quotedId, quotedText };
}

// Backfill logic lives in ../backfill/index.ts
let _backfillModule: typeof import("../backfill/index.js") | null = null;

async function loadBackfill() {
  if (!_backfillModule) {
    try {
      _backfillModule = await import("../backfill/index.js");
    } catch (err) {
      logger.warn({ error: String(err) }, "whatsapp-backfill module not available");
    }
  }
  return _backfillModule;
}

/**
 * Bind whatsmeow-node client events to SQLite history capture.
 */
export function bindWmHistoryCapture(client: WhatsmeowClient): void {
  logger.info("Binding whatsmeow history capture");

  client.on("message", ({ info, message }) => {
    const { text, type } = extractText(message);
    const { quotedId, quotedText } = extractQuotedInfo(message);

    const record: MessageRecord = {
      id: info.id,
      chat_jid: info.chat,
      sender_jid: info.isFromMe ? undefined : info.sender,
      sender_pushname: info.pushName || undefined,
      from_me: info.isFromMe,
      timestamp: info.timestamp,
      message_type: type,
      text_content: text || undefined,
      quoted_id: quotedId || undefined,
      quoted_text: quotedText || undefined,
      raw_json: JSON.stringify({ info, message }),
      source: "live-wm",
    };

    // Upsert chat metadata
    upsertChat(info.chat, undefined, info.isGroup);

    try {
      insertMessage(record);
      logger.debug({ id: info.id, chat: info.chat, type }, "Message captured (wm)");
    } catch {
      // INSERT OR REPLACE handles duplicates
    }
  });

  client.on("history_sync", ({ type }) => {
    logger.info({ type }, "History sync event received (whatsmeow)");
    // whatsmeow-node delivers history_sync as a notification;
    // individual messages arrive via the "message" event after sync completes.
  });

  let connectedJid: string | null = null;

  client.on("connected", ({ jid }) => {
    logger.info({ jid }, "Connected — history capture active (wm)");
    connectedJid = jid;
    void loadBackfill().then((mod) => {
      if (!mod) return;
      mod.requestBackfill(client, jid);
      void mod.writeLastConnected();
    });
  });

  // Deferred backfill trigger: fires 8s after bind to catch the case where
  // the 'connected' event already fired before we registered the listener
  // (common during QR login → 515 restart → fresh client handoff).
  setTimeout(() => {
    if (!connectedJid) {
      logger.info("Deferred backfill check — 'connected' event not yet received, running anyway");
      // Try with empty JID — the DB query doesn't need it if lastSender is populated
      void loadBackfill().then((mod) => mod?.requestBackfill(client, ""));
    }
  }, 8000);

  // Second attempt at 60s in case the first was too early (session still stabilizing)
  setTimeout(() => {
    logger.info("Scheduled backfill check (60s post-bind)");
    void loadBackfill().then((mod) => mod?.requestBackfill(client, connectedJid ?? ""));
  }, 60_000);

  logger.info("whatsmeow history capture bound successfully");
}
