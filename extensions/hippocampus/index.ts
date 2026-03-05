/**
 * FORK: Hippocampus Memory Hook — Plugin extension
 *
 * Registers an after_tool_call hook for memory_search that merges results
 * from the HIPPOCAMPUS pre-computed concept index alongside vector search.
 *
 * Integration: Calls the Python HIPPOCAMPUS CLI in parallel, deduplicates
 * results by path, and re-sorts by score.
 *
 * Wired in by: OpenClaw plugin system via `plugins.entries.hippocampus` in openclaw.json
 */

import { execSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../../src/plugins/types.js";

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
    return [];
  }
}

export function setup(api: OpenClawPluginApi): void {
  const log = api.logger;

  api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, _ctx: PluginHookToolContext) => {
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

      const existing = JSON.parse(
        typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {}),
      );
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

      existing.results.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
      existing.hippocampus = { merged: hippoResults.length };
      event.result = existing;
    } catch {
      log.debug?.("hippocampus merge failed (non-fatal)");
    }
  });

  log.info?.("hippocampus hook registered");
}
