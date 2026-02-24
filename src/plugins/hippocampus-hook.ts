/**
 * HIPPOCAMPUS HOOK — FORK-ISOLATED
 *
 * Wraps the memory_search tool to merge results from the
 * HIPPOCAMPUS pre-computed concept index alongside vector search.
 *
 * Integration strategy:
 * - Registers an after_tool_call hook for memory_search
 * - Calls the Python HIPPOCAMPUS CLI in parallel
 * - Merges results, deduplicates by path, re-sorts by score
 *
 * Isolated: this file is fork-only and does not modify any upstream files.
 * If deleted, the system works exactly as upstream.
 */

import { execSync } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";

const log = createSubsystemLogger("hippocampus");

const HIPPOCAMPUS_CMD =
  "cd /home/globalcaos/.openclaw/workspace/scripts && python3 -m hippocampus.cli lookup";
const TIMEOUT_MS = 5000;

interface HippocampusEntry {
  path: string;
  line?: number;
  score: number;
  source: string;
  preview: string;
  final_score: number;
  matched_anchor?: string;
}

function hippocampusSearch(query: string, maxResults = 8): unknown[] {
  try {
    const escaped = query.replace(/"/g, '\\"').replace(/`/g, "\\`");
    const cmd = `${HIPPOCAMPUS_CMD} "${escaped}" --max ${maxResults} --json`;
    const stdout = execSync(cmd, {
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entries: HippocampusEntry[] = JSON.parse(stdout.trim());
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries.map((e) => ({
      path: e.path,
      startLine: e.line ?? 1,
      endLine: (e.line ?? 1) + 10,
      score: e.final_score,
      snippet: e.preview || "",
      source: "memory",
      citation: e.matched_anchor ? `[hippocampus:${e.matched_anchor}]` : undefined,
    }));
  } catch {
    log.debug("hippocampus search failed (non-fatal)");
    return [];
  }
}

/**
 * Register the HIPPOCAMPUS hook with the plugin system.
 * Called from cognitive-hooks.ts or directly from the fork's startup.
 */
export function registerHippocampusHook(registry: PluginRegistry): void {
  // Push directly onto typedHooks — registerHook is only on the builder,
  // not on the bare PluginRegistry type.
  registry.typedHooks.push({
    pluginId: "hippocampus",
    hookName: "after_tool_call",
    handler: async (event: {
      toolName: string;
      params?: Record<string, unknown>;
      result?: { content?: string };
    }) => {
      if (event.toolName !== "memory_search") {
        return;
      }

      const query = event.params?.query;
      if (typeof query !== "string" || !query.trim()) {
        return;
      }

      try {
        const hippoResults = hippocampusSearch(query);
        if (!hippoResults.length) {
          return;
        }

        // Parse existing results and merge
        const existing = JSON.parse(event.result?.content ?? "{}");
        if (!existing.results || !Array.isArray(existing.results)) {
          return;
        }

        const seen = new Set(
          existing.results.map(
            (r: { path: string; startLine: number }) => r.path + ":" + r.startLine,
          ),
        );

        for (const hr of hippoResults) {
          const entry = hr as { path: string; startLine: number };
          const key = entry.path + ":" + entry.startLine;
          if (!seen.has(key)) {
            existing.results.push(hr);
            seen.add(key);
          }
        }

        // Re-sort by score descending
        existing.results.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

        // Update the result
        existing.hippocampus = { merged: hippoResults.length };
        event.result = { content: JSON.stringify(existing) };
      } catch {
        log.debug("hippocampus merge failed (non-fatal)");
      }
    },
    source: "fork-isolated",
  } as import("./types.js").PluginHookRegistration);

  log.info("HIPPOCAMPUS hook registered (fork-isolated)");
}
