import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("searchMemoryWiki", () => {
  it("finds pages by title and body", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-query-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir } },
      { homedir: "/Users/tester" },
    );
    await initializeMemoryWikiVault(config);
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha body text\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("sources/alpha.md");
  });
});

describe("getMemoryWikiPage", () => {
  it("reads pages by relative path and slices line ranges", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-query-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir } },
      { homedir: "/Users/tester" },
    );
    await initializeMemoryWikiVault(config);
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nline one\nline two\nline three\n",
      }),
      "utf8",
    );

    const result = await getMemoryWikiPage({
      config,
      lookup: "sources/alpha.md",
      fromLine: 4,
      lineCount: 2,
    });

    expect(result?.path).toBe("sources/alpha.md");
    expect(result?.content).toContain("line one");
    expect(result?.content).toContain("line two");
    expect(result?.content).not.toContain("line three");
  });
});
