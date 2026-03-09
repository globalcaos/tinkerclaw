/**
 * ENGRAM Stage 1D: Daily log hot cache.
 *
 * Reads today's daily log markdown from the workspace memory directory
 * and returns its content for injection into the retrieval context.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 4000;

/**
 * Format today's date as YYYY-MM-DD.
 */
function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Load today's daily log from the workspace memory directory.
 *
 * Looks for `memory/YYYY-MM-DD.md` under the given workspace directory.
 * Returns the content (truncated to MAX_CHARS keeping the header) or null if not found.
 */
export function loadTodayDailyLog(workspaceDir: string): string | null {
  const dateStr = todayDateString();
  const logPath = join(workspaceDir, "memory", `${dateStr}.md`);

  if (!existsSync(logPath)) {
    return null;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    if (!content.trim()) {
      return null;
    }

    if (content.length <= MAX_CHARS) {
      return content;
    }

    // Truncate from end, keeping the header (first line)
    const firstNewline = content.indexOf("\n");
    if (firstNewline === -1 || firstNewline >= MAX_CHARS) {
      return content.slice(0, MAX_CHARS);
    }

    const header = content.slice(0, firstNewline + 1);
    const remainingBudget = MAX_CHARS - header.length;
    const body = content.slice(firstNewline + 1, firstNewline + 1 + remainingBudget);
    return header + body;
  } catch {
    return null;
  }
}
