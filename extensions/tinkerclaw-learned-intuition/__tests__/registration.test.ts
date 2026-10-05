import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the Learned Intuition plugin registration.
 * Validates that the plugin correctly registers before_tool_call and llm_output hooks.
 *
 * HOME is redirected to a temp dir for every case. register() writes a policy
 * snapshot to `$HOME/.openclaw/data/amygdala` and, when enforcement is off,
 * DELETES the claude-cli settings file there — so without this isolation a test
 * run disarms the developer's own live AEGIS enforcement hook. It did exactly
 * that once; hence the guard below.
 */

let home: string;

describe("Learned Intuition registration", () => {
  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "amy-home-"));
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".openclaw", "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
    expect(infoMessages.some((m: string) => m.includes("[learned-intuition] registered"))).toBe(
      true,
    );
    expect(infoMessages.some((m: string) => m.includes("phase=1"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("observeOnly=true"))).toBe(true);
  });

  it("writes NO pre-execution enforcement settings by default", async () => {
    const { api } = createMockApi();
    (api as { pluginConfig: Record<string, unknown> }).pluginConfig = {};

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const dataDir = join(home, ".openclaw", "data", "amygdala");
    // The snapshot still lands (observe-only spool keeps working) ...
    expect(existsSync(join(dataDir, "policy.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "policy.json"), "utf-8")).hookEnforcement).toBe(
      false,
    );
    // ... but no claude-cli settings file, so tinker-bridge injects no
    // PreToolUse deny-hook into any spawn unless the owner opts in.
    expect(existsSync(join(dataDir, "cc-hook-settings.json"))).toBe(false);
  });

  it("writes the enforcement settings only when hookEnforcement is opted in", async () => {
    const { api } = createMockApi();
    (api as { pluginConfig: Record<string, unknown> }).pluginConfig = { hookEnforcement: true };

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const dataDir = join(home, ".openclaw", "data", "amygdala");
    expect(existsSync(join(dataDir, "cc-hook-settings.json"))).toBe(true);
  });

  it("shouldEnforce: observeOnly blocks nothing, AEGIS included", async () => {
    const { shouldEnforce } = await import("../index.js");
    const hard = { blocked: true, decision: "hard_block" };
    const soft = { blocked: true, decision: "soft_block" };
    expect(shouldEnforce(hard, true, 1)).toBe(false);
    expect(shouldEnforce(hard, true, 4)).toBe(false);
    expect(shouldEnforce(soft, true, 4)).toBe(false);
    expect(shouldEnforce(hard, false, 1)).toBe(true);
    expect(shouldEnforce(soft, false, 1)).toBe(false);
    expect(shouldEnforce(soft, false, 2)).toBe(true);
    expect(shouldEnforce({ blocked: false, decision: "allow" }, false, 4)).toBe(false);
  });

  it("does NOT block an AEGIS hard-block match under the default config", async () => {
    const { api, hooks } = createMockApi();
    (api as { pluginConfig: Record<string, unknown> }).pluginConfig = {};

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const [{ handler }] = hooks.get("before_tool_call")!;
    const out = await handler({ toolName: "exec", args: { command: "DROP TABLE users" } });
    expect(out).toBeUndefined();
  });

  it("blocks an AEGIS hard-block match once observeOnly is false", async () => {
    const { api, hooks } = createMockApi();
    (api as { pluginConfig: Record<string, unknown> }).pluginConfig = { observeOnly: false };

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const [{ handler }] = hooks.get("before_tool_call")!;
    const out = await handler({ toolName: "exec", args: { command: "DROP TABLE users" } });
    expect(out).toMatchObject({ block: true });
  });

  it("registers no personality-nudge writer output unless opted in", async () => {
    const { api, hooks } = createMockApi();
    (api as { pluginConfig: Record<string, unknown> }).pluginConfig = {};

    const mod = await import("../index.js");
    mod.default.register(api as any);

    const nudgePath = join(home, ".openclaw", "cognitive", "personality-nudge.json");
    for (const { handler } of hooks.get("llm_output") ?? []) {
      await handler({ text: "some assistant output" });
    }
    expect(existsSync(nudgePath)).toBe(false);
  });
});
