import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBaileysAdapter } from "./baileys-adapter-wm.js";

function fakeClient() {
  const seen: { path?: string; bytes?: Buffer; existedAtUpload?: boolean } = {};
  const client = {
    on: vi.fn(),
    uploadMedia: vi.fn(async (p: string, _kind: string) => {
      seen.path = p;
      seen.existedAtUpload = fs.existsSync(p);
      seen.bytes = fs.readFileSync(p);
      return {
        URL: "https://mmg.whatsapp.net/x",
        directPath: "/v/x",
        mediaKey: "a2V5",
        fileEncSHA256: "ZW5j",
        fileSHA256: "c2hh",
        fileLength: seen.bytes.length,
      };
    }),
    sendRawMessage: vi.fn(async () => ({ id: "MSG1", timestamp: 1 })),
  };
  return { client, seen };
}

describe("wm adapter media sends", () => {
  it("uploads a document from a temp file, then sends a documentMessage", async () => {
    const { client, seen } = fakeClient();
    const sock = createBaileysAdapter({
      wmClient: client as never,
      selfJid: "34600000000@s.whatsapp.net",
    });
    const pdf = Buffer.from("%PDF-1.4 test");

    const res = await sock.sendMessage("34611111111@s.whatsapp.net", {
      document: pdf,
      fileName: "report.pdf",
      mimetype: "application/pdf",
      caption: "the report",
    });

    expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(String), "document");
    expect(seen.existedAtUpload).toBe(true);
    expect(seen.bytes?.equals(pdf)).toBe(true);
    expect(seen.path?.endsWith(".pdf")).toBe(true);
    expect(client.sendRawMessage).toHaveBeenCalledWith("34611111111@s.whatsapp.net", {
      documentMessage: {
        URL: "https://mmg.whatsapp.net/x",
        directPath: "/v/x",
        mediaKey: "a2V5",
        fileEncSHA256: "ZW5j",
        fileSHA256: "c2hh",
        fileLength: String(pdf.length),
        mimetype: "application/pdf",
        fileName: "report.pdf",
        caption: "the report",
      },
    });
    expect(fs.existsSync(seen.path!)).toBe(false);
    expect(res.key.id).toBe("MSG1");
  });

  it("refuses any other binary payload instead of piping bytes to the helper", async () => {
    const { client } = fakeClient();
    const sock = createBaileysAdapter({
      wmClient: client as never,
      selfJid: "34600000000@s.whatsapp.net",
    });

    await expect(
      sock.sendMessage("34611111111@s.whatsapp.net", { sticker: Buffer.from("webp") }),
    ).rejects.toThrow(/refusing raw send with binary payload/);
    expect(client.sendRawMessage).not.toHaveBeenCalled();
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });
});
