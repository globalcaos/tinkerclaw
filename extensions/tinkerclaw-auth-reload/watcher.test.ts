import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearSnapshots = vi.fn();
let authPath = "";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  clearRuntimeAuthProfileStoreSnapshots: () => clearSnapshots(),
}));
vi.mock("openclaw/plugin-sdk/fork-auth-admin", () => ({
  resolveAuthStorePath: () => authPath,
}));

const { startAuthProfileWatcher, stopAuthProfileWatcher } = await import("./watcher.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function atomicWrite(target: string, value: unknown): void {
  const tmp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, target);
}

describe("auth profile watcher", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-reload-watcher-"));
    authPath = path.join(dir, "auth-profiles.json");
    fs.writeFileSync(authPath, "{}");
    clearSnapshots.mockClear();
    // The watcher polls under VITEST, and polling hides the dead-inode bug.
    // Exercise the native fs.watch path the gateway runs.
    vi.stubEnv("VITEST", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stopAuthProfileWatcher();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The gateway builds the plugin registry several times per boot, so
  // register() — and with it startAuthProfileWatcher() — runs repeatedly.
  it("keeps invalidating across atomic rewrites after repeated starts", async () => {
    for (let i = 0; i < 5; i++) {
      startAuthProfileWatcher();
    }
    await sleep(500);

    for (let write = 1; write <= 3; write++) {
      atomicWrite(authPath, { write });
      await sleep(1500);
      expect(clearSnapshots).toHaveBeenCalledTimes(write);
    }
  }, 15_000);

  it("ignores sibling files in the auth directory", async () => {
    startAuthProfileWatcher();
    await sleep(500);

    atomicWrite(path.join(dir, "auth-state.json"), { usageStats: {} });
    await sleep(1500);
    expect(clearSnapshots).not.toHaveBeenCalled();
  }, 15_000);
});
