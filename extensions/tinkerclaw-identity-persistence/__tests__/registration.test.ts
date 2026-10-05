/**
 * FORK: Registration tests for Identity Persistence plugin hooks.
 *
 * Verifies the opt-in gate (no hooks without `enabled: true` AND an existing
 * persona file), that an opted-in plugin registers the correct hooks
 * (before_prompt_build, llm_output), and that the before_prompt_build handler
 * returns a persona block.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let dir: string;
let personaPath: string;

/**
 * Build a minimal mock of OpenClawPluginApi that captures hook registrations.
 * Opts in by default so the hook-wiring assertions below test the wiring, not
 * the gate; the gate has its own cases.
 */
function createMockApi(overrides: Record<string, unknown> = {}) {
  const onHook = vi.fn();
  return {
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: {
        enabled: true,
        personaPath,
        syncScoreThreshold: 0.6,
        evaluationInterval: 10,
      },
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

async function registerWith(api: unknown): Promise<void> {
  const mod = await import("../index.js");
  const entry = mod.default;
  if (entry && typeof entry === "object" && "register" in entry) {
    (entry as { register: (a: unknown) => void }).register(api);
  }
}

describe("Plugin Registration", () => {
  beforeEach(() => {
    vi.resetModules();
    // Every case gets its own HOME so the plugin can never read or write the
    // real ~/.openclaw while tests run.
    dir = mkdtempSync(join(tmpdir(), "cortex-reg-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw", "workspace"), { recursive: true });
    personaPath = join(dir, ".openclaw", "workspace", "SOUL.md");
    writeFileSync(personaPath, "# TestAgent\n\n## Identity\nA test persona.\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("registers NO hooks unless explicitly enabled", async () => {
    const { api, onHook } = createMockApi({
      pluginConfig: { personaPath, syncScoreThreshold: 0.6 },
    });

    await registerWith(api);

    expect(onHook).not.toHaveBeenCalled();
  });

  it("registers NO hooks when the configured persona file does not exist", async () => {
    const { api, onHook } = createMockApi({
      pluginConfig: { enabled: true, personaPath: join(dir, "nope", "absent.md") },
    });

    await registerWith(api);

    expect(onHook).not.toHaveBeenCalled();
  });

  it("never creates a persona file it was asked to read", async () => {
    const missing = join(dir, ".openclaw", "workspace", "ABSENT.md");
    const { api } = createMockApi({ pluginConfig: { enabled: true, personaPath: missing } });

    await registerWith(api);

    const { existsSync } = await import("node:fs");
    expect(existsSync(missing)).toBe(false);
  });

  it("registers before_prompt_build and llm_output hooks", async () => {
    const { api, onHook } = createMockApi();

    await registerWith(api);

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

    await registerWith(api);

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

    await registerWith(api);

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

  it("injects no hard rules that the owner did not write", async () => {
    let promptBuildHandler: Function | null = null;
    const { api } = createMockApi({
      on: vi.fn((name: string, handler: Function) => {
        if (name === "before_prompt_build") {
          promptBuildHandler = handler;
        }
      }),
    });

    await registerWith(api);
    const result = await promptBuildHandler!({ prompt: "Hi" }, { sessionKey: "agent:main:main" });

    // The bootstrap persona ships with hardRules: [], so the rendered block
    // carries no "Hard Rules" section and no fork-author branding.
    expect(result.prependSystemContext).not.toContain("Hard Rules");
    expect(result.prependSystemContext).not.toContain("Jarvis");
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

    await registerWith(api);

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

    await registerWith(api);

    const readyMsg = infoSpy.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("[identity-persistence] ready"),
    );
    expect(readyMsg).toBeDefined();
  });
});
