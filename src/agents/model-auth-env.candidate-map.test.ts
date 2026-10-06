import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-10-06: resolveEnvApiKey rebuilt the provider env-key candidate map (a plugin manifest registry read)
// on every call. A caller resolving many providers now passes one map in; the default still builds it.
const mocks = vi.hoisted(() => ({
  resolveProviderEnvApiKeyCandidates: vi.fn(
    (): Record<string, readonly string[]> => ({ acme: ["ACME_API_KEY"] }),
  ),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  resolveProviderEnvApiKeyCandidates: mocks.resolveProviderEnvApiKeyCandidates,
}));
vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));
vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: () => [],
}));
vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider: () => undefined,
}));

const { resolveEnvApiKey } = await import("./model-auth-env.js");

describe("resolveEnvApiKey candidate map", () => {
  beforeEach(() => {
    mocks.resolveProviderEnvApiKeyCandidates.mockClear();
  });

  it("uses a map the caller passes instead of rebuilding it", () => {
    const resolved = resolveEnvApiKey(
      "acme",
      { OTHER_ACME_KEY: "k-1" },
      { acme: ["OTHER_ACME_KEY"] },
    );

    expect(resolved).toEqual({ apiKey: "k-1", source: "env: OTHER_ACME_KEY" });
    expect(mocks.resolveProviderEnvApiKeyCandidates).not.toHaveBeenCalled();
  });

  it("still builds the map itself when none is passed", () => {
    const env = { ACME_API_KEY: "k-2" };
    const resolved = resolveEnvApiKey("acme", env);

    expect(resolved).toEqual({ apiKey: "k-2", source: "env: ACME_API_KEY" });
    expect(mocks.resolveProviderEnvApiKeyCandidates).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProviderEnvApiKeyCandidates).toHaveBeenCalledWith({ env });
  });
});
