/**
 * FORK: context-pruning/runtime — Per-session runtime state registry for context pruning
 *
 * Stores and retrieves the active pruning configuration, tool predicate, and cache-TTL
 * timestamp for each SessionManager instance using a WeakMap-based registry. This allows
 * the extension.ts event handler to access the correct settings for each session without
 * global state. The registry keys on the same SessionManager object reference that Pi
 * passes into ExtensionContext.
 *
 * Wired in by: set by the attempt hooks (via setContextPruningRuntime) when a session
 * starts; read by extension.ts (via getContextPruningRuntime) on each "context" event.
 */
import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { EffectiveContextPruningSettings } from "./settings.js";

export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
};

// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

export const setContextPruningRuntime = registry.set;

export const getContextPruningRuntime = registry.get;
