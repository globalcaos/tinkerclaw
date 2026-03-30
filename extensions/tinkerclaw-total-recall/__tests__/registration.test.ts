import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the Total Recall plugin registration.
 * Validates that the plugin correctly registers hooks, tool, and gateway method.
 */

describe("Total Recall registration", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), "total-recall-reg-"));
  });

  function createMockApi() {
    const hooks = new Map<string, Array<{ handler: Function; priority?: number }>>();
    const registerTool = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerService = vi.fn();

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { budgetTokens: 2000 },
      rootDir: __dirname,
      registerTool,
      registerGatewayMethod,
      registerHook: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerCli: vi.fn(),
      registerService,
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
      id: "tinkerclaw-total-recall",
      name: "Total Recall",
      source: "local" as const,
      runtime: {} as any,
    };

    return { api, hooks, registerTool, registerGatewayMethod, registerService };
  }

  it("registers before_prompt_build hook with priority 50", async () => {
    const { api, hooks } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(api.on).toHaveBeenCalled();

    const bpbHooks = hooks.get("before_prompt_build");
    expect(bpbHooks).toBeDefined();
    expect(bpbHooks!.length).toBe(1);
    expect(bpbHooks![0].priority).toBe(50);
  });

  it("registers llm_output hook", async () => {
    const { api, hooks } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const llmHooks = hooks.get("llm_output");
    expect(llmHooks).toBeDefined();
    expect(llmHooks!.length).toBeGreaterThanOrEqual(1);
  });

  it("registers before_compaction hook", async () => {
    const { api, hooks } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const compactionHooks = hooks.get("before_compaction");
    expect(compactionHooks).toBeDefined();
    expect(compactionHooks!.length).toBe(1);
  });

  it("registers recall tool", async () => {
    const { api, registerTool } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const toolFactory = registerTool.mock.calls[0][0];
    expect(typeof toolFactory).toBe("function");

    const tool = toolFactory({});
    expect(tool.name).toBe("recall");
    expect(tool.parameters.required).toContain("query");
    expect(typeof tool.execute).toBe("function");
  });

  it("registers engram.search gateway method", async () => {
    const { api, registerGatewayMethod } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    expect(registerGatewayMethod.mock.calls[0][0]).toBe("engram.search");
    expect(typeof registerGatewayMethod.mock.calls[0][1]).toBe("function");
  });

  it("logs ready message with budget and baseDir", async () => {
    const { api } = createMockApi();

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const infoMessages = api.logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoMessages.some((m: string) => m.includes("[total-recall] ready"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("budget=2000"))).toBe(true);
  });
});
