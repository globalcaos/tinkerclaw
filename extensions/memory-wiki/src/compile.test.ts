import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("compileMemoryWikiVault", () => {
  it("writes root and directory indexes for native markdown", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir } },
      { homedir: "/Users/tester" },
    );
    await initializeMemoryWikiVault(config);

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(1);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
  });

  it("renders obsidian-friendly links when configured", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir, renderMode: "obsidian" } },
      { homedir: "/Users/tester" },
    );
    await initializeMemoryWikiVault(config);

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[[sources/alpha|Alpha]]",
    );
  });
});
