// FORK 2026-10-29: a channel whose plugin directory is not named after it (the fork's WhatsApp
// layout) gets its doctor contract from the owning plugin's directory, and the lookup never loads
// that plugin's channel entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBundledChannelPluginMetadata } from "../../plugins/bundled-channel-runtime.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { resolveBundledChannelOwnerDirName } from "./bundled-channel-owner-dir.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";

type FixturePlugin = {
  dirName: string;
  manifest: Record<string, unknown>;
  // package.json openclaw.extensions. Left out, the bundled channel metadata skips the directory.
  extensions?: string[];
  files?: Record<string, string>;
};

const ENTRY_LOADS = "__ownerDirFixtureChannelEntryLoads";
const CHANNEL_ENTRY_SOURCE = [
  `globalThis.${ENTRY_LOADS} = (globalThis.${ENTRY_LOADS} ?? 0) + 1;`,
  "export default {};",
  "",
].join("\n");
const CHAT_RULE = { path: ["channels", "chat", "old"], message: "chat legacy rule" };
const CHAT_CONTRACT_SOURCE = [
  `export const legacyConfigRules = [${JSON.stringify(CHAT_RULE)}];`,
  "export function normalizeCompatibilityConfig({ cfg }) {",
  "  return { config: cfg, changes: [] };",
  "}",
  "",
].join("\n");
const OTHER_CONTRACT_SOURCE = "export const legacyConfigRules = [];\n";
const configSchema = { type: "object" };

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  Reflect.deleteProperty(globalThis, ENTRY_LOADS);
});

function useBundledPluginsDir(plugins: readonly FixturePlugin[]): void {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-owner-dir-"));
  tempDirs.push(packageRoot);
  const bundledPluginsDir = path.join(packageRoot, "dist", "extensions");
  for (const plugin of plugins) {
    const pluginDir = path.join(bundledPluginsDir, plugin.dirName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(plugin.manifest));
    const packageJson = {
      name: `@fixture/${plugin.dirName}`,
      version: "0.0.0",
      type: "module",
      ...(plugin.extensions ? { openclaw: { extensions: plugin.extensions } } : {}),
    };
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify(packageJson));
    for (const [fileName, source] of Object.entries(plugin.files ?? {})) {
      fs.writeFileSync(path.join(pluginDir, fileName), source);
    }
  }
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
}

function chatFixture(): FixturePlugin[] {
  return [
    // Sorts first and claims the channel, but has no openclaw.extensions entry.
    {
      dirName: "aaa-chat-draft",
      manifest: { id: "aaa-chat-draft", channels: ["chat"], configSchema },
      files: { "doctor-contract-api.js": OTHER_CONTRACT_SOURCE },
    },
    {
      dirName: "acme-chat",
      manifest: { id: "acme-chat", channels: ["chat"], configSchema },
      extensions: ["./index.js"],
      files: {
        "doctor-contract-api.js": CHAT_CONTRACT_SOURCE,
        "index.js": CHANNEL_ENTRY_SOURCE,
        "channel-plugin-api.js": CHANNEL_ENTRY_SOURCE,
      },
    },
    // Also claims the channel, but sorts after acme-chat.
    {
      dirName: "zeta-chat",
      manifest: { id: "zeta-chat", channels: ["chat", "zeta"], configSchema },
      extensions: ["./index.js"],
      files: { "doctor-contract-api.js": OTHER_CONTRACT_SOURCE },
    },
    // A dormant copy (plugin discovery skips `.disabled` directories) that owns `legacy`.
    {
      dirName: "legacy.disabled-hostver",
      manifest: { id: "legacy", channels: ["legacy"], configSchema },
      extensions: ["./index.js"],
      files: { "doctor-contract-api.js": CHAT_CONTRACT_SOURCE },
    },
    // Matches by id but declares no channel, so it owns none.
    {
      dirName: "solo-plugin",
      manifest: { id: "solo", configSchema },
      extensions: ["./index.js"],
    },
  ];
}

function entryLoads(): number {
  const loads: unknown = Reflect.get(globalThis, ENTRY_LOADS);
  return typeof loads === "number" ? loads : 0;
}

describe("doctor contract lookup through the plugin that owns the channel", () => {
  it("loads the owner's contract without loading its channel entry", () => {
    useBundledPluginsDir(chatFixture());

    const api = loadBundledChannelDoctorContractApi("chat");

    expect(api?.legacyConfigRules).toEqual([CHAT_RULE]);
    expect(typeof api?.normalizeCompatibilityConfig).toBe("function");
    expect(entryLoads()).toBe(0);
    // Control: the counter moves when the channel entry really loads.
    loadBundledPluginPublicArtifactModuleSync({
      dirName: "acme-chat",
      artifactBasename: "channel-plugin-api.js",
      installRuntimeDeps: false,
    });
    expect(entryLoads()).toBe(1);
  });

  it("picks the owner by the bundled channel metadata rule, and never a dormant copy", () => {
    useBundledPluginsDir(chatFixture());
    // listBundledChannelMetadata and the resolveBundledChannelMetadata predicate from bundled.ts,
    // run on the same fixture.
    const rootScope = resolveBundledChannelRootScope();
    const metadata = listBundledChannelPluginMetadata({
      rootDir: rootScope.packageRoot,
      ...(rootScope.pluginsDir ? { scanDir: rootScope.pluginsDir } : {}),
      includeChannelConfigs: false,
      includeSyntheticChannelConfigs: false,
    }).filter((entry) => (entry.manifest.channels?.length ?? 0) > 0);
    const metadataOwner = (channelId: string) =>
      metadata.find(
        (entry) => entry.manifest.id === channelId || entry.manifest.channels?.includes(channelId),
      )?.dirName;

    expect(metadataOwner("chat")).toBe("acme-chat");
    expect(metadataOwner("zeta")).toBe("zeta-chat");
    for (const channelId of ["chat", "zeta", "acme-chat", "solo", "missing"]) {
      expect(resolveBundledChannelOwnerDirName(channelId)).toBe(metadataOwner(channelId));
    }

    expect(metadataOwner("legacy")).toBe("legacy.disabled-hostver");
    expect(resolveBundledChannelOwnerDirName("legacy")).toBeUndefined();
    expect(loadBundledChannelDoctorContractApi("legacy")).toBeUndefined();
  });
});
