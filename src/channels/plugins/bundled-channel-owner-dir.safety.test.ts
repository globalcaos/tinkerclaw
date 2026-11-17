// FORK 2026-10-29: the bundled channel owner lookup reads every candidate manifest through
// loadPluginManifest, so a manifest that loader refuses cannot make its directory a channel's
// owner and choose the doctor contract that gets loaded. A plain read let the symlink and the
// oversized rival below take the channel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest, MAX_PLUGIN_MANIFEST_BYTES } from "../../plugins/manifest.js";
import { resolveBundledChannelOwnerDirName } from "./bundled-channel-owner-dir.js";

const MANIFEST_FILE = "openclaw.plugin.json";
const OWNER_DIR = "acme-chat";
// Sorts before OWNER_DIR, so a rival manifest the lookup accepts takes the channel.
const RIVAL_DIR = "aaa-rival";

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
});

function chatManifest(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, channels: ["chat"], configSchema: { type: "object" }, ...extra });
}

// A bundled plugins dir where OWNER_DIR owns `chat` and RIVAL_DIR has no manifest yet. Both have
// an openclaw.extensions entry, so the rival's manifest alone decides whether it takes the
// channel. outsideDir sits outside every plugin directory.
function useRivalFixture(): { rivalDir: string; outsideDir: string } {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owner-dir-safety-"));
  tempDirs.push(packageRoot);
  const pluginsDir = path.join(packageRoot, "dist", "extensions");
  for (const dirName of [OWNER_DIR, RIVAL_DIR]) {
    fs.mkdirSync(path.join(pluginsDir, dirName), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, dirName, "package.json"),
      JSON.stringify({
        name: `@fixture/${dirName}`,
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
  }
  fs.writeFileSync(path.join(pluginsDir, OWNER_DIR, MANIFEST_FILE), chatManifest(OWNER_DIR));
  const outsideDir = path.join(packageRoot, "outside");
  fs.mkdirSync(outsideDir);
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginsDir;
  return { rivalDir: path.join(pluginsDir, RIVAL_DIR), outsideDir };
}

describe("bundled channel owner lookup and manifests the manifest loader refuses", () => {
  it("control: a rival with a plain manifest file sorts first and takes the channel", () => {
    const { rivalDir } = useRivalFixture();
    fs.writeFileSync(path.join(rivalDir, MANIFEST_FILE), chatManifest(RIVAL_DIR));

    expect(loadPluginManifest(rivalDir, false).ok).toBe(true);
    expect(resolveBundledChannelOwnerDirName("chat")).toBe(RIVAL_DIR);
  });

  it.skipIf(process.platform === "win32")(
    "skips a rival whose manifest is a symlink to a file outside its plugin directory",
    () => {
      const { rivalDir, outsideDir } = useRivalFixture();
      const outsideManifest = path.join(outsideDir, MANIFEST_FILE);
      fs.writeFileSync(outsideManifest, chatManifest(RIVAL_DIR));
      fs.symlinkSync(outsideManifest, path.join(rivalDir, MANIFEST_FILE));

      expect(loadPluginManifest(rivalDir, false).ok).toBe(false);
      expect(resolveBundledChannelOwnerDirName("chat")).toBe(OWNER_DIR);
    },
  );

  it("skips a rival whose manifest is over the manifest size limit", () => {
    const { rivalDir } = useRivalFixture();
    fs.writeFileSync(
      path.join(rivalDir, MANIFEST_FILE),
      chatManifest(RIVAL_DIR, { padding: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES) }),
    );

    expect(loadPluginManifest(rivalDir, false).ok).toBe(false);
    expect(resolveBundledChannelOwnerDirName("chat")).toBe(OWNER_DIR);
  });

  it("skips a rival whose manifest path is a directory, not a regular file", () => {
    const { rivalDir } = useRivalFixture();
    fs.mkdirSync(path.join(rivalDir, MANIFEST_FILE));

    expect(loadPluginManifest(rivalDir, false).ok).toBe(false);
    expect(resolveBundledChannelOwnerDirName("chat")).toBe(OWNER_DIR);
  });
});
