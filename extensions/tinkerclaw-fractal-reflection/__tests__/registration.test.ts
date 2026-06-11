import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Fractal Reflection plugin registration.
 * Validates that the plugin correctly registers an agent_end hook
 * and respects the enabled config flag.
 */

describe("Fractal Reflection registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers agent_end hook", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: true, debounceMs: 30000 },
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
      id: "tinkerclaw-fractal-reflection",
      name: "Fractal Reflection",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    // Should register exactly one agent_end handler
    expect(onFn).toHaveBeenCalledTimes(1);
    expect(onFn.mock.calls[0][0]).toBe("agent_end");
  });

  it("handler is a function", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: true },
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
      id: "tinkerclaw-fractal-reflection",
      name: "Fractal Reflection",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    const handler = onFn.mock.calls[0][1];
    expect(typeof handler).toBe("function");
  });

  it("does not register hooks when disabled", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: false },
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
      id: "tinkerclaw-fractal-reflection",
      name: "Fractal Reflection",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    expect(onFn).not.toHaveBeenCalled();
    expect(mockApi.logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("logs the v2 ready message", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: true },
      rootDir: "/test/dir",
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
      id: "tinkerclaw-fractal-reflection",
      name: "Fractal Reflection",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    expect(mockApi.logger.info).toHaveBeenCalledWith(expect.stringContaining("v2 ready"));
  });
});
