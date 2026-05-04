import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "./send-api.js";

const recordChannelActivity = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(async () => ({ key: { id: "msg-1" } }));
  const sendPresenceUpdate = vi.fn(async () => {});
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
    });
  });

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "invoice.pdf",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to default document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "file",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
  });

  it("sends plain text messages", async () => {
    await api.sendMessage("+1555", "hello");
    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hello" });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("supports image media with caption", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "cap", payload, "image/jpeg");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        image: payload,
        caption: "cap",
        mimetype: "image/jpeg",
      }),
    );
  });

  it("supports audio as push-to-talk voice note", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "", payload, "audio/ogg", { accountId: "alt" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        audio: payload,
        ptt: true,
        mimetype: "audio/ogg",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "alt",
      direction: "outbound",
    });
  });

  it("sends visible text separately from push-to-talk voice notes", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "voice text", payload, "audio/ogg");
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "1555@s.whatsapp.net",
      expect.objectContaining({
        audio: payload,
        ptt: true,
        mimetype: "audio/ogg",
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(2, "1555@s.whatsapp.net", {
      text: "voice text",
    });
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        video: payload,
        caption: "cap",
        mimetype: "video/mp4",
        gifPlayback: true,
      }),
    );
  });

  it("falls back to unknown messageId if Baileys result does not expose key.id", async () => {
    sendMessage.mockResolvedValueOnce({ key: {} as { id: string } });
    const res = await api.sendMessage("+1555", "hello");
    expect(res.messageId).toBe("unknown");
  });

  it("sends polls and records outbound activity", async () => {
    const res = await api.sendPoll("+1555", {
      question: "Q?",
      options: ["a", "b"],
      maxSelections: 2,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        poll: { name: "Q?", values: ["a", "b"], selectableCount: 2 },
      }),
    );
    expect(res.messageId).toBe("msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        react: {
          text: "👍",
          key: expect.objectContaining({
            remoteJid: "1555@s.whatsapp.net",
            id: "msg-2",
            fromMe: false,
            participant: "1999@s.whatsapp.net",
          }),
        },
      }),
    );
  });

  it("keeps direct-chat reactions without a participant key", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false);
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        react: {
          text: "👍",
          key: expect.objectContaining({
            remoteJid: "1555@s.whatsapp.net",
            id: "msg-2",
            fromMe: false,
            participant: undefined,
          }),
        },
      }),
    );
  });

  it("preserves LID participants in reaction keys", async () => {
    await api.sendReaction("12345@g.us", "msg-2", "👍", false, "123@lid");
    expect(sendMessage).toHaveBeenCalledWith(
      "12345@g.us",
      expect.objectContaining({
        react: {
          text: "👍",
          key: expect.objectContaining({
            remoteJid: "12345@g.us",
            id: "msg-2",
            fromMe: false,
            participant: "123@lid",
          }),
        },
      }),
    );
  });

  it("sends composing presence updates to the recipient JID", async () => {
    await api.sendComposingTo("+1555");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });

  it("sends media as document when mediaType is undefined", async () => {
    const mediaBuffer = Buffer.from("test");

    await api.sendMessage("123", "hello", mediaBuffer, undefined);

    expect(sendMessage).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      expect.objectContaining({
        document: mediaBuffer,
        mimetype: "application/octet-stream",
      }),
    );
  });

  it("does not set mediaType when mediaBuffer is absent", async () => {
    await api.sendMessage("123", "hello");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hello" });
  });

  it("preserves the quoted remoteJid provided by the outbound adapter", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: "277038292303944@lid",
        fromMe: false,
        participant: "1234@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      { text: "hello" },
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({
            remoteJid: "277038292303944@lid",
            id: "quoted-1",
          }),
        }),
      }),
    );
  });

  // FORK 2026-05-02: programmatic outbound persona prefix.
  describe("outbound persona prefix", () => {
    it("prepends the configured prefix to plain text bodies", async () => {
      const prefixed = createWebSendApi({
        sock: { sendMessage, sendPresenceUpdate },
        defaultAccountId: "main",
        resolveOutboundPrefix: () => "🤖",
      });
      await prefixed.sendMessage("+1555", "hello world");
      expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
        text: "🤖 hello world",
      });
    });

    it("is idempotent — does not double-prefix already-prefixed text", async () => {
      const prefixed = createWebSendApi({
        sock: { sendMessage, sendPresenceUpdate },
        defaultAccountId: "main",
        resolveOutboundPrefix: () => "🤖",
      });
      await prefixed.sendMessage("+1555", "🤖 already labeled");
      expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
        text: "🤖 already labeled",
      });
    });

    it("prefixes media captions but not empty captions", async () => {
      const prefixed = createWebSendApi({
        sock: { sendMessage, sendPresenceUpdate },
        defaultAccountId: "main",
        resolveOutboundPrefix: () => "🤖",
      });
      const img = Buffer.from("png");
      await prefixed.sendMessage("+1555", "look at this", img, "image/png");
      expect(sendMessage).toHaveBeenCalledWith(
        "1555@s.whatsapp.net",
        expect.objectContaining({
          image: img,
          caption: "🤖 look at this",
        }),
      );
      sendMessage.mockClear();
      await prefixed.sendMessage("+1555", "", img, "image/png");
      expect(sendMessage).toHaveBeenCalledWith(
        "1555@s.whatsapp.net",
        expect.objectContaining({
          image: img,
          caption: undefined,
        }),
      );
    });

    it("prefixes the poll question only", async () => {
      const prefixed = createWebSendApi({
        sock: { sendMessage, sendPresenceUpdate },
        defaultAccountId: "main",
        resolveOutboundPrefix: () => "🤖",
      });
      await prefixed.sendPoll("+1555", { question: "lunch?", options: ["yes", "no"] });
      expect(sendMessage).toHaveBeenCalledWith(
        "1555@s.whatsapp.net",
        expect.objectContaining({
          poll: expect.objectContaining({
            name: "🤖 lunch?",
            values: ["yes", "no"],
          }),
        }),
      );
    });

    it("does not prefix reactions (the reaction is the icon itself)", async () => {
      const prefixed = createWebSendApi({
        sock: { sendMessage, sendPresenceUpdate },
        defaultAccountId: "main",
        resolveOutboundPrefix: () => "🤖",
      });
      await prefixed.sendReaction("+1555", "msg-id", "👍", false);
      expect(sendMessage).toHaveBeenCalledWith(
        "1555@s.whatsapp.net",
        expect.objectContaining({
          react: expect.objectContaining({ text: "👍" }),
        }),
      );
    });

    it("no-ops cleanly when no prefix is configured (backward compat)", async () => {
      // No resolveOutboundPrefix → pass through unchanged. Same shape as the
      // existing non-prefix tests above.
      await api.sendMessage("+1555", "no prefix here");
      expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
        text: "no prefix here",
      });
    });
  });
});
