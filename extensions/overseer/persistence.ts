/**
 * FORK: overseer/persistence — Atomic JSON save/load for topology snapshots
 *
 * Provides `saveState()` and `loadState()` for persisting the Overseer topology
 * graph (`TopologySnapshot`) to disk as JSON. Writes use a tmp+rename pattern to
 * prevent corruption on crash. Called by the plugin's `gateway_start` (restore)
 * and `gateway_stop` (persist) hooks so agent topology survives gateway restarts.
 *
 * Wired in by: imported from `./persistence.js` in `extensions/overseer/index.ts`
 */
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TopologySnapshot } from "./topology.js";

export function saveState(filePath: string, snapshot: TopologySnapshot): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
  renameSync(tmp, filePath);
}

export function loadState(filePath: string): TopologySnapshot | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
      return data as TopologySnapshot;
    }
    return null;
  } catch {
    return null;
  }
}
