import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Round Table plugin registration and synapse_debate tool.
 * Validates that the plugin correctly registers a tool factory and that
 * the tool executes debates returning the expected result shape.
 */

describe("Plugin Registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers synapse_debate tool", async () => {
    const registerTool = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { defaultDepth: "standard", maxRounds: 6 },
      rootDir: __dirname,
      registerTool,
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
      on: vi.fn(),
      config: {},
      id: "tinkerclaw-round-table",
      name: "Round Table",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    const entry = mod.default;
    // definePluginEntry returns an object with a register function
    entry.register(mockApi as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    // registerTool receives a factory function and options
    const toolFactory = registerTool.mock.calls[0][0];
    expect(typeof toolFactory).toBe("function");

    // Call factory with a mock context to get the tool
    const tool = toolFactory({});
    expect(tool.name).toBe("synapse_debate");
    expect(tool.parameters.required).toContain("topic");
    expect(typeof tool.execute).toBe("function");
  });

  it("tool execute runs a debate and returns a result", async () => {
    const registerTool = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { defaultDepth: "quick", maxRounds: 2 },
      rootDir: __dirname,
      registerTool,
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
      on: vi.fn(),
      config: {},
      id: "tinkerclaw-round-table",
      name: "Round Table",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    const toolFactory = registerTool.mock.calls[0][0];
    const tool = toolFactory({});
    const rawResult = await tool.execute("test-call-id", {
      topic: "REST vs GraphQL",
      depth: "quick",
    });

    expect(rawResult).toBeDefined();
    expect(rawResult.content).toBeDefined();
    expect(rawResult.content[0].type).toBe("text");

    const result = rawResult.details;
    expect(result.consensus).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.rounds).toBeDefined();
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.dissent).toBeDefined();
    expect(typeof result.diversityScore).toBe("number");
  });

  it("respects depth parameter for round count", async () => {
    const registerTool = vi.fn();
    const mockApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { defaultDepth: "standard" },
      rootDir: __dirname,
      registerTool,
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
      on: vi.fn(),
      config: {},
      id: "tinkerclaw-round-table",
      name: "Round Table",
      source: "local" as const,
      runtime: {} as any,
    };

    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    const toolFactory = registerTool.mock.calls[0][0];
    const tool = toolFactory({});

    // Quick depth should produce fewer rounds than deep
    const quickResult = await tool.execute("call-1", {
      topic: "Testing depths",
      depth: "quick",
    });
    const quickRounds = quickResult.details.rounds.length;

    // Quick should have at most 2 rounds
    expect(quickRounds).toBeLessThanOrEqual(2);
    expect(quickRounds).toBeGreaterThan(0);
  });
});
