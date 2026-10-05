// Pure, DOM-free: how a tab's page and its cursor window (history-window.ts) meet a chat.history
// reply. FORK 2026-09-23 (chat.history rehaul, plan task 8,
// docs/superpowers/plans/2026-09-23-chat-history-incremental-rehaul.md).
//
// history-window.ts tracks what a window holds and builds requests; history-reconcile.ts decides
// which rows a reply adds to the page. This module is the glue app.ts would otherwise carry
// untested: which window a request may be built from, and what a reply does to that window.

import {
  DEFAULT_HISTORY_RECONCILE_DEPS,
  historyRowIdentity,
  promptKeysOf,
  watchedRowTest,
  type HistoryReconcileDeps,
} from "./history-reconcile.js";
import {
  applyCursor,
  BG_STUB_ROWS,
  BG_UNLOAD_MS,
  buildOlderRequest,
  buildTailRequest,
  cursorOf,
  emptyWindow,
  WINDOW_MAX_ROWS,
  WINDOW_PAGE,
  type HistoryCursor,
  type HistoryWindow,
} from "./history-window.js";
import { insertRenderedAt, renderOrder, type RenderedAt } from "./msg-order.js";

type Rec = Record<string, unknown>;

function asRecord(m: unknown): Rec | null {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Rec) : null;
}

/** Does the page already hold rows the SERVER wrote (anything with a transcript identity)? */
export function pageHoldsServerRows(
  page: readonly unknown[],
  identityOf: (m: unknown) => string | null = historyRowIdentity,
): boolean {
  return Array.isArray(page) && page.some((m) => identityOf(m) !== null);
}

/**
 * The tail request for a tab, and the window its reply must be folded into.
 *
 * A window only describes rows the page actually shows. A page with no server rows (never loaded,
 * or blanked by /clear, a delete or a re-attach) asks the legacy `{sessionKey, limit}` shape and
 * folds the reply into an empty window, whatever the tab's window still says — otherwise an
 * `afterSeq` delta would be written onto a blank page as if it were the whole transcript.
 */
export function tailRequestForPage(
  sessionKey: string,
  w: HistoryWindow,
  page: readonly unknown[],
): { request: Record<string, unknown>; base: HistoryWindow } {
  if (!pageHoldsServerRows(page)) {
    return { request: { sessionKey, limit: WINDOW_PAGE }, base: emptyWindow() };
  }
  return { request: { ...buildTailRequest(sessionKey, w), limit: TAIL_READ_LIMIT }, base: w };
}

/**
 * FORK 2026-09-23 (fix round 1, ruling R25; review findings I1, I2) — the `limit` of every read of a
 * page that already holds server rows, legacy-shaped or cursor tail: the gateway's hard maximum.
 * Without it the gateway's 200 default answers any longer delta `reset` with only its last rows
 * (ruling R10), and with the legacy 100 a cursor-less gateway (R7) serves only the last 100 — both
 * leave a mid-page hole. Only the first open of an EMPTY page asks WINDOW_PAGE rows.
 */
export const TAIL_READ_LIMIT = 1000;

/** Did this request carry a seq cursor (a shape an old gateway rejects)? */
export function isCursorRequest(request: Record<string, unknown>): boolean {
  return request.afterSeq !== undefined || request.beforeSeq !== undefined;
}

/**
 * FORK 2026-09-24 (final whole-branch review item 4, ruling R33) — a gateway that REJECTS a cursor
 * read (`rejected`: the non-transport failure the history classifier reports) predates cursors — a
 * rollback. Forgetting the window only fixed the NEXT read, so the tab sat in the failed strip until
 * something else asked. The read is re-issued at once, legacy-shaped, for the same page, and folds
 * into an empty window. Null — nothing owed — for any other failure, and for a legacy read, so the
 * re-read never loops.
 */
export function legacyReadAfterRejectedCursor(
  request: Record<string, unknown>,
  rejected: boolean,
  page: readonly unknown[],
): { request: Record<string, unknown>; base: HistoryWindow } | null {
  const sessionKey = request.sessionKey;
  if (!rejected || !isCursorRequest(request) || typeof sessionKey !== "string") {
    return null;
  }
  return tailRequestForPage(sessionKey, emptyWindow(), page);
}

/**
 * May this tail reply be merged into `page`? A DELTA (an `afterSeq` request the server honoured)
 * carries only the rows after the window, so it continues a page that holds server rows and must
 * never be written onto a page that was blanked while the read was in flight — that would show
 * the last few rows as if they were the whole transcript. A reset reply is a whole tail window
 * and fits any page; so does any reply to a legacy-shaped request.
 */
export function replyFitsPage(
  request: Record<string, unknown>,
  reply: unknown,
  page: readonly unknown[],
): boolean {
  if (request.afterSeq === undefined) {
    return true;
  }
  const c = cursorOf(reply);
  if (c !== null && c.reset) {
    return true;
  }
  return pageHoldsServerRows(page);
}

/**
 * Which window a finished tail read folds into. The request was built from `base`; while it was in
 * flight an older-page load may have widened the tab's window backward (same epoch, same lastSeq).
 * Folding into `base` would undo that; folding into `current` keeps it. Any other change (a reset,
 * another session, a read that already moved lastSeq) means `current` no longer describes the page
 * this reply continues, so the reply folds into `base` as requested.
 */
export function windowToFold(base: HistoryWindow, current: HistoryWindow): HistoryWindow {
  return current.epoch === base.epoch &&
    current.lastSeq === base.lastSeq &&
    current.sessionId === base.sessionId
    ? current
    : base;
}

/**
 * Fold a chat.history reply into the window its request was built from.
 *
 * Ruling R7: a reply with no (valid) `cursor` — the gateway before its restart — leaves the window
 * exactly as it was, so an empty window keeps every later request legacy-shaped and "load older"
 * stays unavailable. `cursor` is the cursor that was folded in, or null when none was.
 */
export function windowAfterReply(
  base: HistoryWindow,
  reply: unknown,
  kind: "tail" | "older",
): { window: HistoryWindow; resetPage: boolean; cursor: HistoryCursor | null } {
  const cursor = cursorOf(reply);
  if (cursor === null) {
    return { window: base, resetPage: false, cursor: null };
  }
  const sid = (reply as { sessionId?: unknown }).sessionId;
  const { window, resetPage } = applyCursor(base, cursor, typeof sid === "string" ? sid : "", kind);
  return { window, resetPage, cursor };
}

// ─── Which seq a page row holds, under which epoch ───────────────────────────────────────────────

/** Client stamps: the seq a row had in the reply that last carried it, and that reply's epoch. */
export const HIST_EPOCH_FIELD = "_histEpoch";
export const HIST_SEQ_FIELD = "_histSeq";

/**
 * A row's LOCAL transcript seq as served (`__openclaw.seq`), or null. Imported (claude-cli) rows
 * carry no cursor position — the gateway numbers local rows only (chat-history-cursor.ts
 * readLocalSeq) — and neither do client rows.
 */
export function rowLocalSeq(m: unknown): number | null {
  const meta = asRecord(asRecord(m)?.__openclaw);
  if (meta === null || meta.importedFrom != null) {
    return null;
  }
  const seq = meta.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : null;
}

/** A claude-cli import row (served by chat.history's import merge): it never carries a local seq. */
function isImportRow(m: unknown): boolean {
  return asRecord(asRecord(m)?.__openclaw)?.importedFrom != null;
}

/**
 * Record, on every page row a reply carries, the seq it has under that reply's epoch.
 *
 * A seq names a row only under the epoch it was served in (a rewrite, a branch switch or a
 * gateway restart renumbers or re-keys the transcript), and the page keeps rows across epochs. So
 * the numbers the page is paged and trimmed by are read from these stamps, never from a row's
 * `__openclaw.seq`: a row no reply of the current epoch has carried has no position in it.
 * Mutates page rows (client fields only); returns how many were stamped.
 */
export function stampHistorySeqs(
  page: readonly unknown[],
  incoming: readonly unknown[],
  epoch: string | null,
  identityOf: (m: unknown) => string | null = historyRowIdentity,
): number {
  if (epoch === null || !Array.isArray(page) || !Array.isArray(incoming)) {
    return 0;
  }
  const seqById = new Map<string, number>();
  for (const row of incoming) {
    const seq = rowLocalSeq(row);
    const id = seq === null ? null : identityOf(row);
    if (seq !== null && id !== null) {
      seqById.set(id, seq);
    }
  }
  if (seqById.size === 0) {
    return 0;
  }
  let stamped = 0;
  for (const m of page) {
    const rec = asRecord(m);
    const id = rec === null ? null : identityOf(rec);
    const seq = id === null ? undefined : seqById.get(id);
    if (rec === null || seq === undefined) {
      continue;
    }
    try {
      rec[HIST_EPOCH_FIELD] = epoch;
      rec[HIST_SEQ_FIELD] = seq;
      stamped++;
    } catch {
      /* a frozen row simply has no position: it is never paged from or trimmed */
    }
  }
  return stamped;
}

/** The seq this page row holds under `epoch`, or null when no reply of that epoch carried it. */
export function heldSeq(m: unknown, epoch: string | null): number | null {
  const rec = asRecord(m);
  if (rec === null || epoch === null || rec[HIST_EPOCH_FIELD] !== epoch) {
    return null;
  }
  const seq = rec[HIST_SEQ_FIELD];
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : null;
}

function repliedRows(reply: unknown): unknown[] {
  const rows = asRecord(reply)?.messages;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Fold a MERGED tail reply into the window the read was built from (`into`), and stamp on the page
 * the seq each row the reply carried holds under its epoch. Call after the reply's rows are merged.
 * R7: a reply with no cursor leaves `into` untouched.
 *
 * FORK 2026-09-23 (fix round 1, review finding C1) — when the reply RE-INITIALISES the window (a
 * reset, another session, or the first cursor ever folded into this tab), the window may claim only
 * what the page now holds. The merge skips reply rows older than the page's newest row ("behind")
 * and rows of runs the page watched live, so the reply's own `firstSeq` can name rows that are not
 * on the page; adopting it left a hole that no older page ever filled (probe: page 401..500, reset
 * reply 301..500 → 301..400 never came back). `firstSeq` is therefore the lowest seq from which
 * every local row of the reply, up to its newest, is on the page — never below the reply's own
 * `firstSeq` (ruling R23 may start it above a served row) — and the rows below it are "more before".
 *
 * FORK 2026-09-23 (fix round 2, review finding M-c) — a row the page WATCHED counts as held: the
 * merge skipped it because the page already shows it as live bubbles, and stopping the walk there
 * set the window above the run, so after every restart the next older page re-served rows the page
 * has (a no-op per upward wheel) before it reached anything new.
 */
export function foldTailReply(
  into: HistoryWindow,
  reply: unknown,
  page: readonly unknown[],
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
): HistoryWindow {
  const folded = windowAfterReply(into, reply, "tail");
  const c = folded.cursor;
  if (c === null) {
    return folded.window;
  }
  const rows = repliedRows(reply);
  stampHistorySeqs(page, rows, c.epoch, deps.identityOf);
  if (!folded.resetPage && into.epoch !== null) {
    return folded.window;
  }
  const held = lowestContiguousHeldSeq(page, rows, deps);
  const firstSeq = Math.max(c.firstSeq, held ?? c.lastSeq + 1);
  return {
    ...folded.window,
    firstSeq,
    hasMoreBefore: c.hasMoreBefore || (firstSeq > c.firstSeq && firstSeq > 1),
    // R36: the reply counted the user rows before ITS firstSeq; the window starts later, so the
    // reply's rows in between (which the page does not hold) are before it too.
    userRowsBefore:
      c.userRowsBefore === undefined
        ? undefined
        : c.userRowsBefore + countUserRowsInSeqRange(rows, c.firstSeq, firstSeq, rowLocalSeq),
  };
}

/** A user row, as the turn counter counts them (app.ts currentTurnNumber: `role === "user"`). */
function isUserRow(m: unknown): boolean {
  return asRecord(m)?.role === "user";
}

/** User rows among `rows` whose seq (read by `seqOf`) is in [from, to). */
function countUserRowsInSeqRange(
  rows: readonly unknown[],
  from: number,
  to: number,
  seqOf: (m: unknown) => number | null,
): number {
  let n = 0;
  for (const m of rows) {
    const s = seqOf(m);
    if (s !== null && s >= from && s < to && isUserRow(m)) {
      n++;
    }
  }
  return n;
}

/**
 * FORK 2026-09-24 (final whole-branch review item 6, ruling R36) — how many user rows to add to
 * the page's own count so turns are numbered from the transcript's start: the window's
 * `userRowsBefore`, less the local rows the page itself still holds below `firstSeq` (kept below a
 * trim cut) or under no seq of the window's epoch (older rows above a hole) — the gateway counted
 * those already. 0 when the window has no count (a gateway that predates it): the page's own count,
 * as before. The EEG prompt markers use it too: absolute prompt index = offset + index on the page.
 */
export function userRowOffset(page: readonly unknown[], w: HistoryWindow): number {
  if (w.userRowsBefore === undefined || w.epoch === null) {
    return 0;
  }
  let counted = 0;
  for (const m of page) {
    if (!isUserRow(m) || rowLocalSeq(m) === null || historyRowIdentity(m) === null) {
      continue;
    }
    const s = heldSeq(m, w.epoch);
    if (s === null || s < w.firstSeq) {
      counted++;
    }
  }
  return Math.max(0, w.userRowsBefore - counted);
}

/** The turn number a page shows: userRowOffset plus its own user rows (R36). */
export function turnNumberOf(page: readonly unknown[], w: HistoryWindow): number {
  let n = 0;
  for (const m of page) {
    if (isUserRow(m)) {
      n++;
    }
  }
  return userRowOffset(page, w) + n;
}

/**
 * Walking the reply's local rows from its newest down, the lowest seq reached before the first row
 * the page neither holds (by identity) nor watched live; null when that is already the newest.
 */
function lowestContiguousHeldSeq(
  page: readonly unknown[],
  rows: readonly unknown[],
  deps: HistoryReconcileDeps,
): number | null {
  const onPage = new Set<string>();
  for (const m of page) {
    const id = deps.identityOf(m);
    if (id !== null) {
      onPage.add(id);
    }
  }
  const watched = watchedRowTest(page, deps);
  const seqd: Array<{ seq: number; row: unknown; id: string | null }> = [];
  for (const row of rows) {
    const seq = rowLocalSeq(row);
    if (seq !== null) {
      seqd.push({ seq, row, id: deps.identityOf(row) });
    }
  }
  seqd.sort((a, b) => b.seq - a.seq);
  let held: number | null = null;
  for (const { seq, row, id } of seqd) {
    const onThePage = id !== null && onPage.has(id);
    if (!onThePage && !watched(row)) {
      break;
    }
    held = seq;
  }
  return held;
}

// ─── An older page, written above the page ───────────────────────────────────────────────────────

export type OlderPagePlan = {
  /** New rows in reply order, each group with the spot it renders at. */
  groups: Array<{ rows: unknown[]; at: RenderedAt }>;
  skippedKnown: number;
  /** Of skippedKnown, rows with a local seq: the page already held rows this page reached. */
  skippedKnownLocal: number;
  /** Rows of a run the page watched live: the page already shows them, as live bubbles. */
  skippedWatched: number;
  skippedUnplaceable: number;
};

/**
 * Where the rows of an older page (a `beforeSeq` reply) go on the page.
 *
 * The paper rule, applied upward: rows the page already holds (by identity) are never added again
 * and never moved — they are the ANCHORS. Each run of new rows is written directly above the next
 * anchor the reply lists after it, so an older local row lands between the import rows it was
 * served between (a trim keeps seq-less rows, so those can still be on the page). The run after
 * the last anchor goes above the row the page was paged from (seq `beforeSeq` under `epoch`);
 * failing that, below the last anchor; failing both, above everything. A row with no identity
 * cannot be recognised when the same page is served again, so it is not written (counted).
 *
 * FORK 2026-09-23 (fix round 1, review finding C2) — and, exactly as the tail merge does, a row
 * whose instant falls inside a run the page watched live is skipped: the page already shows it as
 * the live bubbles it was written into, and adding the server copy is the double-answer class.
 */
export function planOlderPage(
  page: readonly unknown[],
  incoming: readonly unknown[],
  epoch: string | null,
  beforeSeq: number,
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
): OlderPagePlan {
  const identityOf = deps.identityOf;
  const plan: OlderPagePlan = {
    groups: [],
    skippedKnown: 0,
    skippedKnownLocal: 0,
    skippedWatched: 0,
    skippedUnplaceable: 0,
  };
  // An older page continues a page of server rows. A page with none was blanked (/clear, a delete)
  // while its window lingered, and the reply may be the transcript the owner just cleared.
  if (!pageHoldsServerRows(page, identityOf)) {
    return plan;
  }
  const watched = watchedRowTest(page, deps);
  const keys = promptKeysOf(page, deps);
  const onPage = new Map<string, unknown>();
  for (const m of page) {
    const id = identityOf(m);
    if (id !== null && !onPage.has(id)) {
      onPage.set(id, m);
    }
  }
  const seen = new Set<string>();
  let pending: unknown[] = [];
  let lastKnown: unknown;
  for (const row of incoming) {
    const id = identityOf(row);
    if (id === null) {
      plan.skippedUnplaceable++;
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const key = deps.promptKeyOf?.(row) ?? null;
    // A prompt the page holds by its key (history-reconcile.ts promptKeyOf) is known, and anchors,
    // like a row held by identity. Not "local": the holder may be the page's own bubble, which
    // carries no seq, so it says nothing about where the server rows on the page begin.
    const known = onPage.get(id) ?? (key !== null ? keys.get(key) : undefined);
    if (known !== undefined) {
      plan.skippedKnown++;
      if (onPage.has(id) && rowLocalSeq(row) !== null) {
        plan.skippedKnownLocal++;
      }
      if (pending.length > 0) {
        plan.groups.push({ rows: pending, at: { before: known } });
        pending = [];
      }
      lastKnown = known;
      continue;
    }
    if (watched(row)) {
      plan.skippedWatched++;
      continue;
    }
    pending.push(row);
    if (key !== null) {
      keys.set(key, row);
    }
  }
  if (pending.length > 0) {
    const pagedFrom = page.find((m) => heldSeq(m, epoch) === beforeSeq);
    const at: RenderedAt =
      pagedFrom !== undefined
        ? { before: pagedFrom }
        : lastKnown !== undefined
          ? { after: lastKnown }
          : "top";
    plan.groups.push({ rows: pending, at });
  }
  plan.groups = slotAroundLooseRows(plan.groups, page, deps);
  return plan;
}

// ─── Reset archives: paging past the start of the live transcript ─────────────────────────────
//
// FORK 2026-10-02 (the architect: "The parallel worker's chat history seems to not be loading") — a session
// reset before every turn (the worker of a master-worker build) keeps its transcript path; each
// reset renames what it held to `<path>.reset.<time>`, and chat.history served only the live file.
// After any reload such a tab showed its current turn and nothing before it. `chat.history
// {resetArchiveBefore: T}` (gateway chat-history-archive.ts) serves the newest archive reset before
// T, so the page pages past the live transcript's start into its archives, one reset at a time,
// each under a "session reset" divider. Paged by TIME: a reset every turn shifts every index while
// the page is open.

//
// FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — the gateway
// pages EVERY earlier transcript of a tab now: the resets of a transcript it left (Main's `/new`
// moved it to a new file), that file itself, and earlier copies (repair backups, compaction
// checkpoints). Copies overlap what the page shows, so the page names its FLOOR — the oldest server
// row it holds — and only strictly older rows come back. The floor is taken when an archive is
// started and kept while that archive is read in pages: its offsets count rows under that floor.

/**
 * Where a tab's paging into reset archives stands: the instant reached (`before`), an archive being
 * read in pages (`current`, its reset instant, with `offset` of its rows already on the page — the
 * worker's first archive spans a day — and the `floor` it was started under), or the transcript's
 * start (`done`).
 */
export type ResetPaging = {
  before: number;
  done: boolean;
  current: number | null;
  offset: number;
  floor?: number | null;
};

export const RESET_PAGING_START: ResetPaging = Object.freeze({
  before: Number.MAX_SAFE_INTEGER,
  done: false,
  current: null,
  offset: 0,
  floor: null,
});

/**
 * The read for the next archive, or null once the transcript's start is reached. `pageFloor` is the
 * oldest server row the page holds now (oldestServerRowTs); an archive being read keeps the floor it
 * was started under.
 */
export function resetArchiveRequest(
  sessionKey: string,
  p: ResetPaging,
  pageFloor: number | null = null,
): Record<string, unknown> | null {
  if (p.done) {
    return null;
  }
  const floor = p.current !== null ? (p.floor ?? null) : pageFloor;
  const floorParam = floor !== null && Number.isFinite(floor) ? { archiveFloor: floor } : {};
  return p.current !== null
    ? {
        sessionKey,
        resetArchiveBefore: p.current + 1,
        archiveOffset: p.offset,
        ...floorParam,
        limit: TAIL_READ_LIMIT,
      }
    : { sessionKey, resetArchiveBefore: p.before, ...floorParam, limit: TAIL_READ_LIMIT };
}

/** The oldest timestamp among the page's server rows; null when it holds none. */
export function oldestServerRowTs(
  page: readonly unknown[],
  identityOf: (m: unknown) => string | null = historyRowIdentity,
): number | null {
  let oldest: number | null = null;
  for (const m of page) {
    if (isResetDivider(m) || identityOf(m) === null) {
      continue;
    }
    const t = asRecord(m)?.timestamp;
    if (typeof t === "number" && Number.isFinite(t) && (oldest === null || t < oldest)) {
      oldest = t;
    }
  }
  return oldest;
}

/** What an archive is: a reset's, a transcript the tab left, or an earlier copy of one. */
export type ResetArchiveKind = "reset" | "earlier" | "copy";

export type ResetArchiveMeta = {
  resetAt: number | null;
  olderCount: number;
  rowsBefore: number;
  kind?: ResetArchiveKind;
};

/** The reply's `archive` block; null when the gateway did not answer an archive read. */
export function archiveOf(reply: unknown): ResetArchiveMeta | null {
  const a = asRecord(asRecord(reply)?.archive);
  if (a === null) {
    return null;
  }
  const { resetAt, olderCount } = a;
  if (typeof olderCount !== "number" || !Number.isFinite(olderCount)) {
    return null;
  }
  // A gateway before archive paging sends no rowsBefore: every archive came whole.
  const rowsBefore =
    typeof a.rowsBefore === "number" && Number.isFinite(a.rowsBefore) ? a.rowsBefore : 0;
  if (resetAt === null) {
    return { resetAt: null, olderCount, rowsBefore };
  }
  // A gateway before 2026-10-03 served reset archives only.
  const kind: ResetArchiveKind = a.kind === "earlier" || a.kind === "copy" ? a.kind : "reset";
  return typeof resetAt === "number" && Number.isFinite(resetAt)
    ? { resetAt, olderCount, rowsBefore, kind }
    : null;
}

/**
 * Paging after an archive reply of `served` rows read under `floorUsed` (the request's
 * archiveFloor): more of the same archive while it has rows before them, under the same floor, then
 * the archive before it, then the transcript's start.
 */
export function nextResetPaging(
  p: ResetPaging,
  a: ResetArchiveMeta,
  served: number,
  floorUsed: number | null = null,
): ResetPaging {
  if (a.resetAt === null) {
    return { before: p.before, done: true, current: null, offset: 0, floor: null };
  }
  if (a.rowsBefore > 0) {
    const offset = (p.current === a.resetAt ? p.offset : 0) + served;
    return { before: a.resetAt, done: false, current: a.resetAt, offset, floor: floorUsed };
  }
  return { before: a.resetAt, done: a.olderCount <= 0, current: null, offset: 0, floor: null };
}

/**
 * The client row that marks an archive on the page: below the archive it closes, labelled by what
 * it was (`kind`). A run boundary.
 */
export function resetDividerRow(
  resetAt: number,
  kind: ResetArchiveKind = "reset",
): Record<string, unknown> {
  return {
    role: "system",
    _resetDivider: true,
    _resetAt: resetAt,
    _resetKind: kind,
    timestamp: resetAt,
    content: [],
  };
}

export function isResetDivider(m: unknown): boolean {
  return asRecord(m)?._resetDivider === true;
}

export type ResetArchivePlan = {
  groups: OlderPagePlan["groups"];
  /** The divider to write, or null when the page already shows this reset's. */
  divider: Record<string, unknown> | null;
  dividerAt: RenderedAt;
  resetAt: number;
  skippedKnown: number;
  skippedWatched: number;
  skippedUnplaceable: number;
};

export type RowsByTimePlan = OlderPagePlan & {
  /** The newest incoming row that is on the page once the plan is applied (held or written). */
  lastOnPage: unknown;
};

/**
 * FORK 2026-10-03 (the architect, 4th report: "In the 'Parallel worker' tab I still cannot see its full
 * history") — where rows the page lacks go, by TIME: each before the first page row (render order)
 * whose instant is later than its own, else after the last. Rows the page holds by identity are
 * skipped, and so are rows inside a run the page watched live (it shows them as live bubbles).
 * Nothing on the page moves. Used for reset archives, which are not always older than the page (a
 * background tab never receives its session's live turns, so turns a session reset before every
 * turn ran while the tab was hidden come back from archives NEWER than rows the page kept), and for
 * the live window under a live run (app.ts loadChat), whose rows can predate the watched run.
 */
export function planRowsByTime(
  page: readonly unknown[],
  incoming: readonly unknown[],
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
): RowsByTimePlan {
  const plan: RowsByTimePlan = {
    groups: [],
    skippedKnown: 0,
    skippedKnownLocal: 0,
    skippedWatched: 0,
    skippedUnplaceable: 0,
    lastOnPage: undefined,
  };
  const onPage = new Map<string, unknown>();
  for (const m of page) {
    const id = deps.identityOf(m);
    if (id !== null && !onPage.has(id)) {
      onPage.set(id, m);
    }
  }
  const watched = watchedRowTest(page, deps);
  const keys = promptKeysOf(page, deps);
  const atFor = timeSlots(page, deps);
  const seen = new Set<string>();
  let lastTime: number | null = null;
  let group: { rows: unknown[]; at: RenderedAt } | null = null;
  for (const row of incoming) {
    const id = deps.identityOf(row);
    if (id === null) {
      plan.skippedUnplaceable++;
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const key = deps.promptKeyOf?.(row) ?? null;
    // Held by identity, or a prompt held by its key (history-reconcile.ts promptKeyOf).
    const held = onPage.get(id) ?? (key !== null ? keys.get(key) : undefined);
    if (held !== undefined) {
      plan.skippedKnown++;
      plan.lastOnPage = held;
      continue;
    }
    if (watched(row)) {
      plan.skippedWatched++;
      continue;
    }
    lastTime = deps.timeOf(row) ?? lastTime;
    const at = atFor(lastTime);
    const sameSlot =
      group !== null &&
      (group.at === at ||
        (typeof group.at === "object" &&
          typeof at === "object" &&
          ("before" in group.at && "before" in at
            ? group.at.before === at.before
            : "after" in group.at && "after" in at && group.at.after === at.after)));
    if (!sameSlot) {
      group = { rows: [], at };
      plan.groups.push(group);
    }
    group!.rows.push(row);
    plan.lastOnPage = row;
    if (key !== null) {
      keys.set(key, row);
    }
  }
  return plan;
}

/**
 * Where a row of instant `t` goes on `page`: before the first page row (render order) whose instant
 * is later, else after the last; a row with no instant goes on top.
 */
function timeSlots(
  page: readonly unknown[],
  deps: HistoryReconcileDeps,
): (t: number | null) => RenderedAt {
  const order = renderOrder(page as unknown[]);
  const times = order.map((m) => looseRowTime(m, deps));
  return (t) => {
    if (t === null) {
      return order.length > 0 ? { before: order[0] } : "top";
    }
    for (let i = 0; i < order.length; i++) {
      const ti = times[i];
      if (ti !== null && ti > t) {
        return { before: order[i] };
      }
    }
    return order.length > 0 ? { after: order[order.length - 1] } : "top";
  };
}

/**
 * Where an archive's rows and its divider go: its rows by time (planRowsByTime) — an archive older
 * than the page lands on top, one the page skipped lands between the rows around it — and the
 * divider directly below the archive's last row on the page; with none, where the reset fell.
 */
export function planResetArchivePage(
  page: readonly unknown[],
  incoming: readonly unknown[],
  resetAt: number,
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
  kind: ResetArchiveKind = "reset",
): ResetArchivePlan {
  const rows = planRowsByTime(page, incoming, deps);
  const dividerAt: RenderedAt =
    rows.lastOnPage !== undefined ? { after: rows.lastOnPage } : timeSlots(page, deps)(resetAt);
  return {
    groups: rows.groups,
    // No rows, no divider: an archive with nothing older than the page marks nothing (2026-10-03).
    divider:
      incoming.length === 0 ||
      page.some((m) => isResetDivider(m) && asRecord(m)?._resetAt === resetAt)
        ? null
        : resetDividerRow(resetAt, kind),
    dividerAt,
    resetAt,
    skippedKnown: rows.skippedKnown,
    skippedWatched: rows.skippedWatched,
    skippedUnplaceable: rows.skippedUnplaceable,
  };
}

/**
 * FORK 2026-10-03 — the reset gap a tab fills when it is entered (app.ts fillResetGap) covers only
 * the span the page already holds: an archive set aside before the page's oldest server row is
 * older history, paged in by scrolling up. A page with no server rows has no span.
 */
export function inResetGap(a: ResetArchiveMeta, pageOldest: number | null): boolean {
  return a.resetAt !== null && pageOldest !== null && a.resetAt >= pageOldest;
}

/**
 * After a gap-fill read that wrote `added` rows: more of the same archive, the next older one, or
 * stop — at the first archive that adds nothing the page lacks (the gap is closed) and at the start.
 */
export function resetGapStep(a: ResetArchiveMeta, added: number): "more" | "next" | "stop" {
  if (a.resetAt === null || added === 0) {
    return "stop";
  }
  if (a.rowsBefore > 0) {
    return "more";
  }
  return a.olderCount > 0 ? "next" : "stop";
}

/**
 * Write a planned archive onto `page` IN PLACE. Rows written are tagged `_resetArchiveAt`, so a memory
 * stub can drop them and paging can bring them back. Returns the rows written, divider excluded.
 */
export function applyResetArchivePage(page: unknown[], plan: ResetArchivePlan): unknown[] {
  const written: unknown[] = [];
  for (const group of plan.groups) {
    for (const row of group.rows) {
      const rec = asRecord(row);
      if (rec !== null) {
        rec._resetArchiveAt = plan.resetAt;
      }
    }
    insertRenderedAt(page, group.rows, group.at);
    written.push(...group.rows);
  }
  if (plan.divider !== null) {
    plan.divider._resetArchiveAt = plan.resetAt;
    insertRenderedAt(page, [plan.divider], plan.dividerAt);
  }
  return written;
}

/**
 * FORK 2026-10-02 (the architect: "When switching from Acmevision to its slave, parallel worker, the chat
 * history does not load at all") — history for a page that holds NO server rows yet but is not
 * blank: the live bubbles of a run it has been watching (a reload while the session was busy), and
 * client notes. The tail merge treats such a page as blank and REPLACES it, which would drop the
 * bubble a live run is writing into, so under a live run it waited for a quiet moment that a session
 * running turn after turn never gives; the tab showed only what streamed in since the reload.
 *
 * Instead the reply is written AROUND the rows the page holds, by time, exactly as an older page is
 * slotted around loose rows (slotAroundLooseRows): each new row before the first page row whose
 * instant is later than its own. Rows inside a run the page watched are skipped (the page shows
 * them as live bubbles); rows with no identity are not written (they could not be recognised when
 * served again). Nothing on the page moves, so the live writer's cursor and bubble are untouched.
 * A page that already holds server rows gets an empty plan: the ordinary merge owns it.
 */
export function planHistoryAroundLooseRows(
  page: readonly unknown[],
  incoming: readonly unknown[],
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
): OlderPagePlan {
  const plan: OlderPagePlan = {
    groups: [],
    skippedKnown: 0,
    skippedKnownLocal: 0,
    skippedWatched: 0,
    skippedUnplaceable: 0,
  };
  if (pageHoldsServerRows(page, deps.identityOf)) {
    return plan;
  }
  const watched = watchedRowTest(page, deps);
  const keys = promptKeysOf(page, deps);
  const seen = new Set<string>();
  const rows: unknown[] = [];
  for (const row of incoming) {
    const id = deps.identityOf(row);
    if (id === null) {
      plan.skippedUnplaceable++;
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    // FORK 2026-10-03 — the page's own prompt bubble IS the served prompt that carries its key
    // (history-reconcile.ts promptKeyOf). A reload under a live run left the bubble as the page's
    // only row, and the served copy, stamped when the turn started, fell outside its ±15 s instant.
    const key = deps.promptKeyOf?.(row) ?? null;
    if (key !== null && keys.has(key)) {
      plan.skippedKnown++;
      continue;
    }
    if (watched(row)) {
      plan.skippedWatched++;
      continue;
    }
    rows.push(row);
    if (key !== null) {
      keys.set(key, row);
    }
  }
  if (rows.length > 0) {
    plan.groups = slotAroundLooseRows([{ rows, at: "top" }], page, deps);
  }
  return plan;
}

/**
 * The instant a page row WITHOUT an identity stands for: a live bubble covers its run from the
 * prompt (`_watchedFrom`); a client note sits at its own time (`_anchorAt`, the phase-timing `ts`),
 * else whatever the reconcile clock reads.
 */
function looseRowTime(m: unknown, deps: HistoryReconcileDeps): number | null {
  const rec = asRecord(m);
  if (rec === null) {
    return null;
  }
  const own = deps.timeOf(m);
  if (deps.isLiveRow(m)) {
    const from = deps.watchedFromOf?.(m) ?? null;
    return from !== null && (own === null || from < own) ? from : own;
  }
  for (const v of [rec._anchorAt, rec.ts]) {
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
  }
  return own;
}

/**
 * FORK 2026-09-23 (fix round 1, review finding C2) — rows WITHOUT an identity (live bubbles of a
 * watched run, client notes such as turn timing) cannot be anchors: a reply never lists them. When
 * one sits in the gap a group of new rows is written into, "directly above the anchor" put every new
 * row BELOW it, so a trim followed by paging back moved a watched run, or a note, above rows that
 * came before it (probe: LIVE×50 | 1..600). Each new row is instead written before the first such
 * row in its gap whose instant is later than its own. Only where the NEW rows go is decided by
 * time; no row already on the page moves.
 *
 * Reads the page in render order (msg-order.ts renderOrder, which stamps unstamped rows exactly as
 * the next repaint would).
 */
function slotAroundLooseRows(
  groups: OlderPagePlan["groups"],
  page: readonly unknown[],
  deps: HistoryReconcileDeps,
): OlderPagePlan["groups"] {
  if (groups.length === 0) {
    return groups;
  }
  const order = renderOrder(page as unknown[]);
  const pos = new Map<unknown, number>();
  order.forEach((m, i) => pos.set(m, i));
  const loose = (m: unknown) => deps.identityOf(m) === null;
  const out: OlderPagePlan["groups"] = [];
  for (const g of groups) {
    const gap: unknown[] = [];
    let tailAt: RenderedAt = g.at;
    if (g.at !== "top" && "before" in g.at) {
      const i0 = pos.get(g.at.before);
      for (let i = (i0 ?? 0) - 1; i0 !== undefined && i >= 0 && loose(order[i]); i--) {
        gap.unshift(order[i]);
      }
    } else {
      const i0 = g.at === "top" ? -1 : pos.get(g.at.after);
      for (let i = (i0 ?? order.length) + 1; i < order.length && loose(order[i]); i++) {
        gap.push(order[i]);
      }
      if (gap.length > 0) {
        tailAt = { after: gap[gap.length - 1] };
      }
    }
    if (gap.length === 0) {
      out.push(g);
      continue;
    }
    const times = gap.map((m) => looseRowTime(m, deps));
    let k = 0;
    let cur: unknown[] = [];
    let curK = -1;
    for (const row of g.rows) {
      const t = deps.timeOf(row);
      if (t !== null) {
        while (k < gap.length && !((times[k] ?? Number.NEGATIVE_INFINITY) > t)) {
          k++;
        }
      }
      if (k !== curK && cur.length > 0) {
        out.push({ rows: cur, at: curK < gap.length ? { before: gap[curK] } : tailAt });
        cur = [];
      }
      curK = k;
      cur.push(row);
    }
    if (cur.length > 0) {
      out.push({ rows: cur, at: curK < gap.length ? { before: gap[curK] } : tailAt });
    }
  }
  return out;
}

/** Write a planned older page onto `page` IN PLACE (msg-order.ts insertRenderedAt, per group). */
export function applyOlderPage(page: unknown[], plan: OlderPagePlan): unknown[] {
  const written: unknown[] = [];
  for (const group of plan.groups) {
    insertRenderedAt(page, group.rows, group.at);
    written.push(...group.rows);
  }
  return written;
}

/**
 * FORK 2026-09-24 (final whole-branch review item 4 / task 8 ledger M1, ruling R33) — after a failed
 * older-page read, no new one for this session for this long: against a rolled-back gateway every
 * scroll gesture near the top otherwise sent another request it rejects.
 */
export const OLDER_PAGE_FAILURE_BACKOFF_MS = 60_000;

/** Is the session still backing off after an older-page read that failed at `failedAt`? */
export function olderPageBackedOff(failedAt: number | undefined, now: number): boolean {
  return failedAt !== undefined && now - failedAt < OLDER_PAGE_FAILURE_BACKOFF_MS;
}

export type OlderReplyOutcome =
  /** No cursor on the reply (R7): nothing written, the window as it was. */
  | { kind: "none"; window: HistoryWindow; written: unknown[] }
  /** The window's epoch is gone: the reply is a tail, not an older page. Window dropped. */
  | { kind: "reset"; window: HistoryWindow; written: unknown[] }
  | {
      kind: "written";
      window: HistoryWindow;
      written: unknown[];
      /** The reply reached local rows the page already held (the far side of a hole). */
      reachedHeld: boolean;
    };

/**
 * An older page's reply, applied to `page` IN PLACE: planned and written above the page, the rows it
 * carried stamped with their seq, and the window widened backward. `w` is the window the request
 * was built from (loadOlderPage checks it is still the tab's window before calling). Shared by
 * app.ts loadOlderPage and the composition tests, so both run the same glue.
 */
export function applyOlderReply(
  page: unknown[],
  w: HistoryWindow,
  reply: unknown,
  deps: HistoryReconcileDeps = DEFAULT_HISTORY_RECONCILE_DEPS,
): OlderReplyOutcome {
  const c = cursorOf(reply);
  if (c === null) {
    return { kind: "none", window: w, written: [] };
  }
  if (c.reset) {
    return { kind: "reset", window: emptyWindow(), written: [] };
  }
  const rows = repliedRows(reply);
  const plan = planOlderPage(page, rows, w.epoch, w.firstSeq, deps);
  const written = applyOlderPage(page, plan);
  stampHistorySeqs(page, rows, c.epoch, deps.identityOf);
  return {
    kind: "written",
    window: windowAfterReply(w, reply, "older").window,
    written,
    reachedHeld: plan.skippedKnownLocal > 0,
  };
}

// ─── Holes a fold leaves (ruling R32) ────────────────────────────────────────────────────────────
//
// FORK 2026-09-24 (final whole-branch review, item 3) — a fold that RE-INITIALISES the window (a
// restart's reset, a delta longer than its limit, a byte cut) claims only the reply's tail
// (foldTailReply), so rows between that tail and the older rows the page still shows are a hole.
// Correct by identity — an older page fills it — but only a scroll to the very top asked for one,
// so the hole sat on screen mid-page. The fold now owes a few older pages from its lower edge.
//
// FORK 2026-09-24 (R32 residual, chat-history rehaul follow-up) — a restart on a tab PINNED to the
// latest row over WINDOW_MAX_ROWS: the reset tail (up to 1000 rows) was trimmed at once to the
// newest 400, the plan was DISCARDED because the trim would drop what a fill brings back, and rows
// of the older epoch — never trimmed, nothing pages them back (R12) — stayed above a hole the trim
// had just widened: a silent jump reachable only from the very top. The plan now WAITS while the
// trim holds it back (holeFillWaitsForTrim) and runs on the owner's first scroll off the bottom; a
// fill page asks back the rows the trim took meanwhile (holeFillPageLimit); and a pinned trim that
// opens such a gap under an older epoch's rows owes a fill of its own (holeFillAfterTrim).

/** Older pages a fold's hole is filled with before it is left to scroll-to-top. */
export const HOLE_FILL_MAX_PAGES = 3;

/**
 * An owed hole fill: under which epoch, how many pages remain, and `floor` — the window's lower
 * edge when it was armed, the top of the hole. A pinned trim can move the window's `firstSeq` above
 * it while the plan waits; the next fill page asks those rows back in the same read.
 */
export type HoleFill = { epoch: string; pagesLeft: number; floor: number };

/**
 * Does the page hold SERVER rows above a gap under the window's lower edge? Either a local row of
 * the window's epoch sits below `firstSeq` with seqs missing in between, or a local row holds no
 * seq under that epoch at all (stamped by an earlier epoch, or read before cursors existed) — its
 * distance is unknown, so it counts as a gap until an older page reaches it. Client rows, live
 * bubbles and imports carry no local seq and never make a hole.
 */
export function pageHoleBelowWindow(
  page: readonly unknown[],
  w: HistoryWindow,
  identityOf: (m: unknown) => string | null = historyRowIdentity,
): boolean {
  if (w.epoch === null || !w.hasMoreBefore || w.firstSeq <= 1) {
    return false;
  }
  let below = Number.NEGATIVE_INFINITY;
  for (const m of page) {
    if (rowLocalSeq(m) === null || identityOf(m) === null) {
      continue;
    }
    const s = heldSeq(m, w.epoch);
    if (s === null) {
      return true;
    }
    if (s < w.firstSeq) {
      below = Math.max(below, s);
    }
  }
  return below !== Number.NEGATIVE_INFINITY && below < w.firstSeq - 1;
}

/**
 * The hole fill a tail fold from `before` to `after` owes, or null. Only a fold that moved the
 * window's LOWER edge (epoch, session or firstSeq) can leave a hole — a plain delta widens the
 * window forward only — so a poll never re-arms a fill that already ran.
 */
export function holeFillAfterFold(
  page: readonly unknown[],
  before: HistoryWindow,
  after: HistoryWindow,
): HoleFill | null {
  if (after.epoch === null) {
    return null;
  }
  const edgeMoved =
    before.epoch !== after.epoch ||
    before.sessionId !== after.sessionId ||
    before.firstSeq !== after.firstSeq;
  return edgeMoved && pageHoleBelowWindow(page, after)
    ? { epoch: after.epoch, pagesLeft: HOLE_FILL_MAX_PAGES, floor: after.firstSeq }
    : null;
}

/**
 * Is `plan` still owed on `page` under window `w`? Not once its pages are spent, the epoch moved on,
 * or the hole closed. Whether it may run NOW is a separate question (holeFillWaitsForTrim): a plan
 * the pinned trim holds back is kept, never discarded.
 */
export function holeFillStillOwed(
  plan: HoleFill,
  page: readonly unknown[],
  w: HistoryWindow,
): boolean {
  return plan.pagesLeft > 0 && w.epoch === plan.epoch && pageHoleBelowWindow(page, w);
}

/**
 * Must an owed fill wait? Yes while `trimFloor` (the viewed tab's pinned-trim cutoff,
 * viewedTrimCutoff; null when it would not trim) is at or above the window's lower edge: every row
 * a fill page brings back is below it, and the next merge's trim would drop it again. It WAITS —
 * app.ts keeps the plan and runs it on the owner's first gesture off the bottom
 * (bindChatFollowListener), or on the next loadChat once he is no longer pinned.
 */
export function holeFillWaitsForTrim(w: HistoryWindow, trimFloor: number | null): boolean {
  return trimFloor !== null && w.firstSeq <= trimFloor;
}

/**
 * How many rows one fill page asks: WINDOW_PAGE into the hole, plus every row between the plan's
 * `floor` and the window's lower edge — rows a pinned trim took while the plan waited, which were
 * on the page moments ago. Without them three 100-row pages never reached the hole: a restart's
 * 1000-row reset tail, trimmed to the newest 400, leaves 600 rows between them. Capped at the
 * gateway's hard maximum (TAIL_READ_LIMIT), so a plan stays at most HOLE_FILL_MAX_PAGES reads.
 */
export function holeFillPageLimit(plan: HoleFill, w: HistoryWindow): number {
  return Math.min(TAIL_READ_LIMIT, WINDOW_PAGE + Math.max(0, w.firstSeq - plan.floor));
}

/** One fill page's request (app.ts loadOlderPage and the composition tests), or null. */
export function holeFillRequest(
  sessionKey: string,
  w: HistoryWindow,
  plan: HoleFill,
): Record<string, unknown> | null {
  const request = buildOlderRequest(sessionKey, w);
  return request === null ? null : { ...request, limit: holeFillPageLimit(plan, w) };
}

/**
 * The plan after the VIEWED tab's pinned trim dropped `removed` from `page` (as it is after the
 * trim) and set window `w`. A trim drops only rows holding a seq under the window's epoch; local
 * rows of an OLDER epoch stay (R12), and they are the page's oldest — so a trim that dropped rows
 * while one of them is still on the page opened a gap right under it, which only a scroll to the
 * very top paged back. That gap is owed a fill from the lowest seq dropped: `owed` (a plan under
 * the same epoch) keeps its pages and only lowers its floor; otherwise a fresh plan. Same-epoch rows
 * kept below the cut (R27, a same-epoch hole's older side) arm nothing: they page as before.
 */
export function holeFillAfterTrim(
  owed: HoleFill | null,
  page: readonly unknown[],
  removed: ReadonlySet<unknown>,
  w: HistoryWindow,
  identityOf: (m: unknown) => string | null = historyRowIdentity,
): HoleFill | null {
  const epoch = w.epoch;
  if (epoch === null) {
    return owed;
  }
  let floor = Number.POSITIVE_INFINITY;
  for (const m of removed) {
    const s = heldSeq(m, epoch);
    if (s !== null) {
      floor = Math.min(floor, s);
    }
  }
  const olderEpochRowStays = page.some(
    (m) => rowLocalSeq(m) !== null && identityOf(m) !== null && heldSeq(m, epoch) === null,
  );
  if (floor === Number.POSITIVE_INFINITY || !olderEpochRowStays) {
    return owed;
  }
  if (owed !== null && owed.epoch === epoch) {
    return floor < owed.floor ? { ...owed, floor } : owed;
  }
  return { epoch, pagesLeft: HOLE_FILL_MAX_PAGES, floor };
}

/** After one fill page: the plan for the next one, or null when the hole closed or it is spent. */
export function nextHoleFill(plan: HoleFill, outcome: OlderReplyOutcome): HoleFill | null {
  if (outcome.kind !== "written" || outcome.reachedHeld) {
    return null;
  }
  const pagesLeft = plan.pagesLeft - 1;
  return pagesLeft > 0 ? { ...plan, pagesLeft } : null;
}

// ─── Memory trim: trimmed from memory ≠ deleted from the page ────────────────────────────────────
//
// Rulings R12 (plan task 8). A page only drops rows it can page back in: rows that hold a seq
// under the window's CURRENT epoch (heldSeq), so a `beforeSeq` read of that epoch serves them
// again. Everything else stays in memory — client notes (client-rows.ts), live-written bubbles,
// imported (claude-cli) rows and rows of an older epoch have no position to page back from.

/**
 * The viewed tab's cutoff: keep rows with seq ≥ lastSeq − WINDOW_MAX_ROWS, once the page holds
 * more than WINDOW_MAX_ROWS rows — and ONLY while the owner is pinned to the latest row. Rows
 * above the viewport he is reading are never taken away. Null = do not trim.
 */
export function viewedTrimCutoff(
  page: readonly unknown[],
  w: HistoryWindow,
  pinnedToLatest: boolean,
): number | null {
  if (!pinnedToLatest || w.epoch === null || page.length <= WINDOW_MAX_ROWS) {
    return null;
  }
  const cutoff = w.lastSeq - WINDOW_MAX_ROWS;
  return cutoff > 1 ? cutoff : null;
}

/** A background tab's stub cutoff: keep the newest BG_STUB_ROWS rows that hold a seq. */
export function stubTrimCutoff(
  page: readonly unknown[],
  w: HistoryWindow,
  keep: number = BG_STUB_ROWS,
): number | null {
  if (w.epoch === null) {
    return null;
  }
  const seqs: number[] = [];
  for (const m of page) {
    const s = heldSeq(m, w.epoch);
    if (s !== null) {
      seqs.push(s);
    }
  }
  if (seqs.length <= keep) {
    return null;
  }
  seqs.sort((a, b) => b - a);
  return seqs[keep - 1];
}

/** Stubbed only after BG_UNLOAD_MS unviewed, and never while a run is live on it. */
export function backgroundTrimDue(now: number, lastViewedAt: number, liveRun: boolean): boolean {
  return !liveRun && now - lastViewedAt > BG_UNLOAD_MS;
}

/**
 * Which rows a trim at `keepFromSeq` drops, and the window afterwards: `hasMoreBefore` true and
 * `firstSeq` one past the highest seq dropped, so the older pages serve exactly what was dropped.
 * Null when nothing would be dropped, or when no row with a current-epoch seq would remain to page
 * back from.
 *
 * FORK 2026-09-23 (fix round 2, ruling R27; review findings N1, N2 — replaces round 1's barrier) —
 * a trim never drops a row the page WATCHED: one inside the watched window of a live-written row
 * (a run the page joined mid-way covers from its prompt; an optimistic prompt covers its own
 * instant). Older pages skip exactly those rows as "watched" (planOlderPage), so a dropped one
 * never came back. Such rows are kept in place; everything else eligible below the cut goes, and
 * nothing else stops the trim (round 1's barrier at the first live row kept everything after the
 * owner's first send). Rows kept below the cut sit on the page as anchors; paged-back rows are
 * placed around them and around live rows by slotAroundLooseRows.
 */
export function planTrim(
  page: readonly unknown[],
  w: HistoryWindow,
  keepFromSeq: number,
  opts: { deps?: HistoryReconcileDeps; seqlessServerRows?: boolean } = {},
): { remove: Set<unknown>; window: HistoryWindow } | null {
  if (w.epoch === null) {
    return null;
  }
  const deps = opts.deps ?? DEFAULT_HISTORY_RECONCILE_DEPS;
  const watched = watchedRowTest(page, deps);
  const remove = new Set<unknown>();
  let highestRemoved = Number.NEGATIVE_INFINITY;
  // The FIRST kept current-epoch row by position (fix round 2, review M-a): array order can differ
  // from seq order (a gap-fill inside the watermark slack appends an older row), and an import
  // positioned among kept rows is not served back by the older pages.
  let firstKeptIndex = -1;
  for (let i = 0; i < page.length; i++) {
    const m = page[i];
    const s = heldSeq(m, w.epoch);
    if (s === null) {
      continue;
    }
    if (s < keepFromSeq && !watched(m)) {
      remove.add(m);
      highestRemoved = Math.max(highestRemoved, s);
    } else if (firstKeptIndex < 0) {
      firstKeptIndex = i;
    }
  }
  if (firstKeptIndex < 0) {
    return null;
  }
  // FORK 2026-09-23 (fix round 1, ruling R26; review finding I3) — the background stub also drops
  // claude-cli IMPORTS sitting above the lowest kept local row: an older page from that row serves
  // them again (its import time range reaches back to the previous local row). Kept, they stood
  // orphaned above the stub's first prompt. Never a row without an identity (client notes, live
  // bubbles), never a watched row (R27), and (round 2, R26 amendment, review M-b) never a local row
  // of an OLDER epoch: it may not exist in the current transcript, so nothing would serve it back.
  if (opts.seqlessServerRows === true) {
    for (let i = 0; i < firstKeptIndex; i++) {
      const m = page[i];
      if (isImportRow(m) && deps.identityOf(m) !== null && !watched(m)) {
        remove.add(m);
      }
    }
  }
  if (remove.size === 0) {
    return null;
  }
  // FORK 2026-09-23 (fix round 1, review finding I1) — never below the window's own firstSeq: rows
  // kept below it sit under a hole the window still owes (a same-epoch reset). And (round 2, R27)
  // one past the highest seq DROPPED, not the lowest kept: a watched row kept below the cut would
  // otherwise make the older pages skip everything dropped above it.
  const firstSeq =
    highestRemoved === Number.NEGATIVE_INFINITY
      ? w.firstSeq
      : Math.max(w.firstSeq, highestRemoved + 1);
  // R36: the user rows now below firstSeq (dropped, or kept below the cut) move into the count.
  const userRowsBefore =
    w.userRowsBefore === undefined
      ? undefined
      : w.userRowsBefore +
        countUserRowsInSeqRange(page, w.firstSeq, firstSeq, (m) => heldSeq(m, w.epoch));
  return { remove, window: { ...w, firstSeq, hasMoreBefore: true, userRowsBefore } };
}

/** Drop `remove` from `page` IN PLACE (other closures hold the array), keeping the order. */
export function removeRowsInPlace(page: unknown[], remove: ReadonlySet<unknown>): void {
  let j = 0;
  for (let i = 0; i < page.length; i++) {
    if (!remove.has(page[i])) {
      page[j++] = page[i];
    }
  }
  page.length = j;
}
