import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "wa-outbound-archive-home-"));
vi.stubEnv("HOME", home);
vi.stubEnv("OPENCLAW_HOME", home);
vi.stubEnv("OPENCLAW_WHATSAPP_HISTORY_RETENTION_DAYS", "");

const db = await import("./db.js");
const { createBaileysAdapter } = await import("../baileys-adapter-wm.js");
const { createWebSendApi } = await import("../inbound/send-api.js");

const SELF = "34600000000:12@s.whatsapp.net";
const CHAT = "14080000000@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

type Row = {
  id: string;
  chat_jid: string;
  from_me: number;
  timestamp: number;
  message_type: string | null;
  text_content: string | null;
  quoted_id: string | null;
  raw_json: string | null;
  source: string | null;
};

function row(id: string): Row | undefined {
  return db.getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
}

let nextId = 0;
function fakeClient() {
  const send = async () => ({ id: `3EB0SENT${++nextId}`, timestamp: 1_790_000_000 + nextId });
  return {
    on: vi.fn(),
    sendMessage: vi.fn(send),
    sendRawMessage: vi.fn(send),
    editMessage: vi.fn(async (_chat: string, id: string) => ({ id, timestamp: 1_790_000_500 })),
    revokeMessage: vi.fn(async () => undefined),
    uploadMedia: vi.fn(async (p: string) => ({
      URL: "https://mmg.whatsapp.net/x",
      directPath: "/v/x",
      mediaKey: "a2V5",
      fileEncSHA256: "ZW5j",
      fileSHA256: "c2hh",
      fileLength: fs.statSync(p).size,
    })),
  };
}

function adapter(client = fakeClient()) {
  return createBaileysAdapter({ wmClient: client as never, selfJid: SELF });
}

describe("gateway sends reach the history DB", () => {
  it("writes inside the test home, never the real archive", () => {
    expect(db.HISTORY_DB_PATH.startsWith(home)).toBe(true);
  });

  it("archives a text send as from_me, gateway-sent, at the send time", async () => {
    const res = await adapter().sendMessage(CHAT, { text: "🤖 hello" });
    expect(row(res.key.id)).toMatchObject({
      chat_jid: CHAT,
      from_me: 1,
      timestamp: res.messageTimestamp,
      message_type: "text",
      text_content: "🤖 hello",
      source: "gateway-send",
    });
  });

  it("keeps the quoted id of a quoted reply", async () => {
    const res = await adapter().sendMessage(
      GROUP,
      { text: "answer" },
      { quoted: { key: { remoteJid: GROUP, id: "Q1", participant: CHAT, fromMe: false } } },
    );
    expect(row(res.key.id)).toMatchObject({ text_content: "answer", quoted_id: "Q1" });
  });

  it("archives a media send with its caption and the media keys", async () => {
    const res = await adapter().sendMessage(GROUP, {
      image: Buffer.from("jpeg bytes"),
      mimetype: "image/jpeg",
      caption: "the photo",
    });
    const archived = row(res.key.id);
    expect(archived).toMatchObject({
      chat_jid: GROUP,
      from_me: 1,
      message_type: "image",
      text_content: "the photo",
      source: "gateway-send",
    });
    expect(JSON.parse(archived!.raw_json!).message.imageMessage.directPath).toBe("/v/x");
  });

  it("an edit updates the text and keeps the original", async () => {
    const sock = adapter();
    const sent = await sock.sendMessage(CHAT, { text: "first draft" });
    await sock.sendMessage(CHAT, {
      text: "fixed",
      edit: { remoteJid: CHAT, id: sent.key.id, fromMe: true },
    });
    const archived = row(sent.key.id)!;
    expect(archived.text_content).toBe("fixed");
    expect(archived.timestamp).toBe(sent.messageTimestamp);
    const raw = JSON.parse(archived.raw_json!);
    expect(raw.message).toEqual({ conversation: "first draft" });
    expect(raw.edits).toEqual([{ atSec: 1_790_000_500, text: "fixed" }]);
  });

  it("a revoke marks the row and never deletes it", async () => {
    const sock = adapter();
    const sent = await sock.sendMessage(CHAT, { text: "oops" });
    await sock.sendMessage(CHAT, { delete: { remoteJid: CHAT, id: sent.key.id, fromMe: true } });
    const archived = row(sent.key.id)!;
    expect(archived).toMatchObject({ message_type: "revoked", text_content: "oops" });
    const raw = JSON.parse(archived.raw_json!);
    expect(raw.originalType).toBe("text");
    expect(typeof raw.revokedAtSec).toBe("number");
  });

  it("never touches a row the gateway did not write", async () => {
    db.insertMessage({
      id: "PHONE1",
      chat_jid: CHAT,
      from_me: true,
      timestamp: 1_700_000_000,
      message_type: "text",
      text_content: "typed on the phone",
      source: "live-wm",
    });
    const sock = adapter();
    await sock.sendMessage(CHAT, {
      text: "x",
      edit: { remoteJid: CHAT, id: "PHONE1", fromMe: true },
    });
    await sock.sendMessage(CHAT, { delete: { remoteJid: CHAT, id: "PHONE1", fromMe: true } });
    expect(row("PHONE1")).toMatchObject({
      message_type: "text",
      text_content: "typed on the phone",
      raw_json: null,
      source: "live-wm",
    });
  });

  it("a failing archive warns and the send still succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.closeDb();
    const moved = `${db.HISTORY_DB_PATH}.moved`;
    fs.renameSync(db.HISTORY_DB_PATH, moved);
    fs.mkdirSync(db.HISTORY_DB_PATH); // a directory cannot be opened as a database
    try {
      const res = await adapter().sendMessage(CHAT, { text: "still delivered" });
      expect(res.key.id).toMatch(/^3EB0SENT/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(res.key.id));
    } finally {
      fs.rmdirSync(db.HISTORY_DB_PATH);
      fs.renameSync(moved, db.HISTORY_DB_PATH);
      warn.mockRestore();
    }
  });

  it("the send time survives a restart, so the edit guard can find it", async () => {
    const sock = adapter();
    const api = createWebSendApi({ sock: sock as never, defaultAccountId: "default" });
    const { messageId } = await api.sendMessage(CHAT, "sent before the restart");
    const sentAtSec = row(messageId)!.timestamp;

    // A restart: the in-memory sent-id map and the open DB handle are gone.
    db.closeDb();
    vi.resetModules();
    vi.stubEnv("HOME", home); // the fresh db.js resolves its path again
    vi.stubEnv("OPENCLAW_HOME", home);
    const fresh = await import("../message-sent-at.js");
    const { getSentMessageAtMs } = await import("../inbound/sent-ids.js");
    expect(getSentMessageAtMs(messageId)).toBeUndefined();
    expect(fresh.resolveWhatsAppMessageSentAtMs(messageId)).toBe(sentAtSec * 1000);
  });
});
