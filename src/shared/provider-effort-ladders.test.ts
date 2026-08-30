import { describe, expect, it } from "vitest";
import { resolveProviderEffortLadder } from "./provider-effort-ladders.js";

// These assertions are the anti-drift mechanism described at the top of
// provider-effort-ladders.ts. Each one mirrors a provider plugin's declared
// thinking profile; if a plugin changes its ladder, the corresponding case here
// should be updated IN THE SAME CHANGE, because the chart draws whatever this
// module says and a stale row becomes a picture that lies.

describe("xAI grok-4.6 has a real reasoning_effort ladder", () => {
  it("is low/medium/high/xhigh — the vendor page, not the stale plugin", () => {
    const l = resolveProviderEffortLadder("xai", "grok-4.6");
    expect(l.kind).toBe("graded");
    expect(l.levels).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("grok-4.5 stops at high — xhigh is treated as high", () => {
    expect(resolveProviderEffortLadder("xai", "grok-4.5").levels).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
  it("older grok stays none", () => {
    expect(resolveProviderEffortLadder("xai", "grok-4").kind).toBe("none");
  });
});

describe("binary-thinking providers stay a switch except the 2026-08-27 graded models", () => {
  it("GLM-5.2 is still a switch", () => {
    expect(resolveProviderEffortLadder("zai", "glm-5.2").kind).toBe("binary");
  });
  it("GLM-5.3 is low/high/max, thinking always on", () => {
    expect(resolveProviderEffortLadder("zai", "glm-5.3").levels).toEqual(["low", "high", "max"]);
  });
  it("Kimi K3 is low/high/max, thinking always on", () => {
    expect(resolveProviderEffortLadder("moonshot", "kimi-k3").levels).toEqual([
      "low",
      "high",
      "max",
    ]);
  });
});

describe("Anthropic", () => {
  it("gives Opus 5 / Fable 5 / Sonnet 5 / Opus 4.8 / Opus 4.7 the vendor low→max ladder", () => {
    expect(resolveProviderEffortLadder("claude-code", "claude-opus-5").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(resolveProviderEffortLadder("claude-code", "claude-opus-4-7").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("Sonnet 4.6 has max but not xhigh", () => {
    expect(resolveProviderEffortLadder("claude-code", "claude-sonnet-4-6").levels).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });
});

describe("OpenAI GPT-5.6 has max; older xhigh stays an allow-list", () => {
  it("grants xhigh to gpt-5.4", () => {
    expect(resolveProviderEffortLadder("openai", "gpt-5.4").levels).toContain("xhigh");
  });

  it("gives GPT-5.6 low→max including xhigh and max", () => {
    expect(resolveProviderEffortLadder("openai", "gpt-5.6-sol").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("the re-seller's ladder wins over the lab's", () => {
  it("gives a Claude model served by Copilot the Copilot ladder", () => {
    const l = resolveProviderEffortLadder("github-copilot", "claude-opus-4.7");
    // Copilot's list has no claude entry, so no xhigh — and crucially NOT
    // Anthropic's Opus-4.7 xhigh+max ladder.
    expect(l.levels).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Google", () => {
  it("gives Gemini 3 Pro only low and high", () => {
    expect(resolveProviderEffortLadder("google", "gemini-3-pro").levels).toEqual(["low", "high"]);
  });

  it("never plots adaptive, because the model picks that budget itself", () => {
    for (const id of ["gemini-3-pro", "gemini-2.5-flash"]) {
      expect(resolveProviderEffortLadder("google", id).levels).not.toContain("adaptive");
    }
  });
});

describe("the catalog tail", () => {
  it("returns unknown rather than a default ladder", () => {
    const l = resolveProviderEffortLadder("openrouter", "qwen/qwen3.8-max");
    expect(l.kind).toBe("unknown");
    expect(l.levels).toEqual([]);
  });

  it("forwards an OpenRouter Kimi K3 id to Moonshot's vendor ladder", () => {
    expect(resolveProviderEffortLadder("openrouter", "moonshotai/kimi-k3").levels).toEqual([
      "low",
      "high",
      "max",
    ]);
  });
});

describe("OpenRouter forwards a named lab's vendor ladder", () => {
  it("gives an OpenRouter Claude the Anthropic effort table, not a guess", () => {
    expect(resolveProviderEffortLadder("openrouter", "anthropic/claude-opus-4-7").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
  it("still refuses to invent a ladder for a lab we have no page for", () => {
    expect(resolveProviderEffortLadder("openrouter", "qwen/qwen3.8-max").kind).toBe("unknown");
  });
});
