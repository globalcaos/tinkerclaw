import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

const dirs: string[] = [];
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function register() {
  const root = mkdtempSync(join(tmpdir(), "amy-idx-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const routes: { path: string; auth: string; match?: string }[] = [];
  const methods: string[] = [];
  const hooks: string[] = [];
  const services: { id: string }[] = [];
  const unexpected = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerCli: vi.fn(),
    registerHook: vi.fn(),
    registerChannel: vi.fn(),
    registerProvider: vi.fn(),
  };
  const api = createTestPluginApi({
    id: "tinkerclaw-amygdala",
    pluginConfig: { dataDir },
    registerHttpRoute: (p) => {
      routes.push({ path: p.path, auth: p.auth, match: p.match });
    },
    registerGatewayMethod: (name) => {
      methods.push(name);
    },
    registerService: (s) => {
      services.push({ id: s.id });
      stops.push(() => s.stop?.({} as never));
    },
    on: ((name: string) => {
      hooks.push(name);
    }) as never,
    ...unexpected,
  });
  plugin.register?.(api);
  return { dataDir, routes, methods, hooks, services, unexpected };
}

describe("tinkerclaw-amygdala entry", () => {
  it("registers the three routes (decide, notes, wait), the methods and the native hooks, and nothing else", () => {
    const r = register();
    expect(r.routes.map((x) => x.path).toSorted()).toEqual([
      "/plugins/amygdala2/decide",
      "/plugins/amygdala2/notes",
      "/plugins/amygdala2/wait",
    ]);
    for (const route of r.routes) {
      expect(route.auth).toBe("plugin");
      expect(route.match).toBe("exact");
    }
    expect(r.methods.toSorted()).toEqual([
      "amygdala2.answer",
      "amygdala2.approve",
      "amygdala2.canary",
      "amygdala2.feed",
      "amygdala2.label",
      "amygdala2.nightly",
      "amygdala2.propose",
      "amygdala2.questionRecord",
      "amygdala2.replay",
      "amygdala2.reviews",
      "amygdala2.rewind",
      "amygdala2.status",
      "amygdala2.undo",
    ]);
    expect(r.hooks.toSorted()).toEqual(["after_tool_call", "agent_end", "before_tool_call"]);
    expect(r.services.map((s) => s.id)).toEqual(["tinkerclaw-amygdala"]);
    for (const fn of Object.values(r.unexpected)) expect(fn).not.toHaveBeenCalled();
  });

  it("does its work in register(), not at import: the data dir appears only then", () => {
    const r = register();
    expect(existsSync(join(r.dataDir, "endpoint.json"))).toBe(true);
    expect(existsSync(join(r.dataDir, "policy.json"))).toBe(true);
  });

  it("registers nothing outside full registration mode", () => {
    const routes: unknown[] = [];
    const api = createTestPluginApi({
      registrationMode: "discovery",
      registerHttpRoute: (p) => {
        routes.push(p);
      },
    });
    plugin.register?.(api);
    expect(routes).toHaveLength(0);
  });

  it("ships disabled by default in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
    ) as { enabledByDefault: boolean; id: string };
    expect(manifest.id).toBe("tinkerclaw-amygdala");
    expect(manifest.enabledByDefault).toBe(false);
  });
});
