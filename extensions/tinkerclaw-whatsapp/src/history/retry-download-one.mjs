/**
 * One-shot: retrieve a single expired-media document via the LIVE whatsmeow
 * session (media-retry round-trip), then write the decrypted file out.
 *
 * Standalone — connects its own short-lived whatsmeow client to the SAME
 * store, does downloadAny() (Go-side whatsmeow may auto-retry expired media),
 * and falls back to sendMediaRetryReceipt + downloadMediaWithPath.
 *
 * Usage: node retry-download-one.mjs <messageId> <outPath>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@whatsmeow-node/whatsmeow-node";
import Database from "better-sqlite3";

// All paths resolve against OPENCLAW_HOME (default ~/.openclaw). Override
// individual paths via OPENCLAW_HISTORY_DB / OPENCLAW_WHATSMEOW_STORE if
// the local install layout differs.
const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
const DB =
  process.env.OPENCLAW_HISTORY_DB ?? path.join(OPENCLAW_HOME, "data", "whatsapp-history.db");
const STORE_PATH =
  process.env.OPENCLAW_WHATSMEOW_STORE ??
  path.join(OPENCLAW_HOME, "credentials", "whatsapp", "default", "whatsmeow.db");
const STORE = `file:${STORE_PATH}`;
const [, , MSG_ID, OUT] = process.argv;

const b64ToBytes = (s) => Array.from(Buffer.from(s, "base64"));

function loadMsg(id) {
  const db = new Database(DB, { readonly: true });
  const row = db
    .prepare("SELECT chat_jid,sender_jid,from_me,timestamp,raw_json FROM messages WHERE id=?")
    .get(id);
  db.close();
  if (!row) throw new Error("message not found: " + id);
  const j = JSON.parse(row.raw_json);
  return { row, message: j.message, dm: j.message.documentMessage };
}

async function main() {
  const { row, message, dm } = loadMsg(MSG_ID);
  console.log(`[retry] ${MSG_ID} doc="${dm.fileName}" len=${dm.fileLength}`);

  const client = createClient({ store: STORE });
  let done = false;
  for (const ev of ["error", "disconnected", "logged_out", "stream_error"]) {
    client.on(ev, (d) => console.log(`[wm:${ev}]`, JSON.stringify(d ?? {}).slice(0, 200)));
  }

  const { jid } = await client.init();
  if (!jid) throw new Error("store not paired");
  console.log(`[retry] paired as ${jid}; connecting...`);
  await client.connect();
  await client.waitForConnection(45_000);
  console.log("[retry] connected");

  const mediaKey = b64ToBytes(dm.mediaKey);
  // Minimal, clean waE2E.Message proto JSON — only fields whatsmeow's
  // protojson parser accepts (raw_json carried Baileys-shaped siblings that
  // broke the parse). bytes fields stay base64 strings (protojson decodes).
  // whatsmeow protojson uses Go-style acronym caps: URL / SHA256.
  const protoMsg = {
    documentMessage: {
      URL: dm.url,
      directPath: dm.directPath,
      mediaKey: dm.mediaKey,
      fileSHA256: dm.fileSha256,
      fileEncSHA256: dm.fileEncSha256,
      fileLength: Number(dm.fileLength),
      mimetype: dm.mimetype,
      fileName: dm.fileName,
      title: dm.title,
      mediaKeyTimestamp: Number(dm.mediaKeyTimestamp ?? row.timestamp),
    },
  };

  const info = {
    chat: row.chat_jid,
    sender: row.from_me ? jid : row.sender_jid || row.chat_jid,
    id: MSG_ID,
    timestamp: row.timestamp,
  };

  // Attempt 1: downloadAny with a clean proto message (highest-level Go
  // helper — most likely to wrap the media-retry round-trip internally).
  try {
    const p = await client.downloadAny(protoMsg);
    fs.copyFileSync(p, OUT);
    console.log(`[retry] OK via downloadAny -> ${OUT} (${fs.statSync(OUT).size} bytes)`);
    done = true;
  } catch (e) {
    console.log(`[retry] downloadAny failed: ${String(e).slice(0, 220)}`);
  }

  // Attempt 2: send media-retry receipt, then re-try downloadAny — WhatsApp
  // re-uploads and whatsmeow should resolve the refreshed direct path.
  if (!done) {
    console.log("[retry] sending media-retry receipt...");
    try {
      await client.sendMediaRetryReceipt(info, mediaKey);
    } catch (e) {
      console.log("[retry] receipt err:", String(e).slice(0, 140));
    }
    for (let i = 0; i < 10 && !done; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const p = await client.downloadAny(protoMsg);
        fs.copyFileSync(p, OUT);
        console.log(
          `[retry] OK via retry+downloadAny (attempt ${i + 1}) -> ${OUT} (${fs.statSync(OUT).size} bytes)`,
        );
        done = true;
      } catch (e) {
        console.log(`[retry] poll ${i + 1}: ${String(e).slice(0, 140)}`);
      }
    }
  }

  try {
    await client.disconnect();
  } catch {}
  try {
    client.close();
  } catch {}
  console.log(done ? "[retry] DONE" : "[retry] FAILED");
  process.exit(done ? 0 : 1);
}

main().catch((e) => {
  console.error("[retry] fatal:", e);
  process.exit(2);
});
