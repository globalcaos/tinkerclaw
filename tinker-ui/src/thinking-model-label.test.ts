import { describe, expect, it } from "vitest";
import { detailedModelLabel } from "./thinking-model-label.js";

describe("detailedModelLabel", () => {
  it("keeps the three Opus versions apart", () => {
    expect(detailedModelLabel("claude-code/claude-opus-5-5")).toBe("Opus 5.5");
    expect(detailedModelLabel("claude-opus-5")).toBe("Opus 5");
    expect(detailedModelLabel("claude-code/claude-opus-4-8")).toBe("Opus 4.8");
  });

  it("names the other Claude families with their version", () => {
    expect(detailedModelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(detailedModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(detailedModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(detailedModelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  });

  it("gives every ChatGPT codename its GPT major", () => {
    expect(detailedModelLabel("openai-codex/gpt-6-sol")).toBe("GPT-6 Sol");
    expect(detailedModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(detailedModelLabel("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(detailedModelLabel("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(detailedModelLabel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(detailedModelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(detailedModelLabel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });

  it("separates Grok and Gemini versions", () => {
    expect(detailedModelLabel("xai/grok-4.7")).toBe("Grok 4.7");
    expect(detailedModelLabel("grok-4.6")).toBe("Grok 4.6");
    expect(detailedModelLabel("google/gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
  });

  it("returns empty for anything it has no rule for, so the caller falls back", () => {
    expect(detailedModelLabel("openrouter/moonshotai/kimi-k3")).toBe("");
    expect(detailedModelLabel("copilot/copilot-think-deeper")).toBe("");
    expect(detailedModelLabel("opus")).toBe("");
    expect(detailedModelLabel("")).toBe("");
  });
});
