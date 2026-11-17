// FORK 2026-10-29: fork-owned. Decides whether a plugin snapshot memo may still be served: the
// web-provider snapshot (web-provider-runtime-shared.ts) and the capability plugin-id cache
// (capability-provider-runtime.ts).
//
// Objective: stop the long-lived gateway rebuilding those snapshots on every embedded run. Both
// expired on a time TTL, the smaller of the two plugin cache defaults in cache-controls.ts (1000 ms
// each). Embedded runs on the reference install are a median 108 s apart and never under 1 s
// (turn-span logs 2026-10-28/29, n=289), so every run missed and re-ran load-option resolution
// plus a plugin snapshot load on the gateway thread. With the cache kept warm, an isolated A/B of
// the tool build measured about 0.3 s less per call (mean 2,388 ms against 2,069 ms, 7 calls).
// A hit costs a property read and a WeakMap lookup, so there is no break-even to tune.
//
// Choice: inside the gateway a memo stays valid until something it was built from changes:
//   - the config object: a reload swaps it, and both memos are WeakMaps keyed on it (unchanged);
//   - the active plugin registry: gateway start and deferred plugin reloads install a new one;
//   - bumpPluginSnapshotGeneration(), for code that changes the plugin set in-process without
//     doing either of the above.
// Plugin install and uninstall write plugins.* config, which config-reload-plan.ts treats as
// restart-only. Everywhere else (CLI one-shots, tests) the time TTL applies as before, and so it
// does in any process that sets OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS or
// OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: an explicit time bound wins, and setting one is the way back
// to the TTL without a code change.
//
// Rejected:
//   - a longer TTL: even 60 s covers only the 36% of runs that start within a minute of the last;
//   - the registry's activeVersion counter: setActivePluginRegistry bumps it even when it
//     re-activates the same cached registry, which turns a hit into a miss with nothing changed;
//   - checking on-disk signatures (installed index, manifests) on every lookup: a stat per hit
//     for changes the running gateway does not load until it restarts anyway.
// What would change this: an in-process install or reload path that keeps both the config object
// and the active registry has to call bumpPluginSnapshotGeneration().

import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { gatewaySubagentState } from "./runtime/gateway-bindings.js";

const PLUGIN_SNAPSHOT_GENERATION_STATE = Symbol.for("openclaw.pluginSnapshotGeneration");

type PluginSnapshotGenerationState = {
  explicit: number;
  nextRegistryToken: number;
  registryTokens: WeakMap<PluginRegistry, number>;
};

type GlobalPluginSnapshotGenerationState = typeof globalThis & {
  [PLUGIN_SNAPSHOT_GENERATION_STATE]?: PluginSnapshotGenerationState;
};

// Looked up on every use, as runtime-state.ts does for the active registry, so split dist chunks
// share one state.
function getPluginSnapshotGenerationState(): PluginSnapshotGenerationState {
  const globalState = globalThis as GlobalPluginSnapshotGenerationState;
  let state = globalState[PLUGIN_SNAPSHOT_GENERATION_STATE];
  if (!state) {
    state = {
      explicit: 0,
      nextRegistryToken: 1,
      registryTokens: new WeakMap<PluginRegistry, number>(),
    };
    globalState[PLUGIN_SNAPSHOT_GENERATION_STATE] = state;
  }
  return state;
}

/** Invalidate every generation-checked plugin snapshot memo in this process. */
export function bumpPluginSnapshotGeneration(): void {
  getPluginSnapshotGenerationState().explicit += 1;
}

/**
 * Whether plugin snapshot memos follow the generation instead of the time TTL. True inside the
 * gateway, which installs its subagent runtime before it loads plugins, unless `env` sets one of
 * the two cache-ms knobs. Vitest is left out: a gateway test can leave that process-global runtime
 * installed for the next file of a non-isolated run.
 */
export function usesPluginSnapshotGeneration(env: NodeJS.ProcessEnv): boolean {
  if (gatewaySubagentState.subagent === undefined || normalizeOptionalString(env.VITEST)) {
    return false;
  }
  return (
    normalizeOptionalString(env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS) === undefined &&
    normalizeOptionalString(env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS) === undefined
  );
}

// A number per registry object, not the object itself, so a memo entry never keeps a replaced
// registry alive.
function resolveActiveRegistryToken(state: PluginSnapshotGenerationState): number {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return 0;
  }
  let token = state.registryTokens.get(registry);
  if (token === undefined) {
    token = state.nextRegistryToken;
    state.nextRegistryToken += 1;
    state.registryTokens.set(registry, token);
  }
  return token;
}

/**
 * The generation a snapshot is about to be built against, or undefined outside generation mode.
 * Capture it before building and store it on the memo entry: if it moves during the build, the
 * entry is already stale.
 */
export function capturePluginSnapshotGeneration(env: NodeJS.ProcessEnv): string | undefined {
  if (!usesPluginSnapshotGeneration(env)) {
    return undefined;
  }
  const state = getPluginSnapshotGenerationState();
  return `${state.explicit}:${resolveActiveRegistryToken(state)}`;
}

/**
 * Whether a memo entry may be served: by its generation inside the gateway, by `expiresAt`
 * everywhere else.
 */
export function isPluginSnapshotFresh(
  entry: { expiresAt: number; generation?: string },
  env: NodeJS.ProcessEnv,
): boolean {
  const current = capturePluginSnapshotGeneration(env);
  if (current === undefined) {
    return entry.expiresAt > Date.now();
  }
  return entry.generation === current;
}
