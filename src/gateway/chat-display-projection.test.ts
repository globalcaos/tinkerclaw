import { describe, expect, test } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";

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
