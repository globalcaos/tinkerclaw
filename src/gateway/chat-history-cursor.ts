import { emitEvent } from "../infra/events/emit.js";
import { isShownHistoryUserRow } from "./chat-display-projection.js";
import {
  mergeImportedChatHistoryMessages,
  resolveEarliestLocalTimestamp,
} from "./cli-session-history.merge.js";
import type { ChatHistoryCursor } from "./protocol/index.js";

/**
 * FORK 2026-09-23 (chat.history rehaul, plan task 5) — seq cursors for chat.history.
 *
 * Local transcript rows carry `__openclaw.seq`, a 1-based counter along the served branch,
 * numbered under an epoch that changes on any rewrite, rename or branch switch (TranscriptIndex).
 * A client holding rows up to seq N under epoch E asks `afterSeq: N, epoch: E` and gets only the
 * rows after N; `beforeSeq: M` pages the `limit` rows before M. The PLANNING is pure: it picks the
 * local rows that go into the import merge and the projection, bounds the imported rows to the
 * same window, and says what the reply's `cursor` covers. The handler (server-methods/chat.ts)
 * does the reading, merging and projecting.
 *
 * FORK 2026-09-25 (logging.md §9 step 8) — the module ALSO keeps the `history.minute` rollup
 * (§4.4), which is why it is no longer side-effect free. It is kept here rather than in the
 * handler because the reset REASON exists only here: a reset was one boolean, which is why "why
 * did this tab refetch everything" had no answer. The reasons are the closed enum below; they
 * travel in the rollup's label, never in the plan object (whose shape is pinned by
 * chat-history-cursor.test.ts and read by the handler) and never on the wire cursor. Cost per
 * poll: one Date.now(), one Map get and three integer adds (L3).
 */

/**
 * Why a cursor request could not be honoured and the client was served a fresh window instead.
 * logging.md §4.4: seven reasons collapsed into one boolean is the defect this enum removes.
 * Emitted as the `history.minute` label `reset.<reason>`.
 */
export type ChatHistoryResetReason =
  /** The transcript has no epoch at all (flat or legacy-loaded): no identity to match (R22). */
  | "epoch_null"
  /** The client sent no epoch, or one this transcript no longer has (R22). */
  | "epoch_mismatch"
  /** `afterSeq` names a row this branch does not hold. */
  | "anchor_missing"
  /** The cursor points past the transcript's last row. */
  | "past_end"
  /** More new rows than one window: served whole, never as a delta with its middle dropped (R10). */
  | "over_window"
  /** The byte caps cut the oldest rows of a delta, so it no longer joins up with `afterSeq` (R10). */
  | "byte_cap"
  /** `beforeSeq` names neither a held row nor one past the end. */
  | "before_anchor_missing";

export type ChatHistoryCursorRequest = { afterSeq?: number; beforeSeq?: number; epoch?: string };

// ─── history.minute (logging.md §4.4) ───────────────────────────────────────

/** logging.md §4.4: one `history.minute` row per outcome per 60 s window. */
const HISTORY_ROLLUP_WINDOW_MS = 60_000;

type HistoryOutcomeAgg = { calls: number; rows: number; totalMs: number; maxMs: number };

/** Bounded by the closed outcome set: tail, delta, before, and one bucket per reset reason. */
const historyWindow = new Map<string, HistoryOutcomeAgg>();
/**
 * The window's start, ALIGNED TO THE MINUTE GRID. A lazily-closed window that simply started at
 * the first event would let one call at T0 and one at T0+10 min share a row stamped T0, and a
 * consumer reading a `rollup` named `.minute` would over-report that method tenfold — worst
 * exactly for the quiet producers a rollup is least able to speak for. On the grid, a row stamped
 * at minute M can only hold events from minute M, because an event in a later minute closes it
 * first. An idle minute produces NO row, which is the honest reading of "nothing happened".
 */
let historyWindowStartMs = 0;
/**
 * The outcome and start time of the call whose plan was made most recently. planChatHistoryWindow
 * and buildChatHistoryCursor are the two ends of ONE handler invocation (server-methods/chat.ts,
 * the only call sites), and the window advances ONLY in noteHistoryCall — so the cursor half of a
 * request always lands in the bucket its own plan opened. Cleared when the pair closes, so a
 * cursor built without a plan of ours adds nothing to any bucket.
 */
let pendingOutcome: string | null = null;
let pendingStartedMs = 0;

function historyMinuteSlot(nowMs: number): number {
  return Math.floor(nowMs / HISTORY_ROLLUP_WINDOW_MS) * HISTORY_ROLLUP_WINDOW_MS;
}

function historyBucket(outcome: string): HistoryOutcomeAgg {
  let agg = historyWindow.get(outcome);
  if (agg === undefined) {
    agg = { calls: 0, rows: 0, totalMs: 0, maxMs: 0 };
    historyWindow.set(outcome, agg);
  }
  return agg;
}

/**
 * Emit the open window's rows and open the next. Exported so the gateway's close prelude (and a
 * test) can close the last window deterministically — without that call the final minute before a
 * restart is lost, which is the minute an incident is usually in. OWED: the wiring itself lives in
 * server.impl.ts, which this unit does not own.
 */
export function flushChatHistoryRollup(nowMs: number = Date.now()): void {
  if (historyWindow.size > 0) {
    const tsMs = historyWindowStartMs;
    for (const [outcome, agg] of historyWindow) {
      // A bucket emptied by the byte-cap retag below is not a row; it is an absence.
      if (agg.calls === 0 && agg.rows === 0) {
        continue;
      }
      emitEvent("history.minute", {
        tsMs,
        label: outcome,
        n1: agg.calls,
        n2: agg.rows,
        // n3 (bytes_served) is the HANDLER's to supply: the byte caps live in
        // server-methods/chat.ts, which this unit does not own, and serialising every served row
        // here to measure them would be exactly the per-poll cost L3 forbids. Left NULL, not
        // guessed — an honest gap is queryable, a fabricated number is not.
        n4: agg.totalMs,
        fields: { max_ms: agg.maxMs },
      });
    }
    historyWindow.clear();
  }
  historyWindowStartMs = historyMinuteSlot(nowMs);
}

function noteHistoryCall(outcome: string, nowMs: number): void {
  const slot = historyMinuteSlot(nowMs);
  if (historyWindowStartMs === 0) {
    historyWindowStartMs = slot;
  } else if (slot !== historyWindowStartMs) {
    flushChatHistoryRollup(nowMs);
  }
  historyBucket(outcome).calls += 1;
  pendingOutcome = outcome;
  pendingStartedMs = nowMs;
}

/**
 * Close the pair opened by noteHistoryCall: the rows this reply serves, and the milliseconds the
 * handler spent between the plan and the cursor — the import merge, the projection and the byte
 * caps, which is the work the 2026-09-23 main-thread stall was made of. `byteCapReset` is ruling
 * R10's reset, the one outcome only buildChatHistoryCursor can know: the call is MOVED out of
 * `delta` rather than counted in both.
 */
function noteHistoryServed(rows: number, byteCapReset: boolean, nowMs: number): void {
  const opened = pendingOutcome;
  pendingOutcome = null;
  if (opened === null) {
    return;
  }
  let outcome = opened;
  if (byteCapReset && outcome === "delta") {
    const from = historyWindow.get("delta");
    if (from !== undefined && from.calls > 0) {
      from.calls -= 1;
    }
    outcome = "reset.byte_cap";
    historyBucket(outcome).calls += 1;
  }
  const agg = historyBucket(outcome);
  agg.rows += rows;
  const ms = Math.max(0, nowMs - pendingStartedMs);
  agg.totalMs += ms;
  if (ms > agg.maxMs) {
    agg.maxMs = ms;
  }
}

/** Test hook: drop the open window WITHOUT emitting, so suites do not leak counts into each other. */
export function __resetChatHistoryRollupForTest(): void {
  historyWindow.clear();
  historyWindowStartMs = 0;
  pendingOutcome = null;
  pendingStartedMs = 0;
}

export type ChatHistoryWindowPlan =
  /** The legacy window. `reset` = a cursor request this server could not honour. */
  | { kind: "tail"; reset: boolean }
  | {
      kind: "after";
      afterSeq: number;
      /** Rows after `afterSeq`, plus every stranded (seq-less) local row. */
      local: unknown[];
      /** Imported rows older than this are not part of the delta. */
      importFromTs: number;
      /** The transcript's last seq. */
      lastSeq: number;
    }
  | {
      kind: "before";
      local: unknown[];
      /**
       * Imported rows are served when importFromTs <= ts <= importToTs. Inclusive at both ends:
       * an import tied in time with a boundary row is served by two pages rather than by none.
       */
      importFromTs: number;
      importToTs: number;
      /** The seq range of `local`; both 0 for an empty page. */
      firstSeq: number;
      lastSeq: number;
    };

const RESET: ChatHistoryWindowPlan = { kind: "tail", reset: true };

/** A LOCAL row's seq; undefined for imported rows, stranded prompts and anything unnumbered. */
function readLocalSeq(message: unknown): number | undefined {
  const meta = readMeta(message);
  if (!meta || meta.importedFrom != null) {
    return undefined;
  }
  const seq = meta.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

function readMeta(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
}

function isImportedRow(message: unknown): boolean {
  return readMeta(message)?.importedFrom != null;
}

/** Epoch ms, accepting the ISO-string form some stores keep (as the import merge's sort does). */
function rowTimestampMs(message: unknown): number | undefined {
  const ts = (message as { timestamp?: unknown } | null)?.timestamp;
  if (typeof ts === "number") {
    return Number.isFinite(ts) ? ts : undefined;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function planChatHistoryWindow(params: {
  /** Every local row of the transcript, as readSessionMessagesWithCursor serves them. */
  local: readonly unknown[];
  serverEpoch: string | null;
  request: ChatHistoryCursorRequest;
  /** The effective window size: the `limit` param, else the handler's default. */
  limit: number;
}): ChatHistoryWindowPlan {
  const { afterSeq, beforeSeq, epoch } = params.request;
  const nowMs = Date.now();
  if (afterSeq === undefined && beforeSeq === undefined) {
    noteHistoryCall("tail", nowMs);
    return { kind: "tail", reset: false };
  }
  // Ruling R22: seq numbers name the same rows only under the same epoch. A null server epoch
  // (flat or legacy-loaded transcript) has no identity to match, so it always resets. The two
  // halves are ONE predicate for the client and two different questions for the operator ("this
  // transcript can never serve a delta" against "this tab is holding a stale epoch"), so they are
  // counted apart (§4.4). The served plan is byte-identical either way.
  if (params.serverEpoch === null) {
    noteHistoryCall("reset.epoch_null", nowMs);
    return RESET;
  }
  if (epoch === undefined || epoch !== params.serverEpoch) {
    noteHistoryCall("reset.epoch_mismatch", nowMs);
    return RESET;
  }
  const planned =
    afterSeq !== undefined
      ? planAfter(params.local, afterSeq, params.limit)
      : planBefore(params.local, beforeSeq as number, params.limit);
  noteHistoryCall(
    planned.reason === null
      ? afterSeq !== undefined
        ? "delta"
        : "before"
      : `reset.${planned.reason}`,
    nowMs,
  );
  return planned.plan;
}

function planAfter(
  local: readonly unknown[],
  afterSeq: number,
  limit: number,
): { plan: ChatHistoryWindowPlan; reason: ChatHistoryResetReason | null } {
  const rows: unknown[] = [];
  let lastSeq = 0;
  let anchorFound = afterSeq === 0;
  let importFromTs = Number.NEGATIVE_INFINITY;
  for (const message of local) {
    const seq = readLocalSeq(message);
    if (seq === undefined) {
      // A stranded prompt (prompt-key-marker.ts) is seq-less and placed by its SEND time, so a
      // concurrent append can strand one after the client's last read yet put it before row
      // afterSeq. Its idempotency key is what retires the prompt from the client's outbox, so
      // every delta carries all of them; the client merges rows by identity.
      rows.push(message);
      continue;
    }
    lastSeq = Math.max(lastSeq, seq);
    if (seq === afterSeq) {
      anchorFound = true;
      importFromTs = rowTimestampMs(message) ?? Number.NEGATIVE_INFINITY;
    } else if (seq > afterSeq) {
      rows.push(message);
    }
  }
  // A cursor past the end, or naming a row this branch lacks, cannot come from this epoch. One
  // predicate before, two reset reasons now (§4.4): a missing anchor is a branch switch, a
  // past-the-end cursor is a truncated transcript, and they have different fixes. `past_end` is a
  // strict subset of anchor-missing here (`anchorFound` implies a row with that seq exists, hence
  // lastSeq >= afterSeq), so it is tested second and stays a defensive label rather than dead code.
  if (!anchorFound) {
    return { plan: RESET, reason: "anchor_missing" };
  }
  if (afterSeq > lastSeq) {
    return { plan: RESET, reason: "past_end" };
  }
  // Ruling R10: more new rows than one window is served as a fresh window, never a delta with
  // its middle dropped.
  if (lastSeq - afterSeq > limit) {
    return { plan: RESET, reason: "over_window" };
  }
  return {
    plan: { kind: "after" as const, afterSeq, local: rows, importFromTs, lastSeq },
    reason: null,
  };
}

function planBefore(
  local: readonly unknown[],
  beforeSeq: number,
  limit: number,
): { plan: ChatHistoryWindowPlan; reason: ChatHistoryResetReason | null } {
  let anchorIndex = -1;
  let transcriptLastSeq = 0;
  for (let i = 0; i < local.length; i++) {
    const seq = readLocalSeq(local[i]);
    if (seq === undefined) {
      continue;
    }
    transcriptLastSeq = Math.max(transcriptLastSeq, seq);
    if (seq === beforeSeq) {
      anchorIndex = i;
    }
  }
  if (anchorIndex < 0) {
    // One past the end pages the tail; anything further cannot come from this epoch. Past the end
    // and inside it are different failures (§4.4) — a client one window ahead of the transcript
    // against an anchor this branch no longer holds — so the single predicate is split into two
    // reasons whose union is exactly the original one.
    if (beforeSeq > transcriptLastSeq + 1) {
      return { plan: RESET, reason: "past_end" };
    }
    if (beforeSeq !== transcriptLastSeq + 1) {
      return { plan: RESET, reason: "before_anchor_missing" };
    }
    anchorIndex = local.length;
  }
  let startIndex = anchorIndex;
  let firstSeq: number | undefined;
  let lastSeq: number | undefined;
  let taken = 0;
  for (let i = anchorIndex - 1; i >= 0 && taken < limit; i--) {
    const seq = readLocalSeq(local[i]);
    if (seq === undefined) {
      continue;
    }
    taken += 1;
    startIndex = i;
    firstSeq = seq;
    lastSeq ??= seq;
  }
  // The page that reaches the transcript's start also owns whatever precedes row 1 in time.
  const reachesStart = firstSeq === undefined || firstSeq <= 1;
  if (reachesStart) {
    startIndex = 0;
  }
  const anchor = anchorIndex < local.length ? local[anchorIndex] : undefined;
  return {
    plan: {
      kind: "before" as const,
      local: local.slice(startIndex, anchorIndex),
      importFromTs: reachesStart
        ? Number.NEGATIVE_INFINITY
        : (rowTimestampMs(local[startIndex]) ?? Number.NEGATIVE_INFINITY),
      importToTs:
        anchor === undefined
          ? Number.POSITIVE_INFINITY
          : (rowTimestampMs(anchor) ?? Number.POSITIVE_INFINITY),
      firstSeq: firstSeq ?? beforeSeq - 1,
      lastSeq: lastSeq ?? beforeSeq - 1,
    },
    reason: null,
  };
}

/**
 * Bound the imported (claude-cli) rows of a merged window to the plan's time range. Local rows
 * were already chosen by the plan and pass through. An import with no usable timestamp cannot be
 * placed in or out of the range, so it is kept: over-inclusion is harmless (the client merges by
 * identity), omission is not.
 */
export function filterImportsToWindow(messages: unknown[], plan: ChatHistoryWindowPlan): unknown[] {
  if (plan.kind === "tail") {
    return messages;
  }
  const from = plan.importFromTs;
  const to = plan.kind === "before" ? plan.importToTs : Number.POSITIVE_INFINITY;
  const kept = messages.filter((message) => {
    if (!isImportedRow(message)) {
      return true;
    }
    const ts = rowTimestampMs(message);
    return ts === undefined || (ts >= from && ts <= to);
  });
  return kept.length === messages.length ? messages : kept;
}

/**
 * The reply's cursor. `firstSeq` is the `beforeSeq` that pages everything older than this reply:
 * every row the window held from that local row on is in the reply. Rows the projection hides are
 * consumed, not owed.
 *
 * Ruling R23: when rows were cut after projection (a tail's `limit`, whose LOCAL_TAIL_FLOOR keeps
 * the newest 24 local rows even where newer imports around them are dropped, or the byte caps on
 * any window), `firstSeq` is the first local row AFTER the newest cut row, not the oldest served
 * one. Paging back from the oldest served local row would skip the imports cut between it and the
 * rows served after them. When no local row follows the newest cut row, `firstSeq` is lastSeq + 1
 * (a tail) — beforeSeq one past the end pages the newest rows again with their imports.
 */
export function buildChatHistoryCursor(params: {
  plan: ChatHistoryWindowPlan;
  epoch: string | null;
  /** Every local row of the transcript (tail plans; and userRowsBefore, for any plan). */
  local: readonly unknown[];
  /** Every row the window held after projection, before `limit` and the byte caps, in order. */
  window: readonly unknown[];
  /** The rows of `window` the reply carries: the same references, in the same order. */
  served: readonly unknown[];
  /**
   * The import merge's output BEFORE filterImportsToWindow (the handler's
   * augmentChatHistoryWithCliSessionImports result). Read only by a reply that carries
   * `userRowsBefore`, for the imported user rows older than the window. Absent = none counted.
   */
  merged?: readonly unknown[];
}): ChatHistoryCursor {
  const { plan } = params;
  const newestCut = newestCutIndex(params.window, params.served);
  const cut = newestCut >= 0;
  const resumeSeq = cut ? firstLocalSeqAfter(params.window, newestCut) : undefined;
  let firstSeq: number;
  let lastSeq: number;
  let reset: boolean;
  if (plan.kind === "tail") {
    let min = 0;
    let max = 0;
    for (const message of params.local) {
      const seq = readLocalSeq(message);
      if (seq !== undefined) {
        min = min === 0 ? seq : Math.min(min, seq);
        max = Math.max(max, seq);
      }
    }
    lastSeq = max;
    firstSeq = cut ? (resumeSeq ?? max + 1) : min;
    reset = plan.reset;
  } else if (plan.kind === "after") {
    lastSeq = plan.lastSeq;
    if (cut) {
      // Ruling R10: the byte caps dropped the oldest rows of this delta, so it no longer joins
      // up with afterSeq. What is left is the newest rows that fit: a fresh tail window.
      firstSeq = resumeSeq ?? lastSeq + 1;
      reset = true;
    } else {
      firstSeq = lastSeq > plan.afterSeq ? plan.afterSeq + 1 : plan.afterSeq;
      reset = false;
    }
  } else {
    lastSeq = plan.lastSeq;
    // A page never resumes at its own anchor (that would request the same page again).
    firstSeq = cut ? (resumeSeq ?? plan.lastSeq) : plan.firstSeq;
    reset = false;
  }
  // Rows before firstSeq exist when it is past seq 1, or when something was cut before it.
  const hasMoreBefore = firstSeq > 1 || (cut && firstSeq >= 1);
  const cursor: ChatHistoryCursor = {
    epoch: params.epoch,
    firstSeq,
    lastSeq,
    hasMoreBefore,
    reset,
  };
  // Ruling R36: a plain delta continues a window whose count the client already holds, and the
  // delta is the hot path (every poll), so only windows that (re)start a page carry the count, and
  // only they pay for it: a plain delta never reads `merged`.
  if (plan.kind !== "after" || reset) {
    cursor.userRowsBefore =
      countShownUserRowsBefore(params.local, firstSeq) +
      countCutImportedUserRowsBefore(params.window, params.served, firstSeq) +
      (params.merged ? countImportedUserRowsBelowWindow(plan, params.merged, params.local) : 0);
  }
  // logging.md §4.4: close this request's `history.minute` pair. `plan.kind === "after" && reset`
  // is ruling R10's byte-cap reset — the one outcome the plan could not know.
  noteHistoryServed(params.served.length, plan.kind === "after" && reset, Date.now());
  return cursor;
}

/*
 * FORK 2026-09-24 (R36 residual: turn numbers on cc-bridge tabs) — `userRowsBefore` counts what
 * the Tinker UI counts. The UI numbers a turn as userRowOffset + the `role: "user"` rows on its
 * page, claude-cli IMPORTS included (tinker-ui history-paging.ts turnNumberOf; the EEG prompt
 * index adds the same offset), and userRowOffset subtracts only the LOCAL rows the page holds
 * below `firstSeq`: it cannot place a seq-less import. Counting local rows alone left out every
 * imported user row before the window, so a cc-bridge tab numbered its turns short. The count has
 * three disjoint parts:
 *   1. local shown user rows with a seq below `firstSeq`: countShownUserRowsBefore;
 *   2. imported shown user rows the window held ahead of row `firstSeq` but did not serve (the
 *      tail's `limit` or the byte caps cut them; the older pages serve them):
 *      countCutImportedUserRowsBefore;
 *   3. imported shown user rows OLDER than the window, which filterImportsToWindow dropped before
 *      the projection: countImportedUserRowsBelowWindow.
 * An import the reply serves is on the page and counted there, never here.
 */

/**
 * (1) FORK 2026-09-24 (final whole-branch review item 6, ruling R36) — the user rows the display
 * shows (isShownHistoryUserRow) with a seq below `firstSeq`: the local rows a page starting at
 * `firstSeq` does not hold. Seq-less rows are not counted here: imports are parts 2 and 3 above,
 * and stranded prompts are counted by no part.
 */
function countShownUserRowsBefore(local: readonly unknown[], firstSeq: number): number {
  let count = 0;
  for (const message of local) {
    const seq = readLocalSeq(message);
    if (seq !== undefined && seq < firstSeq && isShownHistoryUserRow(message)) {
      count += 1;
    }
  }
  return count;
}

/**
 * (2) The rows of `window` ahead of row `firstSeq` (the first row with a local seq >= it) that are
 * imported, shown as user rows, and not in `served` (a subsequence of `window`: same references,
 * same order). `firstSeq` resumes after the newest cut row (ruling R23), so these are the cut
 * imports the older pages serve. Where it cannot (a beforeSeq page the caps cut down to rows after
 * its last local one resumes AT that row), the cut rows after it are not counted: no page serves
 * them, so no page shows them either.
 */
function countCutImportedUserRowsBefore(
  window: readonly unknown[],
  served: readonly unknown[],
  firstSeq: number,
): number {
  let count = 0;
  let next = 0;
  for (const message of window) {
    const seq = readLocalSeq(message);
    if (seq !== undefined && seq >= firstSeq) {
      break;
    }
    if (next < served.length && served[next] === message) {
      next += 1;
      continue;
    }
    if (isImportedRow(message) && isShownHistoryUserRow(message)) {
      count += 1;
    }
  }
  return count;
}

/**
 * (3) The shown imported user rows OLDER than a cursor window: the rows of `merged` (the import
 * merge's output before filterImportsToWindow) timestamped below the plan's import floor. That
 * merge deduplicated them against the window's local SLICE only, so the claude-cli copy of a prompt
 * whose local row lies below the window is still among them (a cc-bridge transcript records the
 * prompts the local store holds). Each is run through the same merge again against EVERY local
 * user row, and only the rows it keeps are counted: the rows the whole-store (tail) merge keeps.
 * One claude-cli transcript at a time, because the merge's prehistory-floor valve opens per
 * transcript (augmentChatHistoryWithCliSessionImports merges each alone): a transcript whose rows
 * all predate the local store must not be floored for sitting beside one that overlaps it.
 *
 * Only user rows take part: the merge compares rows of one role, and its assistant rules
 * (dropImportCoveredLocalAssistants, the slot coverage) never remove a user row. The window merge
 * already deduplicated the candidates against each other. Approximated, not handled: the
 * whole-store merge compares an import with the imports it KEPT, and it keeps fewer (it drops the
 * copies this pass drops), so a short prompt repeated within 5 minutes on both sides of such a
 * copy can survive there and not here.
 *
 * Cost: no second claude-cli read (the rows come from the merge the window already ran); one O(n)
 * scan of `merged`; then, only when a candidate exists, the merge over U local user rows and C
 * candidates: O(C x (U + C)) comparisons of per-row text the merge memoises, plus a sort. It runs
 * only for a reply that carries `userRowsBefore` with a finite floor, a beforeSeq page (the owner
 * scrolling up) or an afterSeq delta the byte caps cut: never a plain delta (the per-poll hot
 * path), never a tail (its floor is open). Not memoised: `(epoch, firstSeq)` does not key it,
 * because a claude-cli append, the flood valve's budget or a new spawn in the provenance chain
 * changes the imports while the local epoch stays the same.
 */
function countImportedUserRowsBelowWindow(
  plan: ChatHistoryWindowPlan,
  merged: readonly unknown[],
  local: readonly unknown[],
): number {
  if (plan.kind === "tail" || plan.importFromTs === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  const floor = plan.importFromTs;
  const candidatesByTranscript = new Map<unknown, unknown[]>();
  for (const message of merged) {
    if (!isImportedRow(message) || !isShownHistoryUserRow(message)) {
      continue;
    }
    const ts = rowTimestampMs(message);
    if (ts === undefined || ts >= floor) {
      continue;
    }
    const transcript = readMeta(message)?.cliSessionId;
    const candidates = candidatesByTranscript.get(transcript);
    if (candidates) {
      candidates.push(message);
    } else {
      candidatesByTranscript.set(transcript, [message]);
    }
  }
  if (candidatesByTranscript.size === 0) {
    return 0;
  }
  const localUsers: unknown[] = [];
  for (const message of local) {
    if ((message as { role?: unknown } | null)?.role === "user" && !isImportedRow(message)) {
      localUsers.push(message);
    }
  }
  // The floor the window merge used (chat.ts passes the whole store's earliest row to a cursor
  // window's merge), so this pass floors nothing that one kept.
  const earliestLocalTs = resolveEarliestLocalTimestamp(local);
  let count = 0;
  for (const candidates of candidatesByTranscript.values()) {
    const kept = mergeImportedChatHistoryMessages({
      localMessages: localUsers,
      importedMessages: candidates,
      earliestLocalTs,
    });
    // The merge keeps every local row and appends the imports it keeps.
    count += kept.length - localUsers.length;
  }
  return count;
}

/** Index in `window` of the newest row not in `served` (a subsequence of it); -1 if none. */
function newestCutIndex(window: readonly unknown[], served: readonly unknown[]): number {
  let j = served.length - 1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (j >= 0 && window[i] === served[j]) {
      j -= 1;
      continue;
    }
    return i;
  }
  return -1;
}

function firstLocalSeqAfter(window: readonly unknown[], index: number): number | undefined {
  for (let i = index + 1; i < window.length; i++) {
    const seq = readLocalSeq(window[i]);
    if (seq !== undefined) {
      return seq;
    }
  }
  return undefined;
}
