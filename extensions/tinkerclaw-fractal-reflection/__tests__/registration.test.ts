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

    // agent_end handler first, then the triage-lane read-only tool guard
    expect(onFn).toHaveBeenCalledTimes(2);
    expect(onFn.mock.calls[0][0]).toBe("agent_end");
    expect(onFn.mock.calls[1][0]).toBe("before_tool_call");
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

  it("registers NO agent_end hook with default config (opt-in)", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      // No `enabled` key at all — the shipped default must be OFF, because
      // arming this plugin means one billed subagent run per finished turn.
      pluginConfig: {},
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
  });
  it("blocks non-allowlisted tools for fractal lanes only", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: true },
      rootDir: __dirname,
      registerGatewayMethod: vi.fn(),
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

    const guard = onFn.mock.calls.find((c) => c[0] === "before_tool_call")?.[1];
    expect(typeof guard).toBe("function");

    const lane = "agent:main:fractal-reflection:triage:abc";
    for (const toolName of ["write", "edit", "exec", "apply_patch", "message", "some_new_tool"]) {
      const res = guard({ toolName }, { sessionKey: lane, toolName });
      expect(res?.block, toolName).toBe(true);
    }
    for (const toolName of ["read", "grep", "find", "ls", "memory_search", "memory_get"]) {
      expect(guard({ toolName }, { sessionKey: lane, toolName }), toolName).toBeUndefined();
    }
    // A normal (non-fractal) session is never touched by this plugin.
    expect(
      guard({ toolName: "write" }, { sessionKey: "agent:main:main", toolName: "write" }),
    ).toBeUndefined();
  });

  it("does not arm on a non-boolean enabled value", async () => {
    const onFn = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { enabled: "yes" },
      rootDir: __dirname,
      registerGatewayMethod: vi.fn(),
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
  });
});
