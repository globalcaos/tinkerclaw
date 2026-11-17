// FORK 2026-10-29: fork-owned tests for the plugin snapshot caches: the per-process
// resolveBundledPluginsDir memo (bundled-dir.ts), and the gateway generation check that replaced
// the 1 s TTL of the web-provider snapshot and the capability plugin-id cache
// (plugin-snapshot-generation.ts).
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resetBundledPluginsDirCacheForTest, resolveBundledPluginsDir } from "./bundled-dir.js";
import { resolvePluginCapabilityProviders } from "./capability-provider-runtime.js";
import { bumpPluginSnapshotGeneration } from "./plugin-snapshot-generation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import {
  clearGatewaySubagentRuntime,
  setGatewaySubagentRuntime,
} from "./runtime/gateway-bindings.js";
import {
  createWebProviderSnapshotCache,
  resolvePluginWebProviders,
} from "./web-provider-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  isPluginRegistryLoadInFlight: mocks.isPluginRegistryLoadInFlight,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

// A pass-through spy: it counts the package-root walks behind resolveBundledPluginsDir.
vi.mock("../infra/openclaw-root.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/openclaw-root.js")>();
  return {
    ...actual,
    resolveOpenClawPackageRootSync: vi.fn(actual.resolveOpenClawPackageRootSync),
  };
});

const GAP_MS = 5_000;
// The median gap between embedded runs in the gateway logs this change was measured on.
const MEDIAN_RUN_GAP_MS = 108_000;

type TestWebProvider = { id: string; pluginId: string };

function installGatewayMarker(): void {
  // The gateway installs its subagent runtime before it loads plugins: that is the marker.
  setGatewaySubagentRuntime({} as never);
}

function createWebProviderHarness(env: NodeJS.ProcessEnv): () => TestWebProvider[] {
  const config = {} as OpenClawConfig;
  const deps = {
    snapshotCache: createWebProviderSnapshotCache<TestWebProvider>(),
    resolveBundledResolutionConfig: () => ({
      config: {},
      activationSourceConfig: {},
      autoEnabledReasons: {},
    }),
    resolveCandidatePluginIds: () => ["alpha"],
    mapRegistryProviders: (): TestWebProvider[] => [{ id: "alpha-search", pluginId: "alpha" }],
  };
  return () => resolvePluginWebProviders({ config, env }, deps);
}

describe("resolveBundledPluginsDir memo", () => {
  const packageRootWalks = () => vi.mocked(resolveOpenClawPackageRootSync).mock.calls.length;
  // No override, so a miss walks the argv, cwd and module package roots.
  const sourceEnv = (): NodeJS.ProcessEnv => ({ VITEST: "true" });

  beforeEach(() => {
    resetBundledPluginsDirCacheForTest();
    vi.mocked(resolveOpenClawPackageRootSync).mockClear();
  });

  afterEach(() => {
    resetBundledPluginsDirCacheForTest();
  });

  it("walks the package roots once for repeated calls with the same inputs", () => {
    const first = resolveBundledPluginsDir(sourceEnv());
    const walks = packageRootWalks();
    expect(walks).toBeGreaterThan(0);
    expect(resolveBundledPluginsDir(sourceEnv())).toBe(first);
    expect(resolveBundledPluginsDir(sourceEnv())).toBe(first);
    expect(packageRootWalks()).toBe(walks);
  });

  it("walks again when an input changes and keeps the answer for the earlier inputs", () => {
    resolveBundledPluginsDir(sourceEnv());
    const firstWalks = packageRootWalks();

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
    try {
      resolveBundledPluginsDir(sourceEnv());
    } finally {
      cwdSpy.mockRestore();
    }
    const afterCwdChange = packageRootWalks();
    expect(afterCwdChange).toBeGreaterThan(firstWalks);

    const missingOverride = path.join(os.tmpdir(), "openclaw-snapshot-cache-test", "missing");
    resolveBundledPluginsDir({ ...sourceEnv(), OPENCLAW_BUNDLED_PLUGINS_DIR: missingOverride });
    const afterOverrideChange = packageRootWalks();
    expect(afterOverrideChange).toBeGreaterThan(afterCwdChange);

    resolveBundledPluginsDir(sourceEnv());
    expect(packageRootWalks()).toBe(afterOverrideChange);
  });

  it("walks again after the reset hook", () => {
    resolveBundledPluginsDir(sourceEnv());
    const firstWalks = packageRootWalks();
    resetBundledPluginsDirCacheForTest();
    resolveBundledPluginsDir(sourceEnv());
    expect(packageRootWalks()).toBeGreaterThan(firstWalks);
  });
});

describe("web-provider snapshot validity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearGatewaySubagentRuntime();
    resetPluginRuntimeStateForTest();
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({});
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.isPluginRegistryLoadInFlight.mockReset();
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGatewaySubagentRuntime();
    resetPluginRuntimeStateForTest();
  });

  it("serves the snapshot after a 5 s gap inside the gateway", () => {
    installGatewayMarker();
    const resolve = createWebProviderHarness({});
    const first = resolve();
    vi.advanceTimersByTime(GAP_MS);
    expect(resolve()).toBe(first);
    vi.advanceTimersByTime(MEDIAN_RUN_GAP_MS);
    expect(resolve()).toBe(first);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps the 1 s TTL outside the gateway, as in a CLI one-shot", () => {
    const resolve = createWebProviderHarness({});
    resolve();
    vi.advanceTimersByTime(500);
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GAP_MS);
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after a generation bump, then serves the new snapshot", () => {
    installGatewayMarker();
    const resolve = createWebProviderHarness({});
    resolve();
    bumpPluginSnapshotGeneration();
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GAP_MS);
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when a different registry is active, not on re-activation", () => {
    installGatewayMarker();
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const resolve = createWebProviderHarness({});
    resolve();
    setActivePluginRegistry(registry);
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "an explicit discovery cache-ms knob",
      env: { OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000" },
    },
    {
      label: "an explicit manifest cache-ms knob",
      env: { OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "1000" },
    },
    { label: "a Vitest env", env: { VITEST: "true" } },
  ])("keeps the TTL inside the gateway with $label", ({ env }) => {
    installGatewayMarker();
    const resolve = createWebProviderHarness(env);
    resolve();
    vi.advanceTimersByTime(GAP_MS);
    resolve();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });
});

describe("capability plugin-id cache validity", () => {
  // The capability cache reads process.env, where the Vitest setup puts VITEST and a manifest
  // cache-ms knob. Either keeps the TTL, so these tests lift all three keys while they run.
  const liftedEnvKeys = [
    "VITEST",
    "OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS",
    "OPENCLAW_PLUGIN_MANIFEST_CACHE_MS",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();
  let cfg = {} as OpenClawConfig;
  const resolveImageProviders = () =>
    resolvePluginCapabilityProviders({ key: "imageGenerationProviders", cfg });

  beforeEach(() => {
    vi.useFakeTimers();
    clearGatewaySubagentRuntime();
    resetPluginRuntimeStateForTest();
    for (const key of liftedEnvKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    // A fresh config object per test: the cache is a WeakMap keyed on it.
    cfg = {} as OpenClawConfig;
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        { id: "openai", origin: "bundled", contracts: { imageGenerationProviders: ["openai"] } },
      ],
      diagnostics: [],
    });
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
    vi.useRealTimers();
    clearGatewaySubagentRuntime();
    resetPluginRuntimeStateForTest();
  });

  it("serves cached plugin ids after a 5 s gap in the gateway until a bump", () => {
    installGatewayMarker();
    resolveImageProviders();
    vi.advanceTimersByTime(GAP_MS);
    resolveImageProviders();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
    bumpPluginSnapshotGeneration();
    resolveImageProviders();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("keeps the 1 s TTL outside the gateway", () => {
    resolveImageProviders();
    vi.advanceTimersByTime(GAP_MS);
    resolveImageProviders();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(2);
  });
});
