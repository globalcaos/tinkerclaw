import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "wa-history-home-"));
vi.stubEnv("HOME", home);
vi.stubEnv("OPENCLAW_HOME", home);
vi.stubEnv("OPENCLAW_WHATSAPP_HISTORY_RETENTION_DAYS", "");

const mod = await import("./db.js");
const dbFile = mod.HISTORY_DB_PATH;

describe("history db privacy", () => {
  it("resolves the database inside the test home, never the real one", () => {
    expect(dbFile.startsWith(home)).toBe(true);
  });

  it("does not create the database from a read-side prefetch", () => {
    expect(mod.historyDbExists()).toBe(false);
    expect(mod.getDbIfExists()).toBeNull();
    expect(existsSync(dbFile)).toBe(false);
  });

  it("keeps the main file and both WAL sidecars at 0600, fixing stale sidecars", () => {
    mkdirSync(path.dirname(dbFile), { recursive: true });
    // Sidecars left behind by an older version with a 0644 umask.
    new Database(dbFile).close();
    writeFileSync(`${dbFile}-wal`, "", { mode: 0o644 });
    writeFileSync(`${dbFile}-shm`, "", { mode: 0o644 });
    const db = mod.getDb();
    db.prepare("SELECT count(*) FROM messages").get();
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
      expect(statSync(f).mode & 0o777, f).toBe(0o600);
    }
  });

  it("retention is off unless a positive day count is set", () => {
    expect(mod.resolveHistoryRetentionDays(undefined)).toBeNull();
    expect(mod.resolveHistoryRetentionDays("")).toBeNull();
    expect(mod.resolveHistoryRetentionDays("0")).toBeNull();
    expect(mod.resolveHistoryRetentionDays("abc")).toBeNull();
    expect(mod.resolveHistoryRetentionDays("30")).toBe(30);
  });

  it("prunes only messages older than the retention window", () => {
    const db = mod.getDb();
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, timestamp, text_content) VALUES (?, 'c@s.whatsapp.net', 0, ?, 'hi')",
    );
    insert.run("old", now - 40 * 86400);
    insert.run("new", now - 1 * 86400);
    expect(mod.pruneHistoryOlderThan(db, 30)).toBe(1);
    const ids = db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(["new"]);
  });
});
