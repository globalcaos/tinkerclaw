import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWhatsmeowBinaryOverride } from "../../session-wm.js";
import { resolveChatJidCandidates } from "./chat-jid-match.js";
import { buildThreadEscalationHint, shouldOfferCrossChatLookup } from "./message-line.js";
import {
  buildUnknownContactProtocolBlock,
  shouldOfferContactResearch,
} from "./unknown-contact-protocol.js";

describe("resolveChatJidCandidates", () => {
  it("matches a full JID exactly", () => {
    expect(resolveChatJidCandidates("34600000000@s.whatsapp.net")).toEqual([
      "34600000000@s.whatsapp.net",
      "34600000000@s.whatsapp.net",
    ]);
  });

  it("maps a bare E.164 number to its DM JID, never a pattern", () => {
    const [a, b] = resolveChatJidCandidates("+34600000000");
    expect([a, b]).toEqual(["+34600000000", "34600000000@s.whatsapp.net"]);
    expect(`${a}${b}`).not.toContain("%");
  });
});

describe("cross-chat lookup scope", () => {
  const prev = process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT;
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT;
    } else {
      process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT = prev;
    }
  });

  it("is offered on owner-initiated turns", () => {
    delete process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT;
    expect(shouldOfferCrossChatLookup("owner-management")).toBe(true);
    expect(shouldOfferCrossChatLookup("outbound-draft")).toBe(true);
  });

  it("is off for contact-initiated auto-replies unless opted in", () => {
    delete process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT;
    expect(shouldOfferCrossChatLookup("outbound-auto-reply")).toBe(false);
    process.env.OPENCLAW_WHATSAPP_CROSS_CHAT_HINT = "all";
    expect(shouldOfferCrossChatLookup("outbound-auto-reply")).toBe(true);
  });

  it("renders chat-scoped hints when cross-chat is off", () => {
    const hint = buildThreadEscalationHint({
      chatJid: "x@s.whatsapp.net",
      oldestUnixSec: 0,
      allowCrossChat: false,
    });
    expect(hint).not.toContain("across all chats");
    expect(buildUnknownContactProtocolBlock({ allowCrossChat: false })).not.toContain("cross-chat");
    expect(buildUnknownContactProtocolBlock({ allowCrossChat: true })).toContain("cross-chat");
  });
});

describe("unknown-contact research", () => {
  it("is off unless OPENCLAW_WHATSAPP_CONTACT_RESEARCH=1", () => {
    expect(shouldOfferContactResearch(undefined)).toBe(false);
    expect(shouldOfferContactResearch("true")).toBe(false);
    expect(shouldOfferContactResearch("1")).toBe(true);
  });

  it("omits web lookup and people profiles by default", () => {
    const off = buildUnknownContactProtocolBlock({ allowCrossChat: true });
    expect(off).not.toContain("WebSearch");
    expect(off).not.toContain("memory/people/");
    const on = buildUnknownContactProtocolBlock({ allowCrossChat: true, allowResearch: true });
    expect(on).toContain("WebSearch");
    expect(on).toContain("memory/people/");
  });
});

describe("checkWhatsmeowBinaryOverride", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wm-bin-"));

  it("accepts an owner-controlled executable", () => {
    const bin = path.join(dir, "ok");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(checkWhatsmeowBinaryOverride(bin)).toBeNull();
  });

  it("rejects relative, missing, non-executable and group/world-writable paths", () => {
    expect(checkWhatsmeowBinaryOverride("relative/bin")).toMatch(/absolute/);
    expect(checkWhatsmeowBinaryOverride(path.join(dir, "missing"))).toMatch(/does not exist/);
    const noexec = path.join(dir, "noexec");
    writeFileSync(noexec, "x");
    chmodSync(noexec, 0o644);
    expect(checkWhatsmeowBinaryOverride(noexec)).toMatch(/not executable/);
    const writable = path.join(dir, "writable");
    writeFileSync(writable, "x");
    chmodSync(writable, 0o777);
    expect(checkWhatsmeowBinaryOverride(writable)).toMatch(/writable/);
  });
});
