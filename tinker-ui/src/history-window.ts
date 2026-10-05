// Pure, DOM-free: per-tab cursor state for chat.history paging (Task 7,
// docs/superpowers/sdd/2026-09-23-chat-history-incremental-rehaul).
//
// The gateway's chat.history now accepts afterSeq/beforeSeq/epoch and every
// reply carries a cursor: { epoch, firstSeq, lastSeq, hasMoreBefore, reset }.
// This module tracks what a tab already has and builds the next request —
// nothing here touches the DOM, app.ts state, or issues a request itself.
//
// Back-compat: the live gateway keeps serving the OLD reply shape (no
// `cursor` field at all) until the owner restarts it. cursorOf() is how a
// caller tells the two apart. Separately, a flat/legacy transcript can carry
// a real cursor whose `epoch` is null — that also keeps the window
// cursor-less: buildTailRequest keeps asking the legacy `{sessionKey,
// limit}` shape and buildOlderRequest returns null, exactly the old
// behavior, until a later reply supplies a real epoch.

export type HistoryCursor = {
  epoch: string | null;
  firstSeq: number;
  lastSeq: number;
  hasMoreBefore: boolean;
  reset: boolean;
  /**
   * FORK 2026-09-24 (ruling R36) — user rows the transcript holds before `firstSeq`. Sent on tail
   * windows, resets and older pages; absent on a plain delta and from a gateway that predates it.
   */
  userRowsBefore?: number;
};

export type HistoryWindow = {
  epoch: string | null;
  firstSeq: number;
  lastSeq: number;
  hasMoreBefore: boolean;
  sessionId: string | null;
  /** R36: user rows before `firstSeq`; absent = unknown, count from the page (history-paging.ts). */
  userRowsBefore?: number;
};

/** Rows asked for per page (initial tail fill and each "older" page). */
export const WINDOW_PAGE = 100;
/** Soft cap on rows a live tab keeps on paper before trimming (Task 8). */
export const WINDOW_MAX_ROWS = 400;
/** Rows a backgrounded tab is stubbed down to (Task 8). */
export const BG_STUB_ROWS = 30;
/** How long a tab must sit backgrounded before it is stubbed (Task 8). */
export const BG_UNLOAD_MS = 10 * 60_000;

export function emptyWindow(): HistoryWindow {
  return { epoch: null, firstSeq: 0, lastSeq: 0, hasMoreBefore: false, sessionId: null };
}

/** The next tail request: ask only for rows after what this window already
 *  has, or a plain page when the window has no epoch yet (a fresh tab, or a
 *  legacy transcript that never carries one). */
export function buildTailRequest(sessionKey: string, w: HistoryWindow): Record<string, unknown> {
  return w.epoch !== null && w.lastSeq > 0
    ? { sessionKey, afterSeq: w.lastSeq, epoch: w.epoch }
    : { sessionKey, limit: WINDOW_PAGE };
}

/** The next older-page request, or null when there is nothing older to fetch
 *  (no epoch — cursor-less — or the window already knows it has reached the
 *  start). Pages from `firstSeq` exactly as held; a tail whose local rows
 *  are all newer than a cut import can have firstSeq === lastSeq + 1, which
 *  is still a valid, positive paging point — never derived by subtraction. */
export function buildOlderRequest(
  sessionKey: string,
  w: HistoryWindow,
): Record<string, unknown> | null {
  return w.epoch !== null && w.hasMoreBefore
    ? { sessionKey, beforeSeq: w.firstSeq, limit: WINDOW_PAGE, epoch: w.epoch }
    : null;
}

/**
 * Fold a reply's cursor into the window. `kind` says whether the reply
 * answered a tail request or an older-page request.
 *
 * - A `reset` reply, or one for a different sessionId, replaces the window
 *   wholesale from the cursor (resetPage: true) — the caller (Task 8) decides
 *   what stays on screen; this module only reports that a reset happened.
 * - A first-ever apply on an empty window (epoch === null) also replaces
 *   wholesale — there is nothing yet to merge with.
 * - Otherwise a "tail" apply only ever widens the window forward: lastSeq
 *   moves to the max of what it already had and what came back, and
 *   hasMoreBefore/firstSeq are left untouched. (An afterSeq reply reports
 *   hasMoreBefore true whenever afterSeq >= 1 — that is not information
 *   about rows older than the window's current firstSeq, so a plain tail
 *   apply must never let it overwrite what "older" already established.)
 * - An "older" apply only ever widens the window backward: firstSeq moves to
 *   the min of what it already had and what came back, and hasMoreBefore is
 *   adopted from the reply (the server is the authority on whether more
 *   remain before the new firstSeq).
 */
export function applyCursor(
  w: HistoryWindow,
  c: HistoryCursor,
  sessionId: string,
  kind: "tail" | "older",
): { window: HistoryWindow; resetPage: boolean } {
  const resetPage = c.reset || (w.sessionId !== null && w.sessionId !== sessionId);
  if (resetPage || w.epoch === null) {
    return {
      window: {
        epoch: c.epoch,
        firstSeq: c.firstSeq,
        lastSeq: c.lastSeq,
        hasMoreBefore: c.hasMoreBefore,
        sessionId,
        userRowsBefore: c.userRowsBefore,
      },
      resetPage,
    };
  }
  if (kind === "older") {
    return {
      window: {
        ...w,
        firstSeq: Math.min(w.firstSeq, c.firstSeq),
        hasMoreBefore: c.hasMoreBefore,
        // The count belongs to the reply's firstSeq; it replaces the window's only when that moves.
        userRowsBefore: c.firstSeq < w.firstSeq ? c.userRowsBefore : w.userRowsBefore,
      },
      resetPage,
    };
  }
  return { window: { ...w, epoch: c.epoch, lastSeq: Math.max(w.lastSeq, c.lastSeq) }, resetPage };
}

/** Safely pull a valid cursor out of a chat.history reply, or null when it is
 *  absent or malformed — the signal a caller (Task 8) uses to tell the old
 *  gateway (no `cursor` field at all) from the new one, without a type
 *  assertion. */
export function cursorOf(reply: unknown): HistoryCursor | null {
  if (typeof reply !== "object" || reply === null) {
    return null;
  }
  const c = (reply as Record<string, unknown>).cursor;
  if (typeof c !== "object" || c === null) {
    return null;
  }
  const { epoch, firstSeq, lastSeq, hasMoreBefore, reset } = c as Record<string, unknown>;
  if (epoch !== null && typeof epoch !== "string") {
    return null;
  }
  if (typeof firstSeq !== "number" || typeof lastSeq !== "number") {
    return null;
  }
  // Number.isInteger rejects NaN, Infinity/-Infinity, and fractions in one call; a seq is a row
  // ordinal, so it must also be non-negative.
  if (!Number.isInteger(firstSeq) || firstSeq < 0 || !Number.isInteger(lastSeq) || lastSeq < 0) {
    return null;
  }
  if (typeof hasMoreBefore !== "boolean" || typeof reset !== "boolean") {
    return null;
  }
  // Optional (R36): an invalid count is dropped, never a reason to distrust the cursor.
  const { userRowsBefore } = c as Record<string, unknown>;
  return {
    epoch,
    firstSeq,
    lastSeq,
    hasMoreBefore,
    reset,
    ...(typeof userRowsBefore === "number" &&
    Number.isInteger(userRowsBefore) &&
    userRowsBefore >= 0
      ? { userRowsBefore }
      : {}),
  };
}
