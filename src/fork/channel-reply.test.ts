import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { readChannelReplyStamp, resolveChannelReplyTexts } from "./channel-reply.js";

// FORK 2026-10-02 (channel-reply). The 15:46 turn in the WhatsApp group "I've got special
// powers": the bridge's final message, as stored in the transcript (one thinking part, one
// 1004-char text part), plus the stamp the bridge now puts on it for a WhatsApp run.
const NARRATION =
  "Reading the gifgrep skill instructions to find a mic-drop GIF the right way." +
  'Searching Tenor/Giphy for "mic drop" GIFs to pick one for the group.' +
  "Tenor's demo key returned 403; trying Giphy as the source instead." +
  `No GIF API keys are set, so I'll pull candidate IDs from Giphy's public search page for "mic drop".` +
  "The page downloaded but my pattern missed; looking for any giphy media IDs in the HTML with a looser match." +
  "The Obama mic drop (id `3o7qDSOvfaCO9b3MlO`) is the classic. Checking how the WhatsApp channel ships a GIF, so it arrives animated and not as a still." +
  "Only type stubs matched; looking inside the WhatsApp extension for what it does with a `.gif` or `gifPlayback` on send." +
  "Looking at the extracted frame to confirm it really is the Obama mic drop before it goes to the group." +
  'Right clip: Obama, "Obama out", 2.9 s. Loading the message tool so I can send it as an auto-looping GIF.' +
  `Sending the mic-drop clip to the "I've got special powers" group as an auto-looping GIF, with no caption.`;
const TEXT = `${NARRATION}NO_REPLY`;

function bridgeMessage(text: string, channelReply?: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The GIF is sent; nothing to add in the group." },
      { type: "text", text },
    ],
    api: "anthropic-messages",
    provider: "claude-code",
    model: "claude-opus-5-5",
    usage: {
      input: 10,
      output: 3957,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3967,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_790_948_766_624,
    ...(channelReply ? { channelReply } : {}),
  } as AssistantMessage;
}

/** What run.ts does: resolve the texts against the current attempt's message, then build. */
function deliveredPayloads(message: AssistantMessage) {
  const { assistantTexts } = resolveChannelReplyTexts({
    assistantTexts: [textOf(message)],
    assistant: message,
  });
  return buildEmbeddedRunPayloads({
    assistantTexts,
    toolMetas: [],
    lastAssistant: message,
    sessionKey: "agent:main:whatsapp:group:120363050081077836@g.us",
    inlineToolResultsAllowed: false,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
  });
}

function textOf(message: AssistantMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("channel reply: the 15:46 mic-drop turn", () => {
  it("delivers nothing when the bridge stamped the turn silent", () => {
    expect(TEXT).toHaveLength(1004);
    expect(deliveredPayloads(bridgeMessage(TEXT, { kind: "silent", textLength: 1004 }))).toEqual(
      [],
    );
  });

  it("is the narration leak without the stamp (what the group received)", () => {
    const payloads = deliveredPayloads(bridgeMessage(TEXT));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(TEXT);
  });

  it("delivers only the answer when the bridge stamped a final segment", () => {
    const narration =
      "Running the draft reply to Luís through the `human-voice` checker and noting what this group is like in its chat-profile notes file.";
    const answer = "Imposible, güey, no tengo boca, lo mío es soltar micrófonos 🎤";
    const text = `${narration}${answer}`;
    const payloads = deliveredPayloads(
      bridgeMessage(text, { kind: "final", from: narration.length, textLength: text.length }),
    );
    expect(payloads.map((payload) => payload.text)).toEqual([answer]);
  });
});

describe("resolveChannelReplyTexts", () => {
  it("passes texts through when the message carries no stamp", () => {
    expect(
      resolveChannelReplyTexts({ assistantTexts: ["a", "b"], assistant: bridgeMessage("ab") }),
    ).toStrictEqual({ assistantTexts: ["a", "b"] });
  });

  it("ignores a stamp whose length no longer matches the text", () => {
    expect(
      resolveChannelReplyTexts({
        assistantTexts: [TEXT],
        assistant: bridgeMessage(TEXT, { kind: "silent", textLength: 1003 }),
      }),
    ).toStrictEqual({ assistantTexts: [TEXT], applied: "length-mismatch" });
  });

  it("passes texts through when there is no current attempt message", () => {
    expect(resolveChannelReplyTexts({ assistantTexts: [TEXT], assistant: undefined })).toEqual({
      assistantTexts: [TEXT],
    });
  });
});

describe("readChannelReplyStamp", () => {
  it("rejects malformed stamps", () => {
    for (const channelReply of [
      { kind: "silent" },
      { kind: "final", textLength: 10 },
      { kind: "final", from: 11, textLength: 10 },
      { kind: "final", from: -1, textLength: 10 },
      { kind: "whole", textLength: 10 },
      "silent",
    ]) {
      expect(readChannelReplyStamp({ channelReply })).toBeUndefined();
    }
  });
});
