import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  findBundledPluginMetadataById: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: mocks.findBundledPluginMetadataById,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

import { resolvePluginConfigContractsById } from "./config-contracts.js";

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return {
    plugins,
    channels: [],
    modelProviderConfigs: [],
    modelProviderEntries: [],
    providerAuthResolvers: [],
    providerCatalogProviders: [],
    modelCatalogProviders: [],
    modelAliasProviders: [],
    modelCompatibilityProviders: [],
    dynamicModelResolvers: [],
    endpointFactories: [],
    providerLoaders: [],
    providerSetups: [],
    onboardingProviders: [],
    authChoiceProviders: [],
    providerAuthChoiceProviders: [],
    providerPromptCachePolicies: [],
    providerMetadataProviders: [],
    providerPricingResolvers: [],
    providerHealthChecks: [],
    providerRewriters: [],
    providerToolCatalogProviders: [],
    builtinToolProviders: [],
    skillProviders: [],
    slashCommandProviders: [],
    installProviders: [],
    cliRegistrars: [],
    toolProviders: [],
    webSearchProviders: [],
    webFetchProviders: [],
    providerTtsProviders: [],
    memoryEmbeddingProviders: [],
    custom: [],
  };
}

describe("resolvePluginConfigContractsById", () => {
  beforeEach(() => {
    mocks.findBundledPluginMetadataById.mockReset();
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createRegistry([]));
  });

  it("does not fall back to bundled metadata when registry already resolved a plugin without config contracts", () => {
    mocks.loadPluginManifestRegistry.mockReturnValue(
      createRegistry([
        {
          id: "brave",
          origin: "bundled",
          rootDir: "/tmp/brave",
          manifestPath: "/tmp/brave/openclaw.plugin.json",
          channelConfigs: undefined,
          providerAuthEnvVars: undefined,
          uiHints: undefined,
          configSchema: undefined,
          configContracts: undefined,
          contracts: undefined,
          kind: undefined,
          appSync: undefined,
          packageName: undefined,
          packageVersion: undefined,
          publicSurfaceArtifacts: undefined,
          runtimeSidecarArtifacts: undefined,
          packageManifest: undefined,
        },
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["brave"],
      }),
    ).toEqual(new Map());
    expect(mocks.findBundledPluginMetadataById).not.toHaveBeenCalled();
  });
});
