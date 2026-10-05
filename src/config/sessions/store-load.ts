import fs from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { hydrateSessionStoreSkillsSnapshots } from "./skills-snapshot-store.js";
import {
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  clone?: boolean;
};

const log = createSubsystemLogger("sessions/store");

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

export function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry));
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
      clone: opts.clone,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  if (serializedFromDisk !== undefined) {
    setSerializedSessionStore(storePath, serializedFromDisk);
  } else {
    setSerializedSessionStore(storePath, undefined);
  }

  applySessionStoreMigrations(store);
  normalizeSessionStore(store);
  // FORK 2026-09-21 — hydrate content-addressed skills snapshots HERE, not only in
  // store.ts's wrapper: ~12 modules import this raw loader directly and would
  // otherwise read `prompt: undefined`. In place, before the cache write, so the
  // object cache (and every clone:false hit) holds the hydrated store.
  // `serializedFromDisk` stays the on-disk text: the save path externalises
  // before stringify, so an unchanged store still compares equal and skips the
  // write. Idempotent; an identity no-op for legacy inline entries.
  hydrateSessionStoreSkillsSnapshots({ storePath, store });
  const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfig();
  const beforeCount = Object.keys(store).length;
  if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
    const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, { log: false });
    const countAfterPrune = Object.keys(store).length;
    const capped = shouldRunSessionEntryMaintenance({
      entryCount: countAfterPrune,
      maxEntries: maintenance.maxEntries,
    })
      ? capEntryCount(store, maintenance.maxEntries, { log: false })
      : 0;
    const afterCount = Object.keys(store).length;
    if (pruned > 0 || capped > 0) {
      serializedFromDisk = undefined;
      setSerializedSessionStore(storePath, undefined);
      log.info("applied load-time maintenance to oversized session store", {
        storePath,
        before: beforeCount,
        after: afterCount,
        pruned,
        capped,
        maxEntries: maintenance.maxEntries,
      });
    }
  }

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return opts.clone === false ? store : structuredClone(store);
}

export type LoadSessionStoreEntryOptions = Omit<LoadSessionStoreOptions, "clone">;

// FORK 2026-09-23 — single-entry reads. `loadSessionStore(path)[key]` deep-clones
// the WHOLE store to hand back one entry; a live profile had ~20% of the gateway
// main thread in that clone (3.6 MB store). These run the exact same load
// (cache, mtime+size freshness, skills-snapshot hydration) with clone:false and
// never let the shared cached object escape. Keys are OWN properties only.

/** One entry as a private deep copy (callers may mutate it), or undefined. */
export function loadSessionStoreEntry(
  storePath: string,
  sessionKey: string,
  opts: LoadSessionStoreEntryOptions = {},
): SessionEntry | undefined {
  // READ-ONLY borrow of the cached object: only the entry is copied out.
  const store = loadSessionStore(storePath, { ...opts, clone: false });
  const entry = Object.hasOwn(store, sessionKey) ? store[sessionKey] : undefined;
  return entry === undefined ? undefined : structuredClone(entry);
}

/**
 * Membership without any clone. `ignoreCase` falls back, after an exact miss, to
 * the first key equal under normalizeStoreSessionKey (trim + lowercase).
 */
export function hasSessionStoreEntry(
  storePath: string,
  sessionKey: string,
  opts: LoadSessionStoreEntryOptions & { ignoreCase?: boolean } = {},
): boolean {
  const { ignoreCase, ...loadOpts } = opts;
  // READ-ONLY borrow of the cached object; only a boolean leaves this function.
  const store = loadSessionStore(storePath, { ...loadOpts, clone: false });
  if (Object.hasOwn(store, sessionKey) && store[sessionKey]) {
    return true;
  }
  if (!ignoreCase) {
    return false;
  }
  const normalized = normalizeStoreSessionKey(sessionKey);
  for (const key of Object.keys(store)) {
    if (normalizeStoreSessionKey(key) === normalized) {
      return Boolean(store[key]);
    }
  }
  return false;
}
