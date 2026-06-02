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
): Promise<string> {
  const date = stamp.slice(0, 10); // YYYY-MM-DD
  const dir = path.join(recipeArchiveDir(ownRecipesDir), date);
  await fs.mkdir(dir, { recursive: true });
  const safeStamp = stamp.replace(/[:.]/g, "-");
  const file = path.join(dir, `${slug}-${safeStamp}.md`);
  await fs.writeFile(file, text, "utf-8");
  return file;
}
