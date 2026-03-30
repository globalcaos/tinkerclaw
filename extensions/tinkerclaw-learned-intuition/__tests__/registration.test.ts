import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Learned Intuition plugin registration.
 * Validates that the plugin correctly registers before_tool_call and llm_output hooks.
 */

describe("Learned Intuition registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createMockApi() {
    const hooks = new Map<string, Array<{ handler: Function; priority?: number }>>();

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { phase: 1, observeOnly: true },
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
      on: vi.fn((event: string, handler: Function, opts?: { priority?: number }) => {
        if (!hooks.has(event)) {
          hooks.set(event, []);
        }
        hooks.get(event)!.push({ handler, priority: opts?.priority });
      }),
      config: {},
      id: "tinkerclaw-learned-intuition",
      name: "Learned Intuition",
      source: "local" as const,
      runtime: {} as any,
    };

    return { api, hooks };
  }

  it("registers before_tool_call hook with priority 10", async () => {
    const { api, hooks } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const btcHooks = hooks.get("before_tool_call");
    expect(btcHooks).toBeDefined();
    expect(btcHooks!.length).toBe(1);
    expect(btcHooks![0].priority).toBe(10);
  });

  it("registers llm_output hook", async () => {
    const { api, hooks } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const llmHooks = hooks.get("llm_output");
    expect(llmHooks).toBeDefined();
    expect(llmHooks!.length).toBeGreaterThanOrEqual(1);
  });

  it("logs registered message with phase and mode", async () => {
    const { api } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const infoMessages = api.logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoMessages.some((m: string) => m.includes("[learned-intuition] registered"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("phase=1"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("observeOnly=true"))).toBe(true);
  });
});
