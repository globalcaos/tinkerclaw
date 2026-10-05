import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withTempConfig } from "../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";

// FORK 2026-09-21: sessions.delete/reset must not rewrite sessions.json when no
// in-scope entry carries plugin-owned state (the rewrite of the 16 MB live store
// under its lock contributed to 70-75 s deletes).

async function withStore(
  initial: Record<string, SessionEntry>,
  run: (ctx: { storePath: string; cfg: { session: { store: string } } }) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hook-cleanup-noop-"),
  );
  const storePath = path.join(stateDir, "sessions.json");
  // Compact JSON on purpose: any rewrite by updateSessionStore changes the bytes.
  await fs.writeFile(storePath, JSON.stringify(initial), "utf-8");
  const cfg = { session: { store: storePath } };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await withTempConfig({ cfg, run: () => run({ storePath, cfg }) });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function snapshotFile(storePath: string) {
  const stat = fsSync.statSync(storePath);
  return {
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    contents: fsSync.readFileSync(storePath, "utf-8"),
  };
}

describe("runPluginHostCleanup session-store writes", () => {
  it("does not rewrite the store when no entry carries plugin-owned state", async () => {
    const now = Date.now();
    await withStore(
      {
        "agent:main:main": { sessionId: "session-1", updatedAt: now },
        "agent:main:other": { sessionId: "session-2", updatedAt: now },
      },
      async ({ storePath, cfg }) => {
        const before = snapshotFile(storePath);
        const result = await runPluginHostCleanup({
          cfg,
          reason: "delete",
          sessionKey: "agent:main:main",
        });
        expect(result).toEqual({ cleanupCount: 0, failures: [] });
        expect(snapshotFile(storePath)).toEqual(before);
      },
    );
  });

  it("does not rewrite the store when plugin state lives only outside the cleanup scope", async () => {
    const now = Date.now();
    await withStore(
      {
        "agent:main:main": { sessionId: "session-1", updatedAt: now },
        "agent:main:other": {
          sessionId: "session-2",
          updatedAt: now,
          pluginExtensions: { "fixture-plugin": { workflow: { state: "waiting" } } },
        },
      },
      async ({ storePath, cfg }) => {
        const before = snapshotFile(storePath);
        const result = await runPluginHostCleanup({
          cfg,
          reason: "reset",
          sessionKey: "agent:main:main",
        });
        expect(result.cleanupCount).toBe(0);
        expect(snapshotFile(storePath)).toEqual(before);
      },
    );
  });

  it("still clears plugin-owned state when the target session carries it", async () => {
    const now = Date.now();
    await withStore(
      {
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: now,
          pluginExtensions: { "fixture-plugin": { workflow: { state: "waiting" } } },
        },
        "agent:main:other": {
          sessionId: "session-2",
          updatedAt: now,
          pluginExtensions: { "fixture-plugin": { workflow: { state: "kept" } } },
        },
      },
      async ({ storePath, cfg }) => {
        const result = await runPluginHostCleanup({
          cfg,
          reason: "delete",
          sessionKey: "agent:main:main",
        });
        expect(result.cleanupCount).toBe(1);
        const stored = loadSessionStore(storePath, { skipCache: true });
        expect(stored["agent:main:main"]?.pluginExtensions).toBeUndefined();
        expect(stored["agent:main:other"]?.pluginExtensions?.["fixture-plugin"]).toEqual({
          workflow: { state: "kept" },
        });
      },
    );
  });
});
