import { describe, expect, it } from "vitest";
import {
  buildHumorBlock,
  extractSpokenLine,
  jokesOff,
  lastTurnReplyText,
  reactionTo,
} from "../src/spoken-line.js";

describe("the spoken line (J7 v4.9 §9, 2026-10-01)", () => {
  it("finds the purple line in a reply", () => {
    expect(extractSpokenLine("**Jarvis:** *Four hours, one comma.*\n\nThe fix is in.")).toBe(
      "Four hours, one comma.",
    );
    expect(extractSpokenLine("No purple line here.")).toBeUndefined();
    expect(extractSpokenLine(undefined)).toBeUndefined();
  });

  it("reads explicit reactions; 'not funny' wins over 'funny'", () => {
    expect(reactionTo("hahaha good one")).toBe("laughed");
    expect(reactionTo("jajaja")).toBe("laughed");
    expect(reactionTo("😂 ok now fix the build")).toBe("laughed");
    expect(reactionTo("that was not funny")).toBe("not-funny");
    expect(reactionTo("please, no jokes today")).toBe("not-funny");
    expect(reactionTo("Ok, what about your humor?")).toBe("no-reaction");
  });

  it("switches jokes off when he is frustrated or rushed, not on ordinary messages", () => {
    expect(jokesOff("it's still not working!!")).toBe(true);
    expect(jokesOff("again it doesn't show the button")).toBe(true);
    expect(jokesOff("nope.")).toBe(true);
    expect(jokesOff("WHY IS THIS BROKEN AGAIN")).toBe(true);
    expect(jokesOff("Ok, what about your humor? Revise the J7 paper and the TTS API")).toBe(false);
    expect(jokesOff("Keep improving Jev's prompts")).toBe(false);
  });

  it("collects the previous turn's assistant text across tool calls, and takes its last purple line", () => {
    const msgs = [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "**Jarvis:** *Old line.*" }] },
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file." },
          { type: "toolCall", id: "1" },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "**Jarvis:** *Fixed. The comma confessed.*\n\nDetails." }],
      },
    ];
    const text = lastTurnReplyText(msgs);
    expect(text).not.toContain("Old line");
    expect(extractSpokenLine(text)).toBe("Fixed. The comma confessed.");
    expect(lastTurnReplyText(undefined)).toBeUndefined();
  });

  it("the block says whether a joke is welcome and lists recent lines with reactions", () => {
    const off = buildHumorBlock({ jokesOff: true, recent: [] });
    expect(off).toMatch(/NO JOKE/);
    const on = buildHumorBlock({
      jokesOff: false,
      recent: [{ ts: 1, sessionKey: "k", line: "Four hours, one comma.", reaction: "laughed" }],
    });
    expect(on).toMatch(/one line in three/);
    expect(on).toContain('"Four hours, one comma." → he laughed');
  });
});
