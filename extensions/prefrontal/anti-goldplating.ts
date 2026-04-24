// extensions/prefrontal/anti-goldplating.ts
// FORK: Anti-gold-plating prompt injection — prevents over-engineering by
// injecting explicit anti-pattern rules into every agent prompt.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AntiGoldplatingConfig {
  enabled: boolean;
}

export const DEFAULT_ANTI_GOLDPLATING_CONFIG: AntiGoldplatingConfig = {
  enabled: true,
};

let cachedPrompt: string | null = null;

export function loadAntiGoldplatingPrompt(baseDir?: string): string {
  if (cachedPrompt) {return cachedPrompt;}
  const dir = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const promptPath = join(dir, "anti-goldplating-prompt.md");
  try {
    cachedPrompt = readFileSync(promptPath, "utf-8").trim();
    return cachedPrompt;
  } catch {
    // Fallback: inline rules if file not found
    cachedPrompt = [
      "## Code Discipline — Anti-Gold-Plating Rules",
      "- Don't add features beyond what was asked.",
      "- Don't add error handling for impossible scenarios.",
      "- Three similar lines are better than a premature abstraction.",
      "- Read the file before modifying it.",
    ].join("\n");
    return cachedPrompt;
  }
}

const EXEMPT_TRIGGERS = new Set(["heartbeat", "cron"]);

export function shouldInjectAntiGoldplating(
  config: AntiGoldplatingConfig,
  trigger?: string,
): boolean {
  if (!config.enabled) {return false;}
  if (trigger && EXEMPT_TRIGGERS.has(trigger)) {return false;}
  return true;
}

/** Clear cached prompt (for testing). */
export function _resetCache(): void {
  cachedPrompt = null;
}
