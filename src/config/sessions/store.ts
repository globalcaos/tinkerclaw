import fs from "node:fs";
import path from "node:path";
import { isSessionWriteLockTimeoutError } from "../../agents/session-write-lock-error.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { emitEvent } from "../../infra/events/emit.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  externalizeSessionStoreSkillsSnapshots,
  hydrateSessionStoreSkillsSnapshots,
} from "./skills-snapshot-store.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  isSessionStoreCacheEnabled,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import {
  type LoadSessionStoreOptions,
  loadSessionStore as loadSessionStoreRaw,
  normalizeSessionStore,
} from "./store-load.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
  LOCK_QUEUES,
  type SessionStoreLockQueue,
  type SessionStoreLockTask,
} from "./store-lock-state.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
} from "./store-lock-state.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
export {
  hasSessionStoreEntry,
  loadSessionStoreEntry,
  type LoadSessionStoreEntryOptions,
} from "./store-load.js";

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let trajectoryCleanupRuntimePromise: Promise<typeof import("../../trajectory/cleanup.js")> | null =
  null;
let sessionWriteLockAcquirerForTests: typeof acquireSessionWriteLock | null = null;

/**
 * FORK 2026-09-21 — throttle the NO-NEWS archive sweep.
 *
 * `saveSessionStoreUnlocked` runs on EVERY session-store update while holding
 * the store lock. Even when nothing was archived by this save it used to call
 * `cleanupArchivedSessionTranscripts` twice (reason "deleted" and, because
 * `resetArchiveRetentionMs` defaults to `pruneAfterMs`, reason "reset")
 * against the whole sessions directory. On the live gateway that directory
 * held 14,546 files (2,822 `.deleted.*` archives): two full readdir + name
 * parses per save, under the lock, on every turn.
 *
 * The sweep is idempotent and age-based (retention is measured in days), so
 * running it at most once per ARCHIVE_SWEEP_MIN_INTERVAL_MS per resolved
 * directory keeps retention semantics intact. It only shifts an age-based
 * deletion by at most 10 minutes. A save that DID archive something, and forced
 * maintenance (`maintenanceOverride`, e.g. `openclaw sessions cleanup`),
 * always sweep, exactly as before.
 */
const ARCHIVE_SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastArchiveSweepAtByDir = new Map<string, number>();

function isArchiveSweepDue(dir: string, nowMs: number): boolean {
  const last = lastArchiveSweepAtByDir.get(path.resolve(dir));
  return last === undefined || nowMs - last >= ARCHIVE_SWEEP_MIN_INTERVAL_MS;
}

function stampArchiveSweep(dirs: string[], nowMs: number): void {
  for (const dir of dirs) {
    lastArchiveSweepAtByDir.set(path.resolve(dir), nowMs);
  }
}

export function resetArchiveSweepThrottleForTest(): void {
  lastArchiveSweepAtByDir.clear();
}

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function loadTrajectoryCleanupRuntime() {
  trajectoryCleanupRuntimePromise ??= import("../../trajectory/cleanup.js");
  return trajectoryCleanupRuntimePromise;
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function setSessionWriteLockAcquirerForTests(
  acquirer: typeof acquireSessionWriteLock | null,
): void {
  sessionWriteLockAcquirerForTests = acquirer;
}

export function resetSessionStoreLockRuntimeForTests(): void {
  sessionWriteLockAcquirerForTests = null;
  resetArchiveSweepThrottleForTest();
}

export async function withSessionStoreLockForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, opts);
}

/**
 * FORK 2026-09-03 — hydrating loader (replaces the former pass-through re-export
 * of `store-load.js`).
 *
 * `store-load.ts` returns sessions.json exactly as persisted, and skills
 * snapshots are persisted as content-addressed refs (see
 * skills-snapshot-store.ts). Every reader that comes through the session store
 * must therefore get `skillsSnapshot.prompt` / `.resolvedSkills` back as plain
 * values. Hydration is idempotent and an identity no-op for legacy inline
 * entries, and it stays on even when externalisation is disabled so a rollback
 * never strands data written by an earlier run.
 *
 * NOTE: modules that import `loadSessionStore` from `./store-load.js` DIRECTLY
 * bypass this wrapper — that is why externalisation is still opt-in. See
 * `isSkillsSnapshotExternalizationEnabled`.
 */
export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  return hydrateSessionStoreSkillsSnapshots({
    storePath,
    store: loadSessionStoreRaw(storePath, opts),
  });
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    // FORK 2026-09-23 — READ-ONLY borrow (clone:false): runs per inbound channel
    // message and only a number leaves; resolveSessionStoreEntry never writes.
    const store = loadSessionStore(params.storePath, { clone: false });
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

type SaveSessionStoreOptions = {
  /**
   * logging.md §4.3 — the `site` label for this save's store-lock acquisition.
   * Optional: an untagged caller falls back to the tag derived from the store path.
   */
  lockSite?: string;
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};

/**
 * FORK 2026-09-24 — how a save hands its store object to the object cache.
 *
 * Default (undefined): the cache keeps a structuredClone, because the caller may
 * keep using what it saved. The audit (plan task 11) found callers that do:
 * `updateSessionStore` mutators store objects their callers keep mutating (e.g.
 * auth-profiles/session-override stores the run's live `sessionEntry`), and
 * `saveSessionStore` takes the caller's own store. Both are plugin-SDK exports.
 *
 * `{ isolateKey }`: only for this module's single-entry writers, whose store
 * object is private (a fresh parse, or a private clone) and whose caller can
 * reach exactly one entry: the one it gets back, which also holds its patch
 * values. Callers DO keep mutating that entry (auto-reply's
 * activeSessionEntry), so the cache gets a deep copy of it and adopts the rest
 * by reference: one entry cloned instead of the whole store.
 */
type SessionStoreCacheHandoff = { isolateKey: string } | undefined;

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
  handoff?: SessionStoreCacheHandoff;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(params.storePath, params.serialized);
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    return;
  }
  const isolateKey = params.handoff?.isolateKey;
  if (isolateKey !== undefined && Object.hasOwn(params.store, isolateKey)) {
    const reachable = params.store[isolateKey];
    if (reachable) {
      params.store[isolateKey] = structuredClone(reachable);
    }
  }
  writeSessionStoreCache({
    storePath: params.storePath,
    store: params.store,
    mtimeMs: fileStat?.mtimeMs,
    sizeBytes: fileStat?.sizeBytes,
    serialized: params.serialized,
    adopt: params.handoff !== undefined,
  });
}

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.prototype.hasOwnProperty.call(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, entry.acp);
    }
  }
  return snapshot;
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
  }
}

/**
 * logging.md §4.3 `store.save` — what one save has to report, filled in as the save
 * proceeds so the emitter can tell a save that FINISHED from one that gave up.
 */
type SessionStoreSaveMetrics = {
  /** The exact bytes handed to the atomic write; null when no write happened. */
  written: string | null;
  /** True when the serialization was byte-identical, so writing nothing WAS the save. */
  unchanged: boolean;
  /** Entries in the store as serialized; reused from maintenance when it already counted. */
  entries: number | null;
};

/**
 * logging.md §9 step 6 — one `store.save` row per COMPLETED save.
 *
 * §4.3 gives this row no slot for an outcome (label, n3, n4 and fields are all declared
 * null), so a save that gave up emits nothing at all: a 0-byte row is exactly what a
 * healthy no-op save looks like, and "the store stopped persisting" would otherwise read
 * as "steady and cheap" on the very dashboard this row exists to feed. The failure is
 * still visible — the hold shows up as a `store.lock.held` row, and a thrown error
 * propagates (the ENOENT and Windows-retry paths still swallow or log it, as before).
 *
 * Cost inside the lock: one `Date.now()` and one `setImmediate`. The UTF-8 length scan is
 * the expensive term (measured 0.5-0.66 ms on a 3.05 MB store) and runs on the NEXT tick,
 * off the hold; `written` is the same immutable string the serialized cache already
 * retains, so deferring costs no extra memory and cannot read a store another writer has
 * since mutated. The one residual O(n) term is the key count on the `skipMaintenance` path
 * (measured ~28-80 us at the 500-entry default cap, beside the ~6.7 ms JSON.stringify of
 * the same 3.05 MB store it runs next to; a maintained save reuses the count maintenance
 * already computed).
 *
 * n1 = `bytes_written` is sessions.json's OWN bytes, the file the store lock protects.
 * Skills-snapshot sidecars (externalizeSessionStoreSkillsSnapshots) are content-addressed
 * and written separately; they are deliberately NOT counted here.
 */
function emitStoreSaveEvent(startedAtMs: number, metrics: SessionStoreSaveMetrics): void {
  if (metrics.written === null && !metrics.unchanged) {
    return;
  }
  const finishedAtMs = Date.now();
  const durMs = finishedAtMs - startedAtMs;
  const written = metrics.written;
  const entries = metrics.entries;
  setImmediate(() => {
    emitEvent("store.save", {
      tsMs: finishedAtMs,
      durMs,
      n1: written === null ? 0 : Buffer.byteLength(written, "utf8"),
      n2: entries,
    });
  });
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
  handoff?: SessionStoreCacheHandoff,
): Promise<void> {
  const startedAtMs = Date.now();
  const metrics: SessionStoreSaveMetrics = { written: null, unchanged: false, entries: null };
  // Deliberately NOT a `finally`: a save that threw must not emit a row (see above).
  await saveSessionStoreUnlockedInner(storePath, store, opts, handoff, metrics);
  emitStoreSaveEvent(startedAtMs, metrics);
}

async function saveSessionStoreUnlockedInner(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts: SaveSessionStoreOptions | undefined,
  handoff: SessionStoreCacheHandoff | undefined,
  metrics: SessionStoreSaveMetrics,
): Promise<void> {
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated getRuntimeConfig() calls).
    const maintenance = opts?.maintenanceConfig
      ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
      : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;
    const forceMaintenance = opts?.maintenanceOverride !== undefined;
    const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
      entryCount: beforeCount,
      maxEntries: maintenance.maxEntries,
      force: forceMaintenance,
    });

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey && shouldRunEntryMaintenance) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: true,
        log,
      });
      // Reused as `store.save`'s n2=entries: maintenance already paid for this count.
      metrics.entries = Object.keys(store).length;
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: metrics.entries,
        pruned: 0,
        capped: 0,
        diskBudget,
      });
    } else {
      const preserveSessionKeys = opts?.activeSessionKey
        ? new Set([opts.activeSessionKey])
        : undefined;
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
        preserveKeys: preserveSessionKeys,
      });
      const countAfterPrune = Object.keys(store).length;
      const shouldRunCapMaintenance =
        forceMaintenance ||
        shouldRunSessionEntryMaintenance({
          entryCount: countAfterPrune,
          maxEntries: maintenance.maxEntries,
        });
      const capped = shouldRunCapMaintenance
        ? capEntryCount(store, maintenance.maxEntries, {
            onCapped: ({ entry }) => {
              rememberRemovedSessionFile(removedSessionFiles, entry);
            },
            preserveKeys: preserveSessionKeys,
          })
        : 0;
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
        removedSessionFiles,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (removedSessionFiles.size > 0) {
        const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
        await removeRemovedSessionTrajectoryArtifacts({
          removedSessionFiles,
          referencedSessionIds,
          storePath,
          restrictToStoreDir: true,
        });
      }
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        // FORK 2026-09-21 — see ARCHIVE_SWEEP_MIN_INTERVAL_MS: a no-news save
        // (nothing archived, not forced) sweeps a directory at most once per
        // 10 minutes instead of twice per save.
        const sweepNowMs = Date.now();
        const dueDirs =
          archivedDirs.size > 0 || forceMaintenance
            ? targetDirs
            : targetDirs.filter((dir) => isArchiveSweepDue(dir, sweepNowMs));
        if (dueDirs.length > 0) {
          const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
          await cleanupArchivedSessionTranscripts({
            directories: dueDirs,
            olderThanMs: maintenance.pruneAfterMs,
            reason: "deleted",
          });
          if (maintenance.resetArchiveRetentionMs != null) {
            await cleanupArchivedSessionTranscripts({
              directories: dueDirs,
              olderThanMs: maintenance.resetArchiveRetentionMs,
              reason: "reset",
            });
          }
          stampArchiveSweep(dueDirs, sweepNowMs);
        }
      }

      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: false,
        log,
      });
      // Reused as `store.save`'s n2=entries: maintenance already paid for this count.
      metrics.entries = Object.keys(store).length;
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: metrics.entries,
        pruned,
        capped,
        diskBudget,
      });
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  // FORK 2026-09-21 — deliberately NOT stripping `systemPromptReport` from
  // soft-deleted (`deletedAt`) entries, even though those hold ~1.1 MB of the
  // store. `deletedAt` is sticky: nothing in the runtime clears or checks it, so
  // a new inbound message on a soft-deleted key (main, a still-open tinker tab)
  // runs WITHOUT a reset. That run reads `sessionEntry.systemPromptReport`
  // (bootstrap-warning dedup in agents/command/attempt-execution.ts, /context
  // and usage contextWeight, cli-compaction). Stripping here would wipe a live
  // session's report on every save. Clear `deletedAt` on resume first, then
  // revisit. Pinned by store.maintenance-throttle.test.ts.
  // FORK 2026-09-03 — externalise skills snapshots to content-addressed sidecars
  // before serialising: 7.02 MB of a 10.32 MB sessions.json was duplicated
  // snapshot text, and the whole file is rewritten under the lock on every
  // update. `store` itself stays hydrated, so the in-memory object cache and
  // every live reader are unaffected — only the bytes on disk shrink.
  const persisted = await externalizeSessionStoreSkillsSnapshots({ storePath, store });
  // Only a `skipMaintenance` save pays for its own key count (~28-80 us at the 500-entry
  // default cap, under 1.5% of the stringify below on a 3 MB store); a maintained save
  // reuses the count maintenance already computed.
  metrics.entries ??= Object.keys(persisted).length;
  const json = JSON.stringify(persisted, null, 2);
  if (getSerializedSessionStore(storePath) === json) {
    // Writing nothing IS the save here, which is not the same as giving up.
    metrics.unchanged = true;
    updateSessionStoreWriteCaches({ storePath, store, serialized: json, handoff });
    return;
  }

  // `store.save` reports the bytes ACTUALLY written, so the byte source is recorded in
  // one place, only once the atomic write has resolved.
  const writeOnce = async (): Promise<void> => {
    await writeSessionStoreAtomic({ storePath, store, serialized: json, handoff });
    metrics.written = json;
  };

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i++) {
      try {
        await writeOnce();
        return;
      } catch (err) {
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed — skip this save. The write lock ensures
        // the next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    return;
  }

  try {
    await writeOnce();
  } catch (err) {
    const code = getErrorCode(err);

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeOnce();
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await withSessionStoreLockAt(opts?.lockSite ?? "saveSessionStore", storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  // Arbitrary (plugin) mutators: the cache keeps a clone. See SessionStoreCacheHandoff.
  return await updateSessionStoreWithHandoff(
    storePath,
    mutator,
    opts,
    () => undefined,
    opts?.lockSite ?? "updateSessionStore",
  );
}

/**
 * updateSessionStore with a cache handoff, for THIS module's mutators only:
 * `resolveHandoff` runs after the mutator and names the one entry its caller
 * can still reach.
 */
async function updateSessionStoreWithHandoff<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts: SaveSessionStoreOptions | undefined,
  resolveHandoff: () => SessionStoreCacheHandoff,
  site: string,
): Promise<T> {
  return await withSessionStoreLockAt(site, storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true, clone: false });
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
    const result = await mutator(store);
    preserveExistingAcpMetadata({
      previousAcpByKey,
      nextStore: store,
      allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
    });
    await saveSessionStoreUnlocked(storePath, store, opts, resolveHandoff());
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  /**
   * logging.md §4.3 — the `site` label on this acquisition's `store.lock.held` and
   * `store.lock.timeout` rows. Optional: an untagged caller gets the tag derived from
   * the store path, so the label column is stable and bounded either way.
   */
  site?: string;
};

const SESSION_STORE_LOCK_MIN_HOLD_MS = 5_000;
const SESSION_STORE_LOCK_TIMEOUT_GRACE_MS = 5_000;

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
  handoff?: SessionStoreCacheHandoff;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({
    storePath: params.storePath,
    store: params.store,
    serialized: params.serialized,
    handoff: params.handoff,
  });
}

/**
 * `store` must be PRIVATE to the calling writer (see SessionStoreCacheHandoff):
 * after this returns, the cache owns it and only `params.next` is the caller's.
 */
async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(
    params.storePath,
    params.store,
    { activeSessionKey: params.resolved.normalizedKey },
    { isolateKey: params.resolved.normalizedKey },
  );
  return params.next;
}

function lockTimeoutError(storePath: string): Error {
  return new Error(`timeout waiting for session store lock: ${storePath}`);
}

/**
 * logging.md §4.3 — a `site` label must satisfy emit.ts's LABEL_VALUE (printable ASCII,
 * no whitespace); anything else is dropped THERE and counted as an invalid value, so it
 * is normalized HERE and never guessed. 64 chars, not 128: the label is a call-site name,
 * and the shorter cap keeps the column's cardinality readable.
 */
const LOCK_SITE_TAG = /^[\x21-\x7e]{1,64}$/;

function normalizeLockSiteTag(site: string | undefined): string | null {
  return typeof site === "string" && LOCK_SITE_TAG.test(site) ? site : null;
}

/**
 * The stable default for a caller that passed no `site`: the store file's own name.
 * Derived rather than a constant so an untagged writer is still attributable to ITS store
 * — the gateway's sessions.json, a cron profile's, a test's temp file — while staying
 * bounded, because a store path's basename is not caller-controlled free text.
 */
function deriveLockSiteTag(storePath: string): string {
  const base = path.basename(storePath, ".json");
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  return safe.length > 0 ? `store:${safe}` : "store:unknown";
}

/**
 * logging.md §4.3 `store.lock.held`.
 *
 * Called AFTER the lock has been released, never between acquire and release: the only
 * cost this instrumentation adds inside the hold is the single `Date.now()` that stamps
 * the acquisition (~50 ns). The rest runs after release but still inside the serial drain
 * loop, so it delays the NEXT queued writer's acquisition by the same amount. Measured
 * through the real queue with a no-op file lock (100k acquisitions, median of 7 runs):
 * ~2.2-2.6 us per acquisition before this change, ~2.5-2.8 us after it with the event
 * writer not started, ~3.8-4.3 us with every row queued into a running writer.
 *
 * n2 = `queue_depth` is the contention this writer met ON ARRIVAL (writers ahead of it,
 * plus itself), not the backlog that piled up behind it: arrival depth is the causal
 * partner of `wait_ms`, and it is sampled at ONE instant for both this row and
 * `store.lock.timeout` so the two columns mean the same thing. It counts only THIS
 * process's queue — `acquireSessionWriteLock` is a cross-process file lock, so a writer
 * that waited on another process reports depth 1.
 *
 * n3 = `timeout_ms` is 0, never NULL, for an unbounded writer: 0 is the value the caller
 * passes to mean "no timeout", so `WHERE n3 IS NOT NULL` never silently drops them.
 */
function emitStoreLockHeld(params: {
  task: SessionStoreLockTask;
  acquiredAtMs: number;
  releasedAtMs: number;
}): void {
  emitEvent("store.lock.held", {
    tsMs: params.releasedAtMs,
    label: params.task.site,
    durMs: params.releasedAtMs - params.acquiredAtMs,
    n1: params.acquiredAtMs - params.task.enqueuedAtMs,
    n2: params.task.queueDepth,
    n3: params.task.timeoutMs ?? 0,
  });
}

/** logging.md §4.3 `store.lock.timeout` — a wait that ended without ever holding. */
function emitStoreLockTimeout(task: SessionStoreLockTask, failedAtMs: number): void {
  emitEvent("store.lock.timeout", {
    tsMs: failedAtMs,
    label: task.site,
    n1: failedAtMs - task.enqueuedAtMs,
    n2: task.queueDepth,
  });
}

function resolveSessionStoreLockMaxHoldMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return resolveSessionLockMaxHoldFromTimeout({
    timeoutMs,
    graceMs: SESSION_STORE_LOCK_TIMEOUT_GRACE_MS,
    minMs: SESSION_STORE_LOCK_MIN_HOLD_MS,
  });
}

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
  const existing = LOCK_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreLockQueue = { running: false, pending: [], drainPromise: null };
  LOCK_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }

        const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
        if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
          // UNREACHABLE today: `withSessionStoreLock` only sets `timeoutMs` when it is
          // positive and finite (`hasTimeout`). Kept defensive, and instrumented so it
          // would surface rather than vanish if that ever changes — not a live emitter.
          emitStoreLockTimeout(task, Date.now());
          task.reject(lockTimeoutError(storePath));
          continue;
        }

        let lock: { release: () => Promise<void> } | undefined;
        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        // logging.md §4.3: null until the lock is actually in hand, which is exactly what
        // separates a wait that ended in a hold from one that ended without one.
        let acquiredAtMs: number | null = null;
        try {
          lock = await (sessionWriteLockAcquirerForTests ?? acquireSessionWriteLock)({
            sessionFile: storePath,
            timeoutMs: remainingTimeoutMs,
            staleMs: task.staleMs,
            maxHoldMs: resolveSessionStoreLockMaxHoldMs(task.timeoutMs),
          });
          acquiredAtMs = Date.now();
          result = await task.fn();
        } catch (err) {
          hasFailure = true;
          failed = err;
        } finally {
          await lock?.release().catch(() => undefined);
        }
        const settledAtMs = Date.now();
        if (acquiredAtMs === null) {
          // The lock was never held. ONLY a timeout is a `store.lock.timeout` row: any
          // other acquire failure is a different defect, and counting it here would make
          // "which writers gave up waiting?" lie.
          if (isSessionWriteLockTimeoutError(failed)) {
            emitStoreLockTimeout(task, settledAtMs);
          }
        } else {
          // Emitted even when the guarded callback threw: the lock WAS held that long.
          emitStoreLockHeld({ task, acquiredAtMs, releasedAtMs: settledAtMs });
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        LOCK_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainSessionStoreLockQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  // `pollIntervalMs` is retained for API compatibility with older lock options.
  void opts.pollIntervalMs;

  const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
  const queue = getOrCreateLockQueue(storePath);
  const site = normalizeLockSiteTag(opts.site) ?? deriveLockSiteTag(storePath);
  const enqueuedAtMs = Date.now();

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn: async () => await fn(),
      resolve: (value) => resolve(value as T),
      reject,
      timeoutMs: hasTimeout ? timeoutMs : undefined,
      staleMs,
      site,
      enqueuedAtMs,
      // The contention this writer met on arrival: everyone already queued, plus the
      // one holding the lock, plus itself. Nothing awaits between here and the push,
      // so the depth and the enqueue stamp describe the same instant.
      queueDepth: queue.pending.length + (queue.running ? 1 : 0) + 1,
    };

    queue.pending.push(task);
    void drainSessionStoreLockQueue(storePath);
  });

  return await promise;
}

/**
 * `withSessionStoreLock` with logging.md §4.3's `site` tag in front, so a call site can
 * name itself without pushing its callback out of last-argument position.
 */
async function withSessionStoreLockAt<T>(
  site: string,
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, { ...opts, site });
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLockAt("updateSessionStoreEntry", storePath, async () => {
    const store = loadSessionStore(storePath, { skipCache: true, clone: false });
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  // Every object this mutator hands back (the entry, and the ctx-derived patch
  // values inside it) lives at resolved.normalizedKey: that is the one entry the
  // cache must copy.
  let isolateKey: string | undefined;
  return await updateSessionStoreWithHandoff(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      isolateKey = resolved.normalizedKey;
      const existing = resolved.existing;
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey: resolved.normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        if (existing && resolved.legacyKeys.length > 0) {
          store[resolved.normalizedKey] = existing;
          for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
          }
        }
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = existing
        ? // Inbound metadata updates must not refresh activity timestamps;
          // idle reset evaluation relies on updatedAt from actual session turns.
          mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: normalizeStoreSessionKey(sessionKey) },
    () => (isolateKey === undefined ? undefined : { isolateKey }),
    "recordSessionMetaFromInbound",
  );
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await withSessionStoreLockAt("updateLastRoute", storePath, async () => {
    const store = loadSessionStore(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing && !createIfMissing) {
      return null;
    }
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null &&
      Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey: resolved.normalizedKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    // Route updates must not refresh activity timestamps; idle/daily reset
    // evaluation relies on updatedAt from actual session turns (#49515).
    const next = mergeSessionEntryPreserveActivity(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
    });
  });
}
