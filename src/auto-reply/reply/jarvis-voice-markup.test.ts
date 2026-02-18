import { describe, expect, it } from "vitest";
import { applyJarvisVoiceMarkup } from "./jarvis-voice-markup.js";

describe("applyJarvisVoiceMarkup", () => {
  it("wraps plain text after **Jarvis:**", () => {
    const input = "**Jarvis:** Good morning sir.";
    const result = applyJarvisVoiceMarkup(input);
    expect(result).toBe('**Jarvis:** <span class="jarvis-voice">Good morning sir.</span>');
  });

  it("leaves already-wrapped text unchanged", () => {
    const input = '**Jarvis:** <span class="jarvis-voice">Good morning sir.</span>';
    const result = applyJarvisVoiceMarkup(input);
    expect(result).toBe(input);
  });

  it("returns text unchanged when no Jarvis label", () => {
    const input = "Just a normal reply without voice.";
    expect(applyJarvisVoiceMarkup(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(applyJarvisVoiceMarkup("")).toBe("");
  });

  it("handles Jarvis label in middle of text", () => {
    const input = "Some preamble.\n\n**Jarvis:** The analysis is complete.";
    const result = applyJarvisVoiceMarkup(input);
    expect(result).toContain('<span class="jarvis-voice">The analysis is complete.</span>');
    expect(result).toContain("Some preamble.");
  });

  it("handles multiple Jarvis labels", () => {
    const input = "**Jarvis:** First thing.\n\n**Jarvis:** Second thing.";
    const result = applyJarvisVoiceMarkup(input);
    expect(result).toContain('<span class="jarvis-voice">First thing.</span>');
    expect(result).toContain('<span class="jarvis-voice">Second thing.</span>');
  });

  it("is case insensitive on the label", () => {
    const input = "**JARVIS:** Hello.";
    const result = applyJarvisVoiceMarkup(input);
    expect(result).toContain('<span class="jarvis-voice">Hello.</span>');
  });
});
