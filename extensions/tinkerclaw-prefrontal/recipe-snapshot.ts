/**
 * FORK 2026-05-31 — append-only content archive for recipe self-mutations (J5 apply half).
 *
 * recipe-evolution's autonomy safety argument is "every mutation is reversible via a never-delete
 * archive" — but no archive for kit CONTENT existed (RecipeArchive stores fitness variants, not
 * the kit.md text). This is that archive: before the self-apply loop overwrites a recipe, it
 * snapshots the current kit.md here, dated + never-deleted, so any auto-mutation is one-copy
 * reversible. Lives as a SIBLING of the kits dir (".recipe-archive") so loadRecipeIndex never scans
 * it as a recipe.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Resolve the archive root (sibling of the kits dir). */
export function recipeArchiveDir(ownRecipesDir: string): string {
  return path.resolve(ownRecipesDir, "..", ".recipe-archive");
}

/** SS3 (O2): flat compose/promote provenance for a snapshotted recipe. */
export interface RecipeLineage {
  composedFrom?: "compose" | "extraction" | "promotion";
  composedSkills?: string[];
  composedRecipes?: string[];
  sourceQuery?: string;
}

/**
 * SS3: inject lineage as YAML frontmatter keys just before the closing `---` of a
 * recipe's frontmatter (O2: frontmatter, NOT a sidecar). No frontmatter → text is
 * returned unchanged.
 */
export function injectLineageFrontmatter(text: string, lineage: RecipeLineage): string {
  const lines: string[] = ["lineage:"];
  if (lineage.composedFrom) lines.push(`  composedFrom: ${JSON.stringify(lineage.composedFrom)}`);
  if (lineage.sourceQuery) lines.push(`  sourceQuery: ${JSON.stringify(lineage.sourceQuery)}`);
  if (lineage.composedSkills?.length)
    lines.push(
      `  composedSkills: [${lineage.composedSkills.map((s) => JSON.stringify(s)).join(", ")}]`,
    );
  if (lineage.composedRecipes?.length)
    lines.push(
      `  composedRecipes: [${lineage.composedRecipes.map((s) => JSON.stringify(s)).join(", ")}]`,
    );
  if (lines.length === 1) return text; // nothing to inject
  return text.replace(
    /^(---\n[\s\S]*?\n)(---)/,
    (_full, fm: string, close: string) => `${fm}${lines.join("\n")}\n${close}`,
  );
}

/**
 * Snapshot a recipe's current kit.md text. `stamp` (an ISO timestamp) is injected so the path is
 * deterministic + testable. Returns the absolute archive path written. Append-only: a new file
 * per call, never overwriting a prior snapshot.
 */
export async function snapshotKit(
  ownRecipesDir: string,
  slug: string,
  text: string,
  stamp: string,
  lineage?: RecipeLineage,
): Promise<string> {
  const date = stamp.slice(0, 10); // YYYY-MM-DD
  const dir = path.join(recipeArchiveDir(ownRecipesDir), date);
  await fs.mkdir(dir, { recursive: true });
  const safeStamp = stamp.replace(/[:.]/g, "-");
  const file = path.join(dir, `${slug}-${safeStamp}.md`);
  // SS3: stamp compose/promote lineage into the snapshot frontmatter when present.
  const body = lineage ? injectLineageFrontmatter(text, lineage) : text;
  await fs.writeFile(file, body, "utf-8");
  return file;
}
