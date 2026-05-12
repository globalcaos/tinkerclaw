/**
 * FORK 2026-05-12 — read self identity (JID + LID) directly from the
 * whatsmeow SQLite store.
 *
 * Why this exists: the original auth-store.ts readers look for a
 * `creds.json` file with `me.id` / `me.lid` fields. That file was
 * baileys-era; the whatsmeow backend stores everything in
 * `<authDir>/whatsmeow.db` instead and never produces a JSON file.
 * The bible `failures.md` M7 carried this as an "open follow-up":
 *
 *     "populate `self.lid` from whatsmeow auth state"
 *
 * Closes that follow-up. The `whatsmeow_device` table's single row
 * carries both `jid` and `lid` columns for the connected account; we
 * read them with a bounded read-only query (LIMIT 1) and return the
 * structured shape the rest of auth-store.ts expects.
 *
 * No write path: this module never opens the DB for write. The
 * whatsmeow Go subprocess is the only writer; we are strictly an
 * auxiliary reader for the TypeScript identity pipeline.
 *
 * Bible anchors:
 *   - failures.md M7 (open follow-up before this; resolved now)
 *   - wa-triggers.md (LID rescue contract that consumed self.lid)
 *   - design-principles.md #11 (probes paired with write surfaces — same
 *     reasoning applies: every state mutator the Go binary writes
 *     should have a TypeScript reader, not just the ones in creds.json)
 */

import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const WHATSMEOW_DB_FILENAME = "whatsmeow.db";

export type WhatsmeowDeviceIdentity = {
  jid: string | null;
  lid: string | null;
};

/**
 * Read `(jid, lid)` from the connected account's `whatsmeow_device` row.
 *
 * Returns `null` if the DB file doesn't exist (legacy baileys account)
 * or if the table is empty (account not yet linked). Returns the
 * structured shape otherwise — fields may individually be null if
 * whatsmeow hasn't migrated this device to a LID yet.
 *
 * Read-only; never blocks the whatsmeow writer (uses `readonly: true`).
 */
export function readWhatsmeowDeviceIdentity(authDir: string): WhatsmeowDeviceIdentity | null {
  const dbPath = path.join(authDir, WHATSMEOW_DB_FILENAME);
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare<[], { jid: string | null; lid: string | null }>(
        "SELECT jid, lid FROM whatsmeow_device LIMIT 1",
      )
      .get();
    if (!row) {
      return null;
    }
    return {
      jid: row.jid ?? null,
      lid: row.lid ?? null,
    };
  } catch {
    // DB shape mismatch, lock contention, or any read error — degrade to
    // null and let the caller fall back. We don't want a probe to crash
    // identity resolution because the wm DB is briefly unavailable.
    return null;
  } finally {
    db?.close();
  }
}
