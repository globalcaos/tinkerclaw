/**
 * ENGRAM Stage 1D: Daily log hot cache.
 *
 * Reads today's daily log markdown from the workspace memory directory
 * and returns its content for injection into the retrieval context.
 * Cached in memory with a 60-second TTL to avoid disk reads every turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 4000;
const CACHE_TTL_MS = 60_000;

let cachedLog: { date: string; content: string | null; fetchedAt: number } | null = null;

/**
 * Format a date as YYYY-MM-DD in the local timezone.
 * Note: relies on the Node process timezone matching the user's timezone.
 * For OpenClaw deployments, TZ is typically set to the user's timezone.
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
 * Results are cached for 60 seconds to avoid repeated disk reads.
 */
export function loadTodayDailyLog(workspaceDir: string): string | null {
  const dateStr = todayDateString();
  const now = Date.now();

  // Return cached result if fresh and same day
  if (cachedLog && cachedLog.date === dateStr && now - cachedLog.fetchedAt < CACHE_TTL_MS) {
    return cachedLog.content;
  }

  const logPath = join(workspaceDir, "memory", `${dateStr}.md`);

  if (!existsSync(logPath)) {
    cachedLog = { date: dateStr, content: null, fetchedAt: now };
    console.log(`[ENGRAM] daily log: not found (${dateStr})`);
    return null;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    if (!content.trim()) {
      cachedLog = { date: dateStr, content: null, fetchedAt: now };
      return null;
    }

    let result: string;
    if (content.length <= MAX_CHARS) {
      result = content;
    } else {
      // Truncate from end, keeping the header (first line)
      const firstNewline = content.indexOf("\n");
      if (firstNewline === -1 || firstNewline >= MAX_CHARS) {
        result = content.slice(0, MAX_CHARS);
      } else {
        const header = content.slice(0, firstNewline + 1);
        const remainingBudget = MAX_CHARS - header.length;
        result = header + content.slice(firstNewline + 1, firstNewline + 1 + remainingBudget);
      }
    }

    cachedLog = { date: dateStr, content: result, fetchedAt: now };
    console.log(`[ENGRAM] daily log: loaded ${result.length} chars (${dateStr})`);
    return result;
  } catch {
    cachedLog = { date: dateStr, content: null, fetchedAt: now };
    return null;
  }
}
