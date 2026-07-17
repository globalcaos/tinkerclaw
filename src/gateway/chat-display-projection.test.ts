import { describe, expect, test } from "vitest";
import {
  projectChatDisplayMessages,
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
