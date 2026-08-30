// FORK 2026-08-16 — bug (the architect): "when you are changing the UI while I send prompts to Jarvis,
// sometimes the prompt that I wrote gets forgotten. It does not show in the UI history, Jarvis
// does not acknowledge it or respond it, and I just wasted my time."
//
// THE DEFECT this module closes. A typed prompt used to exist in exactly two volatile places
// between pressing enter and the gateway accepting it:
//   1. `messages[]` — an optimistic user bubble; and
//   2. the composer draft — which `send()` had already blanked.
// Neither survives the window, and the window is wide:
//   • `send()` awaits `buildInjectedPrompt(text)` BEFORE it builds the bubble, so a page reload
//     (every vite rebuild of any UI file HMR-reloads the page) in that slice loses the text with
//     no trace at all — no bubble, no draft write, no catch block;
//   • `req()` rejects "disconnected" the instant the socket is not OPEN, and the gateway's own
//     close handler rejects every in-flight request — so a gateway restart fails the send. The
//     only handling was `console.error(e)`: silent to the user;
//   • a frame handed to an OPEN-but-dying socket is dropped by the browser with no error at all;
//   • and the killer — the optimistic user bubble is NOT a client-only bubble, so the very next
//     `loadChat()` (which runs on EVERY ws reconnect) executes `messages = incoming` and deletes
//     it. That is verbatim the reported symptom: the prompt vanishes from the history and Jarvis
//     never answers it.
//
// THE FIX: a durable outbox. The prompt is written to localStorage SYNCHRONOUSLY, before any
// await and before any network call, and is removed ONLY on positive proof that the gateway has
// it — i.e. it appears in the server transcript. Anything still unproven is re-sent on reconnect
// and on page load, reusing the ORIGINAL idempotencyKey so a replay cannot double-run a turn the
// gateway already accepted.
//
// Pure (DOM-free, global-free) so the rules can be unit-tested — app.ts is an un-testable browser
// entry. Same extraction precedent as queued-sends.ts and retry-lifecycle.ts.

export const OUTBOX_STORAGE_KEY = "tinker-outbox";

/** Hard cap. The outbox is a safety net, not an archive; an unbounded list would eventually
 *  exceed the localStorage quota and start throwing on the very write that protects a prompt. */
export const OUTBOX_MAX = 50;

/** How long a prompt may sit unconfirmed before a replay is allowed. Sized above the measured
 *  chat.send round trip (~0.8s) so the normal path confirms first and never replays. */
export const OUTBOX_REPLAY_GRACE_MS = 15_000;

/** Give up automatic replay after this many attempts. The entry is KEPT (and still rendered as
 *  undelivered, with a manual retry) — dropping it would be the data loss this module exists to
 *  prevent. Only the automatic re-sending stops. */
export const OUTBOX_MAX_ATTEMPTS = 8;

export type OutboxEntry = {
  /** The `clientMsgId` of the user bubble AND the gateway `idempotencyKey`. Stable across every
   *  replay: that is what makes a replay safe rather than a duplicate turn. */
  id: string;
  sessionKey: string;
  /** The RAW text the user typed — never the injected prompt. A replay re-derives the injection,
   *  so a prompt cannot be re-sent with a stale amygdala/fractal preamble. */
  text: string;
  /** When the user pressed enter (ms epoch). */
  ts: number;
  /** How many times this entry has been handed to the transport. */
  attempts: number;
  /** Last transport attempt (ms epoch), or 0 if never attempted. */
  lastAttemptAt: number;
};

/** The 3 localStorage methods this module uses — injected so the rules are testable without a DOM. */
export type OutboxStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function isEntry(v: unknown): v is OutboxEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.sessionKey === "string" &&
    typeof r.text === "string" &&
    typeof r.ts === "number"
  );
}

/**
 * Read the persisted outbox. NEVER throws: this runs on the send path and on boot, and a parse
 * failure must degrade to "no pending prompts", not to a broken composer.
 */
export function readOutbox(store: OutboxStore): OutboxEntry[] {
  let raw: string | null = null;
  try {
    raw = store.getItem(OUTBOX_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry).map((e) => ({
      ...e,
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      lastAttemptAt: typeof e.lastAttemptAt === "number" ? e.lastAttemptAt : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Persist the outbox. NEVER throws — a full/disabled localStorage must not break sending. Returns
 * whether the write actually landed, so a caller can tell "protected" from "best effort".
 */
export function writeOutbox(store: OutboxStore, entries: OutboxEntry[]): boolean {
  const capped = entries.length > OUTBOX_MAX ? entries.slice(entries.length - OUTBOX_MAX) : entries;
  try {
    store.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(capped));
    return true;
  } catch {
    // FORK 2026-08-16 (2nd pass) — a QUOTA failure here silently disarms the whole safety net, and
    // this origin accumulates months of drafts, tab state and per-session EEG stores, so a full
    // localStorage is a live possibility rather than a theoretical one. Shed the OLDEST half and
    // try once more: protecting the prompt just typed matters more than retaining old ones that,
    // by definition, are still unconfirmed but far less likely to be recoverable anyway.
    try {
      const shrunk = capped.slice(Math.floor(capped.length / 2));
      store.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(shrunk));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Record a prompt as pending BEFORE it is sent. Call this synchronously from the enter handler,
 * ahead of every await — the whole point is that the prompt is on disk before anything that can
 * fail, reload, or disconnect happens.
 *
 * Idempotent on `id` so a replay path can call it freely.
 */
export function enqueueOutbox(
  store: OutboxStore,
  entry: Pick<OutboxEntry, "id" | "sessionKey" | "text" | "ts">,
): boolean {
  const entries = readOutbox(store);
  if (entries.some((e) => e.id === entry.id)) {
    return true;
  }
  entries.push({ ...entry, attempts: 0, lastAttemptAt: 0 });
  return writeOutbox(store, entries);
}

/** Drop one entry — call ONLY on proof of delivery. */
export function removeFromOutbox(store: OutboxStore, id: string): void {
  const entries = readOutbox(store);
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) {
    writeOutbox(store, next);
  }
}

/** Note that an entry has just been handed to the transport (bumps attempts + lastAttemptAt). */
export function markAttempted(store: OutboxStore, id: string, now: number): void {
  const entries = readOutbox(store);
  let touched = false;
  for (const e of entries) {
    if (e.id === id) {
      e.attempts += 1;
      e.lastAttemptAt = now;
      touched = true;
    }
  }
  if (touched) {
    writeOutbox(store, entries);
  }
}

/** Entries belonging to one session, oldest first. */
export function outboxForSession(
  entries: readonly OutboxEntry[],
  sessionKey: string | undefined,
  matches: (a: string | undefined, b: string | undefined) => boolean,
): OutboxEntry[] {
  if (!sessionKey) {
    return [];
  }
  return entries
    .filter((e) => e.sessionKey === sessionKey || matches(e.sessionKey, sessionKey))
    .slice()
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Which outbox entries still need an "undelivered" bubble drawn for them.
 *
 * FORK 2026-08-28 — bug (the architect): every DEFERRED prompt was painted TWICE. The 5 s outbox backstop
 * (`reinjectOutboxBubbles` in app.ts) skipped an entry only when
 * `messages.some((m) => m._clientMsgId === entry.id)`. But a deferred prompt is deliberately held
 * OUT of `messages[]` — it lives in `pendingQueuedSends` until the turn it is waiting on finishes —
 * while its outbox entry legitimately survives until `chat.history` proves delivery. So within 5 s
 * of any deferred send a SECOND copy of the same text was pushed into `messages[]` carrying
 * `_undelivered: true`, and the architect saw a solid amber "not delivered - will retry" bubble beside the
 * dimmed grey deferred one: a duplicate bubble AND a false lost-prompt alarm for a prompt the
 * gateway had already acked.
 *
 * The fix is to ask ONE question against the FULL set of ids already represented on screen —
 * `messages[]` AND `pendingQueuedSends` — instead of interrogating `messages[]` alone.
 *
 * CRITICAL INVARIANT — this suppresses a BUBBLE, never an ENTRY. Nothing here may remove, retire or
 * rewrite an outbox entry; only `reconcileWithHistory` may, and only on proof that the transcript
 * holds the prompt. An ack is NOT durability: two gateway restarts on 2026-08-24 destroyed prompts
 * through exactly the "it is on screen, so it must be safe to drop" shortcut.
 *
 * Empty / undefined `presentIds` means "nothing is on screen yet" → every entry still needs a
 * bubble (the page-load / reconnect case). Drawing one bubble too many is the SAFE direction on
 * this path; hiding a prompt is not, and that asymmetry is why there is no clever fallback here.
 *
 * Pure, non-mutating and order-preserving; entries come back BY REFERENCE so the caller can act on
 * them by identity. `presentIds` is any iterable of ids — a `Set` is used as-is, a plain array is
 * accepted for call-site convenience — and a non-string member simply never matches, because an
 * entry id is always a non-empty string (see `isEntry`).
 *
 * It deliberately does NOT re-derive session scope: the caller has already run `outboxForSession`,
 * and giving the render path a second opinion about tab scope is the mistake run-state.ts exists to
 * end ("ONE PREDICATE — no surface re-derives liveness", quoted in queued-sends.ts).
 */
export function outboxEntriesNeedingBubble(
  entries: readonly OutboxEntry[],
  presentIds: Iterable<string> | null | undefined,
): OutboxEntry[] {
  if (!presentIds) {
    return entries.slice();
  }
  // A Set is used directly rather than copied: this runs on a 5 s timer against every id currently
  // on screen. There is deliberately no separate "nothing on screen" branch — an empty set removes
  // nothing and `filter` already returns a fresh array, so a second early return would only invite
  // the next reader to hunt for a semantic difference that does not exist.
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds);
  return entries.filter((e) => !present.has(e.id));
}

/**
 * The text of a user message as the SERVER stores it, reduced for comparison.
 *
 * The gateway persists the INJECTED prompt (user text + amygdala/fractal suffix) as the message
 * body, so a server copy is the client text plus a suffix — never equal to it. Comparison is
 * therefore prefix-based, on whitespace-collapsed text.
 */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A USER message as served by `chat.history`. `ts` is the transcript timestamp when present. */
export type HistoryUserMsg = { idempotencyKey?: unknown; text: string; ts?: unknown };

/**
 * Clock skew allowed between the browser that stamped `entry.ts` and the gateway that stamped the
 * transcript timestamp. Generous: being a minute too lenient risks one duplicate send, being too
 * strict risks never confirming at all.
 */
export const MATCH_SKEW_MS = 60_000;

/**
 * How far back from the END of the transcript a TEXT match may look. Only used when the message
 * carries no usable timestamp; see reconcileWithHistory.
 */
export const PREFIX_MATCH_TAIL = 8;

/**
 * Does this server-side user message correspond to this outbox entry?
 *
 * Exact when the transcript carries the `idempotencyKey` we sent (the gateway stamps it as of
 * 2026-08-16). A key cannot collide, so a keyed match is trusted at any age.
 *
 * REGRESSION FIX 2026-08-16 (the architect: "I am still missing prompts"). The text fallback used to be
 * unbounded in time, and that turned this function into a way to LOSE a prompt: re-sending
 * something you had sent before was instantly "confirmed" by the OLD copy, so the entry was
 * dropped from the outbox, un-flagged, and then deleted from the transcript by the next loadChat —
 * exactly the vanishing the outbox exists to prevent. the architect demonstrably resends identical text
 * (the same "executive summary" prompt at 23:56 and again at 00:11), so a turn CANNOT confirm a
 * prompt that was typed after it happened.
 */
export function historyMatchesEntry(historyMsg: HistoryUserMsg, entry: OutboxEntry): boolean {
  if (typeof historyMsg.idempotencyKey === "string" && historyMsg.idempotencyKey.length > 0) {
    return historyMsg.idempotencyKey === entry.id;
  }
  const want = normalizeForMatch(entry.text);
  if (!want) {
    return false;
  }
  const got = normalizeForMatch(historyMsg.text);
  if (got !== want && !got.startsWith(want)) {
    return false;
  }
  const ts = typeof historyMsg.ts === "number" ? historyMsg.ts : null;
  if (ts !== null && ts < entry.ts - MATCH_SKEW_MS) {
    return false; // this turn predates the prompt; it cannot be this prompt
  }
  return true;
}

/**
 * Reconcile the outbox against the session transcript the server just served.
 *
 * Returns the ids to DROP (proven delivered) and the entries that remain unproven. Matching is
 * one-to-one and consuming: the same history message can confirm only ONE entry, so deliberately
 * sending the identical text twice still leaves the second copy protected rather than having it
 * silently confirmed by the first.
 *
 * `historyUserMsgs` must be the USER messages of the session, in transcript order.
 */
export function reconcileWithHistory(
  entries: readonly OutboxEntry[],
  historyUserMsgs: ReadonlyArray<HistoryUserMsg>,
): { delivered: OutboxEntry[]; pending: OutboxEntry[] } {
  const consumed = new Set<number>();
  const delivered: OutboxEntry[] = [];
  const pending: OutboxEntry[] = [];
  // A TEXT match may only come from the tail of the transcript. Timestamps are the real guard
  // (see historyMatchesEntry), but a transcript row can lack one, and without either rule an
  // identical prompt from weeks ago silently confirms — and thereby deletes — a prompt typed a
  // second ago. A just-delivered turn is at the END of history by construction, so nothing
  // legitimate is lost by refusing to look further back.
  const tailStart = Math.max(0, historyUserMsgs.length - PREFIX_MATCH_TAIL);
  for (const entry of entries) {
    let hit = -1;
    for (let i = 0; i < historyUserMsgs.length; i++) {
      if (consumed.has(i)) {
        continue;
      }
      const msg = historyUserMsgs[i];
      const keyed = typeof msg.idempotencyKey === "string" && msg.idempotencyKey.length > 0;
      if (!keyed && i < tailStart) {
        continue; // text matches are tail-only
      }
      if (historyMatchesEntry(msg, entry)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      consumed.add(hit);
      delivered.push(entry);
    } else {
      pending.push(entry);
    }
  }
  return { delivered, pending };
}

/**
 * Which unproven entries may be re-sent right now.
 *
 * An entry is due when it has waited out the grace period since its last attempt (so the normal
 * fast path confirms before any replay) and has not exhausted its automatic attempts. Exhausted
 * entries are NOT returned and NOT dropped — they stay visible with a manual retry.
 */
// ─── Append-only prompt journal ──────────────────────────────────────────────────────────────
//
// FORK 2026-08-16, second pass (the architect: "I am still missing prompts", after the outbox shipped).
//
// The outbox is DELIVERY state: entries are added and, necessarily, removed. Every removal is a
// judgement call, and the first version of that judgement was wrong in a way that DELETED prompts
// (see historyMatchesEntry). A safety net whose own bookkeeping can destroy the thing it protects
// is not a safety net.
//
// So: a second store that is append-only and that NOTHING in the delivery path may remove. Every
// prompt is written here the instant enter is pressed. Delivery can then be as clever or as wrong
// as it likes; the text the architect typed is still on disk, timestamped, and readable. This is the store
// that makes "whatever goes in the chat stays" true independently of whether the send worked.

export const JOURNAL_STORAGE_KEY = "tinker-prompt-journal";

/** Journal depth. Large enough to cover days of normal use, small enough for localStorage. */
export const JOURNAL_MAX = 300;

export type JournalEntry = { id: string; sessionKey: string; text: string; ts: number };

/** Read the append-only journal, newest last. Never throws. */
export function readJournal(store: OutboxStore): JournalEntry[] {
  try {
    const raw = store.getItem(JOURNAL_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter(isEntry) as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append a prompt to the journal. Called from the send path BEFORE any await, alongside the outbox
 * enqueue. Deduped on id so a replay cannot double-record. Only the oldest are ever shed, and only
 * on overflow — never because anything decided the prompt was "done".
 */
export function appendJournal(store: OutboxStore, entry: JournalEntry): void {
  try {
    const all = readJournal(store);
    if (all.some((e) => e.id === entry.id)) {
      return;
    }
    all.push(entry);
    while (all.length > JOURNAL_MAX) {
      all.shift();
    }
    store.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / disabled storage — the outbox and draft ring remain */
  }
}

export function dueForReplay(
  entries: readonly OutboxEntry[],
  now: number,
  graceMs: number = OUTBOX_REPLAY_GRACE_MS,
  maxAttempts: number = OUTBOX_MAX_ATTEMPTS,
): OutboxEntry[] {
  return entries.filter((e) => {
    if (e.attempts >= maxAttempts) {
      return false;
    }
    const since = e.lastAttemptAt || e.ts;
    return now - since >= graceMs;
  });
}
