/**
 * DM Backfill Script — connects to WhatsApp via whatsmeow-node
 * using stored credentials and requests history sync for stale DM chats.
 *
 * Usage: npx tsx scripts/dm-backfill.mts
 */

import { homedir } from "node:os";
import path from "node:path";
import { createClient } from "@whatsmeow-node/whatsmeow-node";
import Database from "better-sqlite3";

const STORE_PATH = path.join(homedir(), ".openclaw/credentials/whatsapp/default/whatsmeow.db");
const HISTORY_DB_PATH = path.join(homedir(), ".openclaw/data/whatsapp-history.db");
const MAX_CHATS = 50;
const MESSAGES_PER_CHAT = 50;
const STAGGER_MS = 500;

async function main() {
  console.log("=== DM Backfill via whatsmeow-node ===\n");

  // 1. Get stale DM chats from history DB
  const histDb = new Database(HISTORY_DB_PATH, { readonly: true });
  const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h ago
  const staleChats = histDb
    .prepare(`
    SELECT chat_jid as chat, MAX(timestamp) as lastTs, COUNT(*) as msgCount,
           (SELECT id FROM messages m2 WHERE m2.chat_jid = m.chat_jid ORDER BY timestamp DESC LIMIT 1) as lastId,
           (SELECT COALESCE(sender_jid, '') FROM messages m3 WHERE m3.chat_jid = m.chat_jid ORDER BY timestamp DESC LIMIT 1) as lastSender
    FROM messages m
    WHERE chat_jid NOT LIKE '%@g.us'
      AND chat_jid != 'status@broadcast'
      AND chat_jid NOT LIKE '%@broadcast'
    GROUP BY chat_jid
    HAVING MAX(timestamp) < ?
    ORDER BY MAX(timestamp) DESC
    LIMIT ?
  `)
    .all(cutoff, MAX_CHATS) as Array<{
    chat: string;
    lastTs: number;
    msgCount: number;
    lastId: string;
    lastSender: string;
  }>;
  histDb.close();

  console.log(`Found ${staleChats.length} stale DM chats\n`);
  if (staleChats.length === 0) {
    console.log("Nothing to backfill!");
    process.exit(0);
  }

  for (const c of staleChats.slice(0, 10)) {
    const ageH = ((Date.now() / 1000 - c.lastTs) / 3600).toFixed(0);
    console.log(`  ${c.chat}: ${c.msgCount} msgs, ${ageH}h stale, lastId=${c.lastId.slice(0, 16)}`);
  }
  if (staleChats.length > 10) {
    console.log(`  ... and ${staleChats.length - 10} more`);
  }
  console.log();

  // 2. Create whatsmeow client with stored credentials
  console.log("Connecting to WhatsApp (stored credentials)...");
  const client = createClient({ store: STORE_PATH });

  let connectedJid = "";
  let messageCount = 0;
  let historySyncCount = 0;

  client.on("connected", ({ jid }) => {
    connectedJid = jid;
    console.log(`✅ Connected as ${jid}\n`);
  });

  client.on("message", ({ info, message }) => {
    messageCount++;
    const text =
      (message as Record<string, unknown>).conversation ||
      (message as Record<string, unknown> & { extendedTextMessage?: { text?: string } })
        .extendedTextMessage?.text ||
      `[${Object.keys(message)[0]}]`;
    const preview = typeof text === "string" ? text.slice(0, 60) : "[media]";
    if (messageCount <= 20 || messageCount % 50 === 0) {
      console.log(`  📩 [${info.chat}] ${info.isFromMe ? "→" : "←"} ${preview}`);
    }
  });

  client.on("history_sync", ({ type }) => {
    historySyncCount++;
    console.log(`  📜 history_sync event: type=${type} (total: ${historySyncCount})`);
  });

  client.on("error", (err) => {
    console.error("❌ Client error:", err);
  });

  await client.init();
  await client.connect();

  const connected = await client.waitForConnection(30_000);
  if (!connected) {
    console.error("❌ Failed to connect within 30s");
    process.exit(1);
  }

  // Wait a moment for connection to stabilize
  await new Promise((r) => setTimeout(r, 3000));

  // 3. Request history sync for each stale DM
  console.log(`\nSending ${staleChats.length} history sync requests (${STAGGER_MS}ms apart)...\n`);

  let sent = 0;
  let failed = 0;
  let nullResponse = 0;

  for (const chat of staleChats) {
    const ageH = ((Date.now() / 1000 - chat.lastTs) / 3600).toFixed(0);
    try {
      const historyMsg = await client.buildHistorySyncRequest(
        {
          chat: chat.chat,
          sender: chat.lastSender || connectedJid,
          id: chat.lastId,
          timestamp: Math.floor(Date.now() / 1000),
        },
        MESSAGES_PER_CHAT,
      );

      if (historyMsg) {
        await client.sendPeerMessage(historyMsg as Record<string, unknown>);
        sent++;
        console.log(`  ✓ [${sent}/${staleChats.length}] ${chat.chat} (${ageH}h stale)`);
      } else {
        nullResponse++;
        console.log(`  ⚠ [${chat.chat}] buildHistorySyncRequest returned null`);
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ [${chat.chat}] ${String(err).slice(0, 80)}`);
    }

    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }

  console.log(`\n=== Backfill Requests Complete ===`);
  console.log(`  Sent: ${sent}, Null: ${nullResponse}, Failed: ${failed}`);
  console.log(`  Messages received so far: ${messageCount}`);
  console.log(`  History sync events: ${historySyncCount}`);

  // 4. Wait for responses to arrive
  console.log(`\nWaiting 30s for history sync responses...\n`);
  const startMsgs = messageCount;
  await new Promise((r) => setTimeout(r, 30_000));

  console.log(`\n=== Final Results ===`);
  console.log(`  New messages received: ${messageCount - startMsgs}`);
  console.log(`  Total messages received: ${messageCount}`);
  console.log(`  History sync events: ${historySyncCount}`);

  await client.disconnect();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
