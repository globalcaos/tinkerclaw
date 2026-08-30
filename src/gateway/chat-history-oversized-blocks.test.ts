import { describe, expect, it } from "vitest";
import { replaceOversizedChatHistoryMessages } from "./server-methods/chat.js";

// FORK 2026-08-25 (the architect: "the intermediate thinking gets deleted in the chat").
//
// chat.history replaced the ENTIRE content of any message over the per-message cap with
// "[chat.history omitted: message too large]". A message goes over that cap because of one heavy
// block — a screenshot's base64, a tool_result carrying a file — but the narration text sitting in
// the same message is a few hundred bytes and is innocent. It was thrown away with the image.
//
// The client cannot undo it: a frozen streamed bubble carries no CLIENT_ONLY flag, so loadChat's
// `messages = incoming` swaps the good on-screen copy for the stub. That reload is deferred during
// a live turn and released the moment the turn ends — which is why interrupting a turn is when the
// text visibly disappears.
//
// Measured live on 2026-08-25 before the fix: 6 such placeholders in one Tinker tab, 4 in another.

const CAP = 4096;
const HUGE = "A".repeat(20_000);
const PROSE = "Now looking at the actual render rather than trusting the string matches.";

const msgWithScreenshot = () => ({
  role: "assistant",
  timestamp: 1_787_661_771_277,
  content: [
    { type: "text", text: PROSE },
    { type: "image", source: { type: "base64", media_type: "image/png", data: HUGE } },
  ],
});

describe("replaceOversizedChatHistoryMessages (deleted intermediate thinking)", () => {
  it("keeps the narration when an oversized image shares its message", () => {
    const { messages } = replaceOversizedChatHistoryMessages({
      messages: [msgWithScreenshot()],
      maxSingleMessageBytes: CAP,
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(PROSE);
    expect(serialized).not.toContain("[chat.history omitted: message too large]");
    expect(serialized).not.toContain(HUGE.slice(0, 256));
  });

  it("brings the message back under the cap", () => {
    const { messages } = replaceOversizedChatHistoryMessages({
      messages: [msgWithScreenshot()],
      maxSingleMessageBytes: CAP,
    });
    expect(Buffer.byteLength(JSON.stringify(messages[0]), "utf8")).toBeLessThanOrEqual(CAP);
  });

  it("does not count a shrunk message as a dropped one", () => {
    const { replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [msgWithScreenshot()],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(0);
  });

  it("keeps a tool_result's id so the UI can still pair it with its call", () => {
    const { messages } = replaceOversizedChatHistoryMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: PROSE },
            { type: "tool_result", tool_use_id: "toolu_abc123", content: HUGE },
          ],
        },
      ],
      maxSingleMessageBytes: CAP,
    });
    expect(JSON.stringify(messages)).toContain("toolu_abc123");
    expect(JSON.stringify(messages)).toContain(PROSE);
  });

  it("drops only as many heavy blocks as the cap requires", () => {
    const small = "B".repeat(200);
    const { messages } = replaceOversizedChatHistoryMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: PROSE },
            { type: "image", source: { data: small } },
            { type: "image", source: { data: HUGE } },
          ],
        },
      ],
      maxSingleMessageBytes: CAP,
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(small); // the small one survives
    expect(serialized).not.toContain(HUGE.slice(0, 256));
  });

  it("keeps the tool row when there is no prose to save", () => {
    // SUPERSEDED 2026-08-28 — this case used to assert the opposite ("still uses the whole-message
    // placeholder when there is no prose to save"), on the reasoning that a lone giant tool_result
    // has no reader-visible text to lose. That reasoning was wrong: the placeholder also discards
    // the block's type, name and tool_use_id, and tinker-ui decides a bubble is renderable from
    // exactly those — so the row did not render truncated, it vanished from the transcript. Six of
    // the 428 messages served for the dashboard session were such stubs. See
    // src/gateway/server-methods/chat.oversized.test.ts for the full contract.
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [
        { role: "assistant", content: [{ type: "tool_result", tool_use_id: "t1", content: HUGE }] },
      ],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(0);
    expect(JSON.stringify(messages)).not.toContain("[chat.history omitted: message too large]");
    expect(JSON.stringify(messages)).not.toContain(HUGE.slice(0, 256));
    expect(JSON.stringify(messages)).toContain("t1");
  });

  it("never touches a message already under the cap", () => {
    const fine = [{ role: "assistant", content: [{ type: "text", text: PROSE }] }];
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: fine,
      maxSingleMessageBytes: CAP,
    });
    expect(messages).toBe(fine);
    expect(replacedCount).toBe(0);
  });

  it("falls back to the placeholder when the text alone blows the cap", () => {
    const { replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [{ role: "assistant", content: [{ type: "text", text: HUGE }] }],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(1);
  });
});
