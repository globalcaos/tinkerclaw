/**
 * FORK: File watcher for auth-profiles.json.
 *
 * Watches the main auth store's directory via chokidar. On change, invalidates
 * the in-memory runtime auth store cache so the next request reads fresh
 * tokens from disk. Optionally broadcasts an event to connected WS clients.
 */

import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAuthStorePath } from "openclaw/plugin-sdk/fork-auth-admin";
import type { GatewayBroadcastFn } from "openclaw/plugin-sdk/fork-gateway-broadcast";

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
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    clearRuntimeAuthProfileStoreSnapshots();
    console.log("[auth-reload] auth-profiles.json changed, invalidated runtime cache");
    broadcastFn?.("auth.profiles.updated", { source: "file-watcher", clearAll: true });
  }, 500);
}

let watcher: FSWatcher | null = null;

export function startAuthProfileWatcher(): void {
  // register() runs once per plugin-registry build (5x per boot). Several
  // chokidar instances on one FILE share a single fs.watch handle, and the
  // first atomic tmp+rename write leaves them all bound to the dead inode:
  // one event, then silence, and the gateway serves a rotated-away token
  // until a 401 repairs it. So: one watcher only, and on the DIRECTORY,
  // which outlives inode swaps.
  if (watcher) {
    return;
  }
  const authPath = resolveAuthStorePath();
  const authDir = path.dirname(authPath);
  watcher = chokidar.watch(authDir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (candidate) => candidate !== authDir && candidate !== authPath,
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
