// FORK 2026-09-01 (the architect: drag-reorder context tabs; sessions panel follows
// that order — open tabs first, closed tabs immediately after).
//
// Pure (DOM-free, storage-free) helpers so the reorder + panel-sync rules can
// be unit-tested. app.ts owns the pointer events, persistence, and markup;
// it re-derives none of these rules inline. Same extraction precedent as
// queued-sends.ts / outbox.ts.
//
// THE RULE:
//   1. Open tabs occupy the front of the sessions list, in tab-bar order.
//   2. Closing a tab does not delete its session; the row lands immediately
//      after the still-open tabs, keeping its place among other closed ones.
//   3. Everything else (WhatsApp / cron / subagents / leftover pinned) stays
//      below that workspace block.

export const SESSION_PANEL_ORDER_KEY = "sessions:panel-order";

export type TabLike = { id: string; sessionKey?: string | null };

export type KeyMatch = (a: string, b: string) => boolean;

/** Exact match, or one key is a suffix of the other (`tinker:A` vs `agent:main:tinker:A`). */
export const defaultKeyMatch: KeyMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(":" + b) || b.endsWith(":" + a);
};

export function sessionKeysOfTabs(tabs: readonly TabLike[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const key = tab.sessionKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function keyAlreadyListed(listed: readonly string[], key: string, match: KeyMatch): boolean {
  return listed.some((item) => match(item, key));
}

/**
 * Move `draggedId` so it sits immediately before `beforeId`.
 * `beforeId === null` means "append at the end".
 * Unknown ids are a no-op (returns a shallow copy).
 */
export function reorderTabs<T extends { id: string }>(
  tabs: readonly T[],
  draggedId: string,
  beforeId: string | null,
): T[] {
  const from = tabs.findIndex((tab) => tab.id === draggedId);
  if (from < 0) return tabs.slice();
  const next = tabs.slice();
  const [item] = next.splice(from, 1);
  if (!item) return tabs.slice();
  let to = beforeId == null ? next.length : next.findIndex((tab) => tab.id === beforeId);
  if (to < 0) to = next.length;
  next.splice(to, 0, item);
  return next;
}

/**
 * Open tab keys occupy the front, in tab-bar order. Remaining keys from
 * `previousOrder` keep their relative order after that block — which is how a
 * just-closed tab (still in previousOrder, no longer in openKeys) lands
 * immediately after the still-open ones.
 */
export function mergeTabSessionOrder(
  openKeys: readonly string[],
  previousOrder: readonly string[],
  match: KeyMatch = defaultKeyMatch,
): string[] {
  const result: string[] = [];
  const push = (key: string | null | undefined) => {
    if (!key || keyAlreadyListed(result, key, match)) return;
    result.push(key);
  };
  for (const key of openKeys) push(key);
  for (const key of previousOrder) push(key);
  return result;
}

/** Drop keys that no longer exist in the live set. Missing-for-one-poll is the caller's problem. */
export function liveOrderKeys(
  order: readonly string[],
  liveKeys: readonly string[],
  match: KeyMatch = defaultKeyMatch,
): string[] {
  return order.filter((key) => liveKeys.some((live) => match(key, live)));
}

export function dropKeyFromOrder(
  order: readonly string[],
  key: string,
  match: KeyMatch = defaultKeyMatch,
): string[] {
  return order.filter((item) => !match(item, key));
}

/**
 * Open keys first (tab-bar order), then stored-order keys, then leftovers in
 * their incoming relative order. Object identity is the "already taken" mark,
 * so a duplicated key cannot emit the same row twice.
 */
export function orderSessionsByTabs<T>(
  items: readonly T[],
  openKeys: readonly string[],
  storedOrder: readonly string[],
  keyOf: (item: T) => string,
  match: KeyMatch = defaultKeyMatch,
): T[] {
  const used = new Set<T>();
  const take = (key: string): T | undefined => {
    const found = items.find((item) => !used.has(item) && match(keyOf(item), key));
    if (found !== undefined) used.add(found);
    return found;
  };
  const out: T[] = [];
  for (const key of openKeys) {
    const item = take(key);
    if (item !== undefined) out.push(item);
  }
  for (const key of storedOrder) {
    const item = take(key);
    if (item !== undefined) out.push(item);
  }
  for (const item of items) {
    if (!used.has(item)) out.push(item);
  }
  return out;
}

/**
 * Given the tab under the pointer and whether the cursor is on its leading
 * half, return the id that the dragged tab should sit BEFORE.
 * `null` means "append at the end" (no tab under the pointer, or trailing half
 * of the last tab).
 */
export function dropBeforeId(
  tabIds: readonly string[],
  overId: string | null,
  closerToStart: boolean,
): string | null {
  if (!overId) return null;
  const idx = tabIds.indexOf(overId);
  if (idx < 0) return null;
  if (closerToStart) return overId;
  return tabIds[idx + 1] ?? null;
}

/**
 * Restore a tab list that always contains `mainTab`, without forcing Main to
 * index 0 — drag-reorder of Main must survive a reconnect. If the stored list
 * has no Main entry, Main is prepended (first-load default).
 */
export function restoreTabsWithMain<T extends { id: string }>(
  stored: readonly T[],
  mainTab: T,
): T[] {
  if (stored.some((tab) => tab.id === "tab-main")) {
    return stored.map((tab) => (tab.id === "tab-main" ? mainTab : tab));
  }
  return [mainTab, ...stored];
}
