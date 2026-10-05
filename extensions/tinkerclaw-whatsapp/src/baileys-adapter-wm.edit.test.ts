import { describe, expect, it, vi } from "vitest";
import { createBaileysAdapter } from "./baileys-adapter-wm.js";

function fakeClient() {
  return {
    on: vi.fn(),
    editMessage: vi.fn(async () => ({ id: "EDIT1", timestamp: 2 })),
    sendMessage: vi.fn(async () => ({ id: "NEW1", timestamp: 1 })),
    sendRawMessage: vi.fn(async () => ({ id: "RAW", timestamp: 1 })),
    setGroupName: vi.fn(async () => undefined),
    setGroupPhoto: vi.fn(async () => "pic1"),
    leaveGroup: vi.fn(async () => undefined),
  };
}

function adapter(client: ReturnType<typeof fakeClient>) {
  return createBaileysAdapter({
    wmClient: client as never,
    selfJid: "34600000000:12@s.whatsapp.net",
  });
}

const CHAT = "14080000000@s.whatsapp.net";

describe("wm adapter edit", () => {
  it("edits through editMessage instead of posting the text as a new message", async () => {
    const client = fakeClient();
    await adapter(client).sendMessage(CHAT, {
      text: "fixed",
      edit: { remoteJid: CHAT, id: "3EB0AAA", fromMe: true },
    });
    expect(client.editMessage).toHaveBeenCalledWith(CHAT, "3EB0AAA", { conversation: "fixed" });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("wm adapter quoted reply", () => {
  it("sends contextInfo with the stanzaID spelling the Go bridge parses", async () => {
    const client = fakeClient();
    await adapter(client).sendMessage(
      CHAT,
      { text: "answer" },
      {
        quoted: {
          key: { remoteJid: CHAT, id: "Q1", fromMe: false },
          message: { conversation: "question" },
        },
      },
    );
    expect(client.sendRawMessage).toHaveBeenCalledWith(CHAT, {
      extendedTextMessage: {
        text: "answer",
        contextInfo: {
          stanzaID: "Q1",
          participant: CHAT,
          quotedMessage: { conversation: "question" },
        },
      },
    });
  });

  it("names us, without the device suffix, when quoting our own message", async () => {
    const client = fakeClient();
    await adapter(client).sendMessage(
      CHAT,
      { text: "again" },
      { quoted: { key: { remoteJid: CHAT, id: "Q2", fromMe: true } } },
    );
    expect(client.sendRawMessage).toHaveBeenCalledWith(CHAT, {
      extendedTextMessage: {
        text: "again",
        contextInfo: { stanzaID: "Q2", participant: "34600000000@s.whatsapp.net" },
      },
    });
  });

  it("keeps a plain conversation when nothing is quoted", async () => {
    const client = fakeClient();
    await adapter(client).sendMessage(CHAT, { text: "plain" });
    expect(client.sendMessage).toHaveBeenCalledWith(CHAT, { conversation: "plain" });
  });
});

describe("wm adapter group calls", () => {
  const GROUP = "1203630000@g.us";

  it("maps rename, icon and leave onto whatsmeow", async () => {
    const client = fakeClient();
    const sock = adapter(client);
    await sock.groupUpdateSubject(GROUP, "Team");
    await sock.updateProfilePicture(GROUP, { url: "/tmp/icon.jpg" });
    await sock.groupLeave(GROUP);
    expect(client.setGroupName).toHaveBeenCalledWith(GROUP, "Team");
    expect(client.setGroupPhoto).toHaveBeenCalledWith(GROUP, "/tmp/icon.jpg");
    expect(client.leaveGroup).toHaveBeenCalledWith(GROUP);
  });

  it("refuses an icon that is not a file path", async () => {
    const client = fakeClient();
    await expect(adapter(client).updateProfilePicture(GROUP, {})).rejects.toThrow(
      "needs a local file path",
    );
    expect(client.setGroupPhoto).not.toHaveBeenCalled();
  });
});
