import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: getSessionStoreTtl,
});
// FORK 2026-07-21 — retains the last parsed store past TTL expiry, validated by
// mtime+size at read time. A multi-MB sessions.json must not be re-read and
// re-parsed on the event loop merely because the TTL lapsed while the file never
// changed (observed: 27 MB store × a 5 s poller = multi-second event-loop stalls).
const SESSION_STORE_SHADOW = new Map<string, SessionStoreCacheEntry>();
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

export function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

export function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SHADOW.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SHADOW.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SHADOW.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  // FORK 2026-07-21 — clone:false returns the cached object itself (read-only
  // contract, mirrors LoadSessionStoreOptions.clone): a 27 MB structuredClone on
  // every cache hit was a standing ~160 ms event-loop block for pollers.
  clone?: boolean;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (cached) {
    if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
      invalidateSessionStoreCache(params.storePath);
      return null;
    }
    return params.clone === false ? cached.store : structuredClone(cached.store);
  }
  // TTL lapsed (or never cached): if the file is byte-identical to the shadow copy
  // (same mtime+size), re-promote it instead of re-reading 27 MB from disk. A
  // missing stat means we cannot validate — fall through to a real load.
  const shadow = SESSION_STORE_SHADOW.get(params.storePath);
  if (
    shadow &&
    params.mtimeMs !== undefined &&
    params.mtimeMs === shadow.mtimeMs &&
    params.sizeBytes === shadow.sizeBytes
  ) {
    SESSION_STORE_CACHE.set(params.storePath, shadow);
    return params.clone === false ? shadow.store : structuredClone(shadow.store);
  }
  return null;
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  const entry: SessionStoreCacheEntry = {
    store: structuredClone(params.store),
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  };
  SESSION_STORE_CACHE.set(params.storePath, entry);
  SESSION_STORE_SHADOW.set(params.storePath, entry);
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
