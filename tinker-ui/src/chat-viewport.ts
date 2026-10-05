// FORK 2026-10-02 (the architect: "When I switch tabs, particularly when I go back to the AcmeVision tab,
// the first thing I see is in the middle of the conversation, and I have to scroll down … let's also
// pay attention at the point we leave it when we switch tabs, and when we restart gateway or restart
// the computer.")
//
// THE VIEWPORT MEMORY OF A TAB. The chat has one `#messages` pane shared by every tab, and until this
// module the follow latch (`chatFollow`, scroll-follow.ts) and the scroll offset were properties of
// that PANE, not of the tab on it. A switch therefore painted the new tab with the old tab's latch
// and the old tab's pixel offset: leave tab A reading history, open tab B, and B opened at A's
// offset — the middle of B's conversation. Nothing was saved across a reload either, so every UI
// rebuild, gateway-pushed bundle and cold boot landed at the bottom of every tab.
//
// Now each tab remembers, when it is left, one of two things:
//   - FOLLOWING — it was parked at the latest row. Coming back shows the latest row, including what
//     arrived meanwhile, and keeps following. Costs nothing to store (absent means default).
//   - READING at an ANCHOR — the first row on screen and how far from the pane's top it sat. Coming
//     back puts that row exactly there.
//
// The anchor names its row twice, because the two names live in different durability tiers
// (ui-persistence.md: a pointer and its target must share a tier):
//   - `unit`: the keyed-render unit (chat-render.ts). Every row has one, live-written bubbles too,
//     but `u:<_uid>` keys are minted per page load, so it is good for a tab switch only.
//   - `ocId`/`ocPart`: the transcript identity (`data-oc-id`, history-reconcile.ts). Survives a
//     reload; rows written live have none until history serves them, so it is the nearest such row.
// Only the transcript half is persisted.
//
// This module is the pure half: what is remembered, how it is encoded, when a missing row is paged
// for and when that search gives up, which tabs the idle memory stub may cut, how a scroll event is
// told apart from our own write, and how late growth is compensated. app.ts owns the DOM.

export interface ViewportAnchor {
  /** Keyed-render unit key (chat-render.ts `unitKeyOf`). In-session only. */
  unit: string | null;
  /** The unit's top edge minus the pane's top edge, px (negative = above the pane top). */
  unitOffset: number;
  /** Transcript identity of the nearest server row (`data-oc-id`). The persisted half. */
  ocId: string | null;
  /** `data-oc-part` of that row: one transcript row can paint several parts. */
  ocPart: string;
  /** That row's top edge minus the pane's top edge, px. */
  ocOffset: number;
}

export interface ViewportMemory {
  /** True: the tab was parked at the latest row and follows it. */
  follow: boolean;
  /** The row to come back to; null whenever `follow` is true. */
  anchor: ViewportAnchor | null;
}

export const FOLLOWING: ViewportMemory = Object.freeze({ follow: true, anchor: null });

/**
 * What a tab remembers when it is left. Reading with no row to come back to is remembered as
 * following: a raw pixel offset means nothing on another tab's content or after a reload.
 */
export function viewportMemory(follow: boolean, anchor: ViewportAnchor | null): ViewportMemory {
  if (follow || !anchor || (!anchor.unit && !anchor.ocId)) {
    return FOLLOWING;
  }
  return { follow: false, anchor };
}

/** The ui-state choice id that persists one tab's memory (ui-persistence.md id registry). */
export function viewportChoiceId(tabId: string): string {
  return `chat:scroll:${tabId}`;
}

/**
 * One tab's memory as a ui-state choice value. Following is "" — ui-state stores the default as an
 * absent key, so a tab parked at the bottom costs zero bytes. A reading memory keeps only the
 * transcript half; one with no transcript row is stored as following, because nothing could find
 * its row after a reload.
 */
export function encodeViewportMemory(m: ViewportMemory): string {
  const a = m.follow ? null : m.anchor;
  if (!a || !a.ocId) {
    return "";
  }
  return JSON.stringify({ v: 1, id: a.ocId, part: a.ocPart, y: Math.round(a.ocOffset) });
}

/** The inverse of encodeViewportMemory. Anything unreadable is following — absent means default. */
export function decodeViewportMemory(raw: string): ViewportMemory {
  if (!raw) {
    return FOLLOWING;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return FOLLOWING;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return FOLLOWING;
  }
  const rec = v as Record<string, unknown>;
  if (
    rec.v !== 1 ||
    typeof rec.id !== "string" ||
    !rec.id ||
    typeof rec.part !== "string" ||
    typeof rec.y !== "number" ||
    !Number.isFinite(rec.y)
  ) {
    return FOLLOWING;
  }
  return {
    follow: false,
    anchor: { unit: null, unitOffset: 0, ocId: rec.id, ocPart: rec.part, ocOffset: rec.y },
  };
}

/** Older pages a restore may read looking for its row (5 × the 100-row page ≈ 600 rows back). */
export const RESTORE_MAX_PAGES = 5;
/** How long a restore may stay pending. Past this the row is given up on and the tab follows. */
export const RESTORE_MAX_AGE_MS = 30_000;

export type RestoreStep = "page-older" | "wait" | "give-up";

/**
 * A remembered row is not on the page (a reload first reads only the last 100 rows): page older
 * rows in until it is, wait while the session has a live writer (loadOlderPage refuses then), and
 * give up — showing the latest row and following — once the transcript has nothing older, or the
 * page or time budget is spent.
 */
export function pendingRestoreStep(p: {
  pagesTried: number;
  ageMs: number;
  olderAvailable: boolean;
  busy: boolean;
}): RestoreStep {
  if (p.ageMs >= RESTORE_MAX_AGE_MS || p.pagesTried >= RESTORE_MAX_PAGES || !p.olderAvailable) {
    return "give-up";
  }
  return p.busy ? "wait" : "page-older";
}

/**
 * The idle background stub (history-paging.ts stubTrimCutoff, ruling R12) keeps only a tab's newest
 * rows. It may cut a tab left following; a tab left READING keeps its page, for the same reason the
 * viewed trim waits while the owner is off the bottom: never under the history he is reading.
 */
export function backgroundStubAllowed(m: ViewportMemory | null | undefined): boolean {
  return !m || m.follow;
}

/** A write's scroll event lands within one frame or two; one older than this is not its echo. */
export const ECHO_WINDOW_MS = 1_000;

/**
 * Is this scroll event the echo of our own write (`setChatScrollTop`)? The value must match AND the
 * write must be recent. Value alone was the rule until 2026-10-02, and it swallowed real gestures:
 * after the last pin, scrolling up and back down to the same unchanged bottom produced an event
 * equal to that pin's value, so the gesture that should re-arm follow was dropped as an echo.
 * The caller also consumes the record on a match — one write, one echo.
 */
export function isProgrammaticEcho(
  scrollTop: number,
  rec: { top: number; at: number } | null,
  now: number,
): boolean {
  return rec !== null && Math.abs(scrollTop - rec.top) <= 1 && now - rec.at <= ECHO_WINDOW_MS;
}

export type GrowthAdjustment = { kind: "pin" } | { kind: "shift"; by: number } | { kind: "none" };

/**
 * Content that grew after the scroll was set — an image that finished loading, a sandboxed frame
 * that reported its height. `#messages` has `overflow-anchor: none`, so the browser compensates for
 * nothing. Following: pin the bottom again. Reading: what must not move is the first row on screen.
 * Measured on the grown element's ROW (its keyed unit), after the growth: if that row lay wholly
 * above the pane before it grew (`unitBottom - growth <= paneTop`), everything on screen sat below
 * it and was pushed down by exactly `growth`, so scroll down by it. A row that straddled the pane top
 * WAS the first row on screen; its top did not move, so nothing is shifted (shifting by the element
 * alone, as the first cut did, pushed a row away by its own image). Rows below move nothing read.
 *
 * Not used while a just-restored row is held (app.ts `heldViewport`): then the remembered row
 * itself is put back, because before its own images load it may not even reach the pane.
 */
export function lateGrowthAdjustment(p: {
  follow: boolean;
  unitTop: number;
  unitBottom: number;
  paneTop: number;
  growth: number;
}): GrowthAdjustment {
  if (p.follow) {
    return { kind: "pin" };
  }
  if (p.growth !== 0 && p.unitTop < p.paneTop && p.unitBottom - p.growth <= p.paneTop) {
    return { kind: "shift", by: p.growth };
  }
  return { kind: "none" };
}
