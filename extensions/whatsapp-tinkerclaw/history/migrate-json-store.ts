/**
 * Migrate existing JSON store to SQLite
 * Run this once to import all messages from baileys_store_multi.json
 */

import fs from "node:fs";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { insertMessages, upsertChat, upsertContact, getStats, type MessageRecord } from "./db.js";

interface JsonStoreMessage {
  key: {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
    participant?: string;
  };
  // Untyped protobuf payload — shape varies by message type
  message?: Record<string, unknown>;
  messageTimestamp?: number | { low: number; high: number };
  pushName?: string;
}

interface JsonStore {
  chats: Record<string, { id: string; name?: string; unreadCount?: number }>;
  contacts: Record<string, { id: string; name?: string; notify?: string }>;
  messages: Record<string, Record<string, JsonStoreMessage>>;
}

// Raw protobuf JSON from the Baileys store — shape is dynamic, typed access would require
// a full schema. We narrow intentionally in each branch, but use a loose alias at the boundary.
type RawMessagePayload = Record<
  string,
  Record<string, unknown> | string | number | boolean | null | undefined
>;

function extractTextFromMessage(rawMsg: Record<string, unknown> | undefined): {
  text: string | null;
  type: string;
} {
  if (!rawMsg) {
    return { text: null, type: "unknown" };
  }
  // Cast once at the boundary; each branch then checks presence before access
  const msg = rawMsg as RawMessagePayload;

  if (msg.conversation) {
    return { text: msg.conversation as string, type: "text" };
  }

  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext?.text) {
    return { text: ext.text as string, type: "text" };
  }

  const image = msg.imageMessage as Record<string, unknown> | undefined;
  if (image) {
    return { text: (image.caption as string | null) ?? null, type: "image" };
  }

  const video = msg.videoMessage as Record<string, unknown> | undefined;
  if (video) {
    return { text: (video.caption as string | null) ?? null, type: "video" };
  }

  const doc = msg.documentMessage as Record<string, unknown> | undefined;
  if (doc) {
    return { text: ((doc.caption ?? doc.fileName) as string | null) ?? null, type: "document" };
  }

  const audio = msg.audioMessage as Record<string, unknown> | undefined;
  if (audio) {
    return { text: null, type: audio.ptt ? "voice" : "audio" };
  }

  if (msg.stickerMessage) {
    return { text: null, type: "sticker" };
  }

  const loc = msg.locationMessage as Record<string, unknown> | undefined;
  if (loc) {
    return { text: (loc.name as string | null) ?? null, type: "location" };
  }

  const poll = (msg.pollCreationMessage ?? msg.pollCreationMessageV3) as
    | Record<string, unknown>
    | undefined;
  if (poll) {
    return { text: (poll.name as string | null) ?? null, type: "poll" };
  }

  const reaction = msg.reactionMessage as Record<string, unknown> | undefined;
  if (reaction) {
    return { text: (reaction.text as string | null) ?? null, type: "reaction" };
  }

  return { text: null, type: "unknown" };
}

function getTimestamp(ts: number | { low: number; high: number } | undefined): number {
  if (!ts) {
    return Math.floor(Date.now() / 1000);
  }
  if (typeof ts === "number") {
    return ts;
  }
  // Handle Long object from protobuf
  return ts.low;
}

export async function migrateJsonStore(jsonPath: string): Promise<{
  chats: number;
  contacts: number;
  messages: number;
  errors: number;
}> {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`JSON store not found: ${jsonPath}`);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const store: JsonStore = JSON.parse(raw);

  let chatCount = 0;
  let contactCount = 0;
  let messageCount = 0;
  let errorCount = 0;

  for (const [jid, contact] of Object.entries(store.contacts || {})) {
    try {
      upsertContact(jidNormalizedUser(jid), contact.name, contact.notify);
      contactCount++;
    } catch {
      errorCount++;
    }
  }

  for (const [jid, chat] of Object.entries(store.chats || {})) {
    try {
      upsertChat(jidNormalizedUser(jid), chat.name, jid.includes("@g.us"));
      chatCount++;
    } catch {
      errorCount++;
    }
  }

  // Build lookup so messages can reference their chat display name
  const chatNames: Record<string, string> = {};
  for (const [jid, chat] of Object.entries(store.chats || {})) {
    if (chat.name) {
      chatNames[jidNormalizedUser(jid)] = chat.name;
    }
  }

  const records: MessageRecord[] = [];

  for (const [chatJid, msgMap] of Object.entries(store.messages || {})) {
    const normalizedChatJid = jidNormalizedUser(chatJid);
    const chatName = chatNames[normalizedChatJid];

    for (const [msgId, msg] of Object.entries(msgMap)) {
      try {
        const { text, type } = extractTextFromMessage(msg.message);
        const timestamp = getTimestamp(msg.messageTimestamp);

        let senderJid: string | undefined;
        if (msg.key.participant) {
          senderJid = jidNormalizedUser(msg.key.participant);
        } else if (!normalizedChatJid.includes("@g.us") && !msg.key.fromMe) {
          senderJid = normalizedChatJid;
        }

        records.push({
          id: msgId,
          chat_jid: normalizedChatJid,
          chat_name: chatName,
          sender_jid: senderJid,
          sender_pushname: msg.pushName,
          from_me: msg.key.fromMe || false,
          timestamp,
          message_type: type,
          text_content: text || undefined,
          raw_json: JSON.stringify(msg),
          source: "json-migration",
        });
      } catch {
        errorCount++;
      }
    }
  }

  // Batch insert with INSERT OR IGNORE so re-runs are safe
  messageCount = insertMessages(records);

  return { chats: chatCount, contacts: contactCount, messages: messageCount, errors: errorCount };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const defaultPath =
    process.env.HOME + "/.openclaw/credentials/whatsapp/default/baileys_store_multi.json";
  const jsonPath = process.argv[2] || defaultPath;

  console.log(`Migrating from: ${jsonPath}`);

  migrateJsonStore(jsonPath)
    .then((result) => {
      console.log("\n✅ Migration complete:");
      console.log(`   Chats: ${result.chats}`);
      console.log(`   Contacts: ${result.contacts}`);
      console.log(`   Messages: ${result.messages}`);
      console.log(`   Errors: ${result.errors}`);

      const stats = getStats();
      console.log("\n📊 Database stats:");
      console.log(`   Total messages: ${stats.total_messages}`);
      console.log(`   Total chats: ${stats.total_chats}`);
      if (stats.oldest_message && stats.newest_message) {
        console.log(
          `   Date range: ${new Date(stats.oldest_message * 1000).toISOString().slice(0, 10)} → ${new Date(stats.newest_message * 1000).toISOString().slice(0, 10)}`,
        );
      }
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
