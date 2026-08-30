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

/** A message as this module needs to see it: a bag of ad-hoc client fields. */
type MsgRecord = Record<string, unknown>;

/**
 * The three fields this module owns, for call sites that want to name them without `any`.
 * `_arrivedAt` is a wall-clock `Date.now()`, for showing a human a time and for nothing else.
 */
export type OrderedMsg = MsgRecord & { _uid?: string; _seq?: number; _arrivedAt?: number };

/** One preserved client bubble plus the turn it belongs to. See `turnAnchorOf`. */
export type AnchoredMsg = { m: unknown; turn: number };

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
 * `_subagentId` is a STRING id; the other six are booleans. Hence "true, or a non-empty string"
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
  // FORK 2026-08-16 — a USER prompt the gateway has not provably received (see outbox.ts). This is
  // the one entry on this list that guards a message the user TYPED rather than one the client
  // synthesised, and it is the reason the bug existed: an optimistic user bubble carried no
  // client-only flag, so `messages = incoming` in loadChat deleted it on the next reconnect — which
  // is every gateway restart. The prompt then existed nowhere: not on screen, not on the server.
  // It is cleared the moment chat.send resolves, so a DELIVERED prompt is never preserved twice.
  "_undelivered",
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
  return false;
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
    // An unusable anchor becomes the largest possible turn, i.e. the tail — same reasoning as the
    // not-found branch of `turnAnchorOf`.
    const turn =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(0, Math.floor(raw))
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
