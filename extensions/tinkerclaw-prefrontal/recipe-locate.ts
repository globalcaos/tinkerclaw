/**
 * FORK 2026-09-02: recipe-locate — the ONE owner of "which files in the library
 * are recipes, and what slug does each carry".
 *
 * Three call sites used to answer that question independently, and each one
 * stopped at a different depth: the matcher's scanner (one level, fixed
 * 2026-08-22 to two), the runner's `loadRecipeText` (`<dir>/<slug>/recipe.md`
 * only) and the `prefrontal.recipe.read` RPC (same). The library, meanwhile,
 * holds three layouts — `<slug>/recipe.md`, `<category>/<name>.md` and
 * `<category>/<subdivision>/<name>.md` — so a recipe could be listed by the tab,
 * matched by the scanner, and then fail to LOAD when a `uses:` step named it.
 * A leaf module (no imports from recipe-runner / recipe-matcher, so it can never
 * close an import cycle) that every resolver goes through is the structural fix.
 *
 * Slug derivation (unchanged from the scanner, now shared):
 *   `<dir>/<name>/recipe.md|kit.md`  → slug `<name>`
 *   `<dir>/…/compose.recipe.md`      → slug `compose`
 *   `<dir>/…/debug.md`               → slug `debug`
 * Frontmatter `slug:` / `id:` still overrides when present (the index honours it;
 * `findRecipeFile` checks both the derived and the declared slug).
 */
import fs from "node:fs/promises";
import { join } from "node:path";

/** Canonical first, legacy second — the dual-read of the 2026-06-02 rename. */
export const RECIPE_FILENAMES = ["recipe.md", "kit.md"] as const;

/** `<root>/<category>/<subdivision>/<name>.md` is depth 3. Deeper is not a recipe. */
export const SCAN_MAX_DEPTH = 3;

/** Files that live in the library root but are documentation, never recipes. */
const NON_RECIPE_MD = new Set(["CATALOG.md", "AUTHORING.md", "README.md"]);

export interface RecipeFileTarget {
  /** Slug derived from the path (dir name or file stem). */
  slug: string;
  /** Candidate files in preference order; the first readable one is the recipe. */
  candidates: string[];
}

/**
 * Walk a recipe library and return every place a recipe could live, in scan
 * order (parents before children, so a top-level `<slug>/recipe.md` is seen
 * before a same-slug file nested in a category — first-slug-wins callers keep
 * the curated kit). Missing / unreadable dirs contribute nothing; never throws.
 */
export async function collectRecipeTargets(dir: string): Promise<RecipeFileTarget[]> {
  const targets: RecipeFileTarget[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return targets; // dir absent (e.g. no bridged imports yet) — not an error
  }
  const collect = async (base: string, entry: string, depth: number): Promise<void> => {
    const entryPath = join(base, entry);
    if (entry.endsWith(".md")) {
      if (depth === 1 && NON_RECIPE_MD.has(entry)) return;
      if ((RECIPE_FILENAMES as readonly string[]).includes(entry)) return; // covered by the dir target
      targets.push({
        slug: entry.replace(/\.recipe\.md$/, "").replace(/\.md$/, ""),
        candidates: [entryPath],
      });
      return;
    }
    if (entry.startsWith(".")) return;
    targets.push({ slug: entry, candidates: RECIPE_FILENAMES.map((f) => join(entryPath, f)) });
    if (depth >= SCAN_MAX_DEPTH) return;
    let nested: string[] = [];
    try {
      nested = await fs.readdir(entryPath);
    } catch {
      return; // a plain file, not a directory — its candidates above still apply
    }
    for (const child of nested) await collect(entryPath, child, depth + 1);
  };
  for (const entry of entries) await collect(dir, entry, 1);
  return targets;
}

/** The first readable candidate of a target, with its text — or null. */
export async function readFirstCandidate(
  target: RecipeFileTarget,
): Promise<{ path: string; text: string } | null> {
  for (const candidate of target.candidates) {
    try {
      return { path: candidate, text: await fs.readFile(candidate, "utf8") };
    } catch {
      // try next filename
    }
  }
  return null;
}

const FM_SLUG_RE = /^---\n([\s\S]+?)\n---/;

/** Frontmatter `slug:` or `id:` (either quoting style), or undefined. */
export function declaredSlug(text: string): string | undefined {
  const fm = FM_SLUG_RE.exec(text);
  if (!fm) return undefined;
  const m = /^(?:slug|id):\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/im.exec(fm[1]);
  return m ? m[1] : undefined;
}

/**
 * Find the recipe file for `slug` anywhere in the library layout, or null.
 * Matches on the path-derived slug first (no file reads), then on a declared
 * frontmatter `slug:`/`id:` (one read per candidate file) — so a recipe whose
 * file is named differently from its declared slug is still found.
 */
export async function findRecipeFile(dir: string, slug: string): Promise<string | null> {
  const targets = await collectRecipeTargets(dir);
  for (const t of targets) {
    if (t.slug !== slug) continue;
    const hit = await readFirstCandidate(t);
    if (hit) return hit.path;
  }
  for (const t of targets) {
    if (t.slug === slug) continue; // already tried above
    const hit = await readFirstCandidate(t);
    if (hit && declaredSlug(hit.text) === slug) return hit.path;
  }
  return null;
}
