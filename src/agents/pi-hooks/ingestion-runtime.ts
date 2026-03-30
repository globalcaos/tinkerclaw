/**
 * ENGRAM Phase 1.1: Ingestion pipeline runtime registry.
 *
 * Holds a per-session IngestionPipeline instance keyed by SessionManager
 * identity. Phase 1.1b will read from this registry inside
 * agent-runner-execution.ts to hook every turn event.
 */

import type { IngestionPipeline } from "../../memory/engram/ingestion.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

const registry = createSessionManagerRuntimeRegistry<IngestionPipeline>();

/** Store an ingestion pipeline for a given session manager instance. */
export const setIngestionRuntime = registry.set;

/** Retrieve the ingestion pipeline for a given session manager instance, or null. */
export const getIngestionRuntime = registry.get;
