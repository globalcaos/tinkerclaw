import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-host-core";

export const buildWikiPromptSection: MemoryPromptSectionBuilder = ({ availableTools }) => {
  const hasWikiSearch = availableTools.has("wiki_search");
  const hasWikiGet = availableTools.has("wiki_get");
  const hasWikiApply = availableTools.has("wiki_apply");
  const hasWikiLint = availableTools.has("wiki_lint");

  if (!hasWikiSearch && !hasWikiGet && !hasWikiApply && !hasWikiLint) {
    return [];
  }

  const lines = [
    "## Compiled Wiki",
    "Use the wiki when the answer depends on accumulated project knowledge, prior syntheses, entity pages, or source-backed notes that should survive beyond one conversation.",
  ];

  if (hasWikiSearch && hasWikiGet) {
    lines.push(
      "Workflow: `wiki_search` first, then `wiki_get` for the exact page or imported memory file you need. Shared search may return `corpus=memory` results when active-memory bridging is enabled.",
    );
  } else if (hasWikiSearch) {
    lines.push(
      "Use `wiki_search` before answering from stored knowledge. Shared search may return `corpus=memory` results when active-memory bridging is enabled.",
    );
  } else if (hasWikiGet) {
    lines.push(
      "Use `wiki_get` to inspect specific wiki pages or imported memory files by path/id.",
    );
  }

  if (hasWikiApply) {
    lines.push(
      "Use `wiki_apply` for narrow synthesis filing and metadata repair instead of rewriting managed markdown blocks by hand.",
    );
  }
  if (hasWikiLint) {
    lines.push("After meaningful wiki updates, run `wiki_lint` before trusting the vault.");
  }
  lines.push("");
  return lines;
};
