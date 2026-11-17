import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type Handler = (opts: {
  params: unknown;
  respond: (ok: boolean, body: unknown) => void;
}) => Promise<void>;

let state: string;
let prevState: string | undefined;

function load(config: unknown = {}, subagent?: unknown) {
  const handlers = new Map<string, { fn: Handler; scope?: string }>();
  const api = {
    config,
    pluginConfig: {},
    runtime: { subagent },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerGatewayMethod: (name: string, fn: Handler, opts?: { scope?: string }) =>
      handlers.set(name, { fn, scope: opts?.scope }),
  };
  plugin.register(api as never);
  const call = async (name: string, params: unknown = {}) => {
    let body: unknown;
    await handlers.get(name)!.fn({ params, respond: (_ok, b) => (body = b) });
    return body as Record<string, any>;
  };
  return { handlers, call };
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "tb-plugin-"));
  prevState = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = state;
});
afterEach(() => {
  if (prevState === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevState;
  rmSync(state, { recursive: true, force: true });
});

describe("tinkerclaw-token-burner gateway methods", () => {
  it("registers the three methods, all admin-only", () => {
    const { handlers } = load();
    expect([...handlers.keys()].sort()).toEqual([
      "tokenBurner.settings.get",
      "tokenBurner.settings.set",
      "tokenBurner.suggest",
    ]);
    for (const h of handlers.values()) expect(h.scope).toBe("operator.admin");
  });

  it("get returns the defaults and creates the governing prompt from the shipped default", async () => {
    const { call } = load();
    const out = await call("tokenBurner.settings.get");
    expect(out.settings.objective).toBe("code");
    expect(out.objectives).toHaveLength(5);
    expect(out.prompt.path).toBe(join(state, "token-burner", "prompt.md"));
    expect(readFileSync(out.prompt.path, "utf8")).toMatch(/governing prompt/i);
  });

  it("set validates, saves to settings.json, and get reads it back", async () => {
    const { call } = load();
    const bad = await call("tokenBurner.settings.set", { patch: { objective: "nope" } });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/objective/) });
    const ok = await call("tokenBurner.settings.set", {
      patch: { objective: "revenue", strategy: "sell what works" },
    });
    expect(ok.ok).toBe(true);
    const file = JSON.parse(readFileSync(join(state, "token-burner", "settings.json"), "utf8"));
    expect(file).toMatchObject({ objective: "revenue", strategy: "sell what works" });
    expect((await call("tokenBurner.settings.get")).settings.objective).toBe("revenue");
  });

  it("suggest explains itself when no model is set and starts nothing", async () => {
    const run = vi.fn();
    const { call } = load({}, { run });
    const out = await call("tokenBurner.suggest");
    expect(out).toMatchObject({ status: "failed", reason: expect.stringMatching(/No model/) });
    expect(run).not.toHaveBeenCalled();
  });

  it("suggest starts a run and a poll returns the proposal without saving it", async () => {
    const subagent = {
      run: vi.fn(async () => ({ runId: "r1" })),
      waitForRun: vi.fn(async () => ({ status: "ok" })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: '{"objective":"research","strategy":"read"}' }],
      })),
      deleteSession: vi.fn(async () => {}),
    };
    const { call } = load({ agents: { defaults: { model: "anthropic/sonnet-4.6" } } }, subagent);
    expect(await call("tokenBurner.suggest")).toEqual({ status: "running", runId: "r1" });
    const done = await call("tokenBurner.suggest", { runId: "r1" });
    expect(done).toMatchObject({ status: "done", proposal: { objective: "research" } });
    expect((await call("tokenBurner.settings.get")).settings.objective).toBe("code");
  });
});
