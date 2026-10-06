import { describe, expect, it } from "vitest";
import { buildKeyedSteerMessage, steerPromptKey } from "./steer-message.js";

// FORK 2026-10-05 (bug-log `steer-written-twice`): the key a steered prompt's row carries.
describe("steerPromptKey / buildKeyedSteerMessage", () => {
  it("takes the buffer's last caller's key, the one the delivery row carried", () => {
    expect(steerPromptKey("stop for now", ["k1", "k2"])).toBe("k2");
    expect(steerPromptKey("stop for now", ["k1"])).toBe("k1");
  });

  it("leaves a slash command, or a prompt with no key, to AgentSession.steer", () => {
    expect(steerPromptKey("/skill run it", ["k1"])).toBeUndefined();
    expect(steerPromptKey("  /template", ["k1"])).toBeUndefined();
    expect(steerPromptKey("stop for now", [])).toBeUndefined();
    expect(steerPromptKey("stop for now", undefined)).toBeUndefined();
    expect(steerPromptKey("stop for now", [""])).toBeUndefined();
  });

  it("builds the message AgentSession.steer would queue, keyed", () => {
    expect(buildKeyedSteerMessage("stop for now", "k2", 1_234)).toEqual({
      role: "user",
      content: [{ type: "text", text: "stop for now" }],
      timestamp: 1_234,
      idempotencyKey: "k2",
    });
  });
});
