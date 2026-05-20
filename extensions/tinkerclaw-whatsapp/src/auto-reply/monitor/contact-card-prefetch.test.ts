import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState: { db: Database.Database | null } = { db: null };

vi.mock("../../history/db.js", () => ({
  getDb: () => {
    if (!mockState.db) throw new Error("no db");
    return mockState.db;
  },
}));

const { prefetchContactCard } = await import("./contact-card-prefetch.js");

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone TEXT, updated_at INTEGER);
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER, participant_count INTEGER, updated_at INTEGER);
  `);
  return db;
}

beforeEach(() => {
  mockState.db = null;
});

afterEach(() => {
  if (mockState.db) {
    mockState.db.close();
    mockState.db = null;
  }
});

describe("prefetchContactCard — groups", () => {
  it("emits a group card with subject and participant count, no DB required", () => {
    const res = prefetchContactCard({
      chatJid: "120363000000@g.us",
      chatType: "group",
      groupSubject: "Sample Group",
      groupParticipantCount: 27,
    });
    expect(res.block).toContain("[contact-card kind=group]");
    expect(res.block).toContain("Sample Group");
    expect(res.block).toContain("Participants: 27");
    expect(res.displayName).toBe("Sample Group");
    expect(res.slug).toBeNull();
    expect(res.knownInPhonebook).toBe(false);
  });

  it("falls back to (no subject) when group subject is missing", () => {
    const res = prefetchContactCard({
      chatJid: "120363000000@g.us",
      chatType: "group",
    });
    expect(res.block).toContain("(no subject)");
  });
});

describe("prefetchContactCard — DMs with DB", () => {
  it("emits saved phonebook name and notify when contact row exists", () => {
    const db = seedDb();
    db.prepare(
      "INSERT INTO contacts (jid, name, notify, phone, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("1000000001@s.whatsapp.net", "Alice Example", "Alice E.", null, 0);
    mockState.db = db;

    const res = prefetchContactCard({
      chatJid: "1000000001@s.whatsapp.net",
      chatType: "direct",
      senderJid: "1000000001@s.whatsapp.net",
      senderE164: "+1000000001",
    });
    expect(res.block).toContain("[contact-card kind=dm]");
    expect(res.block).toContain('Saved as (the owner\'s phonebook): "Alice Example"');
    expect(res.block).toContain('WhatsApp notify: "Alice E."');
    expect(res.block).toContain("+1000000001");
    expect(res.displayName).toBe("Alice Example");
    expect(res.knownInPhonebook).toBe(true);
  });

  it("emits the unknown marker when contact row is absent", () => {
    const db = seedDb();
    mockState.db = db;

    const res = prefetchContactCard({
      chatJid: "1000000002@s.whatsapp.net",
      chatType: "direct",
      senderJid: "1000000002@s.whatsapp.net",
      senderE164: "+1000000002",
    });
    expect(res.block).toContain("(not saved — unknown contact)");
    expect(res.block).toContain("(none yet — no entry in memory/people/)");
    expect(res.knownInPhonebook).toBe(false);
    expect(res.slug).toBeNull();
  });
});

describe("prefetchContactCard — DMs without DB", () => {
  it("still returns a minimal DM card via pushName fallback", () => {
    mockState.db = null;
    const res = prefetchContactCard({
      chatJid: "1000000003@s.whatsapp.net",
      chatType: "direct",
      senderJid: "1000000003@s.whatsapp.net",
      senderE164: "+1000000003",
      pushName: "Eve",
    });
    expect(res.block).toContain("[contact-card kind=dm]");
    expect(res.block).toContain('WhatsApp notify: "Eve"');
    expect(res.block).toContain("+1000000003");
    expect(res.displayName).toBe("Eve");
    expect(res.knownInPhonebook).toBe(false);
  });
});
