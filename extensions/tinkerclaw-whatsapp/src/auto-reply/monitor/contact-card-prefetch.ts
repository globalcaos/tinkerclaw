import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * FORK 2026-05-20: WhatsApp inbound contact-card prelude block.
 *
 * Until 2026-05-20 the prelude had a `[sender-profile]` block that only fired
 * when the sender had a slug in `memory/people/`. For the (very common) case
 * of "the owner's friend whose number is in his phone but not in people-profiles
 * yet", Jarvis got no name at all — only a chat JID. That triggered the
 * "I don't know who I'm talking to" DM bug.
 *
 * This prefetch reads the WhatsApp history DB directly (the same DB Baileys
 * writes to, where every contact lookup that ever resolved leaves a row) and
 * emits a `[contact-card]` block with the display name as the owner saved it,
 * his notify (pushName), phone, and — when known — the people-profile slug.
 *
 * The block ships even for unknown contacts so the downstream
 * `[unknown-contact-protocol]` block can hang off it deterministically.
 *
 * Read-only against `~/.openclaw/data/whatsapp-history.db` via the shared
 * `getDb()` singleton; try/catch returns null on any failure.
 */
import type Database from "better-sqlite3";
import { getDb } from "../../history/db.js";

const PEOPLE_DIR = path.join(os.homedir(), ".openclaw", "workspace", "memory", "people");
const ALIASES_PATH = path.join(PEOPLE_DIR, "_aliases.json");
const ALIAS_CACHE_TTL_MS = 60_000;

type Alias = {
  displayName?: string;
  phones?: string[];
  lids?: string[];
};
type AliasMap = Record<string, Alias>;
let aliasCache: { at: number; aliases: AliasMap } | null = null;

function loadAliases(): AliasMap | null {
  const now = Date.now();
  if (aliasCache && now - aliasCache.at < ALIAS_CACHE_TTL_MS) {
    return aliasCache.aliases;
  }
  try {
    const raw = fs.readFileSync(ALIASES_PATH, "utf-8");
    const aliases = JSON.parse(raw) as AliasMap;
    aliasCache = { at: now, aliases };
    return aliases;
  } catch {
    return null;
  }
}

function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function findSlug(aliases: AliasMap, e164?: string, lid?: string): string | null {
  if (e164) {
    const target = digitsOnly(e164);
    if (target.length >= 9) {
      const suffix = target.slice(-9);
      for (const [slug, a] of Object.entries(aliases)) {
        for (const phone of a.phones ?? []) {
          const pd = digitsOnly(phone);
          if (pd === target || (pd.length >= 9 && pd.endsWith(suffix))) {
            return slug;
          }
        }
      }
    }
  }
  if (lid && lid.includes("@lid")) {
    const lower = lid.toLowerCase();
    for (const [slug, a] of Object.entries(aliases)) {
      if (a.lids?.some((l) => l.toLowerCase() === lower)) {
        return slug;
      }
    }
  }
  return null;
}

type ContactRow = {
  name: string | null;
  notify: string | null;
  phone: string | null;
};
type ChatRow = {
  name: string | null;
  is_group: number;
};

let contactStmtCache: {
  db: Database.Database;
  stmt: Database.Statement<unknown[], ContactRow>;
} | null = null;
let chatStmtCache: { db: Database.Database; stmt: Database.Statement<unknown[], ChatRow> } | null =
  null;

function getContactStmt(): Database.Statement<unknown[], ContactRow> | null {
  try {
    const db = getDb();
    if (contactStmtCache?.db === db) return contactStmtCache.stmt;
    const stmt = db.prepare<unknown[], ContactRow>(
      `SELECT name, notify, phone FROM contacts WHERE jid = ? LIMIT 1`,
    );
    contactStmtCache = { db, stmt };
    return stmt;
  } catch {
    return null;
  }
}

function getChatStmt(): Database.Statement<unknown[], ChatRow> | null {
  try {
    const db = getDb();
    if (chatStmtCache?.db === db) return chatStmtCache.stmt;
    const stmt = db.prepare<unknown[], ChatRow>(
      `SELECT name, is_group FROM chats WHERE jid = ? LIMIT 1`,
    );
    chatStmtCache = { db, stmt };
    return stmt;
  } catch {
    return null;
  }
}

export type ContactCardResult = {
  block: string;
  slug: string | null;
  displayName: string | null;
  knownInPhonebook: boolean;
};

/**
 * Build a `[contact-card]` block for the chat partner / chat. Always returns
 * a block (even minimal) so downstream prelude steps can rely on it.
 *
 * For DMs: shows the contact's saved name, notify name, phone, and slug.
 * For groups: shows the group subject and participant count.
 */
export function prefetchContactCard(params: {
  chatJid: string;
  chatType: "direct" | "group";
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  pushName?: string;
  groupSubject?: string;
  groupParticipantCount?: number;
}): ContactCardResult {
  const isGroup = params.chatType === "group";

  if (isGroup) {
    const subject = params.groupSubject?.trim() || "(no subject)";
    const count = params.groupParticipantCount;
    const parts = ["[contact-card kind=group]", `Group: ${subject}`];
    if (count !== undefined) parts.push(`Participants: ${count}`);
    parts.push(`Group JID: ${params.chatJid}`);
    parts.push("[/contact-card]");
    return {
      block: parts.join("\n"),
      slug: null,
      displayName: subject,
      knownInPhonebook: false,
    };
  }

  // DM: look up the contact row by sender JID and fall back to chat JID.
  const stmt = getContactStmt();
  const candidates = [params.senderJid, params.chatJid].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  let row: ContactRow | null = null;
  if (stmt) {
    for (const jid of candidates) {
      try {
        const r = stmt.get(jid) as ContactRow | undefined;
        if (r) {
          row = r;
          break;
        }
      } catch {
        // Ignore and try next.
      }
    }
  }

  const chatStmt = getChatStmt();
  let chatRow: ChatRow | null = null;
  if (chatStmt) {
    try {
      chatRow = (chatStmt.get(params.chatJid) as ChatRow | undefined) ?? null;
    } catch {
      // Ignore.
    }
  }

  const savedName = row?.name?.trim() || chatRow?.name?.trim() || null;
  const notify = row?.notify?.trim() || params.pushName?.trim() || null;
  const phone = row?.phone?.trim() || params.senderE164 || null;
  const displayName = savedName || notify || params.senderName || null;
  const knownInPhonebook = !!savedName;

  const aliases = loadAliases();
  const slug = aliases
    ? findSlug(aliases, params.senderE164 ?? phone ?? undefined, params.senderJid)
    : null;

  const parts: string[] = ["[contact-card kind=dm]"];
  if (savedName) {
    parts.push(`Saved as (the owner's phonebook): "${savedName}"`);
  } else {
    parts.push(`Saved as (the owner's phonebook): (not saved — unknown contact)`);
  }
  if (notify && notify !== savedName) {
    parts.push(`WhatsApp notify: "${notify}"`);
  }
  if (phone) {
    parts.push(`Phone: ${phone}`);
  }
  if (params.senderJid && params.senderJid !== phone) {
    parts.push(`JID: ${params.senderJid}`);
  }
  if (slug) {
    parts.push(
      `People-profile slug: ${slug} (read with: openclaw gateway call people.read --params '{"slug":"${slug}"}')`,
    );
  } else {
    parts.push(`People-profile slug: (none yet — no entry in memory/people/)`);
  }
  parts.push("[/contact-card]");

  return {
    block: parts.join("\n"),
    slug,
    displayName,
    knownInPhonebook,
  };
}
