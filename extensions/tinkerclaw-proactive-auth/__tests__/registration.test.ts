import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Proactive OAuth Refresh plugin registration.
 * Validates that the plugin registers gateway_start and gateway_stop hooks
 * and respects the enabled config flag.
 */

function makeMockApi(overrides: Record<string, unknown> = {}) {
  return {
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
    on: vi.fn(),
    config: {},
    id: "tinkerclaw-proactive-auth",
    name: "Proactive OAuth Refresh",
    source: "local" as const,
    runtime: {} as any,
    ...overrides,
  };
}

describe("Proactive Auth registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers gateway_start and gateway_stop hooks", async () => {
    const mockApi = makeMockApi();
    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    expect(mockApi.on).toHaveBeenCalledTimes(2);

    const hookNames = mockApi.on.mock.calls.map((c: any[]) => c[0]);
    expect(hookNames).toContain("gateway_start");
    expect(hookNames).toContain("gateway_stop");
  });

  it("gateway_start handler is a function", async () => {
    const mockApi = makeMockApi();
    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    const startCall = mockApi.on.mock.calls.find((c: any[]) => c[0] === "gateway_start");
    expect(startCall).toBeDefined();
    expect(typeof startCall![1]).toBe("function");
  });

  it("gateway_stop handler is a function", async () => {
    const mockApi = makeMockApi();
    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    const stopCall = mockApi.on.mock.calls.find((c: any[]) => c[0] === "gateway_stop");
    expect(stopCall).toBeDefined();
    expect(typeof stopCall![1]).toBe("function");
  });

  it("does not register hooks when disabled", async () => {
    const mockApi = makeMockApi({ pluginConfig: { enabled: false } });
    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    expect(mockApi.on).not.toHaveBeenCalled();
    expect(mockApi.logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("logs ready message when enabled", async () => {
    const mockApi = makeMockApi();
    const mod = await import("../index.js");
    mod.default.register(mockApi as any);

    expect(mockApi.logger.info).toHaveBeenCalledWith(expect.stringContaining("ready"));
  });
});
