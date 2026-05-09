/**
 * FORK 2026-05-04: WhatsApp recent-thread snippet for inbound envelope.
 *
 * Pulls the last ~6 messages in the same chat (excluding the current inbound)
 * and inlines them into the agent envelope. Without this, "did the user already
 * say X about this earlier?" requires the agent to grep the live history DB
 * mid-turn, which is slow and frequently skipped. Six lines of in-thread
 * context catches the common back-reference pattern at near-zero cost.
 *
 * Read-only query against `~/.openclaw/data/whatsapp-history.db` via the
 * shared `getDb()` singleton in `history/db.ts`. Try/catch wraps everything;
 * any failure (DB locked, missing, schema drift) returns null and the agent
 * falls back to the persona hint alone.
 */
import type Database from "better-sqlite3";
import { getDb } from "../../history/db.js";

const RECENT_LIMIT = 6;
const MAX_LINE_CHARS = 220;
const MAX_BLOCK_CHARS = 1400;

type Row = {
  timestamp: number;
  from_me: number;
  sender_name: string | null;
  sender_pushname: string | null;
  text_content: string | null;
  caption: string | null;
};

let stmtCache: { db: Database.Database; stmt: Database.Statement<unknown[], Row> } | null = null;

function getStmt(): Database.Statement<unknown[], Row> | null {
  try {
    const db = getDb();
    if (stmtCache?.db === db) {
      return stmtCache.stmt;
    }
    // chat_jid match is loose: callers may pass either the full JID
    // (`34600000000@s.whatsapp.net`) or the bare E.164 (`+34600000000`).
    // Substring match catches both — and group JIDs don't share digits with
    // any DM, so cross-contamination is impossible in practice.
    const stmt = db.prepare<unknown[], Row>(
      `SELECT timestamp, from_me, sender_name, sender_pushname, text_content, caption
       FROM messages
       WHERE (chat_jid = ? OR chat_jid LIKE ?)
         AND timestamp < ?
         AND (text_content IS NOT NULL OR caption IS NOT NULL)
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    stmtCache = { db, stmt };
    return stmt;
  } catch {
    return null;
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatRow(r: Row, ownerLabel: string): string {
  const ts = new Date(r.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ");
  const who = r.from_me
    ? ownerLabel
    : (r.sender_name || r.sender_pushname || "them").trim() || "them";
  const body = (r.text_content || r.caption || "").replace(/\s+/g, " ").trim();
  return clip(`[${ts}] ${who}: ${body}`, MAX_LINE_CHARS);
}

export type RecentThreadResult = {
  /** Rendered `[recent-thread]…[/recent-thread]` block, oldest-first. */
  block: string;
  /** Unix seconds of the oldest message included in `block`. Useful to feed
   *  the `whatsapp_history` tool's `until` parameter for further read-back. */
  oldestUnixSec: number;
};

/**
 * Build a compact recent-thread block for the agent envelope. Returns null
 * when the DB is unavailable or there are no prior messages in this chat.
 *
 * 2026-05-09: returns `{block, oldestUnixSec}` so the caller can advertise the
 * exact `until` cursor to the agent's escalation hint (read older messages via
 * the `whatsapp_history` tool). String-only callers (legacy tests) can still
 * read `result?.block`.
 */
export function prefetchRecentThread(params: {
  chatJid: string;
  beforeTimestamp?: number;
  ownerLabel?: string;
}): RecentThreadResult | null {
  const stmt = getStmt();
  if (!stmt) return null;

  const before = params.beforeTimestamp
    ? Math.floor(params.beforeTimestamp / 1000)
    : Math.floor(Date.now() / 1000) + 1;
  const ownerLabel = params.ownerLabel ?? "Owner";

  const bareJid = params.chatJid.replace(/^\+/, "").replace(/@.*$/, "");
  const likePattern = `%${bareJid}%`;

  let rows: Row[];
  try {
    rows = stmt.all(params.chatJid, likePattern, before, RECENT_LIMIT) as Row[];
  } catch {
    return null;
  }
  if (!rows.length) return null;

  // DB returns newest-first; render oldest-first so the snippet reads forward.
  const ordered = rows.slice().reverse();
  const oldestUnixSec = ordered[0]?.timestamp ?? before;
  const lines = ordered.map((r) => formatRow(r, ownerLabel));

  let block = `[recent-thread last=${lines.length}]\n${lines.join("\n")}\n[/recent-thread]`;
  if (block.length > MAX_BLOCK_CHARS) {
    block = `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`;
  }
  return { block, oldestUnixSec };
}
