import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoutingReadProvider } from "openclaw/plugin-sdk/fork-thalamus";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { ThalamusStore } from "../src/store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function register(pluginConfig: Record<string, unknown> | undefined) {
  const tmp = mkdtempSync(join(tmpdir(), "thalamus-entry-"));
  dirs.push(tmp);
  const dataDir = join(tmp, "data");
  const routes: string[] = [];
  const methods: string[] = [];
  const handlers: Record<
    string,
    (a: { params?: unknown; respond: (ok: boolean, v: unknown) => void }) => void
  > = {};
  const hooks: Record<string, (...a: never[]) => unknown> = {};
  const services: string[] = [];
  const unexpected = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerCli: vi.fn(),
    registerHook: vi.fn(),
    registerChannel: vi.fn(),
    registerProvider: vi.fn(),
  };
  const api = createTestPluginApi({
    id: "tinkerclaw-thalamus",
    pluginConfig: pluginConfig ? { dataDir, ...pluginConfig } : undefined,
    registerHttpRoute: (p) => void routes.push(`${p.auth} ${p.match} ${p.path}`),
    registerGatewayMethod: (n, h) => {
      methods.push(n);
      handlers[n] = h as never;
    },
    registerService: (s) => {
      services.push(s.id);
      stops.push(() => s.stop?.({} as never));
    },
    on: ((name: string, fn: never) => void (hooks[name] = fn)) as never,
    ...unexpected,
  });
  plugin.register?.(api);
  const call = (name: string, params: unknown = {}) =>
    new Promise<any>((ok) => handlers[name]({ params, respond: (_o, v) => ok(v) }));
  return { dataDir, routes, methods, hooks, services, unexpected, call };
}

describe("the plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

  it("ships disabled, and lists the folders the build must copy", () => {
    expect(manifest.id).toBe("tinkerclaw-thalamus");
    expect(manifest.enabledByDefault).toBe(false);
    expect(manifest.runtimeAssets).toEqual(expect.arrayContaining(["./questions", "./hooks"]));
    for (const a of manifest.runtimeAssets) expect(existsSync(join(root, a)), a).toBe(true);
  });

  it("names, in its list of assets, the files the runtime really reads", () => {
    for (const f of [
      "questions/task.json",
      "questions/step.json",
      "questions/outcome.json",
      "questions/templates/enhancement.json",
      "hooks/prompt-shortlist.mjs",
      "hooks/post-tool-digest.mjs",
    ]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it("defaults the mode to off and every outside read to off", () => {
    const p = manifest.configSchema.properties;
    expect(p.mode.default).toBe("off");
    expect(p.mode.enum).toEqual(["off", "shadow", "enforce"]);
    expect(p.jev.properties.enabled.default).toBe(false);
    expect(p.jev.properties.sendRealSituations.default).toBe(false);
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });
});

describe("the plugin entry", () => {
  it("registers nothing and opens nothing when the mode is off, or when there is no config", () => {
    for (const cfg of [undefined, {}, { mode: "off" }, { mode: "bogus" }]) {
      const r = register(cfg);
      expect(r.routes, JSON.stringify(cfg)).toEqual([]);
      expect(r.methods).toEqual([]);
      expect(Object.keys(r.hooks)).toEqual([]);
      expect(r.services).toEqual([]);
      expect(existsSync(r.dataDir)).toBe(false);
      for (const fn of Object.values(r.unexpected)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("in shadow registers one loopback route, nine methods and one hook, and nothing else", () => {
    const r = register({ mode: "shadow" });
    expect(r.routes).toEqual(["plugin exact /plugins/thalamus/shortlist"]);
    expect(r.methods.toSorted()).toEqual([
      "thalamus.explain",
      "thalamus.feed",
      "thalamus.learning.pin",
      "thalamus.learning.report",
      "thalamus.learning.run",
      "thalamus.panel",
      "thalamus.plan.preview",
      "thalamus.retryPick",
      "thalamus.status",
    ]);
    expect(Object.keys(r.hooks)).toEqual(["before_prompt_build"]);
    expect(r.services).toEqual(["tinkerclaw-thalamus"]);
    for (const fn of Object.values(r.unexpected)) expect(fn).not.toHaveBeenCalled();
  });

  it("in enforce adds the check and the writer hooks; the digest route needs its own flag on top", () => {
    const plain = register({ mode: "enforce" });
    expect(plain.routes).toEqual(["plugin exact /plugins/thalamus/shortlist"]);
    expect(Object.keys(plain.hooks).toSorted()).toEqual([
      "before_agent_finalize",
      "before_prompt_build",
      "message_sending",
    ]);
    const digesting = register({ mode: "enforce", enforce: { digest: true } });
    expect(digesting.routes).toEqual([
      "plugin exact /plugins/thalamus/shortlist",
      "plugin exact /plugins/thalamus/digest",
    ]);
    const shadowOnly = register({
      mode: "shadow",
      enforce: { digest: true, check: true, finish: true },
    });
    expect(shadowOnly.routes).toEqual(["plugin exact /plugins/thalamus/shortlist"]);
    expect(Object.keys(shadowOnly.hooks)).toEqual(["before_prompt_build"]);
  });

  it("the enforce hooks change nothing while their flags are off", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "thalamus-hooks-"));
    dirs.push(tmp);
    const r = register({ mode: "enforce", dataDir: join(tmp, "data") });
    await running(r);
    const fin = r.hooks.before_agent_finalize as (e: unknown, c: unknown) => Promise<unknown>;
    const send = r.hooks.message_sending as (e: unknown, c: unknown) => Promise<unknown>;
    expect(
      await fin(
        { runId: "run-1", sessionId: "s", stopHookActive: false, lastAssistantMessage: "done" },
        { runId: "run-1" },
      ),
    ).toBeUndefined();
    expect(
      await send({ to: "x", content: "y".repeat(400) }, { runId: "run-1", channelId: "c" }),
    ).toBeUndefined();
  });

  it("has a status method that changes no mode: there is no method that switches shadow or enforcement", () => {
    const r = register({ mode: "shadow" });
    expect(r.methods.some((m) => /mode|enforce|enable/i.test(m))).toBe(false);
  });

  async function running(r: ReturnType<typeof register>) {
    for (let i = 0; i < 300; i++) {
      if ((await r.call("thalamus.status")).running) return;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error("the runtime never started");
  }

  it("a second load on the same data folder shares the running runtime, so the first status counts the reads", async () => {
    // The gateway loads its plugins more than once; its status method stays bound to the first load.
    const tmp = mkdtempSync(join(tmpdir(), "thalamus-twice-"));
    dirs.push(tmp);
    const cfg = { mode: "shadow", dataDir: join(tmp, "data"), jev: { enabled: true } };
    const first = register(cfg);
    await running(first);
    const second = register(cfg);
    await running(second);
    const provider = getRoutingReadProvider();
    expect(provider).toBeDefined();
    provider!.observe(
      "post-tool",
      { id: "s1", sessionKey: "agent:main:tinker:x", turnId: "t1", originKind: "real" },
      [],
    );
    const status = await first.call("thalamus.status");
    expect(status.providerReads).toBe(1);
    expect(status.providerReadsByKind).toEqual({ task: 0, step: 0, outcome: 1 });
    expect((await second.call("thalamus.status")).providerReads).toBe(1);
  });

  const PROMPT = "please run the zyxq-frobnicator on this file";
  const seedStore = (dataDir: string) => {
    const s = new ThalamusStore(join(dataDir, "thalamus.sqlite"));
    s.addCardVersion(
      {
        id: "skill:zyxq-frobnicator",
        kind: "skill",
        name: "zyxq-frobnicator",
        family: "other",
        purpose: "Runs the zyxq-frobnicator on a file.",
        structure: "",
        alsoServed: [],
        version: 1,
        status: "active",
        origin: "seed",
      },
      { createdAt: 1 },
    );
    s.close();
  };

  it("shadow: the prompt hook adds nothing to the agent's context, and the list is still computed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "thalamus-seed-"));
    dirs.push(tmp);
    seedStore(join(tmp, "data"));
    const r = register({ mode: "shadow", dataDir: join(tmp, "data") });
    await running(r);
    const out = await (r.hooks.before_prompt_build as (e: unknown, c: unknown) => Promise<unknown>)(
      { prompt: PROMPT, messages: [] },
      { runId: "run-1", sessionKey: "agent:main:tinker:x", trigger: "user" },
    );
    expect(out).toBeUndefined();
    expect((await r.call("thalamus.status")).cards).toBeGreaterThan(0);
  });

  it("enforce: the prompt hook adds exactly the list, as prepended context", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "thalamus-seed-"));
    dirs.push(tmp);
    seedStore(join(tmp, "data"));
    const r = register({ mode: "enforce", dataDir: join(tmp, "data") });
    await running(r);
    const out = (await (
      r.hooks.before_prompt_build as (e: unknown, c: unknown) => Promise<unknown>
    )(
      { prompt: PROMPT, messages: [] },
      { runId: "run-1", sessionKey: "agent:main:tinker:x", trigger: "user" },
    )) as { prependContext?: string } | undefined;
    expect(Object.keys(out ?? {})).toEqual(["prependContext"]);
    expect(out!.prependContext).toContain("skill zyxq-frobnicator");
    expect(out!.prependContext).toContain("None of these may fit");
    // Jev is off here, so the entry is recall's own pick: it carries no percentage, which would be a made-up number.
    expect(out!.prependContext!.split("\n")[1]).toMatch(/^1\. skill zyxq-frobnicator: /);
  });

  it("enforce: a prompt no enhancement fits gets nothing added", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "thalamus-seed-"));
    dirs.push(tmp);
    seedStore(join(tmp, "data"));
    const r = register({ mode: "enforce", dataDir: join(tmp, "data") });
    await running(r);
    const out = await (r.hooks.before_prompt_build as (e: unknown, c: unknown) => Promise<unknown>)(
      { prompt: "what time is it", messages: [] },
      { runId: "run-2", sessionKey: "agent:main:tinker:x", trigger: "user" },
    );
    expect(out).toBeUndefined();
  });
});
