/**
 * HIPPOCAMPUS Episodic Runtime — Phase 2
 *
 * Registers an EpisodicBuffer alongside the retrieval runtime so that
 * same-day events are queryable immediately without a nightly rebuild.
 *
 * Usage:
 *   import { setEpisodicRuntime, getEpisodicRuntime } from './episodic-runtime.js';
 *
 *   // On session start:
 *   setEpisodicRuntime(sessionManager, { buffer: new EpisodicBuffer() });
 *
 *   // On retrieval:
 *   const rt = getEpisodicRuntime(sessionManager);
 *   if (rt) {
 *     const episodic = rt.buffer.search(query);
 *     const combined = rt.buffer.combinedQuery(query, semanticFn);
 *   }
 *
 * Does NOT modify hippocampus-hook.ts or hippocampus-bridge.ts.
 */

import type { EpisodicBuffer } from "../../memory/engram/hippocampus-enhancement.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export interface EpisodicRuntime {
  /**
   * Hot in-memory buffer for same-day events.
   * Populated by the session ingestion path whenever a new event is stored.
   */
  buffer: EpisodicBuffer;
}

// ---------------------------------------------------------------------------
// Registry (WeakMap, one entry per SessionManager instance)
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<EpisodicRuntime>();

/**
 * Bind an EpisodicRuntime to a session manager instance.
 * Call once during session startup (e.g. from ingestion-runtime.ts).
 */
export const setEpisodicRuntime = registry.set;

/**
 * Retrieve the EpisodicRuntime for a session manager, or null if not set.
 * Always check for null before use — not every session will have one.
 */
export const getEpisodicRuntime = registry.get;

// ---------------------------------------------------------------------------
// Convenience: feed a MemoryEvent into the episodic buffer
// ---------------------------------------------------------------------------

/**
 * Add a raw content string to the episodic buffer for the given session.
 * No-ops silently when no EpisodicRuntime is registered.
 *
 * @param sessionManager  The SessionManager object used as registry key.
 * @param id              Unique event identifier (e.g. ULID).
 * @param content         Event content text.
 * @param importance      Optional importance (1–10, default 5).
 */
export function feedEpisodicEvent(
  sessionManager: unknown,
  id: string,
  content: string,
  importance?: number,
): void {
  const rt = getEpisodicRuntime(sessionManager);
  if (!rt) return;

  rt.buffer.add({
    id,
    timestamp: new Date().toISOString(),
    content,
    source: "session",
    importance,
  });
}
