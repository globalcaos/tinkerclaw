/**
 * FORK 2026-05-11 — WhatsApp probes for the J15 RSC discipline.
 *
 *   wa.lastOutbound({chat, n}) — the last N outbound rows for a chat
 *                                from the whatsapp-history.db SQLite
 *                                store. Catches the canonical "Jarvis's
 *                                reply never actually arrived" class of
 *                                bug: the agent transcript shows the
 *                                model produced text, but no WA outbound
 *                                row exists for the relevant chat.
 *
 *   wa.recentOutbound({n})     — the last N outbound rows across ALL
 *                                chats. Useful for the "did WA delivery
 *                                hang globally" investigation.
 *
 * Scope: READ_SCOPE. Body content is sensitive (the user's WhatsApp
 * messages), but no credential data flows through these probes. Output
 * is truncated to ~600 chars per body row to keep the probe bounded.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

const DB_PATHS = [
  path.resolve(os.homedir(), ".openclaw/data/whatsapp-history.db"),
  path.resolve(os.homedir(), ".openclaw/workspace/data/whatsapp-history.db"),
  path.resolve(os.homedir(), ".openclaw/workspace/whatsapp-history.db"),
];

const MAX_TEXT_LEN = 600;
const MAX_N = 50;

function resolveDb(): string | null {
  for (const p of DB_PATHS) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // try next
    }
  }
  return null;
}

type Row = {
  id: string | null;
  chat_jid: string | null;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number | null;
  timestamp: number | null;
  text_content: string | null;
  message_type: string | null;
  source: string | null;
};

function truncate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= MAX_TEXT_LEN) return value;
  return value.slice(0, MAX_TEXT_LEN) + "…[truncated]";
}

function maskJid(jid: string | null): string | null {
  if (!jid) return jid;
  // Keep the host suffix (after `@`) and mask the numeric prefix beyond
  // the first 4 chars. e.g. "34600000000@s.whatsapp.net" → "3465…@s.whatsapp.net".
  const atIndex = jid.indexOf("@");
  if (atIndex < 0) return jid;
  const left = jid.slice(0, atIndex);
  const right = jid.slice(atIndex);
  if (left.length <= 4) return jid;
  return `${left.slice(0, 4)}…${right}`;
}

function projectRow(row: Row, opts: { maskJids: boolean }): Record<string, unknown> {
  return {
    id: row.id,
    timestamp: row.timestamp,
    fromMe: row.from_me === 1,
    chat: opts.maskJids ? maskJid(row.chat_jid) : row.chat_jid,
    sender: opts.maskJids ? maskJid(row.sender_jid) : row.sender_jid,
    senderName: row.sender_name,
    type: row.message_type,
    source: row.source,
    text: truncate(row.text_content),
  };
}

async function loadBetterSqlite3(): Promise<typeof import("better-sqlite3").default | null> {
  try {
    const mod = await import("better-sqlite3");
    return mod.default;
  } catch {
    return null;
  }
}

export const waProbesHandlers: GatewayRequestHandlers = {
  "wa.lastOutbound": async ({ params, respond }) => {
    const p = (params ?? {}) as { chat?: unknown; n?: unknown; maskJids?: unknown };
    const chat = typeof p.chat === "string" ? p.chat.trim() : "";
    if (!chat) {
      respond(true, { error: "chat (chat_jid) is required" }, undefined);
      return;
    }
    const n = typeof p.n === "number" && p.n > 0 ? Math.min(Math.floor(p.n), MAX_N) : 10;
    const maskJids = p.maskJids !== false; // default true — don't expose raw JIDs
    const dbPath = resolveDb();
    if (!dbPath) {
      respond(
        true,
        { error: "whatsapp-history.db not found at any expected path", searched: DB_PATHS },
        undefined,
      );
      return;
    }
    const Database = await loadBetterSqlite3();
    if (!Database) {
      respond(true, { error: "better-sqlite3 not loadable in this process" }, undefined);
      return;
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, chat_jid, sender_jid, sender_name, from_me, timestamp, text_content,
                  message_type, source
             FROM messages
            WHERE chat_jid = ? AND from_me = 1
            ORDER BY timestamp DESC
            LIMIT ?`,
        )
        .all(chat, n) as Row[];
      respond(
        true,
        {
          dbPath,
          chat,
          maskJids,
          count: rows.length,
          rows: rows.map((row) => projectRow(row, { maskJids })),
        },
        undefined,
      );
    } finally {
      db.close();
    }
  },

  "wa.recentOutbound": async ({ params, respond }) => {
    const p = (params ?? {}) as { n?: unknown; maskJids?: unknown };
    const n = typeof p.n === "number" && p.n > 0 ? Math.min(Math.floor(p.n), MAX_N) : 10;
    const maskJids = p.maskJids !== false;
    const dbPath = resolveDb();
    if (!dbPath) {
      respond(
        true,
        { error: "whatsapp-history.db not found at any expected path", searched: DB_PATHS },
        undefined,
      );
      return;
    }
    const Database = await loadBetterSqlite3();
    if (!Database) {
      respond(true, { error: "better-sqlite3 not loadable in this process" }, undefined);
      return;
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, chat_jid, sender_jid, sender_name, from_me, timestamp, text_content,
                  message_type, source
             FROM messages
            WHERE from_me = 1
            ORDER BY timestamp DESC
            LIMIT ?`,
        )
        .all(n) as Row[];
      respond(
        true,
        {
          dbPath,
          maskJids,
          count: rows.length,
          rows: rows.map((row) => projectRow(row, { maskJids })),
        },
        undefined,
      );
    } finally {
      db.close();
    }
  },
};
