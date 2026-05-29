import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  tokenMatches,
  matchKitsDetailed,
  buildMergedPlan,
  loadKitIndex,
  invalidateKitIndexCache,
  type KitIndexEntry,
} from "../kit-matcher.js";

describe("tokenMatches — fuzzy/stemmed matching", () => {
  it("matches inflections and typos", () => {
    expect(tokenMatches("debugging", "debug")).toBe(true);
    expect(tokenMatches("tests", "test")).toBe(true);
    expect(tokenMatches("crashes", "crash")).toBe(true);
    expect(tokenMatches("optimize", "optimise")).toBe(true);
  });
  it("does not over-match unrelated short tokens", () => {
    expect(tokenMatches("cat", "dog")).toBe(false);
    expect(tokenMatches("hello", "help")).toBe(false);
  });
});

describe("matchKitsDetailed — scoring + confidence", () => {
  const index: KitIndexEntry[] = [
    {
      slug: "debug",
      title: "Debug & Fix",
      summary: "reproduce diagnose fix verify",
      tags: ["debug", "bug", "crash", "error"],
      composes: [],
      path: "/nope",
    },
    {
      slug: "write-paper",
      title: "Write Paper",
      summary: "draft a manuscript",
      tags: ["paper", "write"],
      composes: [],
      path: "/nope",
    },
  ];

  it("high confidence for a clear single winner", () => {
    const r = matchKitsDetailed("debug the crash, it throws an error", index);
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.confidence).toBe("high");
  });

  it("fuzzy match still scores (debugging → debug)", () => {
    const r = matchKitsDetailed("debugging a crashing process", index);
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.confidence).not.toBe("none");
  });

  it("none when nothing clears threshold", () => {
    const r = matchKitsDetailed("xyzzy plugh frobnicate", index);
    expect(r.matches.length).toBe(0);
    expect(r.confidence).toBe("none");
  });
});

describe("buildMergedPlan — composition via composes:", () => {
  let dir: string;
  let index: KitIndexEntry[];
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-compose-"));
    const subMd = `---\nslug: "sub"\ntitle: "Sub"\nsummary: "s"\ntags: ["sub"]\n---\n## Steps\n### 1. SubStepA\nbody\n### 2. SubStepB\nbody\n`;
    const topMd = `---\nslug: "top"\ntitle: "Top"\nsummary: "t"\ntags: ["top"]\ncomposes: ["sub"]\n---\n## Steps\n### 1. TopStep\nbody\n`;
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, "top"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "kit.md"), subMd);
    await fs.writeFile(path.join(dir, "top", "kit.md"), topMd);
    invalidateKitIndexCache();
    index = await loadKitIndex(dir);
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    invalidateKitIndexCache();
  });

  it("loads composes from frontmatter", () => {
    const top = index.find((e) => e.slug === "top");
    expect(top?.composes).toEqual(["sub"]);
  });

  it("pulls composed kit's steps in ahead of the composer's own", async () => {
    const top = index.find((e) => e.slug === "top")!;
    const plan = await buildMergedPlan([{ entry: top, score: 5 }], index);
    expect(plan.composedFrom).toContain("sub");
    expect(plan.kitRefs).toContain("sub");
    const titles = plan.steps.map((s) => s.title);
    expect(titles).toEqual(["SubStepA", "SubStepB", "TopStep"]);
  });
});
