/**
 * WhatsApp Web Gap Filler
 *
 * Scrapes visible messages from WhatsApp Web tab via browser automation,
 * compares with the SQLite DB, and inserts missing messages.
 *
 * Usage: Called by the agent via browser tool interactions.
 * The agent must:
 *   1. Navigate to each chat (search + click)
 *   2. Call scrapeCurrentChat() JS to extract messages
 *   3. Pass the result to insertMissing() to dedupe and store
 *
 * This module handles the DB comparison and insertion.
 */

import { getDb, insertMessage, rebuildFtsIndex, type MessageRecord } from "../history/db.js";

interface ScrapedMessage {
  msgId: string;
  isFromMe: boolean;
  text: string;
  prePlain: string; // "[HH:MM AM/PM, M/D/YYYY] Sender: "
  chatJid: string;
}

interface ScrapedChat {
  chatName: string;
  chatJid: string;
  messages: ScrapedMessage[];
}

/**
 * Parse the prePlain timestamp from WhatsApp Web.
 * Format: "[HH:MM AM/PM, M/D/YYYY] Sender: "
 */
function parsePrePlainTimestamp(prePlain: string): { timestamp: number; sender: string } | null {
  const match = prePlain.match(/\[(\d+:\d+ [AP]M), (\d+\/\d+\/\d+)\] (.+?):\s*$/);
  if (!match) return null;

  const [, timeStr, dateStr, sender] = match;
  const [month, day, year] = dateStr.split("/").map(Number);
  const [hm, ampm] = timeStr.split(" ");
  let [hours, minutes] = hm.split(":").map(Number);
  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;

  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return { timestamp: Math.floor(date.getTime() / 1000), sender };
}

/**
 * Insert scraped messages that don't already exist in the DB.
 * Returns count of new messages inserted.
 */
export function insertMissing(chat: ScrapedChat): {
  inserted: number;
  skipped: number;
  errors: number;
} {
  const db = getDb();
  let inserted = 0,
    skipped = 0,
    errors = 0;

  const chatJid = chat.chatJid.replace("@c.us", "@s.whatsapp.net");

  for (const msg of chat.messages) {
    // Skip if already exists
    const exists = db.prepare("SELECT 1 FROM messages WHERE id = ?").get(msg.msgId);
    if (exists) {
      skipped++;
      continue;
    }

    const parsed = parsePrePlainTimestamp(msg.prePlain);
    if (!parsed) {
      skipped++;
      continue;
    }

    try {
      insertMessage({
        id: msg.msgId,
        chat_jid: chatJid,
        sender_jid: msg.isFromMe ? undefined : chatJid,
        sender_name: msg.isFromMe ? undefined : parsed.sender,
        from_me: msg.isFromMe,
        timestamp: parsed.timestamp,
        message_type: "text",
        text_content: msg.text || undefined,
        source: "web-scrape",
      });
      inserted++;
    } catch {
      errors++;
    }
  }

  return { inserted, skipped, errors };
}

/**
 * Process all scraped chats, insert missing messages, rebuild FTS.
 */
export function processAllScraped(chats: ScrapedChat[]): {
  totalInserted: number;
  totalSkipped: number;
  totalErrors: number;
  perChat: Array<{ chatName: string; chatJid: string; inserted: number; skipped: number }>;
} {
  let totalInserted = 0,
    totalSkipped = 0,
    totalErrors = 0;
  const perChat: Array<{ chatName: string; chatJid: string; inserted: number; skipped: number }> =
    [];

  for (const chat of chats) {
    const result = insertMissing(chat);
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
    if (result.inserted > 0) {
      perChat.push({
        chatName: chat.chatName,
        chatJid: chat.chatJid,
        inserted: result.inserted,
        skipped: result.skipped,
      });
    }
  }

  if (totalInserted > 0) {
    rebuildFtsIndex();
  }

  return { totalInserted, totalSkipped, totalErrors, perChat };
}

/**
 * JS to inject into WhatsApp Web to scrape current chat messages.
 * Returns the function source that should be evaluated in the browser.
 */
export const SCRAPE_CURRENT_CHAT_JS = `() => {
  const msgs = [];
  const rows = document.querySelectorAll('[data-id]');
  for (const row of rows) {
    const dataId = row.getAttribute('data-id');
    if (!dataId || !dataId.includes('_')) continue;
    const isFromMe = dataId.startsWith('true_');
    const parts = dataId.split('_');
    const msgId = parts[parts.length - 1];
    const chatJid = parts.length >= 3 ? parts[1] : '';
    const textEl = row.querySelector('.copyable-text [class*="selectable-text"] span')
      || row.querySelector('.copyable-text span[dir]')
      || row.querySelector('[data-pre-plain-text] span[dir]');
    const text = textEl?.innerText || '';
    const timeEl = row.querySelector('[data-pre-plain-text]');
    const prePlain = timeEl?.getAttribute('data-pre-plain-text') || '';
    if (prePlain || text) {
      msgs.push({ msgId, isFromMe, text: text.slice(0, 1000), prePlain, chatJid });
    }
  }
  return JSON.stringify(msgs);
}`;
