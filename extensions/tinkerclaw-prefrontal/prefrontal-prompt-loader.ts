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

/** Clear cached prompt (for testing). */
export function _resetPromptCache(): void {
  cachedPrompt = null;
}
