/**
 * recipe-locate (2026-09-02): the single owner of the library layout rule.
 * Three layouts must all resolve — `<slug>/recipe.md`, `<category>/<name>.md`,
 * `<category>/<subdivision>/<name>.md` — and root documentation files must not.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRecipeTargets, declaredSlug, findRecipeFile } from "../recipe-locate.js";

let dir: string;

const kit = (slug: string) =>
  `---\nschema: "kit/1.0"\nslug: "${slug}"\ntitle: "${slug}"\nsummary: "s"\ntags: ["${slug}"]\n---\n### 1. One\nbody\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "recipe-locate-"));
  await writeFile(join(dir, "CATALOG.md"), "# not a recipe\n");
  await mkdir(join(dir, "top"), { recursive: true });
  await writeFile(join(dir, "top", "recipe.md"), kit("top"));
  await mkdir(join(dir, "coding"), { recursive: true });
  await writeFile(join(dir, "coding", "feature.md"), kit("feature"));
  await mkdir(join(dir, "writing", "papers"), { recursive: true });
  await writeFile(join(dir, "writing", "papers", "write-paper.md"), kit("write-paper"));
  // declared slug differs from the file stem
  await writeFile(join(dir, "coding", "old-name.md"), kit("renamed"));
  // too deep to be a recipe
  await mkdir(join(dir, "a", "b", "c"), { recursive: true });
  await writeFile(join(dir, "a", "b", "c", "deep.md"), kit("deep"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectRecipeTargets", () => {
  it("yields all three layouts, parents before children, and skips root docs", async () => {
    const targets = await collectRecipeTargets(dir);
    const slugs = targets.map((t) => t.slug);
    expect(slugs).toContain("top");
    expect(slugs).toContain("feature");
    expect(slugs).toContain("write-paper");
    expect(slugs).not.toContain("CATALOG");
    expect(slugs.indexOf("coding")).toBeLessThan(slugs.indexOf("feature")); // parent first
  });

  it("stops at SCAN_MAX_DEPTH — a file four levels down is not a recipe", async () => {
    const targets = await collectRecipeTargets(dir);
    expect(targets.map((t) => t.slug)).not.toContain("deep");
  });

  it("an absent dir contributes nothing and does not throw", async () => {
    expect(await collectRecipeTargets(join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("findRecipeFile", () => {
  it("resolves a top-level kit dir", async () => {
    expect(await findRecipeFile(dir, "top")).toBe(join(dir, "top", "recipe.md"));
  });
  it("resolves a category-folder playbook by file stem", async () => {
    expect(await findRecipeFile(dir, "feature")).toBe(join(dir, "coding", "feature.md"));
  });
  it("resolves a subdivision-folder kit", async () => {
    expect(await findRecipeFile(dir, "write-paper")).toBe(
      join(dir, "writing", "papers", "write-paper.md"),
    );
  });
  it("falls back to the declared frontmatter slug when the file stem differs", async () => {
    expect(await findRecipeFile(dir, "renamed")).toBe(join(dir, "coding", "old-name.md"));
  });
  it("returns null for an unknown slug", async () => {
    expect(await findRecipeFile(dir, "nope")).toBeNull();
  });
});

describe("declaredSlug", () => {
  it("reads slug: or id:, quoted or bare", () => {
    expect(declaredSlug('---\nslug: "a-b"\n---\n')).toBe("a-b");
    expect(declaredSlug("---\nid: feature\ntitle: x\n---\n")).toBe("feature");
    expect(declaredSlug("no frontmatter")).toBeUndefined();
  });
});
