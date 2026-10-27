// FORK 2026-08-05 (the architect: "messages appear out of chronological order, some old messages get
// rewritten, others disappear"). Pure (DOM-free, global-free) message IDENTITY and ORDER, extracted
// so the rule is unit-testable — app.ts is a ~20k-line browser entry that cannot carry a test.
//
// ── THE DEFECT, IN ONE SENTENCE ────────────────────────────────────────────────────────────────
// `app.ts` keeps `let messages: unknown[] = []` and `updateChat()` renders it in RAW ARRAY ORDER
// (`for (j = runStart; j < runEnd; j++) h += renderMsg(messages[j], j, …)` then `el.innerHTML = h`).
// There is no `.sort()` in the file, no per-message id and no DOM key — while ~20 `messages.push(…)`
// sites append, `messages.splice(lastAssistantIdx, 0, ...storedErrors)` inserts MID-ARRAY, and six
// paths remove from the middle. So identity, position and visibility are all three derived from a
// MUTATING ARRAY INDEX: index 7 names a different message before and after any of those mutations.
// That is ONE defect wearing three faces — reordered, rewritten, vanished.
//
// ── THE KEY DESIGN DECISION: THE ORDER KEY IS ORDER OF FIRST RENDER ────────────────────────────
// `_seq` is NOT creation time and NOT a provider timestamp. It is "the Nth message this client ever
// put on screen". The criterion being defended is "a rendered message never moves", NOT "messages
// match server chronology" — and those are different specs with very different costs:
//   • a timestamp key needs every PRODUCER to supply a trustworthy clock. There are ~20 producers,
//     several synthesise bubbles with no server timestamp at all, and the file is under concurrent
//     edit by parallel sessions. One producer that forgets is a silent reorder, forever.
//   • a first-render key needs ONE writer — the renderer — and can be stamped LAZILY, in a single
//     pass, over whatever the array happens to hold. A producer cannot forget what it never does.
// `stampOrder`'s IDEMPOTENCE *is* the acceptance criterion expressed as code rather than as
// vigilance: once a message carries a `_seq`, no later pass may change it, so no later mutation of
// the array can move it. A message that lands mid-array (the `splice`) therefore renders at the
// TAIL — which is correct: it was written to the screen NOW, not then.
//
// ── "TIMESTAMPS OF WHEN WE GET THE MESSAGES AS THEIR ID" (the architect) ───────────────────────────────
// Right instinct, and `_seq` already IS it: arrival time is the natural chronological key, and
// `_seq` is stamped by the RECEIVER, on receipt, in arrival order. What cannot be the key is the
// wall-clock READING of that moment, for two reasons:
//   (a) COLLISIONS. A millisecond is not unique here. A burst of streamed deltas, a `tool_use` and
//       the `tool_result` answering it, and every message of a history replay all land inside the
//       same `Date.now()`. Two messages sharing an id re-creates the exact ambiguity this module
//       exists to remove, and a comparator that ties on them hands their relative order straight
//       back to `sort` — the mutating-index bug wearing a nicer name.
//   (b) `Date.now()` IS NOT MONOTONIC. It is the wall clock: an NTP correction, a DST or timezone
//       write, a laptop resuming from sleep, a user fixing the date — any of them moves it
//       BACKWARDS. An order key that can regress is the one thing this fix cannot tolerate, since
//       a regression reorders messages ALREADY ON SCREEN, which is the defect itself.
// `nextSeq` has neither edge: unique by construction, and it only ever increases. `_seq` IS "when
// we got it", with the sharp edges filed off.
//
// The clock reading is kept anyway, as `_arrivedAt` (`Date.now()`, stamped in the same pass) — for
// DISPLAY AND DEBUGGING ONLY. "3 minutes ago" on a bubble, or the gap between two bubbles in a bug
// report, needs a human-meaningful time that a counter cannot give. Nothing sorts by it; `bySeq`
// says why, in the one place a future reader would try.
//
// `_uid` is the IDENTITY half and is more sacred still. It is what lets a caller point at one bubble
// ("this one is a thinking block now", "this one collapses") without pointing at an index that a
// concurrent push has already invalidated. Criterion (3) — presentation MAY change — is served
// entirely by mutating a message in place under its stable `_uid`. Criterion (2) — a rendered
// message is NEVER deleted — is served by never dropping a stamped message from the list: this
// module hands the callers the tools (`findByUid`, `isClientOnlyBubble`, `reinsertByTurnAnchor`)
// and itself removes nothing, ever.
//
// Messages are `unknown[]` carrying ad-hoc properties, so `_uid`/`_seq`/`_arrivedAt` are purely
// ADDITIVE — nothing on the wire and nothing in app.ts reads those names today. Every write is
// attempted defensively: a frozen or sealed message simply stays unstamped and degrades to array
// order (see `bySeq`); it never throws into a render loop.

// FORK 2026-09-24 — prompt-queue.md step U2: a user bubble's pending state is DERIVED by the pure
// prompt-state.ts from the facts the bubble carries (see "the pending-prompt state of a USER bubble"
// below). Imported, never re-implemented: that module owns the states, the table and the copy.
import {
  derivePromptIndicator,
  derivePromptState,
  type PromptStateInputs,
  type PromptStateName,
} from "./prompt-state.js";

/** A message as this module needs to see it: a bag of ad-hoc client fields. */
type MsgRecord = Record<string, unknown>;

/**
 * The three fields this module owns, for call sites that want to name them without `any`.
 * `_arrivedAt` is a wall-clock `Date.now()`, for showing a human a time and for nothing else.
 */
export type OrderedMsg = MsgRecord & { _uid?: string; _seq?: number; _arrivedAt?: number };

/**
 * Where a client-only bubble belongs, described well enough to survive the transcript changing shape
 * underneath it. See `describeTurnAnchor` / `resolveTurnAnchor`.
 *
 * `turn` is the ORDINAL — how many user messages preceded the bubble in the list it was born in.
 * `at` is the bubble's own wall-clock time. `prompt` is a bounded prefix of the user message the
 * bubble sat under. The ordinal alone was the whole anchor until 2026-09-08, and it is the one of the
 * three that a Claude Code bridge tab cannot keep honest: see the note on `resolveTurnAnchor`.
 */
export type TurnAnchor = { turn: number; at?: number; prompt?: string };

/** One preserved client bubble plus where it belongs. A bare `{ m, turn }` is the legacy shape. */
export type AnchoredMsg = TurnAnchor & { m: unknown };

/**
 * Where an UNSTAMPED message sorts: the tail.
 *
 * NOT "return 0 when either side is missing". A comparator that answers 0 for absent keys is not
 * transitive (a≡b, b<c, a≡c) and `Array.prototype.sort` is entitled to produce arbitrary output
 * from it. A total order over a single numeric key is the only shape `sort` is safe with.
 *
 * The tail is also the right ANSWER, not merely the safe one: the only messages that reach it are
 * ones this module could not write to, and a list where NOTHING could be stamped collapses to "every
 * key equal", which a stable sort renders in exact array order — today's behaviour. The fix can
 * therefore never render worse than the bug it replaces.
 */
const UNSTAMPED_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * The monotonic counter. MODULE-GLOBAL on purpose: tabs hold separate `messages` arrays
 * (`tabStates`), a message crosses between them by `.slice()`, and a per-list counter would hand two
 * lists the same numbers — making `_uid` ambiguous the moment those lists met.
 */
let nextSeq = 1;

/**
 * Test seam. `nextSeq` is module state, so without this a spec asserting concrete `_seq` values
 * would depend on every spec that ran before it in the same file — a suite that passes today and
 * fails the day someone reorders a `describe`. Production never calls this.
 * (Same precedent as `__resetUiStateHydrationForTests` in panels/ui-state.ts.)
 */
export function __resetMsgOrderForTests(): void {
  nextSeq = 1;
}

// --- primitives ------------------------------------------------------------

/** `typeof null === "object"`, and an array is an object too — neither one is a message. */
function asRecord(m: unknown): MsgRecord | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return null;
  }
  return m as MsgRecord;
}

function hasUid(rec: MsgRecord): boolean {
  return typeof rec._uid === "string" && rec._uid.length > 0;
}

function hasSeq(rec: MsgRecord): boolean {
  return typeof rec._seq === "number" && Number.isFinite(rec._seq);
}

/**
 * Type-checked like `hasSeq`, and for the same reason: `OrderedMsg` declares `_arrivedAt` as a
 * `number`, so a squatter of another type (an ISO string off some wire) is replaced rather than
 * honoured — no consumer should have to defend against it.
 *
 * Where this DIVERGES from `_seq`: a finite number is trusted on sight, with no `_uid` required
 * beside it. `_seq` needs that proof because a foreign number would corrupt the ORDER; the worst a
 * foreign `_arrivedAt` can do is show a wrong time, and nothing sorts by it.
 */
function hasArrivedAt(rec: MsgRecord): boolean {
  return typeof rec._arrivedAt === "number" && Number.isFinite(rec._arrivedAt);
}

/**
 * Is this message already OURS? Both fields must be present, and that conjunction is precisely what
 * handles a FOREIGN `_seq` — a number some other layer wrote under the same name. `_uid` is stamped
 * by this module and by nothing else, so its presence is the proof that the `_seq` beside it came
 * from this counter and is comparable with the rest of the list. A `_seq` with no `_uid` is a number
 * from an unrelated numbering: it gets overwritten, because honouring it would drop the message at
 * an arbitrary point in someone else's sequence — the exact "old message gets rewritten" symptom.
 *
 * `_arrivedAt` is deliberately NOT part of this test. This predicate gates both the skip in
 * `stampOrder` and the counter advance; folding a display field into it would let a message whose
 * clock write failed be RENUMBERED on a later pass — a missing tooltip escalated into a reorder.
 */
function isStamped(rec: MsgRecord): boolean {
  return hasUid(rec) && hasSeq(rec);
}

/** app.ts reads the role as `(m.role || "").toLowerCase()` in some places and `m.role === "user"` in
 *  others. Take the tolerant form, so a capitalised role can never silently shift a turn anchor. */
function isUserMsg(m: unknown): boolean {
  const rec = asRecord(m);
  return rec !== null && typeof rec.role === "string" && rec.role.toLowerCase() === "user";
}

// --- identity + order ------------------------------------------------------

/**
 * Give every message that lacks them a `_uid`, a `_seq` and an `_arrivedAt`, in CURRENT ARRAY
 * ORDER.
 *
 * IDEMPOTENT BY CONSTRUCTION — an already-stamped message is skipped, never renumbered. That single
 * `continue` is the whole guarantee: call this on every render, from any code path, in any order,
 * and no message that has ever been drawn can change position.
 *
 * A PARTIALLY stamped message (a `_uid` whose `_seq` was cleared by `reinsertByTurnAnchor`) keeps
 * its identity and gets only a new position. Identity is never reissued, and neither is the arrival
 * stamp: the message did not arrive a second time.
 */
export function stampOrder(list: unknown[]): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const entry of list) {
    const rec = asRecord(entry);
    if (rec === null || isStamped(rec)) {
      continue;
    }
    const seq = nextSeq;
    try {
      if (!hasUid(rec)) {
        rec._uid = `m${seq}`;
      }
      rec._seq = seq;
      // LAST, and only when absent. LAST because a frozen object throws on the FIRST write it
      // reaches, and the `_seq` write above is the one the counter depends on — a new write placed
      // ahead of it would start swallowing numbers. ONLY WHEN ABSENT because a message keeps the
      // moment it actually arrived: the re-stamp `reinsertByTurnAnchor` forces (it clears `_seq`,
      // never this) must not push the time forward, and backfilling a message stamped before this
      // field existed would invent a time it never had — absent is the honest answer, and nothing
      // orders by it anyway.
      if (!hasArrivedAt(rec)) {
        rec._arrivedAt = Date.now();
      }
    } catch {
      /* frozen or sealed under strict mode — handled by the check below, not by this catch */
    }
    // VERIFY THE WRITE LANDED; do not infer it from the absence of an exception. Writing to a frozen
    // object THROWS in strict mode and fails SILENTLY in sloppy mode, and this file is consumed both
    // ways (vite bundles it as strict ESM; a CJS transpile in a test harness is sloppy). Reading the
    // property back is the one answer that is identical in both. An unstampable message keeps no
    // number, costs no number — `bySeq` puts it at the tail in stable array order — and cannot make
    // the counter drift between environments.
    if (isStamped(rec)) {
      nextSeq = seq + 1;
    }
  }
}

function seqOf(m: unknown): number {
  const rec = asRecord(m);
  return rec !== null && isStamped(rec) ? (rec._seq as number) : UNSTAMPED_SEQ;
}

/**
 * Total order over `_seq`; unstamped sorts last. Safe as an `Array.prototype.sort` comparator.
 *
 * DO NOT "IMPROVE" THIS INTO A TIMESTAMP SORT. `_arrivedAt` sits right beside `_seq` and reads like
 * the more honest key; it is not one. It TIES across a whole burst of messages — destroying the
 * total order this comparator is required to be — and it RUNS BACKWARDS on any clock correction,
 * moving bubbles the user has already read. `_seq` is that same arrival order with both defects
 * removed. `_arrivedAt` is for showing a human a time, and for nothing else.
 */
export function bySeq(a: unknown, b: unknown): number {
  const sa = seqOf(a);
  const sb = seqOf(b);
  // Compare rather than subtract: the difference of two MAX_SAFE_INTEGERs is exact today, but a
  // comparison cannot be dragged out of range by a future key.
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/**
 * The list as it should be DRAWN: stamped, then a sorted COPY.
 *
 * `toSorted` and NOT `sort`, because `sort` sorts IN PLACE: sorting the caller's live `messages`
 * would add a fourth mutation lane to the array that ~20 other call sites index into. The copy is
 * the point of this function, not an incidental detail of how it is written.
 *
 * One sort quirk worth knowing rather than re-discovering: `undefined` entries are moved to the
 * end WITHOUT the comparator ever being called on them. So a junk entry can be relocated but never
 * dropped — the returned array always has exactly `list.length` entries, which is criterion (2)
 * holding even for input this module considers unrenderable.
 */
export function renderOrder(list: unknown[]): unknown[] {
  if (!Array.isArray(list)) {
    return [];
  }
  stampOrder(list);
  return list.toSorted(bySeq);
}

/**
 * Where `insertRenderedAt` puts rows: directly above `before`, directly below `after`, or above
 * everything on the list.
 */
export type RenderedAt = { before: unknown } | { after: unknown } | "top";

/**
 * Put `rows` on `list` so they RENDER at `at` — the one legitimate way to write rows ABOVE rows
 * that are already on screen.
 *
 * FORK 2026-09-23 (chat.history rehaul, plan task 8) — an older page loaded on scroll is written
 * above the page. `stampOrder` alone cannot do that: it numbers a row by first render, so a row
 * spliced in at the top would render at the TAIL (see the test named CONTROL). The rule "a drawn
 * row never moves" is kept exactly: the new rows take `_seq` values strictly INSIDE the gap they
 * fill, packed against the row they are written next to (unit steps while the gap allows, fractions
 * when it is narrower), and a fresh `_uid` each from the shared counter, so identity stays unique
 * across lists.
 *
 * FORK 2026-09-23 (fix round 2) — paging back page after page above a row that never moves (a live
 * bubble) keeps narrowing one gap, and float `_seq` values ran out of precision around the ninth
 * page, misordering rows. When a gap is exhausted, every stamped row of the list is renumbered in
 * its CURRENT render order (spaced RENUMBER_SPACING apart) before the insert: an order-preserving
 * renumber moves nothing on screen — the same re-open `reinsertByTurnAnchor` performs.
 *
 * The gap is found in RENDER order (`_seq`), not array order; the rows are also spliced into the
 * array at the matching spot, so code that scans the array (turn starts, anchors) reads the same
 * page. Rows already on the list are skipped outright (never moved, never duplicated); a row that
 * is already stamped keeps its number. Mutates `list` IN PLACE, like `reinsertByTurnAnchor`.
 */
export function insertRenderedAt(list: unknown[], rows: unknown[], at: RenderedAt): void {
  if (!Array.isArray(list) || !Array.isArray(rows) || !Object.isExtensible(list)) {
    return;
  }
  const onList = new Set(list);
  const fresh = rows.filter((m) => !onList.has(m));
  if (fresh.length === 0) {
    return;
  }
  // Every row already on the list gets its first-render number now, exactly as the next render
  // would give it (idempotent), so the gap below is measured against the real render order.
  stampOrder(list);
  const n = fresh.length;
  let gap = gapFor(list, at, n);
  if (!(gap.step > minStep(gap.lo, gap.hi))) {
    renumberInRenderOrder(list);
    gap = gapFor(list, at, n);
  }
  const { index, lo, hi, step, packBelowHi } = gap;
  fresh.forEach((m, i) => {
    const rec = asRecord(m);
    if (rec === null || isStamped(rec)) {
      return;
    }
    try {
      // Identity is never reissued (see stampOrder): only a row without one is given one.
      if (!hasUid(rec)) {
        rec._uid = `m${nextSeq}`;
      }
      rec._seq = packBelowHi ? hi - (n - i) * step : lo + (i + 1) * step;
      if (!hasArrivedAt(rec)) {
        rec._arrivedAt = Date.now();
      }
    } catch {
      /* frozen: renders at the tail by `bySeq`, like any row this module cannot write */
    }
    if (isStamped(rec)) {
      nextSeq += 1;
    }
  });
  list.splice(index, 0, ...fresh);
}

/** Spacing an order-preserving renumber leaves between neighbours (room for later inserts). */
const RENUMBER_SPACING = 1024;

/** Below this a `_seq` step is too close to float resolution to keep rows distinct. */
function minStep(lo: number, hi: number): number {
  return Math.max(Math.abs(lo), Math.abs(hi), 1) * Number.EPSILON * 64;
}

function gapFor(
  list: unknown[],
  at: RenderedAt,
  n: number,
): { index: number; lo: number; hi: number; step: number; packBelowHi: boolean } {
  const seqs = list.map(seqOf).filter((s) => s !== UNSTAMPED_SEQ);
  let index: number;
  let lo: number;
  let hi: number;
  let packBelowHi = true;
  const anchor = at === "top" ? undefined : "before" in at ? at.before : at.after;
  const anchorIndex = anchor === undefined ? -1 : list.indexOf(anchor);
  if (at !== "top" && "after" in at && anchorIndex >= 0) {
    index = anchorIndex + 1;
    lo = seqOf(anchor);
    const above = seqs.filter((s) => s > lo);
    hi = above.length > 0 ? Math.min(...above) : lo + n + 1;
    packBelowHi = false;
  } else if (at !== "top" && "before" in at && anchorIndex >= 0) {
    index = anchorIndex;
    hi = seqOf(anchor);
    const below = seqs.filter((s) => s < hi);
    lo = below.length > 0 ? Math.max(...below) : hi - n - 1;
  } else {
    index = 0;
    hi = seqs.length > 0 ? Math.min(...seqs) : 0;
    lo = hi - n - 1;
  }
  return { index, lo, hi, step: Math.min(1, (hi - lo) / (n + 1)), packBelowHi };
}

/** Renumber every stamped row of `list` in its current render order; nothing changes place. */
function renumberInRenderOrder(list: unknown[]): void {
  let s = 0;
  for (const m of list.toSorted(bySeq)) {
    const rec = asRecord(m);
    if (rec === null || !isStamped(rec)) {
      continue;
    }
    s += RENUMBER_SPACING;
    try {
      rec._seq = s;
    } catch {
      /* frozen after it was stamped: it keeps its number, as in reinsertByTurnAnchor */
    }
  }
  nextSeq = Math.max(nextSeq, s + 1);
}

/**
 * Put ONE row on `list` so it RENDERS at its own time `rowTimeMs`: directly above the first row the
 * page will DRAW later than it, or at the tail when nothing drawn is later.
 *
 * FORK 2026-10-01 — bug-log.md `[chat-divergence]` cause 2, proposed fix (3). app.ts
 * `reinjectOutboxBubbles` redraws an unconfirmed prompt from the durable outbox, and used to place it
 * with an ARRAY splice before the first row with a later `timestamp`. Right about where the row
 * belongs, wrong about what the page draws by: `stampOrder` numbers a row by FIRST RENDER, so on an
 * already-numbered page the newcomer takes the NEXT number and is drawn at the BOTTOM, under every
 * answer the prompt predates — the prompt that "chases". That is the same trap this file's header
 * note and the test named CONTROL already describe, reached from a second call site. All 13 order
 * inversions in a census of 206 page snapshots were such copies, 8 to 24 places below their served
 * twin. A reload numbers the array from scratch, which is why the splice looked correct and why
 * refreshing looked like a fix: it IS correct, on a page nothing has numbered yet, and only there.
 *
 * So the anchor is read in RENDER order and the row is written by `insertRenderedAt` — the one
 * sanctioned way to put a row ABOVE rows already on screen. Two consequences worth keeping: the row
 * takes a `_seq` strictly inside the gap under the anchor (the list is renumbered in its current
 * render order when that gap is spent), and it is spliced into the ARRAY at the anchor's index too,
 * so array scans (turn starts, anchors) and the raw-array debug view read the same page. Nothing
 * already drawn moves — that is `insertRenderedAt`'s contract, not a new one. No new sort and no new
 * key either: time only PICKS the anchor, the order is still `_seq` (see the warning on `bySeq`).
 *
 * `timeOf` is INJECTED, and REQUIRED, the way history-reconcile.ts takes its `timeOf` dep. Not a
 * convenience: WHICH clock a caller trusts decides which rows can be an anchor, and the obvious
 * candidate is a trap. history-reconcile.ts `historyRowTime` falls back to `_arrivedAt`, which
 * `stampOrder` writes as `Date.now()` on every row it numbers — so on a numbered page a client note
 * carrying no time of its own reads as PAGE-LOAD time, counts as "later" than a prompt typed an hour
 * ago, and drags the copy above rows that genuinely precede it: the same inversion, mirrored. (That
 * reader is also cause 8 of the same bug-log entry, for preferring `_bubbleStartedAt`.) A row whose
 * time cannot be read is NEVER an anchor — unreadable is not "later", which is exactly what the
 * `?? 0` in the code this replaces achieved, kept deliberately. A non-finite `rowTimeMs` makes every
 * comparison false and lands the row at the tail, the same degradation by the same rule.
 *
 * Comparison is strict `>`: a row drawn at the same instant is already on screen, so the newcomer
 * goes under it. `timeOf` is never handed a non-record entry — `messages` holds junk this module
 * relocates but never drops (see `renderOrder`), so a caller's reader may be as plain as a property
 * read without having to defend itself. Mutates `list` IN PLACE, like `insertRenderedAt`; a row
 * already on the list is a no-op, never a second copy.
 */
export function placeByTime(
  list: unknown[],
  row: unknown,
  rowTimeMs: number,
  timeOf: (m: unknown) => number | null | undefined,
): void {
  if (!Array.isArray(list) || !Object.isExtensible(list) || list.includes(row)) {
    return;
  }
  // RENDER order, not array order — the whole fix is that one word. `renderOrder` stamps first, so
  // this scan reads the numbers the NEXT paint will use rather than the ones a half-numbered array
  // implies: an unstamped row compares as "last" (`bySeq`), so searching an unstamped list would
  // hide the real anchor behind a row the page has not drawn there.
  let anchor: unknown;
  let found = false;
  for (const entry of renderOrder(list)) {
    if (asRecord(entry) === null) {
      continue;
    }
    const t = timeOf(entry);
    if (typeof t === "number" && Number.isFinite(t) && t > rowTimeMs) {
      anchor = entry;
      found = true;
      break;
    }
  }
  if (!found) {
    // Later than everything drawn: the tail is both the honest answer and exactly what the
    // `messages.push(bubble)` branch this replaces did. Stamped here so BOTH branches leave the same
    // postcondition — on the list, numbered, rendering where it was put — which is what lets a
    // caller place several rows in one loop and read the result back after each one.
    list.push(row);
    stampOrder(list);
    return;
  }
  insertRenderedAt(list, [row], { before: anchor });
}

/** The message carrying this `_uid`, or `undefined`. The index-free way to point at one bubble. */
export function findByUid(list: unknown[], uid: string | null): unknown | undefined {
  if (!Array.isArray(list) || typeof uid !== "string" || uid.length === 0) {
    return undefined;
  }
  for (const entry of list) {
    const rec = asRecord(entry);
    if (rec !== null && rec._uid === uid) {
      return entry;
    }
  }
  return undefined;
}

// --- client-only bubbles ---------------------------------------------------

/**
 * The bubbles this CLIENT synthesised. They exist nowhere on the server, so every
 * `messages = res.messages ?? []` wipes them — that is the "others disappear" half of the defect.
 * Enumerated rather than inferred, because "did not come from the wire" is not observable on the
 * object itself.
 *
 * `_subagentId` is a STRING id; the rest are booleans. Hence "true, or a non-empty string"
 * rather than a bare truthiness test — `_isWarning: 0` must not light this up, and
 * `_subagentId: ""` must not either.
 *
 * `_stopped` is in the specified surface but is NOT currently written by app.ts (the stop bubble is
 * built with `_isWarning: true`). Kept anyway: an unused flag costs one array entry, a missing one
 * costs a deleted bubble.
 */
const CLIENT_ONLY_FLAGS = [
  "_isError",
  "_isWarning",
  "_isOverloadRetry",
  "_isPrefrontal",
  "_subagentId",
  "_isReasoning",
  "_stopped",
  // FORK 2026-08-15 — per-phase timing rows. Synthesised from `stream:"turn-phase"` completion
  // events and, like every flag above, present on no server payload; omitting it here is exactly
  // the "others disappear" defect this list documents, and it cost one live debugging round:
  // the rows were pushed and rendered, then wiped by the next `messages = res.messages ?? []`.
  "_isPhaseTiming",
] as const;

export function isClientOnlyBubble(m: unknown): boolean {
  const rec = asRecord(m);
  if (rec === null) {
    return false;
  }
  for (const flag of CLIENT_ONLY_FLAGS) {
    const value = rec[flag];
    if (value === true || (typeof value === "string" && value.length > 0)) {
      return true;
    }
  }
  // FORK 2026-08-16, re-keyed 2026-09-24 — a USER prompt that only this browser holds. This is the
  // one case here that guards a message the user TYPED rather than one the client synthesised, and
  // it is the reason the 2026-08-16 bug existed: an optimistic user bubble carried no client-only
  // flag, so `messages = incoming` in loadChat deleted it on the next reconnect — which is every
  // gateway restart — and the prompt then existed nowhere, not on screen and not on the server.
  // It used to be the boolean `_undelivered` in the list above. Since prompt-queue.md step U2 it is
  // DERIVED from the bubble's one `_promptState` (`isBrowserOnlyPrompt`, below): that field holds
  // an object, which the flag test above cannot read, and it answers from the same facts the badge
  // is drawn from. It stops answering true once the ack or a transcript proof is recorded, so a
  // DELIVERED prompt is never preserved twice.
  return isBrowserOnlyPrompt(rec);
}

// --- the pending-prompt state of a USER bubble -----------------------------------------------------
//
// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md step U2 (PQ-2 "one state, one
// indicator"; contradiction C1). A user bubble used to describe a pending prompt with a flag TRIPLE
// read by two stacked display lanes: `_queued` (grey "queued"), `_undelivered` and
// `_undeliveredAcked` (amber "not delivered · will retry" / "accepted · not in history"). The grey
// word won the precedence, so a deferred prompt whose chat.send was REJECTED said "queued" although
// no gateway held it. The triple is replaced by ONE field holding the prompt's FACTS (prompt-state.ts
// `PromptStateInputs`), and the one §2 state is DERIVED from them by prompt-state.ts at every read.
//
// Facts, never a stored state name: a fact recorded late (an ack, a replay count, and from step U3
// the gateway's `disposition`) can then never leave a stale name behind, and a reload re-derives
// from the same facts (PQ-11). `notePromptFacts` is the one writer of an existing field.
//
// It lives beside `isClientOnlyBubble` because "does only this browser hold this row?" is the
// question that function already answers for the page, and app.ts (a browser entry) cannot carry a
// test. prompt-state.ts stays the single owner of the states, the table and the copy.

/** The ONE field. Absent on every history row. */
export const PROMPT_STATE_FIELD = "_promptState";

/**
 * The §2 states in which ONLY THIS BROWSER holds the prompt: the gateway has not provably got it
 * (SAVED, SENDING, UNSENT), or it accepted it and neither a holder nor a transcript row has it
 * (LOST). A bubble in one of these exists nowhere on the server, which is exactly what the retired
 * `_undelivered` flag said, and what makes the bubble client-only.
 */
export const BROWSER_ONLY_PROMPT_STATES: readonly PromptStateName[] = Object.freeze([
  "SAVED",
  "SENDING",
  "UNSENT",
  "LOST",
] as const);

const PROMPT_TRANSPORTS: readonly unknown[] = Object.freeze([
  "not-issued",
  "in-flight",
  "rejected",
  "acked",
]);

/** The facts a bubble carries, BY REFERENCE (so `notePromptFacts` can record into them), or null
 *  when it carries none: a history row, or a value that is not a facts object. */
export function promptFactsOf(m: unknown): PromptStateInputs | null {
  const rec = asRecord(m);
  const facts = rec === null ? null : asRecord(rec[PROMPT_STATE_FIELD]);
  if (facts === null || !PROMPT_TRANSPORTS.includes(facts.transport)) {
    return null;
  }
  return facts as unknown as PromptStateInputs;
}

/** The bubble's one §2 state, derived through prompt-state.ts, or null for a row with no facts. */
export function promptStateOf(m: unknown): PromptStateName | null {
  const facts = promptFactsOf(m);
  return facts === null ? null : derivePromptState(facts);
}

/** Only this browser holds the prompt on this bubble (see BROWSER_ONLY_PROMPT_STATES). */
export function isBrowserOnlyPrompt(m: unknown): boolean {
  const state = promptStateOf(m);
  return state !== null && BROWSER_ONLY_PROMPT_STATES.includes(state);
}

/**
 * Record new facts about a prompt on its bubble: the ack, a rejection, a replay's attempt count, a
 * transcript proof. Returns false and writes NOTHING for a bubble with no facts: a history row is
 * not a pending prompt, and inventing facts for it would give it a state nobody observed.
 */
export function notePromptFacts(m: unknown, patch: Readonly<Partial<PromptStateInputs>>): boolean {
  const facts = promptFactsOf(m);
  if (facts === null) {
    return false;
  }
  try {
    Object.assign(facts, patch);
    return true;
  } catch {
    return false; // a frozen row keeps its facts: nothing here may throw into a send or a render
  }
}

/**
 * What a keyed transcript row PROVES (app.ts `markPromptDelivered` and the loadChat reconcile): the
 * gateway got the prompt and a holder demonstrably exists, so it is neither browser-only nor LOST.
 * It derives ACCEPTED, which draws nothing; the gateway's own facts take over from there.
 */
export const PROVEN_PROMPT_FACTS: Readonly<Partial<PromptStateInputs>> = Object.freeze({
  transport: "acked" as const,
  noGatewayHolder: false,
});

/**
 * The facts of a prompt re-drawn from the durable outbox (app.ts `reinjectOutboxBubbles`): one this
 * page does not show and no transcript row proves. prompt-queue.md §3.2: the outbox's two honest
 * states are UNSENT and LOST.
 *   - unacked: the replay tick still owns it. UNSENT while `attempts` is under the outbox cap, LOST
 *     once the automatic replays are exhausted (§2 `UNSENT → LOST`).
 *   - acked: the gateway took it, and it is neither on this page nor in the transcript. LOST
 *     (§2 `ACCEPTED → LOST`), with Resend and Dismiss. These are the STARTING facts, not the last
 *     word: since step U4 the caller (app.ts `reinjectOutboxBubbles`) spreads the gateway's
 *     evidence over them (prompt-state.ts `gatewayHolderFacts`), so a key the `pendingPrompts`
 *     report still names, or whose linked follow-up run has started, is drawn in that phase
 *     (BEHIND, STEERED, PREPARING, RUNNING) instead. That closed the limit U2 left here. With no
 *     such evidence the acked copy stays LOST.
 *   - stopped: FORK 2026-09-25 — the entry's own `cancelledAt` (outbox.ts `markCancelled`, stamped
 *     when the prompt's OWN run ended `aborted`) adds `cancelled`. So a stopped prompt that left no
 *     transcript row is re-drawn CANCELLED after a reload, as the page drew it, never LOST with a
 *     Resend of what the owner had just stopped (PQ-11). CANCELLED outranks every fact app.ts
 *     `reinjectOutboxBubbles` spreads over these (prompt-state.ts `derivePromptState`). Only a
 *     number counts: readOutbox passes the field through unchecked.
 * A FRESH object on every call, because `notePromptFacts` records into it in place.
 */
export function outboxPromptFacts(entry: {
  attempts: number;
  ackedAt?: number;
  cancelledAt?: number;
}): PromptStateInputs {
  const facts: PromptStateInputs =
    entry.ackedAt !== undefined
      ? { transport: "acked", noGatewayHolder: true }
      : { transport: "rejected", attempts: entry.attempts };
  return typeof entry.cancelledAt === "number" ? { ...facts, cancelled: true } : facts;
}

/** The two render slots of app.ts `renderMsg`'s user bubble: a class suffix for the bubble and the
 *  badge HTML. `state` is the derived state (null for a row with no facts), for tests and probes. */
export type PromptBubbleMarks = { state: PromptStateName | null; cls: string; badge: string };

function escPromptAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The bubble's ONE indicator, rendered: the §6.1 row prompt-state.ts gives its derived state, as
 * the two slots app.ts interpolates into all four user-bubble render sites. Both slots are "" for a
 * row with no facts and for every state whose row puts nothing on the prompt (SAVED, SENDING,
 * ACCEPTED, PREPARING, RUNNING, RETRYING, ANSWERED, FAILED): their indicator is the pill, the
 * thinking row, the orange countdown or the red bubble, never the prompt.
 *
 * Classes are keyed by TONE (base.css, one declaration site): `msg-prompt`, `prompt-tone-<tone>`,
 * `prompt-dimmed` and `prompt-dashed` on the bubble; `prompt-badge prompt-tone-<tone>` on the
 * badge. The badge TEXT is the table's, verbatim (copy lives in prompt-state.ts and nowhere else),
 * and the tooltip is the row's own `clearedBy` (PQ-5: what ends this state).
 *
 * The row's `actions` are not drawn HERE: this fills the badge slot only. Since step U4 the LOST
 * row's Resend and Dismiss have their own slot, prompt-state.ts `promptActionsHtml`, which app.ts
 * `renderMsg` draws beside this badge and serves from its delegated #messages click handler. It
 * draws a control only for an action that handler serves (PQ-12).
 */
export function promptBubbleMarks(m: unknown): PromptBubbleMarks {
  const facts = promptFactsOf(m);
  if (facts === null) {
    return { state: null, cls: "", badge: "" };
  }
  const ind = derivePromptIndicator(facts);
  const toned = ind.tone === "grey" || ind.tone === "amber";
  if (!toned && ind.badge === null && !ind.dimmed && !ind.dashed) {
    return { state: ind.state, cls: "", badge: "" };
  }
  const tone = `prompt-tone-${ind.tone}`;
  const cls =
    ` msg-prompt ${tone}` +
    (ind.dimmed ? " prompt-dimmed" : "") +
    (ind.dashed ? " prompt-dashed" : "");
  const badge =
    ind.badge === null
      ? ""
      : `<span class="prompt-badge ${tone}" data-prompt-state="${ind.state}" ` +
        `title="${escPromptAttr(`${ind.state.toLowerCase()} · ends on: ${ind.clearedBy}`)}">` +
        `${escPromptAttr(ind.badge)}</span>`;
  return { state: ind.state, cls, badge };
}

/**
 * How many USER messages precede this message — i.e. which turn it belongs to. A user message does
 * not count itself, so the first turn is 0 and a bubble raised during turn 3 answers 3.
 *
 * A message that is not in the list anchors to the NEWEST turn: a bubble whose anchor cannot be
 * measured still has to land somewhere, and the tail is the only choice that cannot push it ABOVE
 * something the user has already read.
 */
export function turnAnchorOf(list: unknown[], m: unknown): number {
  if (!Array.isArray(list)) {
    return 0;
  }
  let users = 0;
  for (const entry of list) {
    if (entry === m) {
      return users;
    }
    if (isUserMsg(entry)) {
      users++;
    }
  }
  return users;
}

// --- turn anchors that survive a reshaped transcript -----------------------------------------
//
// FORK 2026-09-08 (the architect, clawhub tab: "I see multiple TURN TIMING ... it is a bug to see it so
// many times"). The DOM snapshot held 25 timing blocks: seven complete ones stacked under ONE prompt,
// seven above the first prompt, none under prompts 3-31. The gateway had run one turn for that
// prompt. Every block was real — a measurement from an earlier turn — and every one was in the wrong
// place, because the store kept only the ORDINAL and `reinsertByTurnAnchor` counted that ordinal
// against whatever list it was handed. A bridge tab's list is not stable: the cli-history import
// rewrites it on every ~20 s history reload, the flood valve truncates it, and task-notification /
// auto-resume rows count as user messages. An ordinal past the served count lands at the tail: under
// the newest prompt, where seven old measurements read as seven parallel turns.
//
// The anchor is now the PROMPT the bubble sat under (text, with the bubble's own time to break ties
// between identical prompts — "keep going" ×20 is normal here), then the time alone when that prompt
// is gone from the served list, and the ordinal only when nothing else is known. Nothing is dropped:
// a bubble whose prompt vanished still lands next to the prompt that was live when it was measured.

/** Bounded prefix of a prompt kept as the anchor. Long enough to be unique, short enough to store. */
export const PROMPT_ANCHOR_CHARS = 80;

/**
 * The anchor can also ride ON the message object, under these two fields. `reinsertByTurnAnchor`
 * reads them when the entry it is handed carries only `{ m, turn }` — which is every caller that
 * predates 2026-09-08 and every copy of that call shape (the reconnect preserve loop, the reload
 * restore, a history-reconcile module that inherits either). Carrying the anchor on the row is what
 * makes the fix independent of who maps a stored row back into the list.
 */
export const ANCHOR_AT_FIELD = "_anchorAt";
export const ANCHOR_PROMPT_FIELD = "_anchorPrompt";

/** Write `anchor`'s time and prompt onto `m`, so the row carries its own anchor from now on. */
export function stampTurnAnchorOn(m: unknown, anchor: TurnAnchor): void {
  const rec = asRecord(m);
  if (rec === null) {
    return;
  }
  try {
    if (typeof anchor.at === "number" && Number.isFinite(anchor.at)) {
      rec[ANCHOR_AT_FIELD] = anchor.at;
    }
    if (typeof anchor.prompt === "string" && anchor.prompt.trim()) {
      rec[ANCHOR_PROMPT_FIELD] = anchor.prompt.trim();
    }
  } catch {
    /* a frozen row keeps whatever anchor it had; nothing here may throw into a render */
  }
}

/**
 * How far apart a bubble's own time and its prompt's server time may be for the stored ordinal to be
 * trusted without a prompt on file. A steered prompt is persisted ~50 s after the tab sent it, so the
 * bubble can precede its own prompt's server stamp; 120 s covers that with margin and is far shorter
 * than any real gap between two turns of the same tab.
 */
const ORDINAL_TIME_SLACK_MS = 120_000;

/**
 * The gateway prefixes a persisted prompt with `[Tue 2026-09-08 07:05 GMT+2] `; the bubble the tab
 * anchored to may or may not have carried it yet. Strip it on both sides so they compare equal.
 */
const BRACKET_STAMP_RE = /^\[[^\]]{0,64}\]\s*/;

function promptKeyOf(m: unknown): string {
  const rec = asRecord(m);
  if (rec === null) {
    return "";
  }
  let text = "";
  const c = rec.content;
  if (typeof c === "string") {
    text = c;
  } else if (Array.isArray(c)) {
    text = c
      .map((part) => {
        const p = asRecord(part);
        return p !== null && p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .join(" ");
  } else if (typeof rec.text === "string") {
    text = rec.text;
  }
  return text.replace(BRACKET_STAMP_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * When a message happened, from whichever field this build stamped. `_promptStartedAt` is what
 * app.ts derives for user rows on load; `createdAtMs`/`timestamp` are the server's; `ts` is what the
 * client stamps on the rows it synthesises; `_arrivedAt` is this module's own arrival clock.
 */
function msgTimeOf(m: unknown): number | undefined {
  const rec = asRecord(m);
  if (rec === null) {
    return undefined;
  }
  for (const key of ["_promptStartedAt", "createdAtMs", "timestamp", "ts", "_arrivedAt"]) {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === "string" && v) {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Describe where `m` sits in `list` RIGHT NOW, in the three terms `resolveTurnAnchor` can use later.
 * Call it where `turnAnchorOf` used to be called, with the live list; the ordinal it returns is the
 * same number `turnAnchorOf` returns.
 */
export function describeTurnAnchor(list: unknown[], m: unknown): TurnAnchor {
  const turn = turnAnchorOf(list, m);
  const anchor: TurnAnchor = { turn };
  const at = msgTimeOf(m) ?? Date.now();
  anchor.at = at;
  if (Array.isArray(list) && turn > 0) {
    let users = 0;
    for (const entry of list) {
      if (isUserMsg(entry)) {
        users++;
        if (users === turn) {
          const key = promptKeyOf(entry).slice(0, PROMPT_ANCHOR_CHARS);
          if (key) {
            anchor.prompt = key;
          }
          break;
        }
      }
    }
  }
  return anchor;
}

/**
 * The ordinal `anchor` means IN `list` — the turn to hand `reinsertByTurnAnchor`.
 *
 * Order of trust: (1) the prompt text, disambiguated by time when the same text recurs; (2) the stored
 * ordinal, but only when the prompt at that ordinal has a time that agrees with the bubble's (the
 * steer case: the ordinal is right, the server stamp is late); (3) the bubble's time alone — every
 * prompt stamped at or before it counts, an unstamped prompt counts (the optimistic local bubble has
 * no server stamp yet), and the first prompt stamped AFTER it ends the count; (4) the raw ordinal.
 */
export function resolveTurnAnchor(list: unknown[], anchor: TurnAnchor): number {
  const rawTurn =
    typeof anchor.turn === "number" && Number.isFinite(anchor.turn)
      ? Math.max(0, Math.floor(anchor.turn))
      : UNSTAMPED_SEQ;
  if (!Array.isArray(list)) {
    return rawTurn;
  }
  const at = typeof anchor.at === "number" && Number.isFinite(anchor.at) ? anchor.at : undefined;
  const prompt = typeof anchor.prompt === "string" ? anchor.prompt.trim() : "";
  const users: Array<{ key: string; time: number | undefined }> = [];
  for (const entry of list) {
    if (isUserMsg(entry)) {
      users.push({ key: promptKeyOf(entry), time: msgTimeOf(entry) });
    }
  }

  // (1) the prompt itself
  if (prompt) {
    const matches: number[] = [];
    for (let i = 0; i < users.length; i++) {
      if (users[i].key.includes(prompt)) {
        matches.push(i);
      }
    }
    if (matches.length === 1) {
      return matches[0] + 1;
    }
    if (matches.length > 1) {
      if (at !== undefined) {
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const i of matches) {
          const t = users[i].time;
          if (t === undefined) {
            continue;
          }
          const dist = Math.abs(t - at);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
        if (best >= 0) {
          return best + 1;
        }
      }
      // No time to choose by: the stored ordinal if it names one of the matches, else the newest.
      if (matches.includes(rawTurn - 1)) {
        return rawTurn;
      }
      return matches[matches.length - 1] + 1;
    }
  }

  // (2) the ordinal, when the prompt there agrees in time
  if (at !== undefined && rawTurn >= 1 && rawTurn <= users.length) {
    const t = users[rawTurn - 1].time;
    if (t !== undefined && Math.abs(t - at) <= ORDINAL_TIME_SLACK_MS) {
      return rawTurn;
    }
  }

  // (3) time alone
  if (at !== undefined) {
    let count = 0;
    for (const u of users) {
      if (u.time !== undefined && u.time > at) {
        break;
      }
      count++;
    }
    return count;
  }

  // (4) the ordinal, as it always was
  return rawTurn;
}

/**
 * Put preserved client-only bubbles back into a freshly fetched server list, each at the END of the
 * turn it came from. Mutates `serverMsgs` IN PLACE — app.ts's `messages` is a `let` binding that
 * other closures already hold by reference.
 *
 * THE BUG THIS REPLACES, verbatim from app.ts's history load:
 *     const lastAssistantIdx = findLastIndex(messages, (m) => m.role === "assistant");
 *     if (lastAssistantIdx >= 0) messages.splice(lastAssistantIdx, 0, ...storedErrors);
 * Every restored bubble was dropped in front of the LAST assistant message, whatever turn it
 * actually came from. On a 40-turn session a turn-3 error reappeared at turn 40 — "old messages get
 * rewritten", seen from the user's side. Anchoring by turn puts it back where it happened.
 *
 * A bubble with turn N is flushed just BEFORE the (N+1)-th user message — after user message #N and
 * after everything else that turn produced — or at the very end when no (N+1)-th user message
 * exists. Bubbles sharing a turn keep the caller's order.
 *
 * ── WHY THIS CLEARS `_seq`, AND WHY THAT IS NOT A RENUMBER ────────────────────────────────────
 * `_seq` is only meaningful RELATIVE TO THE LIST IT WAS COUNTED IN, and a wholesale history reload
 * throws that list away. Every server message arrives unstamped and would be numbered ABOVE the
 * survivors, so survivors that kept their old low numbers would sort above the entire reloaded
 * transcript — every preserved error stacked at the top of the chat. The rebuilt list is therefore
 * re-opened for stamping ONCE, here, and the next `stampOrder` numbers it in array order: the
 * server's chronology with the survivors anchored into it. That is criterion (1), exactly.
 *
 * What is NOT cleared is `_uid`. Identity is what criteria (2) and (3) ride on — a caller holding a
 * uid still finds its bubble after the reload and can still restyle it. Nothing is dropped and
 * nothing is re-identified; only a position in a list that no longer exists is recomputed.
 *
 * PRECONDITION: `serverMsgs` is a list straight off the wire. Handing it the LIVE array would
 * re-open that too — harmless (it re-derives array order, which is chronological) but pointless.
 */
export function reinsertByTurnAnchor(serverMsgs: unknown[], anchored: AnchoredMsg[]): void {
  if (!Array.isArray(serverMsgs) || !Array.isArray(anchored) || anchored.length === 0) {
    return;
  }
  // A sealed or frozen target cannot be rewritten. Bail BEFORE touching anything, so a refusal is a
  // clean no-op rather than a half-cleared list with its `_seq` values already gone.
  if (!Object.isExtensible(serverMsgs)) {
    return;
  }

  const groups = new Map<number, unknown[]>();
  for (const entry of anchored) {
    const rec = asRecord(entry);
    if (rec === null || asRecord(rec.m) === null) {
      // A primitive cannot be rendered and cannot be re-stamped; there is nothing to reinsert.
      continue;
    }
    const raw = rec.turn;
    // FORK 2026-09-08 — the anchor's time and prompt come from the entry, or from the row itself
    // (`stampTurnAnchorOn`). A described anchor is resolved against THIS list; the ordinal it
    // carries was counted in a list that no longer exists. An unusable anchor becomes the largest
    // possible turn, i.e. the tail — same reasoning as the not-found branch of `turnAnchorOf`.
    const m = asRecord(rec.m) as MsgRecord;
    const atRaw = rec.at ?? m[ANCHOR_AT_FIELD];
    const promptRaw = rec.prompt ?? m[ANCHOR_PROMPT_FIELD];
    const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : undefined;
    const prompt = typeof promptRaw === "string" && promptRaw.trim() ? promptRaw.trim() : undefined;
    const rawTurn = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    const turn =
      at !== undefined || prompt !== undefined
        ? resolveTurnAnchor(serverMsgs, { turn: rawTurn ?? UNSTAMPED_SEQ, at, prompt })
        : rawTurn !== undefined
          ? Math.max(0, Math.floor(rawTurn))
          : UNSTAMPED_SEQ;
    const bucket = groups.get(turn);
    if (bucket === undefined) {
      groups.set(turn, [rec.m]);
    } else {
      bucket.push(rec.m);
    }
  }
  if (groups.size === 0) {
    return;
  }

  const out: unknown[] = [];
  // Sorted ONCE with a cursor, not re-sorted per user message: `flushThrough` is called on every
  // user message of a transcript that can hold a thousand of them.
  const turnsAsc = [...groups.keys()].toSorted((a, b) => a - b);
  let cursor = 0;
  const flushThrough = (upTo: number): void => {
    while (cursor < turnsAsc.length && turnsAsc[cursor] <= upTo) {
      for (const m of groups.get(turnsAsc[cursor]) as unknown[]) {
        out.push(m);
      }
      cursor++;
    }
  };

  let users = 0;
  for (const entry of serverMsgs) {
    if (isUserMsg(entry)) {
      // This user message OPENS turn `users + 1`, so everything anchored at turn `users` or earlier
      // must already be on the page before it.
      flushThrough(users);
      users++;
    }
    out.push(entry);
  }
  flushThrough(Number.POSITIVE_INFINITY);

  for (const entry of out) {
    const rec = asRecord(entry);
    if (rec === null || !hasSeq(rec)) {
      continue;
    }
    try {
      delete rec._seq;
    } catch {
      /* a message frozen AFTER it was stamped. It keeps its old number and sorts by it; nothing can
         be done from here, and a throw inside a history reload would cost the whole transcript. */
    }
  }

  serverMsgs.length = 0;
  for (const entry of out) {
    serverMsgs.push(entry);
  }
}
