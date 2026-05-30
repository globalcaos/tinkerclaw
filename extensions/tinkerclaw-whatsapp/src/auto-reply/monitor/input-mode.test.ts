import { describe, expect, it } from "vitest";
import { buildInputModeBlock } from "./input-mode.js";

describe("buildInputModeBlock", () => {
  it("emits a [input-mode] block with mode=voice for voice-origin messages", () => {
    const block = buildInputModeBlock({ mode: "voice" });

    expect(block.startsWith("[input-mode]\n")).toBe(true);
    expect(block.endsWith("\n[/input-mode]")).toBe(true);
    expect(block).toContain("mode: voice");
  });

  it("instructs the agent to reply by voice", () => {
    const block = buildInputModeBlock({ mode: "voice" });
    expect(block.toLowerCase()).toContain("reply by voice");
  });

  it("documents the exceptions where text replies are still appropriate", () => {
    const block = buildInputModeBlock({ mode: "voice" });
    // Each exception class should be mentioned at least once so the agent can
    // recognize when NOT to use voice (written artifacts, code, structured data).
    expect(block).toMatch(/written artifact|write me|draft|list|table/i);
    expect(block).toMatch(/code|file paths|links|JSON|diff/i);
  });

  it("mentions the canonical TTS rendering path so the agent knows how to actually reply by voice", () => {
    const block = buildInputModeBlock({ mode: "voice" });
    expect(block).toMatch(/jarvis-wa|sherpa-onnx-tts|OGG\/Opus/i);
  });
});
