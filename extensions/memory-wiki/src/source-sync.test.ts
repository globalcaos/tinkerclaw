import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("syncMemoryWikiImportedSources", () => {
  it("refreshes indexes when imported sources change and skips when they do not", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-sync-private-"));
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-sync-vault-"));
    tempDirs.push(privateDir, vaultDir);

    const sourcePath = path.join(privateDir, "alpha.md");
    await fs.writeFile(sourcePath, "# Alpha\n", "utf8");

    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
        vault: { path: vaultDir },
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
      },
      { homedir: "/Users/tester" },
    );

    const first = await syncMemoryWikiImportedSources({ config });

    expect(first.indexesRefreshed).toBe(true);
    expect(first.indexRefreshReason).toBe("import-changed");
    await expect(fs.readFile(path.join(vaultDir, "index.md"), "utf8")).resolves.toContain(
      "Unsafe Local Import: alpha.md",
    );

    const second = await syncMemoryWikiImportedSources({ config });

    expect(second.indexesRefreshed).toBe(false);
    expect(second.indexRefreshReason).toBe("no-import-changes");

    await fs.rm(path.join(vaultDir, "sources", "index.md"));
    const third = await syncMemoryWikiImportedSources({ config });

    expect(third.indexesRefreshed).toBe(true);
    expect(third.indexRefreshReason).toBe("missing-indexes");
    await expect(
      fs.readFile(path.join(vaultDir, "sources", "index.md"), "utf8"),
    ).resolves.toContain("Unsafe Local Import: alpha.md");
  });

  it("respects ingest.autoCompile=false", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-sync-private-"));
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-sync-vault-"));
    tempDirs.push(privateDir, vaultDir);

    const sourcePath = path.join(privateDir, "alpha.md");
    await fs.writeFile(sourcePath, "# Alpha\n", "utf8");

    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
        vault: { path: vaultDir },
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
        ingest: {
          autoCompile: false,
        },
      },
      { homedir: "/Users/tester" },
    );

    const result = await syncMemoryWikiImportedSources({ config });

    expect(result.indexesRefreshed).toBe(false);
    expect(result.indexRefreshReason).toBe("auto-compile-disabled");
  });
});
