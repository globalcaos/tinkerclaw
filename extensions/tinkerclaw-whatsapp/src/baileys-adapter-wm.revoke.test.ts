import { describe, expect, it, vi } from "vitest";
import { createBaileysAdapter } from "./baileys-adapter-wm.js";

function fakeClient() {
  return {
    on: vi.fn(),
    revokeMessage: vi.fn(async () => undefined),
    sendRawMessage: vi.fn(async () => ({ id: "RAW", timestamp: 1 })),
  };
}

describe("wm adapter message delete", () => {
  it("revokes our own message through revokeMessage, not sendRawMessage", async () => {
    const client = fakeClient();
    const sock = createBaileysAdapter({
      wmClient: client as never,
      selfJid: "34600000000:12@s.whatsapp.net",
    });

    const res = await sock.sendMessage("14080000000@s.whatsapp.net", {
      delete: { remoteJid: "14080000000@s.whatsapp.net", id: "3EB0AAA", fromMe: true },
    });

    expect(client.revokeMessage).toHaveBeenCalledWith(
      "14080000000@s.whatsapp.net",
      "34600000000:12@s.whatsapp.net",
      "3EB0AAA",
    );
    expect(client.sendRawMessage).not.toHaveBeenCalled();
    expect(res.key.id).toBe("3EB0AAA");
  });

  it("names the original sender when deleting someone else's message in a group", async () => {
    const client = fakeClient();
    const sock = createBaileysAdapter({
      wmClient: client as never,
      selfJid: "34600000000@s.whatsapp.net",
    });

    await sock.sendMessage("1203630000@g.us", {
      delete: {
        remoteJid: "1203630000@g.us",
        id: "ABC",
        fromMe: false,
        participant: "34611111111@s.whatsapp.net",
      },
    });

    expect(client.revokeMessage).toHaveBeenCalledWith(
      "1203630000@g.us",
      "34611111111@s.whatsapp.net",
      "ABC",
    );
  });
});
