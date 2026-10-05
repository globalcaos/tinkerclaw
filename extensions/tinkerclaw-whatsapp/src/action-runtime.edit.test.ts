import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";

const originalRuntime = { ...whatsAppActionRuntime };
const editMessageWhatsApp = vi.fn(async () => undefined);
const sendMessageWhatsApp = vi.fn(async () => ({ messageId: "out1", toJid: "x" }));
const updateGroupWhatsApp = vi.fn(async () => undefined);
const sentAt = vi.fn<(id: string) => number | undefined>();

const cfg = { channels: { whatsapp: {} } } as OpenClawConfig;
const MINUTE = 60_000;

function edit(extra: Record<string, unknown> = {}) {
  return handleWhatsAppAction(
    { action: "edit", chatJid: "+15550001111", messageId: "m1", newText: "fixed", ...extra },
    cfg,
  );
}

describe("handleWhatsAppAction edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalRuntime, {
      editMessageWhatsApp,
      sendMessageWhatsApp,
      updateGroupWhatsApp,
      resolveWhatsAppMessageSentAtMs: sentAt,
    });
  });

  afterAll(() => {
    Object.assign(whatsAppActionRuntime, originalRuntime);
  });

  it("edits a message sent within the last 15 minutes", async () => {
    sentAt.mockReturnValue(Date.now() - 3 * MINUTE);
    const result = await edit();
    expect(editMessageWhatsApp).toHaveBeenCalledWith("+15550001111", "m1", "fixed", {
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
    });
    expect(result.details).toEqual({ ok: true, edited: "m1", ageMinutes: 3 });
  });

  it("refuses an edit past the window instead of reporting a silent success", async () => {
    sentAt.mockReturnValue(Date.now() - 42 * MINUTE);
    await expect(edit()).rejects.toThrow(
      "WhatsApp only allows edits within 15 minutes; this message is 42 min old — unsend and resend instead.",
    );
    expect(editMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("warns when the send time is unknown", async () => {
    sentAt.mockReturnValue(undefined);
    const result = await edit();
    expect(editMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ ok: true, edited: "m1" });
    expect((result.details as { warning: string }).warning).toContain("older than 15 minutes");
  });

  it("explains a transport rejection when the send time is unknown", async () => {
    sentAt.mockReturnValue(undefined);
    editMessageWhatsApp.mockRejectedValueOnce(new Error("server returned error 479"));
    await expect(edit()).rejects.toThrow(
      /WhatsApp rejected the edit \(Error: server returned error 479\)\. WhatsApp only allows edits within 15 minutes/,
    );
  });

  it("only edits our own messages", async () => {
    await expect(edit({ fromMe: false })).rejects.toThrow("only lets you edit your own messages");
    expect(editMessageWhatsApp).not.toHaveBeenCalled();
  });
});

describe("handleWhatsAppAction reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalRuntime, { sendMessageWhatsApp });
  });

  afterAll(() => {
    Object.assign(whatsAppActionRuntime, originalRuntime);
  });

  it("sends the text quoting the original message", async () => {
    const result = await handleWhatsAppAction(
      { action: "reply", to: "+15550001111", text: "answer", replyToId: "q1", quotedFromMe: true },
      cfg,
    );
    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "+15550001111",
      "answer",
      expect.objectContaining({
        accountId: DEFAULT_ACCOUNT_ID,
        quotedMessageKey: expect.objectContaining({
          id: "q1",
          remoteJid: "15550001111@s.whatsapp.net",
          fromMe: true,
        }),
      }),
    );
    expect(result.details).toEqual({ ok: true, messageId: "out1", repliedTo: "q1" });
  });
});

describe("handleWhatsAppAction group changes", () => {
  const GROUP = "120363000000000000@g.us";

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalRuntime, { updateGroupWhatsApp });
  });

  afterAll(() => {
    Object.assign(whatsAppActionRuntime, originalRuntime);
  });

  it.each([
    [
      { action: "renameGroup", newName: "Team" },
      { kind: "subject", subject: "Team" },
    ],
    [
      { action: "setGroupIcon", imagePath: "/tmp/icon.jpg" },
      { kind: "icon", imagePath: "/tmp/icon.jpg" },
    ],
    [{ action: "leaveGroup" }, { kind: "leave" }],
  ])("%o becomes the group change %o", async (params, change) => {
    await handleWhatsAppAction({ ...params, groupJid: GROUP }, cfg);
    expect(updateGroupWhatsApp).toHaveBeenCalledWith(GROUP, change, {
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
    });
  });

  it("refuses a direct chat as the group", async () => {
    await expect(
      handleWhatsAppAction({ action: "leaveGroup", groupJid: "+15550001111" }, cfg),
    ).rejects.toThrow("needs a group JID");
    expect(updateGroupWhatsApp).not.toHaveBeenCalled();
  });
});
