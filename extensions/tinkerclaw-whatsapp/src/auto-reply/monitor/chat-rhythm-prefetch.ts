/**
 * FORK 2026-05-09: chat-rhythm prefetch — concrete length stats for the agent's
 * reply targeting.
 *
 * Reads the last N messages of the current chat from `whatsapp-history.db`,
 * excludes Jarvis's own outbound (anything starting with the persona icon `🤖`
 * or the done-separator `⚡`), and returns a small summary block:
 *
 *     [chat-rhythm last=20]
 *     Median: 14 words. P90: 42 words. Sample: 18.
 *     Match this rhythm. If your reply would exceed ~3× median (≥42 words), send
 *     a 1-line summary and offer "¿quieres más?" instead of dumping the long
 *     version.
 *     [/chat-rhythm]
 *
 * The instruction lives in the block (not the persona file) on purpose — the
 * model does better with concrete numbers next to the directive than with
 * abstract "be brief" rules far away in the system prompt.
 *
 * Why bot-excluded: rhythm should anchor on the *human* conversation, not on
 * Jarvis's own past replies. If Jarvis was overly verbose yesterday, including
 * his replies in the median pulls the target up and self-justifies the
 * verbosity. Excluding bot messages forces the rhythm back toward the user.
 *
 * Read-only query against the shared `getDb()` singleton; try/catch wraps
 * everything; any failure returns null and the prelude omits the block.
 */
import type Database from "better-sqlite3";
import { getDb } from "../../history/db.js";

const RHYTHM_WINDOW = 20;
const MIN_SAMPLE = 5;

type Row = {
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
    // Excludes:
    //   - Jarvis's own outbound (text_content starts with 🤖 or ⚡ — the persona
    //     prefix and done-separator from outbound-prefix.ts).
    //   - Empty / NULL bodies (we count words; 0-word rows pollute the stat).
    // The chat_jid match mirrors thread-prefetch.ts (loose, JID or bare digits).
    const stmt = db.prepare<unknown[], Row>(
      `SELECT text_content, caption
       FROM messages
       WHERE (chat_jid = ? OR chat_jid LIKE ?)
         AND timestamp < ?
         AND (text_content IS NOT NULL OR caption IS NOT NULL)
         AND COALESCE(text_content, caption, '') != ''
         AND COALESCE(text_content, '') NOT LIKE '🤖%'
         AND COALESCE(text_content, '') NOT LIKE '⚡%'
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    stmtCache = { db, stmt };
    return stmt;
  } catch {
    return null;
  }
}

function wordCount(s: string): number {
  // Count whitespace-separated tokens. Works for Spanish/English/most
  // languages; Chinese/Japanese would need a different metric but those
  // chats are not in scope for the current deployment.
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function quantile(sorted: number[], q: number): number {
  // Standard nearest-rank percentile. sorted ASC. q in [0,1].
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))] ?? 0;
}

export type ChatRhythmResult = {
  block: string;
  median: number;
  p90: number;
  sample: number;
};

/**
 * Build a `[chat-rhythm]` block for the prelude. Returns null when the DB
 * is unavailable or there aren't enough non-bot messages to form a useful
 * stat (under MIN_SAMPLE).
 */
export function prefetchChatRhythm(params: {
  chatJid: string;
  beforeTimestamp?: number;
}): ChatRhythmResult | null {
  const stmt = getStmt();
  if (!stmt) return null;

  const before = params.beforeTimestamp
    ? Math.floor(params.beforeTimestamp / 1000)
    : Math.floor(Date.now() / 1000) + 1;
  const bareJid = params.chatJid.replace(/^\+/, "").replace(/@.*$/, "");
  const likePattern = `%${bareJid}%`;

  let rows: Row[];
  try {
    rows = stmt.all(params.chatJid, likePattern, before, RHYTHM_WINDOW) as Row[];
  } catch {
    return null;
  }
  const counts = rows
    .map((r) => wordCount(r.text_content ?? r.caption ?? ""))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (counts.length < MIN_SAMPLE) return null;

  const median = quantile(counts, 0.5);
  const p90 = quantile(counts, 0.9);
  // Threshold for the "propose, don't dump" rule. 3× median is intentionally
  // generous — most legitimate replies fit; only the wall-of-text ones trip it.
  const longThreshold = Math.max(p90, median * 3);

  const block = [
    `[chat-rhythm last=${counts.length}]`,
    `Median: ${median} words. P90: ${p90} words. Sample: ${counts.length} non-bot messages.`,
    `Target the median for normal replies. If your full answer would exceed ~${longThreshold} words,`,
    'send a 1-line summary and ask "¿quieres la versión completa?" / "want the long version?"',
    "before sending the long form. The persona scaffolding (🤖 prefix, reactions, ⚡ done-separator)",
    "is wire-level and ALWAYS ships regardless of length — don't economise on those.",
    "[/chat-rhythm]",
  ].join("\n");

  return { block, median, p90, sample: counts.length };
}
