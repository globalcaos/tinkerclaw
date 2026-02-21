/**
 * HIPPOCAMPUS Bridge — Calls the Python HIPPOCAMPUS CLI and returns
 * results compatible with MemorySearchResult[].
 */
import { execSync } from "node:child_process";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MemorySearchResult } from "../../memory/types.js";

const log = createSubsystemLogger("hippocampus");

const HIPPOCAMPUS_CMD = "node /home/globalcaos/.openclaw/workspace/scripts/hippocampus/cli.mjs lookup";
const TIMEOUT_MS = 5000; // 5s max

interface HippocampusEntry {
  path: string;
  line?: number;
  score: number;
  source: string;
  preview: string;
  final_score: number;
  matched_anchor?: string;
  lookup_ms?: number;
}

export function hippocampusSearch(
  query: string,
  maxResults = 10,
): MemorySearchResult[] {
  try {
    const escaped = query.replace(/"/g, '\\"').replace(/`/g, "\\`");
    const cmd = `${HIPPOCAMPUS_CMD} "${escaped}" --max ${maxResults} --json`;
    const stdout = execSync(cmd, {
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entries: HippocampusEntry[] = JSON.parse(stdout.trim());
    if (!Array.isArray(entries)) return [];

    return entries.map((e) => ({
      path: e.path,
      startLine: e.line ?? 1,
      endLine: (e.line ?? 1) + 10,
      score: e.final_score,
      snippet: e.preview || "",
      source: "memory" as const,
      citation: e.matched_anchor ? `[hippocampus:${e.matched_anchor}]` : undefined,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug(`hippocampus search failed (non-fatal): ${msg}`);
    return [];
  }
}
