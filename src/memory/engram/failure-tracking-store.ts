/**
 * ENGRAM Phase 3D runtime wiring (Upgrade 4) — atomic-write persistence of the
 * per-strategy failure-state map.
 *
 * failure-tracking.ts ships PURE transition functions plus a thin best-effort
 * `loadFailureState`/`saveFailureState` pair. This module is the *durable* store
 * the consolidation cron uses: it persists the `FailureStateMap` to a single
 * JSON file (`~/.openclaw/engram/failure-state.json`) via the
 * write-temp-then-rename atomic pattern (feedback_atomic_store_writes) so a
 * concurrent writer's fields are never silently clobbered.
 *
 * Mirrors the I/O discipline of src/fork/curiosity-store.ts:
 *  - `baseDir` override on every I/O fn so tests point at a temp dir.
 *  - defensive read (missing/corrupt file → empty map, never throws).
 *  - `updateFailureStateMap` = read-modify-write under the atomic helper, so the
 *    mutator always sees the FRESH on-disk copy (not a stale in-memory snapshot).
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 4).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FailureStateMap } from "./failure-tracking.js";

/** Filename of the persisted per-strategy failure-state map. */
const FAILURE_STATE_FILE = "failure-state.json";

/**
 * Resolve the failure-state file path. `baseDir` overrides the default ENGRAM
 * root (`~/.openclaw/engram`) — pass a temp dir in tests.
 */
export function failureStatePath(baseDir?: string): string {
  const root = baseDir ?? join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw", "engram");
  return join(root, FAILURE_STATE_FILE);
}

/**
 * Load the persisted failure-state map. Returns an empty map when the file is
 * absent or corrupt (append-only-safe: a torn write degrades to "start fresh",
 * never an exception that would crash the consolidation cron).
 */
export function loadFailureStateMap(baseDir?: string): FailureStateMap {
  const path = failureStatePath(baseDir);
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FailureStateMap;
  } catch {
    return {};
  }
}

/**
 * Persist the failure-state map atomically: write a sibling temp file then
 * rename over the target (rename is atomic on POSIX), so a reader never observes
 * a half-written file and a crash mid-write leaves the prior good copy intact.
 * Creates the directory lazily. Pretty-printed for human/audit inspection.
 */
export function saveFailureStateMap(map: FailureStateMap, baseDir?: string): void {
  const path = failureStatePath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Read-modify-write the failure-state map under the atomic save.
 *
 * The mutator is handed the FRESH on-disk copy (re-read inside this helper),
 * mutates it, and returns it; the result is then persisted atomically. This is
 * the only correct write path when another code path may have written the file
 * since the caller last loaded it — a blind save of a stale snapshot would drop
 * the other writer's strategies (feedback_atomic_store_writes).
 *
 * Returns the persisted map.
 */
export function updateFailureStateMap(
  baseDir: string | undefined,
  mutate: (fresh: FailureStateMap) => FailureStateMap,
): FailureStateMap {
  const fresh = loadFailureStateMap(baseDir);
  const next = mutate(fresh);
  saveFailureStateMap(next, baseDir);
  return next;
}
