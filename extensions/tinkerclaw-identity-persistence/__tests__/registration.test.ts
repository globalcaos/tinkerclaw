/**
 * FORK: Registration tests for Identity Persistence plugin hooks.
 *
 * Verifies that the plugin registers the correct hooks (before_prompt_build,
 * llm_output) and that the before_prompt_build handler returns a persona block.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Build a minimal mock of OpenClawPluginApi that captures hook registrations.
 */
function createMockApi(overrides: Record<string, unknown> = {}) {
  const onHook = vi.fn();
  return {
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: { syncScoreThreshold: 0.6, evaluationInterval: 10 },
      rootDir: __dirname,
      config: { agents: { defaults: { name: "TestAgent" } } },
      registerTool: vi.fn(),
      registerGatewayMethod: vi.fn(),
      on: onHook,
      ...overrides,
    },
    onHook,
  };
}

describe("Plugin Registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers before_prompt_build and llm_output hooks", async () => {
    const { api, onHook } = createMockApi();

    const mod = await import("../index.js");
    const entry = mod.default;
    if (entry && typeof entry === "object" && "register" in entry) {
      (entry as { register: (a: unknown) => void }).register(api);
    }

    const hookNames = onHook.mock.calls.map(([name]: [string, ...unknown[]]) => name);
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("llm_output");

    // Should have exactly 1 before_prompt_build and 2 llm_output handlers
    const promptBuildCount = hookNames.filter((n: string) => n === "before_prompt_build").length;
    const llmOutputCount = hookNames.filter((n: string) => n === "llm_output").length;
    expect(promptBuildCount).toBe(1);
    expect(llmOutputCount).toBe(2);
  });

  it("before_prompt_build is registered with priority 100", async () => {
    const { api, onHook } = createMockApi();

    const mod = await import("../index.js");
    const entry = mod.default;
    if (entry && typeof entry === "object" && "register" in entry) {
      (entry as { register: (a: unknown) => void }).register(api);
    }

    // Find the before_prompt_build registration call
    const promptBuildCall = onHook.mock.calls.find(
      ([name]: [string, ...unknown[]]) => name === "before_prompt_build",
    );
    expect(promptBuildCall).toBeDefined();

    // Third argument should be the options object with priority
    const options = promptBuildCall?.[2] as { priority?: number } | undefined;
    expect(options?.priority).toBe(100);
  });

  it("before_prompt_build returns persona block in prependSystemContext", async () => {
    let promptBuildHandler: Function | null = null;
    const { api } = createMockApi({
      on: vi.fn((name: string, handler: Function, _opts?: Record<string, unknown>) => {
        if (name === "before_prompt_build") {
          promptBuildHandler = handler;
        }
      }),
    });

    const mod = await import("../index.js");
    const entry = mod.default;
    if (entry && typeof entry === "object" && "register" in entry) {
      (entry as { register: (a: unknown) => void }).register(api);
    }

    expect(promptBuildHandler).not.toBeNull();

    const result = await promptBuildHandler!(
      { prompt: "Hello" },
      { sessionKey: "agent:main:main" },
    );

    expect(result).toBeDefined();
    expect(typeof result.prependSystemContext).toBe("string");
    expect(result.prependSystemContext.length).toBeGreaterThan(0);
    // Should contain the agent name from config
    expect(result.prependSystemContext).toContain("TestAgent");
  });

  it("llm_output SyncScore handler increments turn counter", async () => {
    const llmOutputHandlers: Function[] = [];
    const { api } = createMockApi({
      on: vi.fn((name: string, handler: Function, _opts?: Record<string, unknown>) => {
        if (name === "llm_output") {
          llmOutputHandlers.push(handler);
        }
      }),
    });

    const mod = await import("../index.js");
    const entry = mod.default;
    if (entry && typeof entry === "object" && "register" in entry) {
      (entry as { register: (a: unknown) => void }).register(api);
    }

    expect(llmOutputHandlers.length).toBe(2);

    // Both handlers should accept text payload without throwing
    for (const handler of llmOutputHandlers) {
      await expect(
        handler({ text: "Test response" }, { sessionKey: "agent:main:main" }),
      ).resolves.not.toThrow();
    }
  });

  it("logs ready message with persona name", async () => {
    const infoSpy = vi.fn();
    const { api } = createMockApi({
      logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() },
    });

    const mod = await import("../index.js");
    const entry = mod.default;
    if (entry && typeof entry === "object" && "register" in entry) {
      (entry as { register: (a: unknown) => void }).register(api);
    }

    const readyMsg = infoSpy.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("[identity-persistence] ready"),
    );
    expect(readyMsg).toBeDefined();
  });
});
