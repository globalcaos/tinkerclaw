/**
 * ENGRAM Phase 1.5: Compaction reflection runtime registry.
 *
 * Holds a per-session CompactionReflector keyed by SessionManager identity,
 * following the same WeakMap registry pattern as ingestion-runtime.ts.
 * Wire into extensions.ts when compaction.mode === "engram":
 *   initReflectionRuntime(sessionManager, eventStore)
 * Then access via:
 *   getReflectionRuntime(sessionManager)?.reflect(markerEventId, preState)
 *
 * FORK-ISOLATED: This file is unique to our fork.
 */

import {
	createCompactionReflector,
	type CompactionReflector,
} from "../../memory/engram/compaction-reflection.js";
import type { EventStore } from "../../memory/engram/event-store.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<CompactionReflector>();

/** Store a compaction reflector for a given session manager instance. */
export const setReflectionRuntime = registry.set;

/** Retrieve the compaction reflector for a given session manager instance, or null. */
export const getReflectionRuntime = registry.get;

// ---------------------------------------------------------------------------
// Convenience initialiser
// ---------------------------------------------------------------------------

/**
 * Create a CompactionReflector bound to `eventStore`, register it for
 * `sessionManager`, and return it.
 *
 * Call this once during session setup (same site as setPointerCompactionRuntime).
 *
 * @example
 * ```ts
 * const reflector = initReflectionRuntime(sessionManager, eventStore);
 * // Later, after compact():
 * reflector.reflect(result.markerEventId, { contextTokens, activeTopics });
 * ```
 */
export function initReflectionRuntime(
	sessionManager: unknown,
	eventStore: EventStore,
): CompactionReflector {
	const reflector = createCompactionReflector(eventStore);
	setReflectionRuntime(sessionManager, reflector);
	return reflector;
}
