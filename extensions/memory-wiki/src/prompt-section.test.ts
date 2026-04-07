import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { buildWikiPromptSection, createWikiPromptSectionBuilder } from "./prompt-section.js";

let suiteRoot = "";

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-prompt-suite-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
});

describe("buildWikiPromptSection", () => {
  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const lines = buildWikiPromptSection({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    });

    expect(lines.join("\n")).toContain("`memory_search` with `corpus=all`");
    expect(lines.join("\n")).toContain("`memory_get` with `corpus=wiki` or `corpus=all`");
    expect(lines.join("\n")).toContain("wiki-specific ranking or provenance details");
  });

  it("stays empty when no wiki or memory-adjacent tools are registered", () => {
    expect(buildWikiPromptSection({ availableTools: new Set(["web_search"]) })).toEqual([]);
  });

  it("can append a compact compiled digest snapshot when enabled", async () => {
    const rootDir = path.join(suiteRoot, "digest-enabled");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"),
      JSON.stringify(
        {
          claimCount: 8,
          contradictionClusters: [{ key: "claim.alpha.db" }],
          pages: [
            {
              title: "Alpha",
              kind: "entity",
              claimCount: 3,
              questions: ["Still active?"],
              contradictions: ["Conflicts with source.beta"],
              topClaims: [
                {
                  text: "Alpha uses PostgreSQL for production writes.",
                  status: "supported",
                  confidence: 0.91,
                  freshnessLevel: "fresh",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const builder = createWikiPromptSectionBuilder(
      resolveMemoryWikiConfig({
        vault: { path: rootDir },
        context: { includeCompiledDigestPrompt: true },
      }),
    );

    const lines = builder({ availableTools: new Set(["web_search"]) });

    expect(lines.join("\n")).toContain("## Compiled Wiki Snapshot");
    expect(lines.join("\n")).toContain(
      "Alpha: entity, 3 claims, 1 open questions, 1 contradiction notes",
    );
    expect(lines.join("\n")).toContain("Alpha uses PostgreSQL for production writes.");
  });

  it("keeps the digest snapshot disabled by default", async () => {
    const rootDir = path.join(suiteRoot, "digest-disabled");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"),
      JSON.stringify({
        claimCount: 1,
        pages: [{ title: "Alpha", kind: "entity", claimCount: 1, topClaims: [] }],
      }),
      "utf8",
    );
    const builder = createWikiPromptSectionBuilder(
      resolveMemoryWikiConfig({
        vault: { path: rootDir },
      }),
    );

    expect(builder({ availableTools: new Set(["web_search"]) })).toEqual([]);
  });
});
