import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("syncMemoryWikiUnsafeLocalSources", () => {
  it("imports explicit private paths and preserves unsafe-local provenance", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-private-"));
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-unsafe-vault-"));
    tempDirs.push(privateDir, vaultDir);

    await fs.mkdir(path.join(privateDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(privateDir, "nested", "state.md"), "# internal state\n", "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "cache.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "blob.bin"), "\u0000\u0001", "utf8");
    const directPath = path.join(privateDir, "events.log");
    await fs.writeFile(directPath, "private log\n", "utf8");

    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
        vault: { path: vaultDir },
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [path.join(privateDir, "nested"), directPath],
        },
      },
      { homedir: "/Users/tester" },
    );

    const first = await syncMemoryWikiUnsafeLocalSources(config);

    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);

    const page = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-unsafe-local");
    expect(page).toContain("provenanceMode: unsafe-local");

    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
  });
});
