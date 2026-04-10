/**
 * FORK: In-memory cache for WhatsApp group names.
 *
 * Used by access-control.ts to determine whether a group is an "agent group"
 * (its subject contains the configured triggerPrefix) without hitting
 * WhatsApp's API on every inbound message.
 *
 * Cache entries have a 5-minute TTL. On miss, the cache fetches group metadata
 * via a registered fetcher function (set by the session layer). On fetch error,
 * the stale cached value is returned as a safe default.
 *
 * Invalidation: call updateGroupName() from the `groups.update` event handler.
 */

import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";

const logger = getChildLogger({ module: "group-name-cache" });

interface CacheEntry {
  subject: string;
  cachedAt: number;
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

type GroupMetadataFn = (jid: string) => Promise<{ subject: string }>;
let _fetchGroupMetadata: GroupMetadataFn | null = null;

/**
 * Register the function used to fetch group metadata on cache miss.
 * Typically wired to whatsmeow's groupMetadata() call.
 */
export function setGroupMetadataFetcher(fn: GroupMetadataFn): void {
  _fetchGroupMetadata = fn;
}

/**
 * Eagerly update the cached name for a group.
 * Call this from the `groups.update` event handler.
 */
export function updateGroupName(jid: string, subject: string): void {
  cache.set(jid, { subject, cachedAt: Date.now() });
}

/**
 * Get the group name for a JID, fetching from WhatsApp on cache miss.
 * Returns null if the fetcher is not registered and no cached value exists.
 * Falls back to a stale cached value on fetch error.
 */
export async function getGroupName(jid: string): Promise<string | null> {
  const entry = cache.get(jid);
  if (entry && Date.now() - entry.cachedAt < TTL_MS) {
    return entry.subject;
  }
  if (!_fetchGroupMetadata) {
    logger.warn("groupMetadata fetcher not registered");
    return entry?.subject ?? null;
  }
  try {
    const meta = await _fetchGroupMetadata(jid);
    cache.set(jid, { subject: meta.subject, cachedAt: Date.now() });
    return meta.subject;
  } catch (err) {
    logger.debug({ error: String(err), jid }, "failed to fetch group metadata");
    return entry?.subject ?? null;
  }
}

/**
 * Check whether a group's name contains the agent's triggerPrefix
 * (case-insensitive). Returns false if the group name cannot be resolved.
 */
export async function isAgentGroup(jid: string, triggerPrefix: string): Promise<boolean> {
  const name = await getGroupName(jid);
  if (!name) {
    return false;
  }
  return name.toLowerCase().includes(triggerPrefix.toLowerCase());
}

/**
 * Clear the entire group name cache. Useful for tests and account switches.
 */
export function clearGroupNameCache(): void {
  cache.clear();
}
