// extensions/prefrontal/prefrontal-prompt-loader.ts
// FORK: Loads prefrontal-prompt.md (Iron Laws, debugging protocol,
// orchestration methodology) for injection into agent prompts.
// Caches the file in memory after first read.
//
// Wired in by: index.ts before_prompt_build hook

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRecipes } from "./recipe-engine.js";

let cachedPrompt: string | null = null;
let cachedAddendum: string | null = null;

/**
 * Load prefrontal-prompt.md from the extension directory.
 * Returns null if the file cannot be read (non-fatal).
 */
export function loadPrefrontalPrompt(baseDir?: string): string | null {
  if (cachedPrompt !== null) {
    return cachedPrompt;
  }
  const dir = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const promptPath = join(dir, "prefrontal-prompt.md");
  try {
    cachedPrompt = readFileSync(promptPath, "utf-8").trim();
    return cachedPrompt;
  } catch {
    cachedPrompt = "";
    return null;
  }
}

/**
 * Build the recipe system addendum dynamically from loaded recipes.
 * Groups recipes by category so the model sees the full catalog.
 */
function buildRecipeAddendum(): string {
  const recipes = getRecipes();
  if (recipes.length === 0) {
    return `

## Recipe System
When facing a complex task, describe your approach before acting.`;
  }

  // Group by category
  const byCategory = new Map<string, typeof recipes>();
  for (const r of recipes) {
    const cat = (r as { category?: string }).category ?? "general";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  const lines: string[] = [
    "",
    "## Recipe System",
    "When facing a complex task, you can activate a structured recipe by stating which workflow you're following in your response.",
    "",
    "**Available recipes:**",
    "",
  ];

  for (const [category, catRecipes] of byCategory) {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    const names = catRecipes.map(r => `\`${r.id}\``).join(", ");
    lines.push(`- **${label}:** ${names}`);
  }

  lines.push("");
  lines.push('Activate by mentioning: "following the debug recipe" or "using the upstream-merge recipe". The system tracks your progress through steps.');
  lines.push("");
  lines.push("## Planning");
  lines.push("Before starting complex tasks, describe your approach in your response. This serves as your plan — visible to the user and preserved in context. Don't just act; explain what you're about to do and why.");

  return lines.join("\n");
}

/**
 * Load prefrontal prompt with recipe system and planning instructions appended.
 * The recipe/planning addendum is built dynamically from loaded recipes
 * so the model sees all available workflows, not just a hardcoded subset.
 */
export function loadPrefrontalPromptWithAddendum(baseDir?: string): string | null {
  const base = loadPrefrontalPrompt(baseDir);
  if (base === null) return null;
  // Rebuild addendum if recipes were reloaded (cache cleared on reload)
  if (cachedAddendum === null) {
    cachedAddendum = buildRecipeAddendum();
  }
  return base + cachedAddendum;
}

/** Clear cached prompt and addendum (for testing / recipe reload). */
export function _resetPromptCache(): void {
  cachedPrompt = null;
  cachedAddendum = null;
}
