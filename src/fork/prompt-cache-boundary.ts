// src/fork/prompt-cache-boundary.ts
// FORK: Prompt cache boundary — splits system prompts into static (cacheable)
// and dynamic (per-turn) sections. Follows Claude Code's static/dynamic pattern.

export const CACHE_BOUNDARY_MARKER = "__PREFRONTAL_CACHE_BOUNDARY__";

export interface CacheAwareBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface SplitResult {
  staticSection: string;
  dynamicSection: string;
}

/**
 * Split a prompt string at the cache boundary marker.
 * Everything before the marker is static (cacheable), everything after is dynamic.
 * If no marker is found, the entire prompt is treated as static.
 */
export function splitPromptAtBoundary(prompt: string): SplitResult {
  const idx = prompt.indexOf(CACHE_BOUNDARY_MARKER);
  if (idx < 0) {
    return { staticSection: prompt, dynamicSection: "" };
  }
  return {
    staticSection: prompt.slice(0, idx).trimEnd(),
    dynamicSection: prompt.slice(idx + CACHE_BOUNDARY_MARKER.length).trimStart(),
  };
}

/**
 * Build cache-aware content blocks from static and dynamic sections.
 * The static block gets cache_control: { type: "ephemeral" } to enable prompt caching.
 * The dynamic block has no cache_control (changes every turn, not cacheable).
 */
export function buildCacheAwareBlocks(
  staticSection: string,
  dynamicSection: string,
): CacheAwareBlock[] {
  const blocks: CacheAwareBlock[] = [];

  if (staticSection) {
    blocks.push({
      type: "text",
      text: staticSection,
      cache_control: { type: "ephemeral" },
    });
  }

  if (dynamicSection) {
    blocks.push({
      type: "text",
      text: dynamicSection,
    });
  }

  return blocks;
}

/**
 * Convenience: split a prompt and build cache-aware blocks in one call.
 */
export function buildCacheAwarePrompt(prompt: string): CacheAwareBlock[] {
  const { staticSection, dynamicSection } = splitPromptAtBoundary(prompt);
  return buildCacheAwareBlocks(staticSection, dynamicSection);
}
