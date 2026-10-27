import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import "./monitor-inbox.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsmeowLidLookup } from "./lid-map-whatsmeow-db.js";
import {
  type InboxOnMessage,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

// 2026-10-13: DMs delivered on a LID were dropped ("resolveInboundJid returned
// null") because the whatsmeow adapter had no LID lookup. These cases drive the
// real whatsmeow_lid_map reader against a temp store. Fake numbers only.
const OWNER_PN = "15550009999";
const OWNER_LID = "100000000000009";
const ALLOWED_PN = "15550001111";
const ALLOWED_LID = "100000000000001";
const STRANGER_PN = "15550002222";
const STRANGER_LID = "100000000000002";
const MEMBER_LID = "100000000000003";

installWebMonitorInboxUnitTestHooks();

let storeDir: string;
let seq = 0;

function nextId(label: string) {
  seq += 1;
  return `${label}-${seq}`;
}

function dm(params: { remoteJid: string; text: string; fromMe?: boolean; participant?: string }) {
  return {
    type: "notify",
    messages: [
      {
        key: {
          id: nextId("lid"),
          fromMe: params.fromMe ?? false,
          remoteJid: params.remoteJid,
          participant: params.participant,
        },
        message: { conversation: params.text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: "Peer",
      },
    ],
  };
}

function installLidStore() {
  const dbPath = path.join(storeDir, "whatsmeow.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL)");
  const insert = db.prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)");
  insert.run(OWNER_LID, OWNER_PN);
  insert.run(ALLOWED_LID, ALLOWED_PN);
  insert.run(STRANGER_LID, STRANGER_PN);
  insert.run(MEMBER_LID, "15550003333");
  db.close();
  const lookup = createWhatsmeowLidLookup(dbPath);
  const sock = getSock();
  // The monitor reads lidMapping once when it attaches, like the real adapter.
  (sock.signalRepository as { lidMapping: unknown }).lidMapping = lookup;
  sock.user.id = `${OWNER_PN}@s.whatsapp.net`;
  return { sock, getPNForLID: vi.spyOn(lookup, "getPNForLID") };
}

function useConfig(allowFrom: string[], extra: Record<string, unknown> = {}) {
  mockLoadConfig.mockReturnValue({
    channels: { whatsapp: { dmPolicy: "allowlist", groupPolicy: "open", allowFrom, ...extra } },
    messages: { messagePrefix: undefined, responsePrefix: undefined },
  });
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lid-store-"));
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe("inbound DMs delivered on a LID, resolved through whatsmeow_lid_map", () => {
  it("processes an allowlisted contact's LID DM with their E.164 as sender", async () => {
    useConfig([`+${OWNER_PN}`, `+${ALLOWED_PN}`]);
    const { sock } = installLidStore();
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit("messages.upsert", dm({ remoteJid: `${ALLOWED_LID}@lid`, text: "Jarvis, hola" }));
    await waitForMessageCalls(onMessage, 1);

    const inbound = onMessage.mock.calls[0]?.[0] as unknown as {
      from: string;
      senderE164: string;
      chatId: string;
      chatType: string;
      reply: (text: string) => Promise<void>;
    };
    expect(inbound).toMatchObject({
      from: `+${ALLOWED_PN}`,
      senderE164: `+${ALLOWED_PN}`,
      chatId: `${ALLOWED_LID}@lid`,
      chatType: "direct",
    });
    // The reply goes back to the chat it came from, the LID chat.
    await inbound.reply("ok");
    expect(sock.sendMessage).toHaveBeenCalledWith(`${ALLOWED_LID}@lid`, { text: "ok" });

    await listener.close();
  });

  it("lets a contact listed in allowFrom only by their LID through", async () => {
    useConfig([`+${OWNER_PN}`, `${ALLOWED_LID}@lid`]);
    const { sock } = installLidStore();
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit("messages.upsert", dm({ remoteJid: `${ALLOWED_LID}@lid`, text: "Jarvis, hola" }));
    await waitForMessageCalls(onMessage, 1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ from: `+${ALLOWED_PN}` });

    await listener.close();
  });

  it("keeps a non-allowlisted LID sender silent: no message, no reply, no pairing, no receipt", async () => {
    useConfig([`+${OWNER_PN}`, `+${ALLOWED_PN}`, `${ALLOWED_LID}@lid`]);
    const { sock, getPNForLID } = installLidStore();
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.sendPresenceUpdate.mockClear();

    sock.ev.emit("messages.upsert", dm({ remoteJid: `${STRANGER_LID}@lid`, text: "hello" }));
    sock.ev.emit(
      "messages.upsert",
      dm({ remoteJid: `${STRANGER_LID}@lid`, text: "Jarvis, hello" }),
    );
    await vi.waitFor(() => expect(getPNForLID).toHaveBeenCalledTimes(2));
    await settleInboundWork();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock.readMessages).not.toHaveBeenCalled();
    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();

    await listener.close();
  });

  it("still rewrites the owner's self-chat LID to the phone JID once the LID resolves", async () => {
    useConfig([`+${OWNER_PN}`, `+${ALLOWED_PN}`]);
    const { sock } = installLidStore();
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      dm({ remoteJid: `${OWNER_LID}@lid`, text: "note to self", fromMe: true }),
    );
    await waitForMessageCalls(onMessage, 1);

    const inbound = onMessage.mock.calls[0]?.[0] as unknown as {
      from: string;
      chatId: string;
      reply: (text: string) => Promise<void>;
    };
    expect(inbound).toMatchObject({
      from: `+${OWNER_PN}`,
      chatId: `${OWNER_PN}@s.whatsapp.net`,
    });
    await inbound.reply("ok");
    expect(sock.sendMessage).toHaveBeenCalledWith(`${OWNER_PN}@s.whatsapp.net`, { text: "ok" });

    await listener.close();
  });

  it("keys the owner's own message in a peer's LID chat on the peer, replying in that chat", async () => {
    useConfig([`+${OWNER_PN}`]);
    const { sock } = installLidStore();
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      dm({ remoteJid: `${STRANGER_LID}@lid`, text: "Jarvis, look this up", fromMe: true }),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      from: `+${STRANGER_PN}`,
      senderE164: `+${OWNER_PN}`,
      chatId: `${STRANGER_LID}@lid`,
    });

    await listener.close();
  });

  it("does not put hidden group members' numbers into group context", async () => {
    useConfig([`+${OWNER_PN}`]);
    const { sock, getPNForLID } = installLidStore();
    (sock as unknown as { groupMetadata: unknown }).groupMetadata = vi.fn(async () => ({
      subject: "Group",
      participants: [{ id: `${MEMBER_LID}@lid` }, { id: `${OWNER_LID}@lid` }],
    }));
    const onMessage = vi.fn(async (_msg: unknown) => undefined);
    const { listener } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      dm({
        remoteJid: "120363000000000001@g.us",
        participant: `${MEMBER_LID}@lid`,
        text: "hi all",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const inbound = onMessage.mock.calls[0]?.[0] as unknown as {
      senderE164?: string;
      groupParticipants?: string[];
    };
    expect(inbound.senderE164).toBeUndefined();
    expect(inbound.groupParticipants).toEqual([`${MEMBER_LID}@lid`, `${OWNER_LID}@lid`]);
    expect(JSON.stringify(inbound.groupParticipants)).not.toContain("15550003333");
    expect(getPNForLID).not.toHaveBeenCalled();

    await listener.close();
  });
});
