/**
 * FORK 2026-10-13 — resolve a peer's LID to its phone number from the
 * whatsmeow SQLite store.
 *
 * Why this exists: WhatsApp now delivers many DMs on the sender's LID
 * (`<lid>@lid`) instead of their phone JID. The inbound monitor resolves the
 * sender through `sock.signalRepository.lidMapping.getPNForLID`, which real
 * Baileys provides. The whatsmeow adapter exposed `lidMapping: undefined`, so
 * every DM delivered on a LID was dropped with "resolveInboundJid returned
 * null" — including messages from allowlisted contacts. whatsmeow keeps the
 * mapping itself (table `whatsmeow_lid_map(lid TEXT PRIMARY KEY, pn TEXT
 * UNIQUE NOT NULL)`, digits only), but the whatsmeow-node bridge has no
 * command that exposes it, so we read the table directly.
 *
 * No write path: the DB is opened read-only, one short read per cache miss.
 * The Go subprocess is the only writer; the store runs in WAL mode, so a
 * reader never blocks it. Every failure (missing file, schema drift, busy
 * lock, corrupt file) is a miss, never a throw — a miss means the message
 * drops exactly as it did before this lookup existed.
 *
 * Same pattern as identity-whatsmeow-db.ts (self JID/LID from
 * `whatsmeow_device`).
 */

import fsSync from "node:fs";
import Database from "better-sqlite3";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";

export type WhatsmeowLidLookup = {
  /** "<lid>[:dev]@lid" → "<pn>@s.whatsapp.net", or null when unknown. Never throws. */
  getPNForLID: (jid: string) => Promise<string | null>;
  /**
   * Privacy scope. WhatsApp hides members' phone numbers from each other in
   * LID-addressed groups; resolving group participants through this table
   * would put those numbers into the agent's group context. The inbound
   * monitor reads this flag and only uses the lookup for direct chats.
   */
  directChatsOnly: true;
  /** One-shot health check for the startup log. Never throws. */
  probe: () => { ok: true; rows: number } | { ok: false; reason: string };
};

const LID_RE = /^(\d+)(?::\d+)?@(lid|hosted\.lid)$/;
const PN_DIGITS_RE = /^\d{6,15}$/;
// Short: whatsmeow may store a brand-new contact's pair a moment after the
// message event reaches Node. A permanent negative entry would drop that
// contact for the life of the process.
const DEFAULT_NEGATIVE_TTL_MS = 30_000;
// ~4x the live table (2,736 rows on 2026-10-13). Oldest entry goes first.
const POSITIVE_CACHE_MAX = 10_000;
// better-sqlite3 calls are synchronous; its default busy timeout (5 s) would
// stall the event loop. A busy store is treated as a miss and retried later.
const DEFAULT_BUSY_TIMEOUT_MS = 250;

export function createWhatsmeowLidLookup(
  dbPath: string,
  opts?: { now?: () => number; negativeTtlMs?: number; busyTimeoutMs?: number },
): WhatsmeowLidLookup {
  const positive = new Map<string, string>(); // lid user → pn digits (the pair is stable)
  const negative = new Map<string, number>(); // lid user → expiresAt
  const now = opts?.now ?? Date.now;
  const negativeTtlMs = opts?.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const busyTimeoutMs = opts?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  // Open per miss rather than holding a handle: hits are cached for the life of
  // the process, so this runs about once per new LID, and a fresh open follows
  // the store file if a relink or logout replaces it.
  function withDb<T>(read: (db: Database.Database) => T): T {
    if (!fsSync.existsSync(dbPath)) {
      throw new Error("store file missing");
    }
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
      return read(db);
    } finally {
      db?.close();
    }
  }

  function queryPn(lidUser: string): string | null {
    try {
      const row = withDb((db) =>
        db
          .prepare<[string], { pn: unknown }>("SELECT pn FROM whatsmeow_lid_map WHERE lid = ?")
          .get(lidUser),
      );
      const pn = row ? String(row.pn) : "";
      return PN_DIGITS_RE.test(pn) ? pn : null;
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`[wm-adapter] lid map read failed for ${lidUser}: ${String(err)}`);
      }
      return null;
    }
  }

  return {
    directChatsOnly: true,
    probe() {
      try {
        const row = withDb((db) =>
          db.prepare<[], { n: number }>("SELECT count(*) AS n FROM whatsmeow_lid_map").get(),
        );
        return { ok: true, rows: Number(row?.n ?? 0) };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async getPNForLID(jid) {
      const match = typeof jid === "string" ? LID_RE.exec(jid.trim()) : null;
      if (!match) {
        return null;
      }
      const lidUser = match[1];
      const hit = positive.get(lidUser);
      if (hit) {
        return `${hit}@s.whatsapp.net`;
      }
      const expiresAt = negative.get(lidUser);
      if (expiresAt !== undefined && expiresAt > now()) {
        return null;
      }
      const pn = queryPn(lidUser);
      if (!pn) {
        negative.set(lidUser, now() + negativeTtlMs);
        if (shouldLogVerbose()) {
          logVerbose(`[wm-adapter] lid map has no phone number for ${jid}`);
        }
        return null;
      }
      negative.delete(lidUser);
      if (positive.size >= POSITIVE_CACHE_MAX) {
        const oldest = positive.keys().next().value;
        if (oldest !== undefined) {
          positive.delete(oldest);
        }
      }
      positive.set(lidUser, pn);
      return `${pn}@s.whatsapp.net`;
    },
  };
}
