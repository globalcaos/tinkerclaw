/**
 * FORK 2026-10-09: the recipe-index publish contract (recipe-index-publish.ts) that the
 * Claude Code hook reads. Temp stateDir only — no host paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishRecipeIndex, recipeIndexPath } from "./recipe-index-publish.js";
import type { RecipeIndexEntry } from "./recipe-matcher.js";

function entry(slug: string, over: Partial<RecipeIndexEntry> = {}): RecipeIndexEntry {
  return {
    slug,
    owner: "owner-a",
    title: `Title ${slug}`,
    summary: `Summary ${slug}`,
    tags: [slug],
    antiTriggers: ["never"],
    composes: [],
    path: `/recipes/${slug}/recipe.md`,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("publishRecipeIndex", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "recipe-index-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("writes the contract shape sorted by slug, listed fields only", async () => {
    await publishRecipeIndex(
      [
        entry("zeta", { category: "coding", subdivision: "review" }),
        entry("alpha", { owner: "owner-b", tags: ["a", "b"] }),
      ],
      { stateDir },
    );
    const file = recipeIndexPath(stateDir);
    expect(file).toBe(path.join(stateDir, "prefrontal", "recipe-index.json"));
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
      version: number;
      generatedAt: string;
      recipes: Array<Record<string, unknown>>;
    };
    expect(raw.version).toBe(1);
    expect(Number.isNaN(Date.parse(raw.generatedAt))).toBe(false);
    expect(raw.recipes.map((r) => r.slug)).toEqual(["alpha", "zeta"]);
    expect(raw.recipes[0]).toEqual({
      slug: "alpha",
      owner: "owner-b",
      title: "Title alpha",
      summary: "Summary alpha",
      tags: ["a", "b"],
      path: "/recipes/alpha/recipe.md",
    });
    expect(raw.recipes[1]).toMatchObject({ category: "coding", subdivision: "review" });
    // matcher-only fields never leak into the contract
    expect("antiTriggers" in raw.recipes[0]).toBe(false);
    expect("composes" in raw.recipes[0]).toBe(false);
    // no tmp file left beside the published one
    expect(await fs.readdir(path.dirname(file))).toEqual(["recipe-index.json"]);
  });

  it("an identical second publish does not rewrite the file", async () => {
    const entries = [entry("beta"), entry("alpha")];
    await publishRecipeIndex(entries, { stateDir });
    const file = recipeIndexPath(stateDir);
    const before = await fs.readFile(file, "utf8");
    const mtimeBefore = (await fs.stat(file)).mtimeMs;
    await sleep(20); // a rewrite would move mtime
    await publishRecipeIndex(entries.toReversed(), { stateDir });
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect((await fs.stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("changed entries rewrite the file", async () => {
    await publishRecipeIndex([entry("alpha", { title: "v1" })], { stateDir });
    const file = recipeIndexPath(stateDir);
    const before = JSON.parse(await fs.readFile(file, "utf8")) as { generatedAt: string };
    await sleep(20);
    await publishRecipeIndex([entry("alpha", { title: "v2" }), entry("gamma")], { stateDir });
    const after = JSON.parse(await fs.readFile(file, "utf8")) as {
      generatedAt: string;
      recipes: Array<{ slug: string; title: string }>;
    };
    expect(after.recipes.map((r) => `${r.slug}:${r.title}`)).toEqual([
      "alpha:v2",
      "gamma:Title gamma",
    ]);
    expect(after.generatedAt).not.toBe(before.generatedAt);
  });

  it("an unwritable dir does not throw — one warn line", async () => {
    // A regular file where the state dir should be: mkdir fails with ENOTDIR for any
    // user (a chmod-based check passes as root).
    const blocker = path.join(stateDir, "blocker");
    await fs.writeFile(blocker, "not a directory\n");
    const warns: string[] = [];
    await expect(
      publishRecipeIndex([entry("alpha")], {
        stateDir: path.join(blocker, "state"),
        log: { warn: (m) => warns.push(m) },
      }),
    ).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("[recipe-index] publish");
  });
});
