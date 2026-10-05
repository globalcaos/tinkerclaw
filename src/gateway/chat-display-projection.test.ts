import { describe, expect, test } from "vitest";
import {
  projectChatDisplayMessages,
  projectRecentChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "./chat-display-projection.js";

// Regression: duplicated assistant bubbles after a gateway restart mid-turn.
// The restart persists a streamed partial as an abort echo (openclawAbort.aborted),
// then the resumed reply is persisted separately. suppressSupersededAbortEchoes
// drops the echo when the resumed reply begins with it — but it compared with a
// bare .trim(), so a respawn that re-streamed the reply with different newlines/
// indentation defeated startsWith() and BOTH bubbles leaked. The compare now
// collapses whitespace (and is bidirectional). See double-response-rootcause.
describe("chat-display-projection abort-echo supersede", () => {
  const assistantTexts = (messages: unknown[]): string[] =>
    (messages as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>)
      .filter((m) => m.role === "assistant")
      .map((m) => (m.content ?? []).find((b) => b.type === "text")?.text ?? "");

  test("echo is suppressed when the resumed reply differs only by whitespace", () => {
    const echo = "On it.\nLet me check\n\nthe file.";
    const resumed = "On it. Let me check the file. Here is the answer.";
    const out = projectChatDisplayMessages(
      [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        {
          role: "assistant",
          openclawAbort: { aborted: true },
          content: [{ type: "text", text: echo }],
        },
        { role: "assistant", content: [{ type: "text", text: resumed }] },
      ],
      { stripEnvelope: false },
    );
    expect(assistantTexts(out)).toEqual([resumed]);
  });

  test("a genuinely aborted echo with no resumed reply is kept", () => {
    const echo = "Partial thought before the interruption.";
    const out = projectChatDisplayMessages(
      [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        {
          role: "assistant",
          openclawAbort: { aborted: true },
          content: [{ type: "text", text: echo }],
        },
      ],
      { stripEnvelope: false },
    );
    expect(assistantTexts(out)).toEqual([echo]);
  });
});

// Regression: long structured assistant answers (💬 ANSWER → 🧠 AMYGDALA →
// 🌿 FRACTAL) were silently cut at the tail. Root cause was the 8_000-char
// display cap in chat-display-projection truncating the visible answer text,
// so the AMYGDALA/FRACTAL sections never reached the UI (even on reload). The
// per-message 128KB byte backstop is the real ceiling; visible text must not
// be cut by the redundant char cap. See response-truncation-bookmark memory.
describe("chat-display-projection visible-text cap", () => {
  test("a 12k-char assistant answer keeps its FRACTAL tail (no 8k cut)", () => {
    const answer =
      "💬 ANSWER\n\n" +
      "x".repeat(11_000) +
      "\n\n🧠 AMYGDALA\n\nprudence note\n\n🌿 FRACTAL\n\nIMPROVE — tail marker";
    expect(answer.length).toBeGreaterThan(8_000);
    const [out] = sanitizeChatHistoryMessages([
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ]) as Array<{ content: Array<{ type: string; text: string }> }>;
    const text = out.content.find((b) => b.type === "text")?.text ?? "";
    expect(text).not.toContain("...(truncated)...");
    expect(text).toContain("🌿 FRACTAL");
    expect(text).toContain("IMPROVE — tail marker");
  });

  test("oversized thinking is still capped (noise stays tight)", () => {
    const [out] = sanitizeChatHistoryMessages([
      { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(20_000) }] },
    ]) as Array<{ content: Array<{ type: string; thinking: string }> }>;
    const thinking = out.content.find((b) => b.type === "thinking")?.thinking ?? "";
    expect(thinking).toContain("...(truncated)...");
  });
});

// FORK 2026-09-23 (M20, chat.history rehaul task 2, Step 4) — `readSessionMessages` now caches
// its parsed transcript and hands the SAME message objects out on every cache hit (only the
// containing array is a fresh copy each call — see session-utils.fs.ts). `chat.history`
// (server-methods/chat.ts) runs `projectRecentChatDisplayMessages(rawMessages, {...})` immediately
// after `augmentChatHistoryWithCliSessionImports` — that IS the projection under test here. If any
// step along that path mutated a message object in place instead of copying it, the second
// (cached) serve of the same session would silently hand out corrupted history. Deep-freezing the
// input stands in for the cache's shared objects: a real mutation throws (strict mode) instead of
// quietly poisoning the next cache hit.
describe("chat-display-projection does not mutate its input (cache safety)", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.getOwnPropertyNames(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    return value;
  }

  test("projectRecentChatDisplayMessages does not throw on a deep-frozen realistic message array", () => {
    const messages: unknown[] = [
      { role: "user", content: "plain string user message" },
      { role: "user", content: [{ type: "text", text: "array-content user message" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t".repeat(50), thinkingSignature: "sig" },
          { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
          { type: "text", text: "the answer" },
        ],
        usage: { input: 10, output: 20 },
        cost: { total: 0.01 },
        details: { raw: true },
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      {
        role: "assistant",
        openclawAbort: { aborted: true },
        content: [{ type: "text", text: "partial echo before interrupt" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial echo before interrupt, resumed" }],
      },
      { role: "user", content: [{ type: "image", data: "base64data", mimeType: "image/png" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "imported turn" }],
        __openclaw: { seq: 8, importedFrom: "claude-cli" },
      },
    ];
    const frozen = deepFreeze(messages);

    expect(() =>
      projectRecentChatDisplayMessages(frozen, { maxChars: 8_000, maxMessages: 3 }),
    ).not.toThrow();

    // Sanity: the frozen input is genuinely untouched (not just "didn't throw synchronously").
    expect(Object.isFrozen(messages[2])).toBe(true);
    expect(
      ((messages[2] as { content: Array<{ text?: string }> }).content[2] as { text: string }).text,
    ).toBe("the answer");
  });
});
