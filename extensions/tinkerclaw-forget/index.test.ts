import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { resolveForgetConfig } from "./index.js";

type Factory = (ctx: Record<string, unknown>) => { name: string } | null;

function mockApi(pluginConfig: Record<string, unknown>) {
  const tools: Array<{ factory: Factory; opts: unknown }> = [];
  const methods: Array<{ name: string; opts: unknown }> = [];
  const hooks: string[] = [];
  const api = {
    id: "tinkerclaw-forget",
    name: "Forget",
    source: "local" as const,
    pluginConfig,
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { agent: { resolveAgentWorkspaceDir: () => "/nonexistent" } },
    registerTool: vi.fn((factory: Factory, opts: unknown) => tools.push({ factory, opts })),
    registerGatewayMethod: vi.fn((name: string, _handler: unknown, opts: unknown) =>
      methods.push({ name, opts }),
    ),
    on: vi.fn((event: string) => hooks.push(event)),
  };
  return { api, tools, methods, hooks };
}

const saved = process.env.OPENCLAW_STATE_DIR;
let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "forget-reg-"));
  process.env.OPENCLAW_STATE_DIR = state;
});
afterEach(() => {
  if (saved === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = saved;
  }
  rmSync(state, { recursive: true, force: true });
});

describe("register()", () => {
  it("defaults to preview: an optional tool for the owner only, and an admin-scoped gateway method", () => {
    const { api, tools, methods, hooks } = mockApi({});
    plugin.register(api as never);
    expect(tools).toHaveLength(1);
    expect(tools[0].opts).toEqual({ optional: true });
    expect(tools[0].factory({ senderIsOwner: true })?.name).toBe("forget");
    expect(tools[0].factory({ senderIsOwner: false })).toBeNull();
    expect(tools[0].factory({ senderIsOwner: true, sandboxed: true })).toBeNull();
    expect(methods).toEqual([{ name: "memory.forget", opts: { scope: "operator.admin" } }]);
    expect(hooks).toContain("gateway_stop");
  });

  it("registers nothing when off", () => {
    const { api, tools, methods } = mockApi({ mode: "off" });
    plugin.register(api as never);
    expect(tools).toHaveLength(0);
    expect(methods).toHaveLength(0);
  });
});

describe("resolveForgetConfig", () => {
  it("fills the defaults and keeps only known modes", () => {
    expect(resolveForgetConfig(undefined, "/s")).toEqual({
      mode: "preview",
      extraRoots: [],
      backupDirs: ["/s/backups"],
      remoteCopies: [],
      claudeCode: true,
      gitHistory: true,
      maxBinaryScanMB: 2048,
    });
    expect(
      resolveForgetConfig({ mode: "apply", backupDirs: [], claudeCode: false }, "/s"),
    ).toMatchObject({
      mode: "apply",
      backupDirs: [],
      claudeCode: false,
    });
    expect(resolveForgetConfig({ mode: "yes" }, "/s").mode).toBe("preview");
  });
});
