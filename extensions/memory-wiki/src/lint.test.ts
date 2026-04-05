import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("lintMemoryWikiVault", () => {
  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-lint-"));
    tempDirs.push(rootDir);
    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir, renderMode: "obsidian" } },
      { homedir: "/Users/tester" },
    );
    await initializeMemoryWikiVault(config);

    const duplicate = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: 0.2,
      },
      body: "# Alpha\n\n[[missing-page]]\n",
    });
    await fs.writeFile(path.join(rootDir, "entities", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(path.join(rootDir, "concepts", "alpha.md"), duplicate, "utf8");

    const result = await lintMemoryWikiVault(config);

    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-source-ids");
    expect(result.issues.map((issue) => issue.code)).toContain("broken-wikilink");
    expect(result.issues.map((issue) => issue.code)).toContain("contradiction-present");
    expect(result.issues.map((issue) => issue.code)).toContain("open-question");
    expect(result.issues.map((issue) => issue.code)).toContain("low-confidence");
    expect(result.issuesByCategory.contradictions).toHaveLength(2);
    expect(result.issuesByCategory["open-questions"]).toHaveLength(2);
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Errors");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Contradictions");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Open Questions");
  });
});
