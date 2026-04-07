// extensions/prefrontal/prefrontal-prompt-loader.ts
// FORK: Loads prefrontal-prompt.md (Iron Laws, debugging protocol,
// orchestration methodology) for injection into agent prompts.
// Caches the file in memory after first read.
//
// Wired in by: index.ts before_prompt_build hook

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
let cachedPrompt: string | null = null;

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

/** Static addendum — general enough that adding new recipes requires no prompt changes. */
const RECIPE_ADDENDUM = `

## Recipe System
Structured recipes are available for common task types. Each recipe defines a step-by-step workflow with preconditions, required tools, and success criteria per step. Recipes are organized by category in the \`recipes/\` directory (coding, writing, operations, analysis, security, communication).

To activate a recipe, state which one you're following in your response — for example, "following the debug recipe" or "using the upstream-merge recipe." The system will track your progress through the steps and guide you. When you complete a step's success criteria, the next step activates automatically.

If you're unsure which recipe fits, describe the task and the system will suggest one. You can also work without a recipe — they are guides, not constraints.

## Planning
Before starting complex tasks, describe your approach in your response. This serves as your plan — visible to the user and preserved in context. Don't just act; explain what you're about to do and why. This is more valuable than any formal planning step.`;

/**
 * Load prefrontal prompt with recipe system instructions appended.
 * The addendum is static and general — it doesn't enumerate recipes
 * so adding new ones never requires editing this prompt.
 */
export function loadPrefrontalPromptWithAddendum(baseDir?: string): string | null {
  const base = loadPrefrontalPrompt(baseDir);
  if (base === null) return null;
  return base + RECIPE_ADDENDUM;
}

/** Clear cached prompt (for testing). */
export function _resetPromptCache(): void {
  cachedPrompt = null;
}
