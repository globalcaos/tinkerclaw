// Pure, DOM-free: reconcile a chat.history payload INTO the page without ever rewriting the page.
//
// FORK 2026-09-08 (the architect: "a plain 'use it as paper, write it and never go back' is more useful and
// how a chat is supposed to behave … any funky dedup algorithm or similar should be gone").
//
// THE DEFECT THIS REPLACES. loadChat used to do `messages = incoming` — throw the page away and
// rebuild it from server history on every reconnect, tab switch and turn end (163 history serves
// against 20 sends in one measured day) — and then patch what that destroyed: a "preserve" loop
// for client-only bubbles, a text-keyed "the server also has it" escape, reinsertByTurnAnchor to
// put the survivors back, a whole-array re-normalisation, and three separate text-equality dedup
// guards (2026-06-22, 2026-09-07 render guard, persisted-error notes). Every one of those was
// scaffolding around the rewrite, and the rewrite is what manufactured the months-long "double
// answers": a server thinking row was normalised into a client-flagged copy, the next rewrite
// treated the copy as something the server lacked, preserved it, and normalised the fresh server
// row into another copy. +1 per merge, forever. Verified 2026-09-08 by replaying the real payload.
//
// THE RULE. The page is paper. It is only ever
//   - WRITTEN ONCE, when it is blank (a fresh tab takes the server history as its first page), or
//   - GAP-FILLED, with rows the client provably never saw — by IDENTITY, never by text.
// Nothing on the page is replaced, moved, re-normalised or compared for similarity. A row the
// client watched being written live is already on the page (in the shape it was written), so the
// server's later copy of that same run is recognised by its TIME WINDOW and skipped. A row older
// than everything the page already holds is "going back" and is skipped too. What remains is a
// genuine gap — a turn that happened while this client was not listening — and it is APPENDED, in
// the order you learn about it, which is the only order paper has.

export type HistoryReconcileDeps = {
  /** Stable server identity of a row (`__openclaw.id`, else the CLI import's `externalId`). */
  identityOf: (m: unknown) => string | null;
  /** Best-known instant of a row in ms, or null. */
  timeOf: (m: unknown) => number | null;
  /** A row this client wrote itself while watching a run (streamed bubble, optimistic prompt). */
  isLiveRow: (m: unknown) => boolean;
  /** The run a live row belongs to; live rows sharing a run form one watched window. */
  liveRunOf: (m: unknown) => string | null;
  /**
   * FORK 2026-09-23 — where a live row's run is covered FROM, when that is earlier than the row
   * itself. The live stream is cumulative, so a page that joined a run mid-way still shows the run
   * from its prompt on: the start as history rows, the rest continued by the live writer
   * (live-continuation.ts). Without this the window began at the first live bubble, and the run's
   * history rows from between the page's last history read and that bubble were appended again by
   * the next gap-fill — a second copy of text the live bubble already shows. Optional: absent
   * means "the row's own time", exactly the old rule.
   */
  watchedFromOf?: (m: unknown) => number | null;
  /**
   * FORK 2026-10-03 — until when a live row's text was WRITTEN, when that is later than the row's own
   * time. A row's time is when it OPENED (`_bubbleStartedAt`), but the server stamps a claude-cli
   * import row when its block FINISHED, so an answer that streamed for longer than the slack fell
   * out of its own run's window and the next gap-fill appended the served copy under the live one
   * (bug-log [chat-divergence] cause 8, caught on a page 2026-10-02 22:52).
   *
   * Review round 1 (same day) fixed what this reads: the bubble's LAST WRITE, and only for a bubble
   * whose segment is CLOSED (no longer `_temporary`). Not the time something promoted it: a Stop
   * promotes every leftover temp (an hour-old frozen partial would cover the hour), and the first
   * final promotes a narration whose run's answer came only with the second final (a page that
   * missed that one would never be given the answer). Not an open temp's last write either: a tab
   * left mid-answer stopped watching there, and covering the served answer would hide its rest.
   * Applied to every served row except a prompt someone typed, which is never a copy of what this
   * page wrote (`isTypedPrompt`). Optional: absent means "the row's own time", the old rule.
   */
  watchedToOf?: (m: unknown) => number | null;
  /**
   * FORK 2026-10-03 — the PROMPT KEY a row carries (`historyPromptKey`): a served user row's
   * `idempotencyKey`, or the `_clientMsgId` of the page's own bubble, which send() hands chat.send
   * as that same key. A served prompt whose key a page row already carries IS that row's prompt:
   * known, exactly as a shared `identityOf` is, never by text. Without it the served copy of a
   * prompt the page drew itself was a stranger once it fell outside the bubble's ±15 s instant
   * (46% of prompts start more than 15 s after the send), and was written beside the bubble.
   * Optional: absent means identity by `identityOf` alone, the old rule.
   */
  promptKeyOf?: (m: unknown) => string | null;
};

export type HistoryReconcileResult = {
  mode: "fresh" | "gapfill";
  /** Rows to append to the page, in incoming order. Empty on a fresh page (the page IS incoming). */
  added: unknown[];
  skippedKnown: number;
  skippedWatched: number;
  skippedBehind: number;
  skippedUnplaceable: number;
};

/** Clock slack around a watched run: server timestamps and the client's arrival clock differ by
 *  transport latency, and a final's `timestamp` is stamped a moment after its last delta. */
export const WATCHED_WINDOW_SLACK_MS = 15_000;

/** `to` ends where the run's newest live row OPENED; `toWritten` where its closed rows were last
 *  WRITTEN (`watchedToOf`), never earlier than `to`. */
type Window = { from: number; to: number; toWritten: number };

function watchedWindows(page: readonly unknown[], deps: HistoryReconcileDeps): Window[] {
  const byRun = new Map<string, Window>();
  const instants: Window[] = [];
  for (const m of page) {
    if (!deps.isLiveRow(m)) {
      continue;
    }
    const t = deps.timeOf(m);
    if (t === null) {
      continue;
    }
    const run = deps.liveRunOf(m);
    if (run === null) {
      // A live row with no run (an optimistic prompt) is its own instant.
      // FORK 2026-09-23 (chat.history rehaul, plan task 8 fix round 3, ruling R28) — EACH one. They
      // used to be folded into ONE window from the earliest send to the latest, so after two sends
      // every row between them read as "watched": the tail merge dropped a turn that arrived from
      // elsewhere in between (a cron, another device, a reconnect), no trim could free those rows,
      // and a second send retroactively hid rows an earlier trim had dropped from the older pages.
      // A run the client watched is covered by its own run window, never by this span.
      instants.push({ from: t, to: t, toWritten: t });
      continue;
    }
    const covered = deps.watchedFromOf?.(m) ?? null;
    const from = covered !== null && covered < t ? covered : t;
    const written = deps.watchedToOf?.(m) ?? null;
    const toWritten = written !== null && written > t ? written : t;
    const w = byRun.get(run);
    if (w === undefined) {
      byRun.set(run, { from, to: t, toWritten });
    } else {
      w.from = Math.min(w.from, from);
      w.to = Math.max(w.to, t);
      w.toWritten = Math.max(w.toWritten, toWritten);
    }
  }
  const out = [...byRun.values(), ...instants];
  return out.map((w) => ({
    from: w.from - WATCHED_WINDOW_SLACK_MS,
    to: w.to + WATCHED_WINDOW_SLACK_MS,
    toWritten: Math.max(w.to, w.toWritten) + WATCHED_WINDOW_SLACK_MS,
  }));
}

/** A served row someone TYPED (a user row with no tool result): never a copy of a bubble this page
 *  wrote, so it is tested against the windows without the last-write extension. */
function isTypedPrompt(row: unknown): boolean {
  const rec = asRecord(row);
  if (rec === null || String(rec.role ?? "").toLowerCase() !== "user") {
    return false;
  }
  return !(
    Array.isArray(rec.content) &&
    (rec.content as unknown[]).some((b) => asRecord(b)?.type === "tool_result")
  );
}

function inAnyWindow(t: number, windows: readonly Window[], typedPrompt = false): boolean {
  for (const w of windows) {
    if (t >= w.from && t <= (typedPrompt ? w.to : w.toWritten)) {
      return true;
    }
  }
  return false;
}

/**
 * FORK 2026-09-23 (chat.history rehaul, plan task 8 fix round 1, review finding C2) — the same
 * watched-window rule `reconcileHistoryIntoPage` applies, for a caller that writes rows somewhere
 * other than the tail (an older page loaded on scroll): true when a row's instant falls inside a run
 * this page watched being written live, i.e. the page already shows that row's content.
 */
export function watchedRowTest(
  page: readonly unknown[],
  deps: HistoryReconcileDeps,
): (row: unknown) => boolean {
  const windows = watchedWindows(page, deps);
  return (row) => {
    const t = deps.timeOf(row);
    return t !== null && inAnyWindow(t, windows, isTypedPrompt(row));
  };
}

/**
 * Decide what a history payload adds to the page. Never mutates either argument.
 */
export function reconcileHistoryIntoPage(
  page: readonly unknown[],
  incoming: readonly unknown[],
  deps: HistoryReconcileDeps,
): HistoryReconcileResult {
  const result: HistoryReconcileResult = {
    mode: "gapfill",
    added: [],
    skippedKnown: 0,
    skippedWatched: 0,
    skippedBehind: 0,
    skippedUnplaceable: 0,
  };
  // A page containing only client-side rows has not loaded server paper yet. This happens when
  // an optimistic prompt is restored before the first chat.history response: treating that one
  // row as an established page makes the watermark logic reject the entire older transcript as
  // "behind", leaving the tab with only the newest prompt. The caller restores client-only rows
  // after writing the fresh server page, so no local bubble is lost here.
  if (!Array.isArray(page) || !page.some((m) => deps.identityOf(m) !== null)) {
    result.mode = "fresh";
    return result;
  }

  const known = new Set<string>();
  // The newest instant the page already holds from the SERVER. Anything the server sends that is
  // older than this and unknown to the page is history the page chose not to show (a trimmed
  // window, a filtered row) — showing it now would be going back.
  let watermark = Number.NEGATIVE_INFINITY;
  for (const m of page) {
    const id = deps.identityOf(m);
    if (id !== null) {
      known.add(id);
      const t = deps.timeOf(m);
      if (t !== null && t > watermark) {
        watermark = t;
      }
    }
  }
  const windows = watchedWindows(page, deps);
  const keys = promptKeysOf(page, deps);

  for (const row of incoming) {
    const id = deps.identityOf(row);
    if (id !== null && known.has(id)) {
      result.skippedKnown++;
      continue;
    }
    const key = deps.promptKeyOf?.(row) ?? null;
    if (key !== null && keys.has(key)) {
      result.skippedKnown++;
      continue;
    }
    const t = deps.timeOf(row);
    if (t === null) {
      // No identity match and no instant: it cannot be placed on paper honestly. Declining is the
      // 2026-07-28 invariant ("never overwrite good content with nothing") applied to an addition.
      result.skippedUnplaceable++;
      continue;
    }
    if (inAnyWindow(t, windows, isTypedPrompt(row))) {
      result.skippedWatched++;
      continue;
    }
    if (t < watermark - WATCHED_WINDOW_SLACK_MS) {
      result.skippedBehind++;
      continue;
    }
    result.added.push(row);
    if (key !== null) {
      keys.set(key, row);
    }
  }
  return result;
}

/**
 * FORK 2026-10-03 — the prompt keys the page holds (`promptKeyOf`), each with the first page row
 * that holds it, so a planner can anchor on that row as it would on a row known by identity.
 */
export function promptKeysOf(
  page: readonly unknown[],
  deps: HistoryReconcileDeps,
): Map<string, unknown> {
  const keys = new Map<string, unknown>();
  if (deps.promptKeyOf === undefined) {
    return keys;
  }
  for (const m of page) {
    const k = deps.promptKeyOf(m);
    if (k !== null && !keys.has(k)) {
      keys.set(k, m);
    }
  }
  return keys;
}

// ─── Default deps, shared by app.ts and the tests so the two cannot drift ───────────────────────

function asRecord(m: unknown): Record<string, unknown> | null {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v) {
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

/** `__openclaw.id` (a local transcript entry) or `__openclaw.externalId` (a claude-cli import);
 *  both stable across serves, unlike `seq`, which is a per-serve ordinal that moves as the window
 *  slides.
 *
 *  FORK 2026-09-08 (the ClawHub tab still doubled after the paper rule landed): an import row
 *  (cli-session-history.claude.ts) has NO `__openclaw.id` — its identity is the CLI transcript's
 *  uuid, written as `__openclaw.externalId`, and this reader looked for a top-level `externalId`
 *  the server never sends. 387 of 1,000 served rows in that session therefore had no identity: a
 *  cc-bridge turn that was the newest thing on the page was re-appended by every history serve
 *  until a later local row moved the watermark past it (3 copies of one answer, a static
 *  mid-page block, a clean tail). The top-level field is kept as a fallback only. */
export function historyRowIdentity(m: unknown): string | null {
  const rec = asRecord(m);
  if (rec === null) {
    return null;
  }
  const oc = asRecord(rec.__openclaw);
  const id = oc?.id;
  if (typeof id === "string" && id.length > 0) {
    return `oc:${id}`;
  }
  const ext = oc?.externalId ?? rec.externalId;
  if (typeof ext === "string" && ext.length > 0) {
    return `ext:${ext}`;
  }
  return null;
}

/** Server timestamp first (it is the row's own moment), then the client's own stamps for rows the
 *  client wrote: the prompt's send time, the bubble's start/end, and finally its arrival. */
export function historyRowTime(m: unknown): number | null {
  const rec = asRecord(m);
  if (rec === null) {
    return null;
  }
  return (
    toMs(rec.timestamp) ??
    toMs(rec.createdAtMs) ??
    toMs(rec._promptStartedAt) ??
    toMs(rec._bubbleStartedAt) ??
    toMs(rec._bubbleEndedAt) ??
    toMs(rec._arrivedAt)
  );
}

/** Rows the send/stream path wrote: they carry a run stamp or a client message id and no server
 *  identity. Client-only NOTES (warnings, phase timings) are not live rows — they are not copies
 *  of anything the server will send, so they must not widen a watched window. */
export function isLiveClientRow(m: unknown): boolean {
  const rec = asRecord(m);
  if (rec === null || historyRowIdentity(m) !== null) {
    return false;
  }
  const role = String(rec.role ?? "").toLowerCase();
  if (role !== "user" && role !== "assistant") {
    return false;
  }
  return (
    (typeof rec._runId === "string" && rec._runId.length > 0) ||
    (typeof rec._reasoningRunId === "string" && rec._reasoningRunId.length > 0) ||
    (typeof rec._clientMsgId === "string" && rec._clientMsgId.length > 0) ||
    typeof rec._bubbleStartedAt === "number"
  );
}

export function liveClientRowRun(m: unknown): string | null {
  const rec = asRecord(m);
  if (rec === null) {
    return null;
  }
  const r = rec._runId ?? rec._reasoningRunId;
  return typeof r === "string" && r.length > 0 ? r : null;
}

/** `_watchedFrom`, stamped by the live writer on the bubbles a run's text and thinking open: the
 *  run's prompt time. For a run that took over a turn a gateway restart froze, that turn's prompt
 *  or start (live-continuation.ts resumedRunWatchedFrom): its replay re-sends the turn from the
 *  first byte. */
export function liveClientRowWatchedFrom(m: unknown): number | null {
  const rec = asRecord(m);
  return rec === null ? null : toMs(rec._watchedFrom);
}

/** `_lastWriteAt`, stamped by the live writers each time a bubble's text grows, for a bubble whose
 *  segment is closed (not `_temporary`): until when the page watched what that row shows
 *  (`watchedToOf`). Null for a row still open, or frozen open when the page stopped watching. */
export function liveClientRowWatchedTo(m: unknown): number | null {
  const rec = asRecord(m);
  if (rec === null || rec._temporary === true) {
    return null;
  }
  return toMs(rec._lastWriteAt);
}

/** FORK 2026-10-03 — a user row's prompt key: the served `idempotencyKey`, else the `_clientMsgId`
 *  of the page's own bubble (send() mints one uuid for both). Null for every other role, so no
 *  answer is ever matched this way, and `supersededIdempotencyKeys` is never read: it names OTHER
 *  prompts, orphaned sends the outbox settles with its own key-and-text rule. */
export function historyPromptKey(m: unknown): string | null {
  const rec = asRecord(m);
  if (rec === null || String(rec.role ?? "").toLowerCase() !== "user") {
    return null;
  }
  for (const k of [rec.idempotencyKey, rec._clientMsgId]) {
    if (typeof k === "string" && k.length > 0) {
      return k;
    }
  }
  return null;
}

export const DEFAULT_HISTORY_RECONCILE_DEPS: HistoryReconcileDeps = {
  identityOf: historyRowIdentity,
  timeOf: historyRowTime,
  isLiveRow: isLiveClientRow,
  liveRunOf: liveClientRowRun,
  watchedFromOf: liveClientRowWatchedFrom,
  watchedToOf: liveClientRowWatchedTo,
  promptKeyOf: historyPromptKey,
};
