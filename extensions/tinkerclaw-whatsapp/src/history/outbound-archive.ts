/**
 * FORK 2026-10-03: the gateway's own WhatsApp sends, written to the history DB.
 *
 * live-capture.ts only sees what whatsmeow raises as a `message` event, and whatsmeow raises none
 * for what this device sends. Baileys echoed our sends through `messages.upsert`, so since the
 * 2026-03-26 switch to whatsmeow nothing the gateway said reached the archive: no send time for the
 * 15-minute edit guard after a restart, and "has the chat moved on" checks blind to our replies.
 *
 * Called from the whatsmeow adapter's sendMessage, the one point every send passes through, after
 * the send succeeded. Best-effort: a failure here warns and never reaches the send.
 */

import { getDb, insertMessages } from "./db.js";
import { extractQuotedInfo, extractText } from "./live-capture.js";

export const GATEWAY_SEND_SOURCE = "gateway-send";

export type OutboundArchiveEntry =
  | {
      kind: "message";
      id: string;
      chatJid: string;
      timestampSec: number;
      /** The whatsmeow-shaped message that went on the wire. */
      message: Record<string, unknown>;
    }
  | { kind: "edit"; id: string; text: string; atSec: number }
  | { kind: "revoke"; id: string; atSec: number };

type ArchivedRow = { message_type: string | null; raw_json: string | null };

function readOwnRow(id: string): { row: ArchivedRow; raw: Record<string, unknown> } | undefined {
  const row = getDb()
    .prepare("SELECT message_type, raw_json FROM messages WHERE id = ? AND source = ?")
    .get(id, GATEWAY_SEND_SOURCE) as ArchivedRow | undefined;
  if (!row) {
    return undefined;
  }
  return { row, raw: row.raw_json ? (JSON.parse(row.raw_json) as Record<string, unknown>) : {} };
}

function writeEntry(entry: OutboundArchiveEntry): void {
  if (entry.kind === "message") {
    const { text, type } = extractText(entry.message);
    const { quotedId, quotedText } = extractQuotedInfo(entry.message);
    // INSERT OR IGNORE: a row that already exists under this id is never rewritten.
    insertMessages([
      {
        id: entry.id,
        chat_jid: entry.chatJid,
        from_me: true,
        timestamp: entry.timestampSec,
        message_type: type,
        text_content: text || undefined,
        quoted_id: quotedId || undefined,
        quoted_text: quotedText || undefined,
        raw_json: JSON.stringify({
          info: {
            id: entry.id,
            chat: entry.chatJid,
            isFromMe: true,
            timestamp: entry.timestampSec,
          },
          message: entry.message,
        }),
        source: GATEWAY_SEND_SOURCE,
      },
    ]);
    return;
  }
  // Edits and revokes only touch rows this module wrote; anything else is left as it is.
  const own = readOwnRow(entry.id);
  if (!own) {
    return;
  }
  const db = getDb();
  if (entry.kind === "edit") {
    // The original stays in raw_json.message; each edit is appended.
    const edits = Array.isArray(own.raw.edits) ? own.raw.edits : [];
    const raw = { ...own.raw, edits: [...edits, { atSec: entry.atSec, text: entry.text }] };
    db.prepare(
      "UPDATE messages SET text_content = ?, raw_json = ? WHERE id = ? AND source = ?",
    ).run(entry.text, JSON.stringify(raw), entry.id, GATEWAY_SEND_SOURCE);
    return;
  }
  if (own.row.message_type === "revoked") {
    return;
  }
  const raw = { ...own.raw, revokedAtSec: entry.atSec, originalType: own.row.message_type };
  db.prepare(
    "UPDATE messages SET message_type = 'revoked', raw_json = ? WHERE id = ? AND source = ?",
  ).run(JSON.stringify(raw), entry.id, GATEWAY_SEND_SOURCE);
}

/** Record a send in the history DB. Never throws. */
export function archiveOutboundSend(entry: OutboundArchiveEntry): void {
  try {
    writeEntry(entry);
  } catch (err) {
    // console, not the pino child: those get filtered out of the gateway journal (live-capture.ts).
    console.warn(
      `[wa-history] could not archive ${entry.kind} ${entry.id}: ${String(err).slice(0, 200)}`,
    );
  }
}
