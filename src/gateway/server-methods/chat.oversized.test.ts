import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "./chat.js";

// FORK 2026-08-28 (R3: what the gateway answers must be what the chat shows).
//
// The 2026-08-25 block-shrink only ran when a message carried prose. A message with NO text block —
// a lone fat tool_result, which is the commonest shape — fell through to the whole-message
// placeholder "[chat.history omitted: message too large]", which discards the block's type, its
// name and its tool_use_id. tinker-ui's msgHasVisibleContent keys on tool_use / tool_result, so the
// row could not be rendered at all: the tool did not show up truncated, it VANISHED.
//
// Measured live before this fix: 6 of the 428 messages served for the dashboard session were such
// placeholders — six tool results the architect could never see. The 128 KB cap is not the bug and
// is deliberately unchanged; the requirement is that an omitted body still renders as an
// identifiable row carrying its type, its identity and the size of what was left out.

const CAP = 4096;
const HUGE = "A".repeat(20_000);
const PROSE = "Now looking at the actual render rather than trusting the string matches.";
const WHOLE_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

const toolResultOnly = () => ({
  role: "user",
  timestamp: 1_787_661_771_277,
  content: [{ type: "tool_result", tool_use_id: "toolu_01vanished", name: "Bash", content: HUGE }],
});

const firstBlock = (message: unknown): Record<string, unknown> =>
  (message as { content: Array<Record<string, unknown>> }).content[0];

describe("chat.history oversized truncation keeps the row", () => {
  it("does not raise the byte cap as the fix", () => {
    expect(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES).toBe(128 * 1024);
  });

  it("(a) still keeps the prose when an oversized image shares its message", () => {
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: PROSE },
            { type: "image", source: { type: "base64", media_type: "image/png", data: HUGE } },
          ],
        },
      ],
      maxSingleMessageBytes: CAP,
    });
    const serialized = JSON.stringify(messages);
    expect(replacedCount).toBe(0);
    expect(serialized).toContain(PROSE);
    expect(serialized).not.toContain(WHOLE_MESSAGE_PLACEHOLDER);
    expect(serialized).not.toContain(HUGE.slice(0, 256));
  });

  it("(b) keeps type, name, tool_use_id and a byte count when there is no prose to save", () => {
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [toolResultOnly()],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(0);
    expect(JSON.stringify(messages)).not.toContain(WHOLE_MESSAGE_PLACEHOLDER);
    const block = firstBlock(messages[0]);
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_01vanished");
    expect(block.name).toBe("Bash");
    expect(block.__openclaw).toMatchObject({ omitted: true, reason: "oversized" });
    const bytes = (block.__openclaw as { bytes: number }).bytes;
    expect(bytes).toBeGreaterThan(20_000);
    // The count must be readable in the row itself, not only in the metadata envelope.
    expect(String(block.content)).toContain(String(bytes));
  });

  it("(b) drops the oversized body and lands under the cap", () => {
    const { messages } = replaceOversizedChatHistoryMessages({
      messages: [toolResultOnly()],
      maxSingleMessageBytes: CAP,
    });
    expect(JSON.stringify(messages)).not.toContain(HUGE.slice(0, 256));
    expect(Buffer.byteLength(JSON.stringify(messages[0]), "utf8")).toBeLessThanOrEqual(CAP);
  });

  it("(b) keeps a tool_use's name and id when its input blows the cap", () => {
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_02", name: "Write", input: { text: HUGE } }],
        },
      ],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(0);
    const block = firstBlock(messages[0]);
    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("toolu_02");
    expect(block.name).toBe("Write");
    expect(JSON.stringify(messages)).not.toContain(HUGE.slice(0, 256));
  });

  it("(c) never changes the number of messages served", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      toolResultOnly(),
      { role: "assistant", content: [{ type: "text", text: PROSE }] },
      toolResultOnly(),
    ];
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: input,
      maxSingleMessageBytes: CAP,
    });
    expect(messages).toHaveLength(input.length);
    expect(replacedCount).toBe(0);
    expect(JSON.stringify(messages)).not.toContain(WHOLE_MESSAGE_PLACEHOLDER);
  });

  it("keeps the whole-message placeholder as the last resort for prose-only overflow", () => {
    // Not a regression: prose is never dropped, so a message oversized on text alone is genuinely
    // unrepresentable as a row and still degrades to the stub.
    const { messages, replacedCount } = replaceOversizedChatHistoryMessages({
      messages: [{ role: "assistant", content: [{ type: "text", text: HUGE }] }],
      maxSingleMessageBytes: CAP,
    });
    expect(replacedCount).toBe(1);
    expect(JSON.stringify(messages)).toContain(WHOLE_MESSAGE_PLACEHOLDER);
  });
});
