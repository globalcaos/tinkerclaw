/**
 * FORK: File watcher for auth-profiles.json.
 *
 * Watches the main auth store file via chokidar. On change, invalidates
 * the in-memory runtime auth store cache so the next request reads fresh
 * tokens from disk. Optionally broadcasts an event to connected WS clients.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { resolveAuthStorePath } from "../../src/agents/auth-profiles/paths.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../src/agents/auth-profiles/store.js";
import type { GatewayBroadcastFn } from "../../src/gateway/server-broadcast.js";

/** Module-level broadcast ref, captured from gateway method context. */
let broadcastFn: GatewayBroadcastFn | null = null;

export function setBroadcast(fn: GatewayBroadcastFn): void {
  broadcastFn ??= fn;
}

export function getBroadcast(): GatewayBroadcastFn | null {
  return broadcastFn;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onFileChange(): void {
  if (debounceTimer) {clearTimeout(debounceTimer);}
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    clearRuntimeAuthProfileStoreSnapshots();
    console.log("[auth-reload] auth-profiles.json changed, invalidated runtime cache");
    broadcastFn?.("auth.profiles.updated", { source: "file-watcher", clearAll: true });
  }, 500);
}

let watcher: FSWatcher | null = null;

export function startAuthProfileWatcher(): void {
  const authPath = resolveAuthStorePath();
  watcher = chokidar.watch(authPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });
  watcher.on("add", onFileChange);
  watcher.on("change", onFileChange);
  console.log(`[auth-reload] watching ${authPath}`);
}

export function stopAuthProfileWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  watcher?.close();
  watcher = null;
}
