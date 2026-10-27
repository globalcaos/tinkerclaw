import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaileysAdapter } from "./baileys-adapter-wm.js";
import { createWhatsmeowLidLookup } from "./lid-map-whatsmeow-db.js";

// Fake numbers only. The table shape copies the live whatsmeow store:
// whatsmeow_lid_map(lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL), digits only.
const LID = "100000000000001";
const PN = "15550001111";

let dir: string;
let dbPath: string;

function createStore(opts?: { journal?: "wal" | "delete"; rows?: Array<[string, string]> }) {
  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${opts?.journal ?? "wal"}`);
  db.exec("CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL)");
  const insert = db.prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)");
  for (const [lid, pn] of opts?.rows ?? [[LID, PN]]) {
    insert.run(lid, pn);
  }
  return db;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lid-map-"));
  dbPath = path.join(dir, "whatsmeow.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createWhatsmeowLidLookup", () => {
  it("resolves a LID to a phone JID, with or without a device suffix", async () => {
    createStore().close();
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBe(`${PN}@s.whatsapp.net`);
    expect(await lookup.getPNForLID(`${LID}:7@lid`)).toBe(`${PN}@s.whatsapp.net`);
    expect(lookup.directChatsOnly).toBe(true);
    expect(lookup.probe()).toEqual({ ok: true, rows: 1 });
  });

  it("serves a hit from cache once found, even if the file goes away", async () => {
    createStore().close();
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBe(`${PN}@s.whatsapp.net`);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBe(`${PN}@s.whatsapp.net`);
  });

  it("returns null for an unknown LID and retries only after the negative TTL", async () => {
    const writer = createStore();
    let now = 1_000_000;
    const lookup = createWhatsmeowLidLookup(dbPath, { now: () => now, negativeTtlMs: 30_000 });
    expect(await lookup.getPNForLID("100000000000002@lid")).toBeNull();

    writer
      .prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)")
      .run("100000000000002", "15550002222");
    now += 29_000;
    expect(await lookup.getPNForLID("100000000000002@lid")).toBeNull();
    now += 2_000;
    expect(await lookup.getPNForLID("100000000000002@lid")).toBe("15550002222@s.whatsapp.net");
    writer.close();
  });

  it("returns null when the store file is missing", async () => {
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBeNull();
    expect(lookup.probe().ok).toBe(false);
  });

  it("returns null without throwing when the table is missing", async () => {
    new Database(dbPath).close();
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBeNull();
    expect(lookup.probe().ok).toBe(false);
  });

  it("returns null without throwing when the file is not a database", async () => {
    fs.writeFileSync(dbPath, "this is not sqlite ".repeat(512));
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBeNull();
    expect(lookup.probe().ok).toBe(false);
  });

  it("returns null quickly when another connection holds an exclusive lock", async () => {
    const writer = createStore({ journal: "delete" });
    writer.pragma("locking_mode = EXCLUSIVE");
    writer.exec("BEGIN EXCLUSIVE");
    writer
      .prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)")
      .run("100000000000003", "15550003333");
    const lookup = createWhatsmeowLidLookup(dbPath, { busyTimeoutMs: 20 });
    const started = Date.now();
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    writer.exec("ROLLBACK");
    writer.close();
  });

  it("is not blocked by an open WAL write transaction", async () => {
    const writer = createStore();
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)")
      .run("100000000000004", "15550004444");
    const lookup = createWhatsmeowLidLookup(dbPath, { busyTimeoutMs: 20 });
    expect(await lookup.getPNForLID(`${LID}@lid`)).toBe(`${PN}@s.whatsapp.net`);
    // Uncommitted rows are invisible to the reader.
    expect(await lookup.getPNForLID("100000000000004@lid")).toBeNull();
    writer.exec("COMMIT");
    writer.close();
  });

  it("rejects non-LID input and a pn that is not digits", async () => {
    createStore({
      rows: [
        [LID, PN],
        ["100000000000005", "15550005555@s.whatsapp.net"],
      ],
    }).close();
    const lookup = createWhatsmeowLidLookup(dbPath);
    expect(await lookup.getPNForLID(`${PN}@s.whatsapp.net`)).toBeNull();
    expect(await lookup.getPNForLID("120363000000000000@g.us")).toBeNull();
    expect(await lookup.getPNForLID("")).toBeNull();
    expect(await lookup.getPNForLID(undefined as unknown as string)).toBeNull();
    expect(await lookup.getPNForLID("100000000000005@lid")).toBeNull();
  });
});

describe("wm adapter lidMapping", () => {
  const fakeClient = () => ({ on: () => undefined }) as never;

  it("has no LID lookup when no store path is given", () => {
    const sock = createBaileysAdapter({ wmClient: fakeClient() });
    expect(sock.signalRepository.lidMapping).toBeUndefined();
  });

  it("resolves peer LIDs from the store path it is given", async () => {
    createStore().close();
    const sock = createBaileysAdapter({ wmClient: fakeClient(), storePath: dbPath });
    expect(await sock.signalRepository.lidMapping?.getPNForLID(`${LID}@lid`)).toBe(
      `${PN}@s.whatsapp.net`,
    );
  });
});
