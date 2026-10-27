import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resolving the bundled root walks up to 12 ancestor directories three times, reading a
// package.json at each. On 2026-10-10 the gateway's task sweep spent 3.4 s of a 37 s CPU profile
// doing that once per bundled channel id per task, so the lookup must happen once per iteration.
const CHANNEL_IDS = ["alpha", "beta", "gamma", "delta", "epsilon"];

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./bundled-root.js");
  vi.doUnmock("./bundled-ids.js");
  vi.doUnmock("./bundled.js");
});

async function loadRegistryWithCountedRootScope() {
  const resolveBundledChannelRootScope = vi.fn(() => ({
    packageRoot: "/pkg",
    cacheKey: "/pkg/dist/extensions",
    pluginsDir: "/pkg/dist/extensions",
  }));
  vi.doMock("./bundled-root.js", () => ({ resolveBundledChannelRootScope }));
  vi.doMock("./bundled-ids.js", () => ({
    listBundledChannelPluginIdsForRoot: () => CHANNEL_IDS,
  }));
  vi.doMock("./bundled.js", () => ({
    getBundledChannelPlugin: (id: string) =>
      CHANNEL_IDS.includes(id) ? { id, meta: { id } } : undefined,
    getBundledChannelSetupPlugin: () => undefined,
    getBundledChannelSecrets: () => undefined,
    getBundledChannelSetupSecrets: () => undefined,
  }));
  const registry = await importFreshModule<typeof import("./bootstrap-registry.js")>(
    import.meta.url,
    "./bootstrap-registry.js?scope=root-scope-once",
  );
  return { registry, resolveBundledChannelRootScope };
}

describe("bootstrap channel plugin iteration", () => {
  it("resolves the bundled root once per iteration, not once per channel id", async () => {
    const { registry, resolveBundledChannelRootScope } = await loadRegistryWithCountedRootScope();

    const plugins = [...registry.iterateBootstrapChannelPlugins()];

    expect(plugins.map((plugin) => plugin.id)).toEqual(CHANNEL_IDS);
    expect(resolveBundledChannelRootScope).toHaveBeenCalledTimes(1);
  });

  it("still answers single-id lookups from the same cached registry", async () => {
    const { registry } = await loadRegistryWithCountedRootScope();

    const first = [...registry.iterateBootstrapChannelPlugins()][1];

    expect(registry.getBootstrapChannelPlugin("beta")).toBe(first);
    expect(registry.getBootstrapChannelPlugin("missing")).toBeUndefined();
  });
});
