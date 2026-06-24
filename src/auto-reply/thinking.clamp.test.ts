import { beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: resolveSupportedThinkingLevel resolves a model's thinking profile purely through
// the provider plugin registry (src/plugins/provider-thinking.js). In a bare unit test that
// registry is EMPTY, so without mocking every model collapses to the BASE profile
// (off..high) and nothing above `high` is reachable. The xhigh ceiling of gpt-5.5 and the
// `max` ceiling of claude-opus-4-8 are runtime provider facts (the openai plugin advertises
// xhigh for gpt-5.2+, and claudeCodeThinkingProfile() admits `max`). We therefore mock
// ../plugins/provider-thinking.js exactly like thinking.test.ts and feed it the faithful
// per-provider profiles, then assert the clamp behavior of resolveSupportedThinkingLevel.
const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderThinkingProfile: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
}));

let resolveSupportedThinkingLevel: typeof import("./thinking.js").resolveSupportedThinkingLevel;

async function loadFreshThinkingModuleForTest() {
  vi.resetModules();
  vi.doMock("../plugins/provider-thinking.js", () => ({
    resolveProviderBinaryThinking: providerRuntimeMocks.resolveProviderBinaryThinking,
    resolveProviderDefaultThinkingLevel: providerRuntimeMocks.resolveProviderDefaultThinkingLevel,
    resolveProviderThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
    resolveProviderXHighThinking: providerRuntimeMocks.resolveProviderXHighThinking,
  }));
  return await import("./thinking.js");
}

beforeEach(async () => {
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReset();
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReset();
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(undefined);

  // openai/gpt-5.5 tops out at xhigh (no `max`); claude-code/claude-opus-4-8 admits `max`.
  providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
    ({ provider, context }) => {
      if (provider === "openai" && context.modelId === "gpt-5.5") {
        return {
          levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
        };
      }
      if (provider === "claude-code" && context.modelId === "claude-opus-4-8") {
        return {
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "xhigh" },
            { id: "max" },
          ],
        };
      }
      return undefined;
    },
  );

  ({ resolveSupportedThinkingLevel } = await loadFreshThinkingModuleForTest());
});

describe("resolveSupportedThinkingLevel clamping", () => {
  it("clamps an unsupported max down to the model's xhigh ceiling (openai/gpt-5.5)", () => {
    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-5.5",
        level: "max",
      }),
    ).toBe("xhigh");
  });

  it("returns a supported level unchanged (openai/gpt-5.5 + high)", () => {
    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-5.5",
        level: "high",
      }),
    ).toBe("high");
  });

  it("keeps max for a max-supporting model (claude-code/claude-opus-4-8)", () => {
    expect(
      resolveSupportedThinkingLevel({
        provider: "claude-code",
        model: "claude-opus-4-8",
        level: "max",
      }),
    ).toBe("max");
  });
});
