import { homedir } from "node:os";
import path from "node:path";
import { createClient } from "@whatsmeow-node/whatsmeow-node";
import Database from "better-sqlite3";
const store = path.join(homedir(), ".openclaw/credentials/whatsapp/default/whatsmeow.db");
const db = new Database(path.join(homedir(), ".openclaw/data/whatsapp-history.db"), {
  readonly: true,
});
const row = db
  .prepare(`SELECT chat_jid chat, MAX(timestamp) lastTs,
 (SELECT id FROM messages m2 WHERE m2.chat_jid=m.chat_jid ORDER BY timestamp DESC LIMIT 1) lastId,
 (SELECT COALESCE(sender_jid,'') FROM messages m3 WHERE m3.chat_jid=m.chat_jid ORDER BY timestamp DESC LIMIT 1) lastSender
 FROM messages m
 WHERE chat_jid NOT LIKE '%@g.us' AND chat_jid!='status@broadcast' AND chat_jid NOT LIKE '%@broadcast'
 GROUP BY chat_jid HAVING MAX(timestamp) < ? ORDER BY MAX(timestamp) DESC LIMIT 1`)
  .get(Math.floor(Date.now() / 1000) - 86400);
console.log("target", row);
const client = createClient({ store });
client.on("connected", ({ jid }) => console.log("connected", jid));
client.on("history_sync", ({ type }) => console.log("history_sync", type));
client.on("message", ({ info, message }) =>
  console.log("message", info.chat, Object.keys(message)[0]),
);
await client.init();
await client.connect();
await client.waitForConnection(30000);
const msg = await client.buildHistorySyncRequest(
  {
    chat: row.chat,
    sender: row.lastSender || "",
    id: row.lastId,
    timestamp: Math.floor(Date.now() / 1000),
  },
  10,
);
console.log("built", !!msg);
if (msg) {
  console.log(await client.sendPeerMessage(msg));
}
await new Promise((r) => setTimeout(r, 15000));
await client.disconnect();
