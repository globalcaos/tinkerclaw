/**
 * 0.1.2 — config.models and anatomy.* are not budget tracking, so they are registered only when
 * plugin config opts in, and config.models never returns more than provider/mode/label per
 * auth profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register, { projectModelConfig } from "../index.js";

function fakeApi(pluginConfig: Record<string, unknown> | undefined) {
  const methods: string[] = [];
  const api = {
    config: {},
    pluginConfig,
    log: { info: () => {} },
    registerGatewayMethod: (name: string) => methods.push(name),
    registerHttpRoute: () => {},
    registerTool: () => {},
  };
  return { api, methods };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opt-in gateway surfaces", () => {
  it("registers only budget.* methods by default", () => {
    const { api, methods } = fakeApi(undefined);
    register(api as any);
    expect(methods.sort()).toEqual(
      ["budget.refresh", "budget.status", "budget.update", "budget.usage"].sort(),
    );
  });

  it("registers config.models only with exposeModelConfig: true", () => {
    const { api, methods } = fakeApi({ exposeModelConfig: true });
    register(api as any);
    expect(methods).toContain("config.models");
    expect(methods.some((m) => m.startsWith("anatomy."))).toBe(false);
  });

  it("registers anatomy.* only with exposeAnatomyTimeline: true", () => {
    const { api, methods } = fakeApi({ exposeAnatomyTimeline: true });
    register(api as any);
    expect(methods).toEqual(
      expect.arrayContaining(["anatomy.recent", "anatomy.before", "anatomy.session"]),
    );
    expect(methods).not.toContain("config.models");
  });
});

describe("config.models projection", () => {
  it("drops everything but provider, mode and label from auth profiles", () => {
    const out = projectModelConfig({
      agents: {
        defaults: { model: { primary: "a/b", fallbacks: ["c/d"] }, models: { "a/b": {} } },
      },
      auth: {
        profiles: {
          "anthropic:work": {
            provider: "anthropic",
            mode: "oauth",
            label: "Work",
            credentialFile: "/home/x/.secret.json",
            token: "sk-should-not-leak",
          },
        },
        order: { anthropic: ["anthropic:work"] },
      },
    });
    expect(out.primary).toBe("a/b");
    expect(out.fallbacks).toEqual(["c/d"]);
    expect(out.authProfiles).toEqual({
      "anthropic:work": { provider: "anthropic", mode: "oauth", label: "Work" },
    });
    expect(out.authOrder).toEqual({ anthropic: ["anthropic:work"] });
  });
});
