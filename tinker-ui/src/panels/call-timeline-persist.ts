/**
 * The CALL TIMELINE's last run per session, kept across a page reload (TINKER_UI_DESIGN_BIBLE/
 * context-window-panel.md §5.3, "the last run on screen").
 *
 * FORK 2026-10-02 (the owner: "The CALL TIMELINE panel sometimes stays empty, it should always show
 * the last run instead"). CallTimelineStore lives in the page, and nothing on the gateway keeps a
 * per-call record with first-token times, so a reload (every rebuild pushes one) left the store with
 * history rows only, which are not drawn: the panel sat empty until the next prompt. Each session's
 * newest finished run is written here as a RunSnapshot and put back into the fresh store.
 *
 * THE LIMIT (ui-persistence.md, the client-rows table): this is localStorage, and the owner's
 * Chrome profile wipes localStorage on a clean exit. A reload, F5, a rebuild push and a tab switch
 * keep the last run; a browser restart does not, and the panel then shows the history note until
 * the tab's next prompt. Closing that needs a server-side per-call record, which does not exist.
 *
 * Keys are matched with the caller's predicate (app.ts sessionKeyMatches, the one every other
 * consumer uses), never normalised here: the gateway's canonical key and a tab's short key are the
 * same session, and a second normaliser would be a second answer to that question.
 */
import type { RunSnapshot } from "./call-timeline.js";

export const LAST_RUN_KEY = "tinker.callTimeline.lastRun";
/** Sessions kept; the least recently saved goes first. Matches CALL_TIMELINE_MAX_STORES. */
export const LAST_RUN_MAX_SESSIONS = 16;

type Entry = { savedAt: number; snap: unknown };
type Store = Record<string, Entry>;
type Matches = (a: string, b: string) => boolean;

function readStore(storage: Storage): Store {
  try {
    const raw = storage.getItem(LAST_RUN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Store = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const e = entry as Partial<Entry> | null;
      if (e && typeof e === "object" && typeof e.savedAt === "number" && e.snap) {
        out[key] = { savedAt: e.savedAt, snap: e.snap };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Write, shedding the older half of the sessions on a quota failure and retrying ONCE. */
function writeStore(store: Store, storage: Storage): boolean {
  try {
    storage.setItem(LAST_RUN_KEY, JSON.stringify(store));
    return true;
  } catch {
    try {
      const keys = Object.keys(store).sort((a, b) => store[a].savedAt - store[b].savedAt);
      for (const key of keys.slice(0, Math.floor(keys.length / 2))) {
        delete store[key];
      }
      storage.setItem(LAST_RUN_KEY, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }
}

/** The stored snapshot for this session, unvalidated (CallTimelineStore.restoreRun checks it). */
export function loadLastRun(
  sessionKey: string,
  matches: Matches,
  storage: Storage = globalThis.localStorage,
): unknown {
  const store = readStore(storage);
  const hit = Object.keys(store).find((k) => k === sessionKey || matches(sessionKey, k));
  return hit === undefined ? null : store[hit].snap;
}

/**
 * Save this session's last run. Any entry under another spelling of the same session is replaced,
 * and past LAST_RUN_MAX_SESSIONS the least recently saved go. Returns whether it landed.
 */
export function saveLastRun(
  sessionKey: string,
  snap: RunSnapshot,
  matches: Matches,
  savedAt: number,
  storage: Storage = globalThis.localStorage,
): boolean {
  const store = readStore(storage);
  for (const k of Object.keys(store)) {
    if (k === sessionKey || matches(sessionKey, k)) {
      delete store[k];
    }
  }
  store[sessionKey] = { savedAt, snap };
  const keys = Object.keys(store).sort((a, b) => store[a].savedAt - store[b].savedAt);
  for (const key of keys.slice(0, Math.max(0, keys.length - LAST_RUN_MAX_SESSIONS))) {
    delete store[key];
  }
  return writeStore(store, storage);
}
