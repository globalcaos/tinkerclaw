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
// gateway already accepted — until the gateway acks it or its automatic replays are spent
// (`dueForReplay`). Either way the entry itself stays until that proof, or the owner's Dismiss.
//
// Pure (DOM-free, global-free) so the rules can be unit-tested — app.ts is an un-testable browser
// entry. Same extraction precedent as queued-sends.ts and retry-lifecycle.ts.

import { cursorOf, type HistoryWindow } from "./history-window.js";

export const OUTBOX_STORAGE_KEY = "tinker-outbox";

/** Hard cap. The outbox is a safety net, not an archive; an unbounded list would eventually
 *  exceed the localStorage quota and start throwing on the very write that protects a prompt. */
export const OUTBOX_MAX = 50;

/** How long a prompt may sit unconfirmed before a replay is allowed. Sized above the measured
 *  chat.send round trip (~0.8s) so the normal path confirms first and never replays. */
export const OUTBOX_REPLAY_GRACE_MS = 15_000;

/** Give up automatic replay after this many attempts. The entry is KEPT, because dropping it would be
 *  the data loss this module exists to prevent; only the automatic re-sending stops. The bubble then
 *  reads LOST (`not in history`, prompt-state.ts) and offers the owner Resend and Dismiss (step U4,
 *  2026-09-24). prompt-state.ts imports this number, so it has one owner. */
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
  /**
   * When the gateway ACKED this id (ms epoch), or absent if it never has.
   *
   * FORK 2026-09-04 (the architect: "there is a bug that makes it delete it somehow" — four prompts
   * gone in one morning). An ack is NOT proof of durability, and the send path has said so since
   * 2026-08-24. But it IS proof the gateway holds this idempotencyKey, which makes re-sending it
   * pointless: the dedupe cache just echoes `{status:"ok"}` for a run that already finished.
   *
   * The replay path used to resolve that contradiction by DELETING the entry on the echo — the
   * exact anti-pattern the send path had removed. So the sequence that ate the architect's prompts
   * was: turn accepted but never persisted -> unprovable -> replayed after 15s -> dedupe echoes ok
   * -> entry destroyed, last copy gone.
   *
   * The honest resolution is to stop REPLAYING without stopping PROTECTING. An acked entry is
   * parked, not retired: only transcript proof (`reconcileWithHistory`) or the owner's Dismiss
   * (`dismissOutboxEntry`, step U4) may retire it. A reconnect does not re-arm it: the socket
   * changing says nothing about whether the accepted turn ran, and replaying after the gateway's
   * short-lived dedupe cache expires can execute real work a second time. If the transcript never
   * proves the turn, the parked copy stays visible, and once the gateway's evidence says no holder
   * has it, it reads LOST with the owner's Resend (a NEW key: this one is never sent again) and
   * Dismiss (FORK 2026-09-24, prompt-queue.md U4).
   */
  ackedAt?: number;
  /**
   * FORK 2026-09-08 — IDENTITY, NEVER TEXT. `true` on every entry created since the gateway
   * started serving `idempotencyKey` back on the user rows it persists (chat.history, same change).
   * For such an entry the ONLY admissible proof of delivery is a served row whose key equals `id`;
   * the text-prefix fallback in `historyMatchesEntry` is closed to it.
   *
   * Why the field exists: the keyed match had never once fired — the gateway accepted the key on
   * chat.send and never wrote it to the transcript — so the text fallback over the last
   * PREFIX_MATCH_TAIL user rows decided everything. In a cc-bridge session most user rows are
   * tool_result-only or system-injected (session mtjwloe0: 10 of 19 user rows carried only tool
   * results; the tail-8 held 4 of them). A real prompt fell out of that window, was never confirmed,
   * was re-armed on every reconnect (24-69 a day) and re-sent until OUTBOX_MAX_ATTEMPTS — answered
   * twice. No heuristic on the text path fixes that; only an identity the server hands back does.
   *
   * Absent (or anything but a literal `true`) means a LEGACY entry written before the key was
   * served. Those keep the text fallback, unchanged and unwidened, because a key can never arrive
   * for them. Stamped by `enqueueOutbox` and by nothing else.
   */
  keyedProofExpected?: boolean;
  /**
   * FORK 2026-09-23 — when this session's outbox proof (chat.history) was last fetched, ms epoch.
   * Lets `outboxSessionsNeedingProof` stop re-fetching a session's WHOLE transcript on every 20s
   * tick once nothing in it is due for replay: an acked/unprovable entry used to force that fetch
   * forever, with no upper bound, which is what saturated the gateway event loop. Absent (or any
   * non-number) means "never checked" and is always stale. Stamped by `markProofChecked`.
   */
  lastProofCheckAt?: number;
  /**
   * FORK 2026-09-23 (chat.history rehaul, plan task 8) — the tab's cursor window when the prompt was
   * typed: the last transcript seq it held, and the epoch that seq was numbered under. Lets the
   * proof read ask for the rows AFTER the send (`outboxProofRequest`) instead of the last 200, so a
   * prompt pushed out of the tail by later rows is still proven. Stamped at enqueue only when the
   * tab had a cursor window; absent means "unknown" and keeps the tail read. A seq means nothing
   * without its epoch, so the two are only ever used together.
   */
  sentAfterSeq?: number;
  sentEpoch?: string;
  /**
   * FORK 2026-09-24 — the key of the prompt this entry RE-SENDS. Set by exactly two producers:
   *   - prompt-queue.md U4: the owner's explicit RESEND of the LOST prompt with this id;
   *   - prompt-queue.md U5 (contradiction C8): one fire of the recoverable-error retry ladder
   *     (`enqueueLadderRetry`), naming the prompt the owner typed (§2: "RETRYING → SENDING: ladder
   *     fires — a NEW prompt linked by retryOf").
   * Either way the entry travels under its OWN id, a new key: the original's would be absorbed by
   * the gateway's dedupe cache, which only echoes the finished run, so a re-send never reuses the key
   * it replaces (enqueueOutbox refuses that).
   *
   * A LINK, never a state: nothing derives an indicator from it, and it changes nothing about how
   * the entry is replayed, proven or retired. The entry is proven by a row keyed with its own `id`,
   * like any other. Absent on every typed prompt, and whenever the ladder could not name the
   * original (a row that carried no key the page could read).
   */
  retryOf?: string;
  /**
   * FORK 2026-09-25 — when the prompt's OWN run ended `aborted` (ms epoch): the owner's Stop, or a
   * sessions.delete / sessions.reset that aborted its key (queued-sends.ts `ownRunTerminal`).
   * Stamped by `markCancelled` alone, whose one caller is app.ts notePromptTerminal, and not when a
   * bubble of the prompt already recorded its run's `final` (PQ-6: the first own-run terminal
   * stands).
   *
   * THE DEFECT it ends. The stop was a fact on the page's bubble and nowhere else, so a reload
   * re-drew an acked, unproven entry from `ackedAt` alone: LOST, with a Resend of the prompt the
   * owner had just stopped (the known limit a891a143865 left in msg-order.ts `outboxPromptFacts`,
   * which now reads this). prompt-queue.md PQ-11: state survives the tab.
   *
   * A FACT, never a retirement: the entry stays until transcript proof or the owner's Dismiss
   * (PQ-9). PROOF ignores it — a stopped prompt is still in the transcript, and a keyed row retires
   * it like any other. REPLAY does NOT (corrected 2026-09-25, same day): `dueForReplay` refuses a
   * cancelled entry, because re-sending would run the very turn the stop ended. The `ackedAt` park
   * does not already cover that: an aborted run was accepted, but the ACK is what a page can miss (a
   * socket that dropped before chat.send's reply came back), and only then is a stopped entry still
   * due. readOutbox passes it through with the rest of the entry, so a reader accepts it only as a
   * number.
   */
  cancelledAt?: number;
  /**
   * FORK 2026-10-01 — when the prompt's OWN run delivered its successful `final` (ms epoch): the
   * answer, recorded on the entry. Stamped by `markAnswered` alone, whose one caller is app.ts
   * notePromptTerminal, and only for a `final` that carries no failure outcome: a failed or error
   * final answered nothing. The first own-run outcome stands (PQ-6): an entry already stopped
   * (`cancelledAt`) is never stamped answered, and `markCancelled` never stamps an answered one.
   *
   * THE DEFECT it ends (bug-log.md [chat-divergence], cause 1, client half). The answer was a fact
   * on the page's bubble and nowhere else, and a fresh history merge throws that bubble away. An
   * entry nothing proves (a session's FIRST prompt is never keyed in the transcript) was then
   * re-drawn from disk on every load as LOST beside its served row: one prompt, two bubbles, and a
   * Resend that would re-run an answered prompt. It also kept its session's transcript read every
   * PROOF_RECHECK_MS, up to OUTBOX_CURSOR_PROOF_LIMIT rows a time, for good.
   *
   * A FACT, never a retirement (PQ-9): the entry stays until keyed transcript proof or the owner's
   * Dismiss. The stamp changes what the entry COSTS: no bubble (`outboxEntriesNeedingBubble`), no
   * replay (`dueForReplay`), no proof read of its own (`outboxSessionsNeedingProof`), and never
   * LOST (prompt-state.ts `gatewayHolderFacts`). A read made for another entry of its session still
   * reconciles it, so keyed proof still retires it. readOutbox keeps the stamp only as a finite
   * number. Anything else reads as "not answered", the safe direction: a prompt drawn once too
   * often costs a glance, and a hidden one costs the prompt.
   */
  answeredAt?: number;
};

/**
 * The localStorage methods this module uses — injected so the rules are testable without a DOM —
 * plus one optional observer.
 *
 * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/logging.md §4.5, §9 step 7) — `onTransition` is told of
 * every transition this module WRITES (see OutboxTransition). app.ts's store forwards it to
 * event-ingest.ts as a `ui.outbox.state` row. It is optional so that a store that records nothing
 * (every unit-test fake) stays two methods; event-ingest.test.ts pins app.ts's store to carry it, so
 * it cannot go missing there silently. It is called only after the write landed, and a throw from
 * it is swallowed: telemetry must never break a send.
 */
export type OutboxStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  onTransition?(t: OutboxTransition): void;
};

/**
 * FORK 2026-09-24 — logging.md §4.5 `ui.outbox.state`: the catalog row's closed `to_state` set, in
 * the catalog's order (event-ingest.test.ts holds the two equal). What produces each:
 *   queued    enqueueOutbox persisted a NEW entry: a typed prompt, an owner's Resend, a ladder fire;
 *   replayed  markAttempted. Its one caller is app.ts resendOutboxEntry: every automatic replay, and
 *             a ladder fire's first send, which IS a re-send of the prompt it names;
 *   acked     markAcked, on the entry's FIRST ack;
 *   proven    removeFromOutbox, whose one caller is the transcript reconcile (proof `transcript`);
 *   gave_up   the entry left the outbox WITHOUT transcript proof: the owner's Dismiss (proof
 *             `dismissed`), the old half of a Resend (`resent`), or the cap / quota shed in
 *             persistOutbox (`shed`);
 *   attempted has NO producer: `attempts` counts replays only, and send()'s first chat.send writes
 *             nothing here. That hand-off is the prompt's SENDING state, which `ui.prompt.state`
 *             records. It stays in the set because the catalog declares it.
 * An entry that leaves through this module's writes therefore ends in exactly one of proven and
 * gave_up. Two losses stay OUTSIDE the record, because neither has an entry to report: readOutbox
 * drops a stored row that is not an entry (`isEntry`), and a store that does not parse is read as
 * empty (its bytes kept at OUTBOX_CORRUPT_KEY), so the next write replaces it. A `queued` count
 * above proven + gave_up + the entries still held is how either shows.
 * No row, because no state changes: markProofChecked (it stamps when proof was last looked for,
 * although logging.md §4.5 lists it among the emitters), markCancelled and markAnswered (a stop or
 * an answer is the PROMPT's terminal, which `ui.prompt.state` records; the entry's delivery state
 * does not move), and replays running out (the entry stays, and nothing about it is written). The
 * latter shows as the prompt's UNSENT → LOST in
 * `ui.prompt.state`; the replay count is the `n1` (attempts) of the entry's last `replayed` row,
 * joined on run_id.
 */
export const OUTBOX_TRANSITION_STATES = Object.freeze([
  "queued",
  "attempted",
  "acked",
  "proven",
  "replayed",
  "gave_up",
] as const);
export type OutboxTransitionState = (typeof OUTBOX_TRANSITION_STATES)[number];

/** `from` also allows "none": the entry did not exist before this transition. */
export const OUTBOX_TRANSITION_FROM = Object.freeze(["none", ...OUTBOX_TRANSITION_STATES] as const);

/** What retired an entry: a transcript row, the owner's Dismiss or Resend, or the cap / quota shed. */
export const OUTBOX_RETIREMENT_PROOFS = Object.freeze([
  "transcript",
  "dismissed",
  "resent",
  "shed",
] as const);
export type OutboxRetirementProof = (typeof OUTBOX_RETIREMENT_PROOFS)[number];

/**
 * One transition, as `onTransition` receives it. No text and no session key. `id` is the entry's
 * key; event-ingest.ts sends it as the row's run_id (the catalog's "run_id=the entry id") only when
 * it is a UUID, which every key app.ts mints is.
 */
export type OutboxTransition = {
  id: string;
  to: OutboxTransitionState;
  from: OutboxTransitionState | "none";
  /** The entry's `attempts` after the transition. */
  attempts: number;
  /** The entry's `ts`: when the owner pressed Enter. The row's age is measured from it. */
  typedAt: number;
  proof?: OutboxRetirementProof;
};

/** The state an entry's stored fields put it in, as the `from` of its next transition. */
function outboxStateOf(e: OutboxEntry): OutboxTransitionState {
  if (e.ackedAt !== undefined) {
    return "acked";
  }
  return e.attempts > 0 ? "replayed" : "queued";
}

/** Tell the store's observer, if it has one. Never throws. */
function reportTransition(
  store: OutboxStore,
  e: OutboxEntry,
  to: OutboxTransitionState,
  from: OutboxTransitionState | "none",
  proof?: OutboxRetirementProof,
): void {
  try {
    if (typeof store.onTransition !== "function") {
      return;
    }
    store.onTransition({
      id: e.id,
      to,
      from,
      attempts: e.attempts,
      typedAt: e.ts,
      ...(proof !== undefined ? { proof } : {}),
    });
  } catch {
    /* telemetry never breaks the send path */
  }
}

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
 * FORK 2026-10-01 — the prompt's OWN run answered it (`OutboxEntry.answeredAt`, `markAnswered`).
 * Only a finite number counts: a stamp that cannot be read must never hide a prompt.
 */
function isAnswered(e: { answeredAt?: unknown }): boolean {
  return typeof e.answeredAt === "number" && Number.isFinite(e.answeredAt);
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
    return parsed.filter(isEntry).map(({ sentAfterSeq, sentEpoch, retryOf, answeredAt, ...e }) => ({
      ...e,
      // FORK 2026-09-24 (U4) — the Resend link reads back only as a non-empty string.
      ...(typeof retryOf === "string" && retryOf.length > 0 ? { retryOf } : {}),
      // FORK 2026-09-23 — a send-time cursor that does not read back as a seq + epoch is "unknown".
      ...(typeof sentAfterSeq === "number" && Number.isInteger(sentAfterSeq) && sentAfterSeq >= 0
        ? { sentAfterSeq }
        : {}),
      ...(typeof sentEpoch === "string" && sentEpoch.length > 0 ? { sentEpoch } : {}),
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      lastAttemptAt: typeof e.lastAttemptAt === "number" ? e.lastAttemptAt : 0,
      ...(typeof e.ackedAt === "number" ? { ackedAt: e.ackedAt } : {}),
      // FORK 2026-09-08 — only a literal `true` counts; a legacy row has no such field and must keep
      // reading as legacy (see OutboxEntry.keyedProofExpected). The consumer tests `=== true` too.
      ...(e.keyedProofExpected === true ? { keyedProofExpected: true } : {}),
      // FORK 2026-09-23 — round-trip the proof-check stamp same as ackedAt above, so an old stored
      // entry without it still loads (as "never checked", the safe default).
      ...(typeof e.lastProofCheckAt === "number" ? { lastProofCheckAt: e.lastProofCheckAt } : {}),
      // FORK 2026-10-01 — the answer stamp reads back only as a finite number; junk reads as "not
      // answered", so a stamp that cannot be read never hides a prompt (OutboxEntry.answeredAt).
      ...(isAnswered({ answeredAt }) ? { answeredAt } : {}),
    }));
  } catch {
    quarantineCorruptOutbox(store, raw);
    return [];
  }
}

/** Where an unparseable outbox is parked so its bytes are not lost. */
export const OUTBOX_CORRUPT_KEY = "tinker-outbox-corrupt";

/**
 * Preserve an outbox we could not parse.
 *
 * FORK 2026-09-04 — every mutator here is read-modify-write over `readOutbox`, so a parse failure
 * returning `[]` was not a read-only degradation: the very next `enqueueOutbox` wrote that `[]`
 * back as truth and the whole store — every unconfirmed prompt in it — ceased to exist. Returning
 * `[]` is still right for BEHAVIOUR (the composer must not break), but the bytes are copied aside
 * first so a human can still get the text back. Never throws; a failure here must not break a send.
 */
function quarantineCorruptOutbox(store: OutboxStore, raw: string): void {
  try {
    store.setItem(OUTBOX_CORRUPT_KEY, raw);
  } catch {
    /* full or disabled storage — nothing more we can do, and a send must still proceed */
  }
}

/**
 * Persist the outbox. NEVER throws — a full/disabled localStorage must not break sending. Returns
 * whether the write actually landed, so a caller can tell "protected" from "best effort".
 */
export function writeOutbox(store: OutboxStore, entries: OutboxEntry[]): boolean {
  return persistOutbox(store, entries).ok;
}

/**
 * writeOutbox's body, which also says which entries it SHED to make the write land.
 *
 * FORK 2026-09-24 (logging.md §4.5) — the cap and the quota fallback below are the only paths in
 * this module that delete an UNPROVEN prompt, and they did it without a trace. Each shed entry is
 * now reported as `gave_up` with proof `shed`, once the write that shed it has landed, and a
 * mutator reports nothing more for an entry it just watched being shed.
 */
function persistOutbox(
  store: OutboxStore,
  entries: OutboxEntry[],
): { ok: boolean; shed: readonly OutboxEntry[] } {
  const over = Math.max(0, entries.length - OUTBOX_MAX);
  const capped = over > 0 ? entries.slice(over) : entries;
  let shed: OutboxEntry[];
  try {
    store.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(capped));
    shed = entries.slice(0, over);
  } catch {
    // FORK 2026-08-16 (2nd pass) — a QUOTA failure here silently disarms the whole safety net, and
    // this origin accumulates months of drafts, tab state and per-session EEG stores, so a full
    // localStorage is a live possibility rather than a theoretical one. Shed the OLDEST half and
    // try once more: protecting the prompt just typed matters more than retaining old ones that,
    // by definition, are still unconfirmed but far less likely to be recoverable anyway.
    try {
      const cut = Math.floor(capped.length / 2);
      store.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(capped.slice(cut)));
      shed = [...entries.slice(0, over), ...capped.slice(0, cut)];
    } catch {
      return { ok: false, shed: [] };
    }
  }
  // Reported AFTER the write and outside its try: a fault in telemetry must never read as a full
  // disk and send the quota fallback shedding a healthy outbox.
  for (const e of shed) {
    reportTransition(store, e, "gave_up", outboxStateOf(e), "shed");
  }
  return { ok: true, shed };
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
  entry: Pick<OutboxEntry, "id" | "sessionKey" | "text" | "ts"> &
    Partial<Pick<OutboxEntry, "sentAfterSeq" | "sentEpoch" | "retryOf">>,
): boolean {
  // FORK 2026-09-24 (U4) — a Resend travels under a NEW key. An entry that names itself as the
  // prompt it re-sends would be the old key going out again, which the gateway's dedupe cache only
  // echoes (65ba434b5c9). Refused, and nothing is written.
  if (entry.retryOf !== undefined && entry.retryOf === entry.id) {
    return false;
  }
  const entries = readOutbox(store);
  if (entries.some((e) => e.id === entry.id)) {
    return true;
  }
  // FORK 2026-09-08 — every entry born here expects the gateway to hand its key back on the
  // persisted user row, so text can never confirm it (see OutboxEntry.keyedProofExpected). Stamped
  // here and nowhere else: a caller cannot opt an entry out of identity proof.
  const created: OutboxEntry = {
    ...entry,
    attempts: 0,
    lastAttemptAt: 0,
    keyedProofExpected: true,
  };
  entries.push(created);
  const { ok, shed } = persistOutbox(store, entries);
  if (ok && !shed.includes(created)) {
    reportTransition(store, created, "queued", "none");
  }
  return ok;
}

/** One retry-ladder fire, as app.ts `retryLastTurn` hands it to `enqueueLadderRetry`. */
export type LadderRetryFire = {
  /** The FRESH gateway idempotencyKey the fire is sent under. It becomes the entry's `id`, so outbox
   *  id = bubble id = gateway key (PQ-1). Never the original's: see `enqueueLadderRetry`. */
  idempotencyKey: string;
  sessionKey: string;
  /** The RAW text, as for a typed prompt; the send path injects the preamble. */
  text: string;
  /** When the ladder fired (ms epoch). */
  ts: number;
  /** The key of the prompt this fire re-sends (`OutboxEntry.retryOf`). */
  retryOf?: string;
  sentAfterSeq?: number;
  sentEpoch?: string;
};

/**
 * FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step U5 (contradiction C8): ONE
 * retry-ladder fire, saved as a NEW protected prompt.
 *
 * THE DEFECT. The recoverable-error ladder (app.ts `retryLastTurn`) put its fire straight on the
 * wire: `chat.send` with a fresh key, the RAW text, and no entry here. A fire that met a closed
 * socket existed only in the page's in-memory ladder state, so a reload during the disconnect (every
 * vite rebuild HMR-reloads the page) lost it outright, and no transcript row could ever prove it. The
 * ladder runs precisely while the gateway is unwell, which is when that happens.
 *
 * THE FIX is send()'s ordering rule. The caller runs this synchronously, BEFORE its first await: the
 * entry and the append-only journal row are on disk under the fire's OWN fresh key, linked by
 * `retryOf` to the prompt it re-sends (the journal row carries the link too, as a Resend's does).
 * From there it is an ordinary outbox entry. It is sent by the one outbox send path (app.ts
 * `resendOutboxEntry`), replayed by the 20 s tick after a reload or a reconnect, proven by a
 * transcript row keyed with its id, and retired by that proof (or the owner's Dismiss) alone (PQ-9).
 *
 * REFUSED, and nothing written: an empty key, empty text, or a key equal to `retryOf`. The original's
 * key would be absorbed by the gateway's dedupe cache, which echoes the failed run, so such a fire
 * could only look sent.
 *
 * Returns the entry as the outbox now holds it, and whether the write landed. `persisted: false`
 * (full or disabled storage) still returns the entry, so the caller can send it best effort, as
 * send() does when `enqueueOutbox` fails. Nothing will replay such a fire, though, and the caller must
 * keep its own back-off. Never throws.
 */
export function enqueueLadderRetry(
  store: OutboxStore,
  fire: LadderRetryFire,
): { entry: OutboxEntry; persisted: boolean } | null {
  const { idempotencyKey: id, retryOf, ...rest } = fire;
  if (!id || id === retryOf || !fire.text.trim()) {
    return null;
  }
  const link = typeof retryOf === "string" && retryOf.length > 0 ? { retryOf } : {};
  const persisted = enqueueOutbox(store, { id, ...rest, ...link });
  appendJournal(store, { id, sessionKey: fire.sessionKey, text: fire.text, ts: fire.ts, ...link });
  const stored = persisted ? readOutbox(store).find((e) => e.id === id) : undefined;
  // Unpersisted: the in-memory copy the caller sends. `keyedProofExpected` is left off on purpose,
  // because enqueueOutbox is its only writer and no reconcile will ever read this copy.
  return { entry: stored ?? { id, ...rest, ...link, attempts: 0, lastAttemptAt: 0 }, persisted };
}

/**
 * Drop one entry — call ONLY on proof of delivery. Its one caller is app.ts markPromptDelivered,
 * reached only from the transcript reconcile, so the transition it reports is `proven` by the
 * transcript (logging.md §4.5).
 */
export function removeFromOutbox(store: OutboxStore, id: string): void {
  const entries = readOutbox(store);
  const gone = entries.filter((e) => e.id === id);
  if (gone.length === 0) {
    return;
  }
  if (
    persistOutbox(
      store,
      entries.filter((e) => e.id !== id),
    ).ok
  ) {
    for (const e of gone) {
      reportTransition(store, e, "proven", outboxStateOf(e), "transcript");
    }
  }
}

/**
 * Record that the gateway ACKED this id. Parks the entry against further replay WITHOUT retiring
 * it — see `OutboxEntry.ackedAt`. Retirement remains the exclusive privilege of transcript proof.
 */
export function markAcked(store: OutboxStore, id: string, now: number): void {
  const entries = readOutbox(store);
  const moved: Array<{ e: OutboxEntry; from: OutboxTransitionState }> = [];
  for (const e of entries) {
    if (e.id === id && e.ackedAt === undefined) {
      moved.push({ e, from: outboxStateOf(e) });
      e.ackedAt = now;
    }
  }
  persistAndReport(store, entries, moved, "acked");
}

/**
 * FORK 2026-09-25 — record that this prompt's OWN run ended `aborted`, so a reload re-draws it
 * CANCELLED rather than LOST (see `OutboxEntry.cancelledAt`; msg-order.ts `outboxPromptFacts`
 * reads it). A STAMP, never a retirement (PQ-9). The first stop stands (PQ-6): a second `aborted`
 * for the key moves nothing, and since 2026-10-01 neither does one for an entry whose own run
 * already answered it (`answeredAt`, see `markAnswered`): the first own-run outcome stands on disk
 * as it does on the bubble. No transition is reported, because the entry's delivery state does not
 * change (see OUTBOX_TRANSITION_STATES). A no-op for an id the outbox does not hold: proven,
 * dismissed, or a runId that is not a prompt's key.
 */
export function markCancelled(store: OutboxStore, id: string, now: number): void {
  const entries = readOutbox(store);
  let touched = false;
  for (const e of entries) {
    if (e.id === id && typeof e.cancelledAt !== "number" && !isAnswered(e)) {
      e.cancelledAt = now;
      touched = true;
    }
  }
  if (touched) {
    writeOutbox(store, entries);
  }
}

/**
 * FORK 2026-10-01 — record that this prompt's OWN run delivered its successful `final`, so a reload
 * neither re-draws it nor reads its session's transcript for it, and nothing derives it LOST (see
 * `OutboxEntry.answeredAt`; bug-log.md [chat-divergence], cause 1, client half). A STAMP, never a
 * retirement (PQ-9). The first own-run outcome stands (PQ-6): a second answer moves nothing, and
 * neither does an answer for an entry already stopped (`cancelledAt`). No transition is reported,
 * because the entry's delivery state does not change (see OUTBOX_TRANSITION_STATES). A no-op for an
 * id the outbox does not hold: proven, dismissed, or a runId that is not a prompt's key. Its one
 * caller, app.ts notePromptTerminal, decides what an answer is: a `final` that carries a failure
 * outcome is not one.
 */
export function markAnswered(store: OutboxStore, id: string, now: number): void {
  const entries = readOutbox(store);
  let touched = false;
  for (const e of entries) {
    if (e.id === id && !isAnswered(e) && typeof e.cancelledAt !== "number") {
      e.answeredAt = now;
      touched = true;
    }
  }
  if (touched) {
    writeOutbox(store, entries);
  }
}

/**
 * Note that an entry has just been handed to the transport (bumps attempts + lastAttemptAt). Its
 * one caller is app.ts resendOutboxEntry, so the transition it reports is `replayed` (logging.md
 * §4.5).
 */
export function markAttempted(store: OutboxStore, id: string, now: number): void {
  const entries = readOutbox(store);
  const moved: Array<{ e: OutboxEntry; from: OutboxTransitionState }> = [];
  for (const e of entries) {
    if (e.id === id) {
      moved.push({ e, from: outboxStateOf(e) });
      e.attempts += 1;
      e.lastAttemptAt = now;
    }
  }
  persistAndReport(store, entries, moved, "replayed");
}

/** Persist a mutator's change, then report each moved entry the write landed and did not shed. */
function persistAndReport(
  store: OutboxStore,
  entries: OutboxEntry[],
  moved: ReadonlyArray<{ e: OutboxEntry; from: OutboxTransitionState }>,
  to: OutboxTransitionState,
): void {
  if (moved.length === 0) {
    return;
  }
  const { ok, shed } = persistOutbox(store, entries);
  if (!ok) {
    return;
  }
  for (const { e, from } of moved) {
    if (!shed.includes(e)) {
      reportTransition(store, e, to, from);
    }
  }
}

/**
 * Record that this session's outbox proof (chat.history) was just fetched. Stamps EVERY entry for
 * `sessionKey`, matched exactly — the caller (`flushOutbox`) derives sessions straight from stored
 * entries' own `sessionKey`, so there is no alias to resolve here. See `outboxSessionsNeedingProof`.
 */
export function markProofChecked(store: OutboxStore, sessionKey: string, now: number): void {
  const entries = readOutbox(store);
  let touched = false;
  for (const e of entries) {
    if (e.sessionKey === sessionKey) {
      e.lastProofCheckAt = now;
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
 * Which outbox entries still need a bubble re-drawn for them (UNSENT or LOST since prompt-queue.md
 * step U2; app.ts `reinjectOutboxBubbles` draws it).
 *
 * FORK 2026-10-01 — never an ANSWERED entry (`answeredAt`, stamped when the prompt's own run
 * delivered its successful `final`). The page that watched the run drew the answer, and the served
 * history carries the turn. Re-drawing it from disk after a fresh merge is bug-log.md
 * [chat-divergence] cause 1: a LOST copy beside the served row, with a Resend that would re-run an
 * answered prompt. Like everything here, that suppresses the BUBBLE and leaves the ENTRY alone.
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
 * Empty / undefined `presentIds` means "nothing is on screen yet" → every unanswered entry still
 * needs a bubble (the page-load / reconnect case). Drawing one bubble too many is the SAFE
 * direction on this path; hiding a prompt is not, and that asymmetry is why there is no clever
 * fallback here. The answered exception rests on a recorded fact (its own run's answer), never on
 * a guess about what the screen shows.
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
  const unanswered = entries.filter((e) => !isAnswered(e));
  if (!presentIds) {
    return unanswered;
  }
  // A Set is used directly rather than copied: this runs on a 5 s timer against every id currently
  // on screen. There is deliberately no separate "nothing on screen" branch — an empty set removes
  // nothing and `filter` already returns a fresh array, so a second early return would only invite
  // the next reader to hunt for a semantic difference that does not exist.
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds);
  return unanswered.filter((e) => !present.has(e.id));
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
export type HistoryUserMsg = {
  idempotencyKey?: unknown;
  /** Keys of accepted sends whose run never persisted its own row (gateway, prompt-key-marker.ts). */
  supersededIdempotencyKeys?: unknown;
  text: string;
  ts?: unknown;
};

/**
 * FORK 2026-09-23 — the client half of the gateway's 2026-09-14 orphan fix, which had never been
 * built: the gateway lists `supersededIdempotencyKeys` on the row that followed an orphaned send
 * (a re-send of the same prompt, a supersede) and nothing here read it, so those entries sat under
 * "not delivered · will retry" forever. Identity AND text, as the gateway contract asks: the key
 * must be listed on this row, and the entry's text must appear in it (`includes`, not a prefix —
 * the served body leads with the timestamp envelope). Never consumes the row: the row's own
 * prompt is a different entry and must still be able to claim it.
 */
export function supersededRowCoversEntry(historyMsg: HistoryUserMsg, entry: OutboxEntry): boolean {
  const keys = historyMsg.supersededIdempotencyKeys;
  if (!Array.isArray(keys) || !keys.includes(entry.id)) {
    return false;
  }
  const want = normalizeForMatch(entry.text);
  return want.length > 0 && normalizeForMatch(historyMsg.text).includes(want);
}

/**
 * Clock skew allowed between the browser that stamped `entry.ts` and the gateway that stamped the
 * transcript timestamp. Generous: being a minute too lenient risks one duplicate send, being too
 * strict risks never confirming at all.
 */
export const MATCH_SKEW_MS = 60_000;

/**
 * How far back from the END of the transcript a TEXT match may look. Applies to EVERY text match,
 * on top of the timestamp guard in historyMatchesEntry (the code has always done both; an earlier
 * version of this comment claimed the tail was consulted only for rows without a timestamp).
 *
 * FORK 2026-09-08 — LEGACY ONLY. Text matching is closed to any entry carrying
 * `keyedProofExpected`; this window governs only entries written before the gateway served keys.
 * Deliberately NOT widened: in a cc-bridge session tool_result-only user rows crowd this tail
 * (4 of 8 in session mtjwloe0), which is why no text window could be made reliable and identity
 * replaced it. See reconcileWithHistory.
 */
export const PREFIX_MATCH_TAIL = 8;

/**
 * Does this server-side user message correspond to this outbox entry?
 *
 * Exact when the transcript carries the `idempotencyKey` we sent. A key cannot collide, so a keyed
 * match is trusted at any age and any position.
 *
 * CORRECTION 2026-09-08: this used to say "the gateway stamps it as of 2026-08-16". It did not —
 * chat.send ACCEPTED the key and the transcript never carried it, so this branch had never fired
 * once and the text fallback below decided every reconcile. The gateway persists and serves the key
 * as of 2026-09-08, and an entry that expects it (`keyedProofExpected`) is proven by NOTHING else.
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
  // FORK 2026-09-08 — IDENTITY, NEVER TEXT. An entry that expects its key back cannot be proven by
  // an unkeyed row: either the row is not this prompt, or it is and the key is not being served yet,
  // and in both cases the honest answer is "unproven". No text heuristic is consulted. Only a legacy
  // entry (written before the gateway served keys) may fall through to the prefix rule below.
  if (entry.keyedProofExpected === true) {
    return false;
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
 * `historyUserMsgs` must be ALL the USER messages of the session, in transcript order — including
 * tool_result-only and system-injected rows (FORK 2026-09-08). Those carry no key and no text, so
 * they never match anything; but filtering them out would move the legacy tail window, and content
 * filtering is precisely the heuristic the text path must not grow. A keyed row is consulted at
 * ANY position and ANY age; only the legacy text rule is confined to the tail.
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
        continue; // text matches are tail-only (and, for a keyedProofExpected entry, closed entirely
        // — historyMatchesEntry refuses every unkeyed row for it, wherever it sits)
      }
      if (historyMatchesEntry(msg, entry)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      consumed.add(hit);
      delivered.push(entry);
    } else if (historyUserMsgs.some((msg) => supersededRowCoversEntry(msg, entry))) {
      delivered.push(entry);
    } else {
      pending.push(entry);
    }
  }
  return { delivered, pending };
}

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

export type JournalEntry = {
  id: string;
  sessionKey: string;
  text: string;
  ts: number;
  /** FORK 2026-09-24 (U4) — this prompt is the owner's explicit Resend of that one (a NEW key). */
  retryOf?: string;
  /** FORK 2026-09-24 (U4) — when the owner retired this prompt's outbox entry (Dismiss, or the old
   *  half of a Resend). The row itself stays: the journal never loses a prompt. */
  dismissedAt?: number;
  /** FORK 2026-09-24 (U4) — the key of the new prompt a Resend sent this text under. */
  resentAs?: string;
};

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

/**
 * FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.1 / §7 step U4 (PQ-9, PQ-12).
 *
 * THE OWNER'S RETIREMENT of an outbox entry. PQ-9 allows exactly two: keyed transcript proof
 * (`reconcileWithHistory` → app.ts markPromptDelivered → `removeFromOutbox`), and this one. It is
 * reached only from an explicit click on a LOST prompt: Dismiss, or Resend once the NEW prompt is on
 * disk (`resentAs` names it).
 *
 * JOURNALED, and the journal row STAYS: text outlives every indicator. Before the entry leaves the
 * outbox, its journal row is stamped `dismissedAt` (and `resentAs`), re-appended first if the journal
 * no longer holds it (it sheds its oldest rows on overflow, and an entry can predate the journal). If
 * that write fails, NOTHING is retired and the answer is false: a dismissal the journal cannot record
 * would be the silent deletion this module exists to prevent.
 *
 * Also false, with nothing written, when there is no such entry, and when `resentAs` is the entry's
 * own key: a Resend travels under a NEW key (see enqueueOutbox).
 */
export function dismissOutboxEntry(
  store: OutboxStore,
  id: string,
  now: number,
  opts: { resentAs?: string } = {},
): boolean {
  const resentAs = opts.resentAs;
  if (resentAs !== undefined && (resentAs.length === 0 || resentAs === id)) {
    return false;
  }
  const entries = readOutbox(store);
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    return false;
  }
  if (!stampJournalRetirement(store, entry, now, resentAs)) {
    return false;
  }
  const retired = writeOutbox(
    store,
    entries.filter((e) => e.id !== id),
  );
  if (retired) {
    // logging.md §4.5: the owner gave up on this key, by Dismiss or by sending its text anew.
    reportTransition(
      store,
      entry,
      "gave_up",
      outboxStateOf(entry),
      resentAs !== undefined ? "resent" : "dismissed",
    );
  }
  return retired;
}

/** Record the owner's retirement on the entry's journal row. Never throws; false = not recorded. */
function stampJournalRetirement(
  store: OutboxStore,
  entry: OutboxEntry,
  now: number,
  resentAs: string | undefined,
): boolean {
  try {
    const raw = store.getItem(JOURNAL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return false; // not a journal this code wrote: never overwrite it
    }
    const rows = parsed as unknown[];
    let row = rows.find((r) => isEntry(r) && r.id === entry.id) as JournalEntry | undefined;
    if (!row) {
      row = { id: entry.id, sessionKey: entry.sessionKey, text: entry.text, ts: entry.ts };
      rows.push(row);
      while (rows.length > JOURNAL_MAX) {
        rows.shift();
      }
    }
    row.dismissedAt = now;
    if (resentAs !== undefined) {
      row.resentAs = resentAs;
    }
    store.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

/**
 * Which unproven entries may be re-sent right now.
 *
 * An entry is due when it has waited out the grace period since its last attempt (so the normal
 * fast path confirms before any replay), is not acked (see `ackedAt`: a replay could only draw the
 * dedupe echo), was not stopped (see `cancelledAt`), was not answered (see `answeredAt`), and has
 * not exhausted its automatic attempts. Entries that are not due are NOT
 * dropped; they stay in the outbox until a transcript proves them or the owner dismisses them. An
 * exhausted entry's bubble reads LOST (`not in history`) and offers the owner Resend (a NEW key)
 * and Dismiss (step U4); nothing here replays it again.
 *
 * FORK 2026-09-24 (prompt-queue.md U6, C7) — this block used to sit above the journal section, a
 * screen away from the function it documents, and promised "a manual retry" no handler served.
 */
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
    // FORK 2026-09-04 — the gateway already holds this idempotencyKey, so a replay cannot do
    // anything except draw the same `{status:"ok"}` echo back out of the dedupe cache. Parking it
    // here is what lets the replay path stop deleting: it no longer has to choose between
    // re-sending forever and destroying the entry. Reconnects deliberately leave the park intact.
    if (e.ackedAt !== undefined) {
      return false;
    }
    // FORK 2026-09-25 — the owner's Stop, or a sessions.delete / sessions.reset, ended THIS
    // prompt's own run (`cancelledAt`, stamped by markCancelled). Re-sending it would run the very
    // turn they stopped. Usually moot, because an aborted run was accepted first and the ack park
    // above holds it — but the ack is exactly what a page can miss (a socket that dropped before
    // chat.send's reply came back), and then nothing else stood between the stop and a replay once
    // the grace period passed. `typeof` rather than `!== undefined`: readOutbox passes this stamp
    // through UNVALIDATED, so a stored value that is not a number must read as NOT cancelled
    // (msg-order.ts `outboxPromptFacts` tests it the same way) instead of parking an unproven
    // prompt forever. A fact, never a retirement: the entry stays until proof or Dismiss (PQ-9),
    // and the owner's Resend goes out under a NEW key.
    if (typeof e.cancelledAt === "number") {
      return false;
    }
    // FORK 2026-10-01 — the prompt's OWN run answered it (`answeredAt`, stamped by markAnswered).
    // A replay could only draw the dedupe echo of that finished run or, once the gateway's
    // in-process dedupe is gone (a restart), run the answered prompt a second time. The ack park
    // above usually holds it already; this holds it when the ack was missed and the final was not.
    if (isAnswered(e)) {
      return false;
    }
    const since = e.lastAttemptAt || e.ts;
    return now - since >= graceMs;
  });
}

/**
 * How long a session's outbox proof (chat.history) may go unchecked once nothing in it is due for
 * replay. Below this age the backstop skips re-fetching that session's transcript entirely.
 *
 * FORK 2026-09-23 — the gateway event-loop saturation fix. `flushOutbox`'s 20s tick used to fetch
 * `chat.history` (limit 1000) for EVERY session holding ANY outbox entry, before checking whether
 * anything was due — so an acked, unprovable entry kept its session's whole transcript re-read
 * every 20s forever, with no upper bound. Proof still must not go stale forever (an acked entry
 * really can vanish from the transcript, e.g. a restart that lost the write), so a session with
 * nothing due is now re-checked at this cadence instead of never — and never more often.
 *
 * FORK 2026-10-01 — an ANSWERED entry (`answeredAt`) is never re-checked on its own: its own run
 * answered it, so no read can change what the owner sees, and an unprovable one (a session's first
 * prompt) used to cost its session a read every PROOF_RECHECK_MS for good (bug-log.md
 * [chat-divergence], cause 1). See `outboxSessionsNeedingProof`.
 */
export const PROOF_RECHECK_MS = 120_000;

/** Rows a proof read asks for when it cannot ask by cursor (Task 1's tail read). */
export const OUTBOX_PROOF_LIMIT = 200;

/**
 * The `limit` a CURSOR proof read carries (ruling R24): the gateway's hard maximum. An afterSeq
 * delta longer than its limit is answered `reset` with only the last `limit` rows (ruling R10), and
 * without a limit the gateway applies its 200 default — so a prompt sent more than 200 rows ago
 * would never be proven by the delta that exists to prove it.
 */
export const OUTBOX_CURSOR_PROOF_LIMIT = 1000;

/**
 * The chat.history request that proves (or disproves) one session's outbox entries.
 *
 * FORK 2026-09-23 (chat.history rehaul, plan task 8; review focus 5) — ask for the rows AFTER the
 * oldest entry's send-time seq (one row early, never below 0) when EVERY entry recorded one under
 * the epoch the tab's window holds now: `{sessionKey, afterSeq, epoch, limit: 1000}`. A keyed proof
 * row is then found however far it has fallen behind the tail. Otherwise — an entry typed without a window, a
 * window without an epoch (the gateway before its restart, R7), or a seq recorded under another
 * epoch, where it names a different row — ask the last OUTBOX_PROOF_LIMIT rows, as before. A text
 * (legacy) proof is only ever consulted near the tail: a legacy entry has no send-time seq, so its
 * session always takes the tail read. flushOutbox retries a `reset` reply once as a tail read.
 */
export function outboxProofRequest(
  sessionKey: string,
  entries: readonly OutboxEntry[],
  w: HistoryWindow,
): Record<string, unknown> {
  const tail = outboxTailProofRequest(sessionKey, entries);
  if (w.epoch === null || entries.length === 0) {
    return tail;
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const e of entries) {
    if (typeof e.sentAfterSeq !== "number" || e.sentEpoch !== w.epoch) {
      return tail;
    }
    oldest = Math.min(oldest, e.sentAfterSeq);
  }
  return {
    sessionKey,
    afterSeq: Math.max(0, oldest - 1),
    epoch: w.epoch,
    limit: OUTBOX_CURSOR_PROOF_LIMIT,
  };
}

/**
 * FORK 2026-09-24 (final whole-branch review item 7) — the proof read that asks by TAIL, not by
 * cursor. A `keyedProofExpected` entry is proven by its key at ANY position (historyMatchesEntry),
 * so a session holding one asks the gateway's maximum (OUTBOX_CURSOR_PROOF_LIMIT); only text proof
 * is tail-bound, so text-proof-only (legacy) sessions keep OUTBOX_PROOF_LIMIT. Also the retry
 * flushOutbox issues after a cursor read is reset or rejected.
 */
export function outboxTailProofRequest(
  sessionKey: string,
  entries: readonly OutboxEntry[],
): Record<string, unknown> {
  const keyed = entries.some((e) => e.keyedProofExpected === true);
  return { sessionKey, limit: keyed ? OUTBOX_CURSOR_PROOF_LIMIT : OUTBOX_PROOF_LIMIT };
}

/**
 * FORK 2026-09-24 (task 8 ledger M2) — after a CURSOR proof read, must flushOutbox read the tail
 * again? When the read failed or was rejected (no reply: an old gateway), yes. When the reply is a
 * `reset`, it already IS a tail window (the last OUTBOX_CURSOR_PROOF_LIMIT rows): flushOutbox
 * reconciles against it first and reads again only if entries are `stillPending` after that. A
 * delta, or a read that was a tail read to begin with, never needs a second read.
 */
export function outboxNeedsTailProofRead(
  request: Record<string, unknown>,
  reply: unknown,
  stillPending: number,
): boolean {
  if (request.afterSeq === undefined && request.beforeSeq === undefined) {
    return false;
  }
  if (reply === null || reply === undefined) {
    return true;
  }
  return cursorOf(reply)?.reset === true && stillPending > 0;
}

/**
 * Which sessions `flushOutbox` must fetch `chat.history` for on this tick.
 *
 * A session is pulled in by either of two independent, unioned reasons:
 *  - it holds an entry `dueForReplay` — a replay must always ask the server first (see
 *    `flushOutbox`'s own "ASK THE SERVER FIRST, ALWAYS" doc comment), so a due entry's session is
 *    never skipped regardless of how recently proof was checked;
 *  - it holds an UNANSWERED entry whose `lastProofCheckAt` is unset (never checked) or at least
 *    `PROOF_RECHECK_MS` old — so a parked/acked session's proof still gets rechecked periodically
 *    rather than never again.
 *
 * A session whose every entry is parked (acked, not due) AND was checked recently pulls in
 * nothing — that is precisely the fix: such a session used to force a full re-fetch every tick.
 *
 * FORK 2026-10-01 — nor does a session whose every entry is ANSWERED (`answeredAt`), however long
 * ago it was checked: an answered entry is never due (`dueForReplay`) and never stale. A read made
 * for its session anyway (for an unanswered neighbour here, or app.ts loadChat's) still reconciles
 * it, so keyed proof still retires it; it just never causes a read of its own. (This block sat
 * above OUTBOX_PROOF_LIMIT, two declarations away from this function, until 2026-10-01: the
 * misplacement U6 fixed for `dueForReplay`.)
 *
 * Pure; does not read or write storage. `flushOutbox` stamps `lastProofCheckAt` itself, via
 * `markProofChecked`, after each session's fetch actually completes.
 */
export function outboxSessionsNeedingProof(entries: readonly OutboxEntry[], now: number): string[] {
  const out = new Set<string>();
  for (const e of dueForReplay(entries, now)) {
    out.add(e.sessionKey);
  }
  for (const e of entries) {
    if (!isAnswered(e) && now - (e.lastProofCheckAt ?? 0) >= PROOF_RECHECK_MS) {
      out.add(e.sessionKey);
    }
  }
  return [...out];
}
