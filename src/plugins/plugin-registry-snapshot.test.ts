import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex, type InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-snapshot", tempDirs);
}

function createHermeticEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
}

function writeManifestlessClaudeBundle(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "skills", "SKILL.md"), "# Workspace skill\n", "utf8");
}

function createManifestlessClaudeBundleIndex(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): InstalledPluginIndex {
  return loadInstalledPluginIndex({
    config: {
      plugins: {
        load: { paths: [params.rootDir] },
      },
    },
    env: params.env,
  });
}

describe("loadPluginRegistrySnapshotWithMetadata", () => {
  it("keeps persisted manifestless Claude bundles on the fast path", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = createHermeticEnv(tempRoot);
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writeManifestlessClaudeBundle(rootDir);
    const index = createManifestlessClaudeBundleIndex({ rootDir, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toEqual([]);
  });

  // 2026-10-23 (JarvisPi): the auth probes behind every tool build ask with preferPersisted: false, and each call
  // rebuilt the index from every manifest on the gateway's main thread.
  describe("callers that skip the persisted registry", () => {
    function setup() {
      const tempRoot = makeTempDir();
      const rootDir = path.join(tempRoot, "workspace");
      const stateDir = path.join(tempRoot, "state");
      const env = createHermeticEnv(tempRoot);
      const config = { plugins: { load: { paths: [rootDir] } } };
      writeManifestlessClaudeBundle(rootDir);
      return { rootDir, stateDir, env, config };
    }

    it("reuse the derived index instead of rebuilding it on every call", () => {
      const { stateDir, env, config } = setup();
      const first = loadPluginRegistrySnapshotWithMetadata({
        config,
        env,
        stateDir,
        preferPersisted: false,
      });
      const second = loadPluginRegistrySnapshotWithMetadata({
        config,
        env,
        stateDir,
        preferPersisted: false,
      });

      expect(first.source).toBe("derived");
      expect(second).toBe(first);
    });

    it("never receive a persisted-mode result", () => {
      const { rootDir, stateDir, env, config } = setup();
      writePersistedInstalledPluginIndexSync(
        createManifestlessClaudeBundleIndex({ rootDir, env }),
        { stateDir },
      );

      const persisted = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });
      const fresh = loadPluginRegistrySnapshotWithMetadata({
        config,
        env,
        stateDir,
        preferPersisted: false,
      });

      expect(persisted.source).toBe("persisted");
      expect(fresh.source).toBe("derived");
    });

    it("still rebuild when they opt out with cache: false", () => {
      const { stateDir, env, config } = setup();
      const opts = { config, env, stateDir, preferPersisted: false, cache: false } as const;
      const first = loadPluginRegistrySnapshotWithMetadata(opts);
      const second = loadPluginRegistrySnapshotWithMetadata(opts);

      expect(second).not.toBe(first);
    });
  });
});
