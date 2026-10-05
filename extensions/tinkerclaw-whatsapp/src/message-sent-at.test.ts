import { describe, expect, it } from "vitest";
import { forgetSentMessageId, trackSentMessageId } from "./inbound/sent-ids.js";
import { resolveWhatsAppMessageSentAtMs } from "./message-sent-at.js";

describe("resolveWhatsAppMessageSentAtMs", () => {
  it("knows when this process sent a message", () => {
    trackSentMessageId("sent-at-1", 1_790_000_000_000);
    expect(resolveWhatsAppMessageSentAtMs("sent-at-1")).toBe(1_790_000_000_000);
    forgetSentMessageId("sent-at-1");
  });

  it("returns undefined for an id nobody recorded", () => {
    expect(resolveWhatsAppMessageSentAtMs("never-seen")).toBeUndefined();
  });
});
