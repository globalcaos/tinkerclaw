import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import { resolveMemoryWikiConfig } from "./config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("syncMemoryWikiBridgeSources", () => {
  it("imports public memory-core artifacts and stays idempotent across reruns", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-ws-"));
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-vault-"));
    tempDirs.push(workspaceDir, vaultDir);

    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
      "# Dream Report\n",
      "utf8",
    );

    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: { path: vaultDir },
        bridge: {
          enabled: true,
          readMemoryCore: true,
          indexMemoryRoot: true,
          indexDailyNotes: true,
          indexDreamReports: true,
        },
      },
      { homedir: "/Users/tester" },
    );
    const appConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "memory-core": {
            enabled: true,
            config: {},
          },
        },
      },
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(first.workspaces).toBe(1);
    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.pagePaths).toHaveLength(3);

    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(3);

    const memoryPage = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);

    const logLines = (await fs.readFile(path.join(vaultDir, ".openclaw-wiki", "log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(2);
  });

  it("returns a no-op result outside bridge mode", async () => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-isolated-"));
    tempDirs.push(vaultDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: vaultDir } },
      { homedir: "/Users/tester" },
    );

    const result = await syncMemoryWikiBridgeSources({ config });

    expect(result).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    });
  });

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-events-ws-"));
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-events-vault-"));
    tempDirs.push(workspaceDir, vaultDir);

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "bridge events",
      resultCount: 1,
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 1,
          endLine: 2,
          score: 0.8,
        },
      ],
    });

    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: { path: vaultDir },
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
      },
      { homedir: "/Users/tester" },
    );
    const appConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "memory-core": {
            enabled: true,
            config: {},
          },
        },
      },
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
  });
});
