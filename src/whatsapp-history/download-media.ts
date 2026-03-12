/**
 * download-media.ts
 * Download WhatsApp media from messages stored in the whatsapp-history SQLite DB.
 *
 * Usage:
 *   bun src/whatsapp-history/download-media.ts --id <messageId> [--out <dir>]
 *   bun src/whatsapp-history/download-media.ts --list-media [--since YYYY-MM-DD] [--chat <jid>]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = path.join(os.homedir(), ".openclaw/data/whatsapp-history.db");
const DEFAULT_OUT = path.join(os.homedir(), ".openclaw/workspace/data/wa-media");

// Media message types and their Baileys mediaType string
const MEDIA_TYPES: Record<string, string> = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
  ptvMessage: "ptv",
};

// Extension fallback by mediaType
const EXT_FALLBACK: Record<string, string> = {
  image: "jpg",
  video: "mp4",
  audio: "ogg",
  document: "bin",
  sticker: "webp",
  ptv: "mp4",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb(): Database.Database {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found: ${DB_PATH}`);
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
}

function extFromMimetype(mimetype: string | null | undefined, mediaType: string): string {
  if (mimetype) {
    // e.g. "image/jpeg" → "jpeg", "audio/ogg; codecs=opus" → "ogg"
    const base = mimetype.split(";")[0]?.trim() ?? "";
    const ext = base.split("/")[1];
    if (ext) return ext;
  }
  return EXT_FALLBACK[mediaType] ?? "bin";
}

function detectMediaType(message: Record<string, unknown>): {
  mediaType: string;
  msgContent: Record<string, unknown>;
} | null {
  for (const [key, baileyType] of Object.entries(MEDIA_TYPES)) {
    if (message[key] && typeof message[key] === "object") {
      return { mediaType: baileyType, msgContent: message[key] as Record<string, unknown> };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core: download a single message by ID
// ---------------------------------------------------------------------------

async function downloadById(messageId: string, outDir: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, chat_jid, sender_name, timestamp, message_type, raw_json
       FROM messages WHERE id = ? LIMIT 1`,
    )
    .get(messageId) as
    | {
        id: string;
        chat_jid: string;
        sender_name: string | null;
        timestamp: number;
        message_type: string | null;
        raw_json: string | null;
      }
    | undefined;
  db.close();

  if (!row) {
    throw new Error(`Message not found: ${messageId}`);
  }
  if (!row.raw_json) {
    throw new Error(`Message has no raw_json: ${messageId}`);
  }

  const waMsg = JSON.parse(row.raw_json) as {
    message?: Record<string, unknown>;
    key?: { id?: string };
  };
  const innerMessage = waMsg.message;
  if (!innerMessage) {
    throw new Error("raw_json has no .message field");
  }

  const detected = detectMediaType(innerMessage);
  if (!detected) {
    throw new Error(`Message ${messageId} is not a media message (type: ${row.message_type})`);
  }

  const { mediaType, msgContent } = detected;

  // Extract download params from proto
  const mediaKey = msgContent.mediaKey as string | Buffer | null | undefined;
  const directPath = msgContent.directPath as string | null | undefined;
  const url = msgContent.url as string | null | undefined;
  const mimetype = msgContent.mimetype as string | null | undefined;
  const fileName = (msgContent as Record<string, unknown>).fileName as string | null | undefined;

  if (!mediaKey) {
    throw new Error("No mediaKey in message — cannot decrypt");
  }
  if (!directPath && !url) {
    throw new Error("No directPath or url in message — cannot download");
  }

  console.log(`Downloading ${mediaType} (${messageId})...`);

  const stream = await downloadContentFromMessage(
    {
      mediaKey: mediaKey as Buffer,
      directPath: directPath ?? undefined,
      url: url ?? undefined,
    },
    mediaType as Parameters<typeof downloadContentFromMessage>[1],
  );

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);

  // Determine output filename
  const ext = extFromMimetype(mimetype, mediaType);
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const baseName = fileName ?? `${safeId}.${ext}`;
  const outputPath = path.join(outDir, baseName);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  console.log(outputPath);
}

// ---------------------------------------------------------------------------
// List media messages
// ---------------------------------------------------------------------------

interface MediaRow {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender_name: string | null;
  timestamp: number;
  message_type: string | null;
  caption: string | null;
}

function listMedia(opts: { since?: string; chat?: string; limit?: number }): void {
  const db = getDb();

  const sinceTs = opts.since
    ? Math.floor(new Date(opts.since).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 48 * 60 * 60;

  const mediaTypes = ["image", "video", "audio", "document", "sticker", "ptt", "ptv"];
  const typePlaceholders = mediaTypes.map(() => "?").join(", ");

  const conditions: string[] = [
    `timestamp >= ?`,
    `message_type IN (${typePlaceholders})`,
    `raw_json IS NOT NULL`,
  ];
  const params: unknown[] = [sinceTs, ...mediaTypes];

  if (opts.chat) {
    conditions.push(`(chat_jid LIKE ? OR chat_name LIKE ?)`);
    params.push(`%${opts.chat}%`, `%${opts.chat}%`);
  }

  const limit = opts.limit ?? 50;
  const sql = `
    SELECT id, chat_jid, chat_name, sender_name, timestamp, message_type, caption
    FROM messages
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as MediaRow[];
  db.close();

  if (rows.length === 0) {
    console.log("No media messages found.");
    return;
  }

  console.log(`\nFound ${rows.length} media message(s):\n`);
  for (const row of rows) {
    const date = new Date(row.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
    const chat = row.chat_name ?? row.chat_jid;
    const sender = row.sender_name ?? "?";
    const caption = row.caption ? ` | "${row.caption.slice(0, 40)}"` : "";
    console.log(`  ${date}  [${row.message_type}]  ${chat} / ${sender}${caption}`);
    console.log(`    ID: ${row.id}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args["list-media"] || args["list"]) {
    listMedia({
      since: args["since"] as string | undefined,
      chat: args["chat"] as string | undefined,
      limit: args["limit"] ? parseInt(args["limit"] as string, 10) : undefined,
    });
    return;
  }

  if (args["id"]) {
    const messageId = args["id"] as string;
    const outDir = (args["out"] as string | undefined) ?? DEFAULT_OUT;
    await downloadById(messageId, outDir);
    return;
  }

  console.log(`
WhatsApp Media Downloader
Usage:
  bun src/whatsapp-history/download-media.ts --id <messageId> [--out <dir>]
  bun src/whatsapp-history/download-media.ts --list-media [--since YYYY-MM-DD] [--chat <jid>] [--limit N]

Options:
  --id <messageId>      Download media for this message ID
  --out <dir>           Output directory (default: ~/.openclaw/workspace/data/wa-media/)
  --list-media          List recent media messages (default: last 48h)
  --since YYYY-MM-DD    Filter --list-media from this date
  --chat <jid|name>     Filter --list-media by chat JID or name
  --limit N             Limit --list-media results (default: 50)
`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
