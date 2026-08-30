import { describe, expect, test } from "vitest";
import { LOCAL_TAIL_FLOOR, limitChatDisplayMessages } from "./chat-display-projection.js";

// FORK 2026-08-26 regression: chat.history merges the local OpenClaw store (ONE
// coalesced message per completed turn) with imported claude-cli transcripts
// (one message per tool-loop STEP). A tool-heavy turn floods the tail with
// hundreds of import records carrying the newest timestamps, and the old blind
// tail slice in limitChatDisplayMessages served windows that were 95-100%
// tool-loop import — the user's real conversation was entirely absent at every
// requested limit (measured live: 24 real turns on disk, ~0 served). The
// limiter now guarantees the newest LOCAL_TAIL_FLOOR local messages (no
// __openclaw.importedFrom) survive; imports only fill the remaining budget.

type TestMessage = Record<string, unknown>;

function localMsg(i: number, timestamp: number): TestMessage {
  return {
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `local-${i}` }],
    timestamp,
  };
}

function importedMsg(i: number, timestamp: number): TestMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `import-${i}` }],
    timestamp,
    __openclaw: { importedFrom: "claude-cli", externalId: `ext-${i}` },
  };
}

function isImported(message: TestMessage): boolean {
  const meta = message.__openclaw as { importedFrom?: unknown } | undefined;
  return Boolean(meta && meta.importedFrom != null);
}

function timestampsOf(messages: TestMessage[]): number[] {
  return messages.map((m) => m.timestamp as number);
}

// CONTROL: the behaviour the fix replaces. Every "the floor saves the
// conversation" assertion below is paired with this, so the test cannot pass
// against a limiter that never learned the difference — first we show the old
// blind tail slice really does serve zero real turns, then that the new one
// does not.
function legacyTailSlice(messages: TestMessage[], maxMessages: number): TestMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(-Math.floor(maxMessages));
}

describe("limitChatDisplayMessages local-tail floor", () => {
  test("LOCAL_TAIL_FLOOR is the documented 24-turn guarantee", () => {
    expect(LOCAL_TAIL_FLOOR).toBe(24);
  });

  test("40 imported + 4 local, maxMessages=10 -> all 4 local messages survive", () => {
    const local = [0, 1, 2, 3].map((i) => localMsg(i, 100 + i));
    const imported = Array.from({ length: 40 }, (_, i) => importedMsg(i, 1_000 + i));
    const messages = [...local, ...imported];

    // CONTROL: the old blind tail slice serves ZERO of the 4 real turns.
    expect(legacyTailSlice(messages, 10).filter((m) => !isImported(m))).toEqual([]);

    const out = limitChatDisplayMessages(messages, 10);
    expect(out).toHaveLength(10);
    expect(out.filter((m) => !isImported(m))).toEqual(local);
    // The remaining budget is filled with the NEWEST imports.
    expect(timestampsOf(out.filter(isImported))).toEqual([
      1_034, 1_035, 1_036, 1_037, 1_038, 1_039,
    ]);
  });

  test("an all-local input is byte-identical to the legacy tail slice", () => {
    const messages = Array.from({ length: 30 }, (_, i) => localMsg(i, i));
    const out = limitChatDisplayMessages(messages, 10);
    expect(JSON.stringify(out)).toBe(JSON.stringify(messages.slice(-10)));
  });

  test("an all-imported input is byte-identical to the legacy tail slice", () => {
    const messages = Array.from({ length: 30 }, (_, i) => importedMsg(i, i));
    const out = limitChatDisplayMessages(messages, 10);
    expect(JSON.stringify(out)).toBe(JSON.stringify(messages.slice(-10)));
  });

  test("output ordering stays chronological when local and imported interleave", () => {
    const messages: TestMessage[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push(i % 5 === 0 ? localMsg(i, i) : importedMsg(i, i));
    }
    const out = limitChatDisplayMessages(messages, 20);
    expect(out).toHaveLength(20);
    const ts = timestampsOf(out);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // All 12 locals fit under the floor, so every one survives.
    expect(out.filter((m) => !isImported(m))).toHaveLength(12);
  });

  test("realistic shape: 350 imported + 24 local, maxMessages=1000 -> all 24 local present", () => {
    const local = Array.from({ length: 24 }, (_, i) => localMsg(i, 100 + i));
    const imported = Array.from({ length: 350 }, (_, i) => importedMsg(i, 10_000 + i));
    const messages = [...local, ...imported];
    const out = limitChatDisplayMessages(messages, 1_000);
    // 374 <= 1000: the limiter never truncates, everything survives.
    expect(out).toBe(messages);
    expect(out.filter((m) => !isImported(m))).toHaveLength(24);

    // CONTROL at the squeezed limit: the old tail slice serves zero real turns.
    expect(legacyTailSlice(messages, 100).filter((m) => !isImported(m))).toEqual([]);

    // The same shape squeezed to 100 STILL keeps every real turn — this is the
    // exact live failure shape (24 real turns on disk, ~0 served).
    const squeezed = limitChatDisplayMessages(messages, 100);
    expect(squeezed).toHaveLength(100);
    expect(squeezed.filter((m) => !isImported(m))).toEqual(local);
  });

  test("a budget below the floor gives the whole window to local messages", () => {
    const local = Array.from({ length: 30 }, (_, i) => localMsg(i, 100 + i));
    const imported = Array.from({ length: 200 }, (_, i) => importedMsg(i, 10_000 + i));
    const out = limitChatDisplayMessages([...local, ...imported], 10);
    expect(out).toHaveLength(10);
    expect(out.every((m) => !isImported(m))).toBe(true);
    // The 10 NEWEST local messages take the window.
    expect(timestampsOf(out)).toEqual([120, 121, 122, 123, 124, 125, 126, 127, 128, 129]);
  });

  test("the floor never exceeds the requested window size", () => {
    const local = Array.from({ length: 30 }, (_, i) => localMsg(i, 100 + i));
    const imported = Array.from({ length: 200 }, (_, i) => importedMsg(i, 10_000 + i));
    const messages = [...local, ...imported];
    for (const limit of [1, 2, 5, 10, 24, 25, 50, 100, 229]) {
      expect(limitChatDisplayMessages(messages, limit)).toHaveLength(limit);
    }
  });
});
