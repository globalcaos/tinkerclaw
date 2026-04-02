import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Computational Humor plugin registration.
 * Validates that the plugin correctly registers before_prompt_build and
 * llm_output hooks, and respects the frequency=off config flag.
 */

describe("Computational Humor registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createMockApi(overrides: Record<string, unknown> = {}) {
    const onFn = vi.fn();
    return {
      onFn,
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig: { frequency: "low", sensitivityThreshold: 0.8 },
        rootDir: __dirname,
        registerTool: vi.fn(),
        registerGatewayMethod: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerCli: vi.fn(),
        registerService: vi.fn(),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        registerContextEngine: vi.fn(),
        resolvePath: (p: string) => p,
        on: onFn,
        config: {},
        id: "tinkerclaw-computational-humor",
        name: "Computational Humor",
        source: "local" as const,
        runtime: {} as any,
        ...overrides,
      },
    };
  }

  it("registers before_prompt_build and llm_output hooks", async () => {
    const { onFn, api } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(onFn).toHaveBeenCalledTimes(2);
    const hookNames = onFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("llm_output");
  });

  it("handlers are functions", async () => {
    const { onFn, api } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    for (const call of onFn.mock.calls) {
      expect(typeof call[1]).toBe("function");
    }
  });

  it("does not register hooks when frequency=off", async () => {
    const { onFn, api } = createMockApi({
      pluginConfig: { frequency: "off" },
    });

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(onFn).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("logs ready message with frequency and sensitivity values", async () => {
    const { api } = createMockApi({
      pluginConfig: { frequency: "medium", sensitivityThreshold: 0.6 },
    });

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("medium"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("0.6"));
  });
});
