/**
 * How recently a WhatsApp chat was used (FORK 2026-11-12), read from the gateway's own message archive.
 *
 * Asked to send a packet to his sister, the agent took a contact labelled "Hermana" for her and sent it to a chat with
 * no earlier message in the archive; his sister's chat held five agent messages from the two days before. The archive
 * is opened read-only for one count and closed again. An unreadable archive or an id that is not a chat gives null,
 * and null holds nothing.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const FIRST_CONTACT_DAYS = 90;

/** Messages in the recipient's chat since `sinceMs`, either direction; null when unknown. */
export type ChatHistory = (recipient: string, sinceMs: number) => number | null;

/** The archive's chat id: `+34 600 00 00 09` → `34600000009@s.whatsapp.net`, an 18-digit group id → `…@g.us`. */
export function chatJid(recipient: string): string | null {
  const r = recipient.trim();
  if (/^[\w.+-]+@(?:s\.whatsapp\.net|g\.us|lid)$/.test(r)) return r;
  const digits = r.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d{6,20}$/.test(digits)) return null;
  return digits.length >= 17 && digits.startsWith("120363")
    ? `${digits}@g.us`
    : `${digits}@s.whatsapp.net`;
}

export function whatsappChatHistory(
  dbPath = join(homedir(), ".openclaw/data/whatsapp-history.db"),
): ChatHistory {
  return (recipient, sinceMs) => {
    const jid = chatJid(recipient);
    if (jid === null) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare("SELECT count(*) AS n FROM messages WHERE chat_jid = ? AND timestamp >= ?")
        .get(jid, Math.floor(sinceMs / 1000)) as { n: number } | undefined;
      return row?.n ?? null;
    } catch (err) {
      console.error("[amygdala] chat history unreadable", err);
      return null;
    } finally {
      db?.close();
    }
  };
}
