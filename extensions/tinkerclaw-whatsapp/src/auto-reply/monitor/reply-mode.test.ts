import { describe, expect, it } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { buildReplyModeBlock, deriveReplyMode } from "./reply-mode.js";

function makeMsg(overrides: Partial<WebInboundMessage>): WebInboundMessage {
  return {
    from: "+1000000001",
    conversationId: "+1000000001",
    to: "+1000000099",
    accountId: "default",
    body: "hola",
    chatType: "direct",
    chatId: "+1000000001",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

describe("deriveReplyMode", () => {
  it("returns outbound-draft when owner typed with trigger prefix in someone else's chat", () => {
    const msg = makeMsg({ fromMe: true, ownerPrefixTriggered: true });
    expect(deriveReplyMode(msg)).toBe("outbound-draft");
  });

  it("returns outbound-auto-reply when a third party wrote in to the owner", () => {
    const msg = makeMsg({ fromMe: false });
    expect(deriveReplyMode(msg)).toBe("outbound-auto-reply");
  });

  it("returns owner-management when sender equals self in a self-chat DM", () => {
    const msg = makeMsg({
      fromMe: true,
      ownerPrefixTriggered: true,
      senderJid: "999@s.whatsapp.net",
      selfJid: "999@s.whatsapp.net",
      chatId: "999@s.whatsapp.net",
      from: "999@s.whatsapp.net",
    });
    expect(deriveReplyMode(msg)).toBe("owner-management");
  });

  it("returns owner-management when chatId matches the owner's selfLid", () => {
    const msg = makeMsg({
      chatId: "12345@lid",
      from: "12345@lid",
      selfLid: "12345@lid",
      senderJid: "12345@lid",
    });
    expect(deriveReplyMode(msg)).toBe("owner-management");
  });

  it("returns owner-management when senderE164 digits match selfE164 even with different JID representations", () => {
    const msg = makeMsg({
      chatId: "1000000001@s.whatsapp.net",
      from: "1000000001@s.whatsapp.net",
      senderJid: "1000000001@s.whatsapp.net",
      senderE164: "+1000000001",
      selfE164: "1000000001",
      fromMe: true,
    });
    expect(deriveReplyMode(msg)).toBe("owner-management");
  });

  it("returns owner-management when last-9 digits of partner suffix-match selfE164", () => {
    const msg = makeMsg({
      chatId: "0001000000001@s.whatsapp.net",
      from: "0001000000001@s.whatsapp.net",
      senderJid: "0001000000001@s.whatsapp.net",
      senderE164: "+1000000001",
      selfE164: "+1000000001",
    });
    expect(deriveReplyMode(msg)).toBe("owner-management");
  });
});

describe("buildReplyModeBlock", () => {
  it("outbound-draft block names the recipient and forbids meta-questions to the owner", () => {
    const block = buildReplyModeBlock({
      mode: "outbound-draft",
      recipientName: "Alice",
      recipientPhone: "+1000000001",
    });
    expect(block).toContain("mode: outbound-draft");
    expect(block).toContain("Alice");
    expect(block).toContain("sent verbatim");
    expect(block).toContain("NOT a meta-discussion");
  });

  it("outbound-auto-reply block targets the inbound sender", () => {
    const block = buildReplyModeBlock({
      mode: "outbound-auto-reply",
      recipientName: "Bob",
      recipientPhone: "+1000000002",
    });
    expect(block).toContain("mode: outbound-auto-reply");
    expect(block).toContain("Bob");
    expect(block).toContain("auto-replying on the owner's behalf");
  });

  it("owner-management block tells Jarvis meta-questions ARE allowed", () => {
    const block = buildReplyModeBlock({
      mode: "owner-management",
      recipientName: null,
      recipientPhone: null,
    });
    expect(block).toContain("mode: owner-management");
    expect(block).toContain("the owner (owner self-chat)");
    expect(block).toContain("private");
  });

  it("falls back to phone or generic when recipient name is unknown", () => {
    const block = buildReplyModeBlock({
      mode: "outbound-auto-reply",
      recipientName: null,
      recipientPhone: "+1000000003",
    });
    expect(block).toContain("+1000000003");
  });
});
