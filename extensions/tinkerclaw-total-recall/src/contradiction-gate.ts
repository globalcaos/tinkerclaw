/**
 * ENGRAM Stage 1D.3: Pre-action contradiction gate.
 *
 * Detects write-intent in user messages (calendar, email, task mutations)
 * and searches today's daily log + FTS for state contradictions.
 * Returns warnings to inject into the retrieval pack so the agent sees
 * contradictions BEFORE acting on stale data.
 *
 * Design: passive injection, not a blocking hook. The agent sees the
 * warning in context and can decide whether to proceed.
 */

import { loadTodayDailyLog } from "./daily-log-cache.js";
import { extractEntities } from "./entity-extraction.js";
import type { EventStore } from "./event-store.js";
import { globalFtsSearch } from "./global-fts-bridge.js";

/** Words/phrases that signal write-class actions */
const WRITE_INTENT_PATTERNS = [
  // Calendar
  /\b(update|move|cancel|reschedule|create|add|delete|remove|postpone)\b.*\b(calendar|event|meeting|appointment|cita|reunió|reunión)\b/i,
  /\b(calendar|event|meeting|appointment|cita|reunió|reunión)\b.*\b(update|move|cancel|reschedule|create|add|delete|remove|postpone)\b/i,
  // Email
  /\b(send|draft|reply|forward|respond|email|mail|enviar|correo)\b/i,
  // Task management
  /\b(close|complete|done|finish|create|add)\b.*\b(task|todo|todoist|tarea)\b/i,
  /\b(task|todo|todoist|tarea)\b.*\b(close|complete|done|finish|create|add)\b/i,
];

/** State-contradiction keywords to look for in daily log matches */
const CONTRADICTION_SIGNALS = [
  "postponed",
  "cancelled",
  "canceled",
  "rescheduled",
  "moved",
  "done",
  "completed",
  "resolved",
  "fixed",
  "closed",
  "ajornat",
  "ajornada",
  "cancel·lat",
  "cancel·lada",
  "posposat",
  "posposada",
  "fet",
  "acabat",
  "tancat",
];

export interface ContradictionWarning {
  entity: string;
  signal: string;
  source: string;
  snippet: string;
}

/**
 * Detect whether a user message implies a write action.
 */
export function hasWriteIntent(text: string): boolean {
  return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Search for contradictions between the intended action and known state.
 * Checks today's daily log and recent FTS events for conflicting signals.
 */
export function findContradictions(
  text: string,
  store: EventStore,
  workspaceDir: string,
): ContradictionWarning[] {
  const warnings: ContradictionWarning[] = [];
  const entities = extractEntities(text);

  // All entity strings to search for
  const searchTerms = [...entities.events, ...entities.people, ...entities.projects].filter(
    (t) => t.length > 2,
  );

  if (searchTerms.length === 0) {
    return warnings;
  }

  // Check daily log first (fastest, most relevant)
  const dailyLog = loadTodayDailyLog(workspaceDir);
  if (dailyLog) {
    const logLower = dailyLog.toLowerCase();
    for (const term of searchTerms) {
      const termLower = term.toLowerCase();
      if (!logLower.includes(termLower)) {
        continue;
      }

      // Found the entity in today's log — check for contradiction signals
      for (const signal of CONTRADICTION_SIGNALS) {
        // Look for the signal near the entity (within ~200 chars)
        const termIdx = logLower.indexOf(termLower);
        const searchWindow = logLower.slice(
          Math.max(0, termIdx - 100),
          Math.min(logLower.length, termIdx + termLower.length + 100),
        );
        if (searchWindow.includes(signal)) {
          // Extract a readable snippet from the original (non-lowered) text
          const start = Math.max(0, termIdx - 50);
          const end = Math.min(dailyLog.length, termIdx + termLower.length + 100);
          const snippet = dailyLog.slice(start, end).replace(/\n/g, " ").trim();
          warnings.push({
            entity: term,
            signal,
            source: "daily-log",
            snippet,
          });
          break; // One signal per entity is enough
        }
      }
    }
  }

  // Also check FTS for recent events mentioning these entities + contradiction signals
  if (warnings.length === 0) {
    for (const term of searchTerms.slice(0, 3)) {
      // Combine entity with contradiction signals for targeted search
      for (const signal of CONTRADICTION_SIGNALS.slice(0, 6)) {
        const results = globalFtsSearch(store, `${term} ${signal}`, 3);
        for (const result of results) {
          const contentLower = result.event.content.toLowerCase();
          if (contentLower.includes(term.toLowerCase()) && contentLower.includes(signal)) {
            warnings.push({
              entity: term,
              signal,
              source: "fts-events",
              snippet: result.event.content.slice(0, 150),
            });
            break;
          }
        }
        if (warnings.length > 0) {
          break;
        }
      }
      if (warnings.length > 0) {
        break;
      }
    }
  }

  if (warnings.length > 0) {
    console.log(
      `[ENGRAM] contradiction gate: ${warnings.length} warning(s) for [${searchTerms.join(", ")}]`,
    );
  }

  return warnings;
}

/**
 * Format contradiction warnings for injection into the retrieval pack.
 */
export function formatContradictionWarnings(warnings: ContradictionWarning[]): string {
  if (warnings.length === 0) {
    return "";
  }

  const lines = ["## ⚠️ Contradiction Alert — Check Before Acting\n"];
  for (const w of warnings) {
    lines.push(`- **${w.entity}** may be **${w.signal}** (source: ${w.source})`);
    lines.push(`  > ${w.snippet}`);
  }
  lines.push("");
  lines.push("*Cross-check this before proceeding with any write action.*\n");

  return lines.join("\n");
}
