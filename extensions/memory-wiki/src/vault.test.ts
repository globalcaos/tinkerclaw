import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { initializeMemoryWikiVault, WIKI_VAULT_DIRECTORIES } from "./vault.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("initializeMemoryWikiVault", () => {
  it("creates the wiki layout and seed files", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      {
        vault: {
          path: rootDir,
          renderMode: "obsidian",
        },
      },
      { homedir: "/Users/tester" },
    );

    const result = await initializeMemoryWikiVault(config, {
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.created).toBe(true);
    await Promise.all(
      WIKI_VAULT_DIRECTORIES.map(async (relativeDir) => {
        await expect(fs.stat(path.join(rootDir, relativeDir))).resolves.toBeTruthy();
      }),
    );
    await expect(fs.readFile(path.join(rootDir, "AGENTS.md"), "utf8")).resolves.toContain(
      "Memory Wiki Agent Guide",
    );
    await expect(fs.readFile(path.join(rootDir, "WIKI.md"), "utf8")).resolves.toContain(
      "Render mode: `obsidian`",
    );
    await expect(
      fs.readFile(path.join(rootDir, ".openclaw-wiki", "state.json"), "utf8"),
    ).resolves.toContain('"renderMode": "obsidian"');
  });

  it("is idempotent when the vault already exists", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      {
        vault: {
          path: rootDir,
        },
      },
      { homedir: "/Users/tester" },
    );

    await initializeMemoryWikiVault(config);
    const second = await initializeMemoryWikiVault(config);

    expect(second.created).toBe(false);
    expect(second.createdDirectories).toHaveLength(0);
    expect(second.createdFiles).toHaveLength(0);
  });
});
