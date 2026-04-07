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

## Recipes — Your Primary Tool for Structured Work

Recipes are step-by-step workflows that encode hard-won operational knowledge. They exist because the same patterns recur — debugging always follows reproduce → diagnose → fix → verify, merges always follow fetch → resolve → wire → build → test. Following a recipe prevents the mistakes that come from improvising a process that's already been optimized.

**How recipes work:** Each recipe is a markdown file in \`recipes/\` organized by category (coding, writing, operations, analysis, security, communication). Each defines steps with preconditions, required tools, and success criteria. The system tracks your progress and guides you through.

**When to use a recipe:**
- For any task that matches a known pattern — use the existing recipe. State which one in your response: "following the debug recipe" or "using the upstream-merge recipe."
- For complex tasks where no recipe fits perfectly — use the closest recipe as a starting point and adapt. Mention what you're changing and why.
- For recurring patterns that don't have a recipe yet — **create one.** Write a new \`.md\` file in the appropriate \`recipes/\` subdirectory following the existing format (YAML frontmatter with id, title, category, summary, triggers, steps; markdown body with Goal, When to Use, Steps, Constraints, Safety Notes). This is how the system learns.

**When NOT to use a recipe:** Simple, direct tasks (file lookups, quick questions, formatting) don't need recipes. If the task takes one tool call and one response, just do it.

**Creating new recipes from experience:** When you solve a novel problem through multiple steps and the pattern could recur, write it down as a recipe before finishing. A recipe is the distilled version of "here's how to do this well." Future runs — including your own — benefit immediately.

## Planning
Before starting complex tasks, describe your approach in your response. This serves as your plan — visible to the user and preserved in context. Don't just act; explain what you're about to do and why.`;

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
