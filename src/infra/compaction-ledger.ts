// FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A4 + A7; logging.md §4.7;
// failures.md M21; principles P6, P7 and P10 of that optic) — the compaction LEDGER's memory and
// its read path.
//
// ONE WRITER. Every compaction the gateway can hear closes with ONE `end` through the A1 owner,
// src/infra/compaction-telemetry.ts, whichever executor ran it: pi-auto, the runner leaf and the
// engine-owned queued branch, the manual RPC (through the leaf), the EVICT button
// (session-eviction.ts, trigger "evict") and the claude CLI's own compaction (the tinker-bridge,
// trigger "cli-internal"). On that end the owner queues one `compaction.run` row on the events
// database and hands the same figures to noteCompactionLedgerEnd. Nothing else feeds this module.
// The sessions.compact RPC reply is not an input, so a manual compaction the clicking tab hears
// twice (the reply and the stream) is one row and one count.
//
// ONE ROW PER FACT. `compaction.run` IS the ledger: an eviction is a compaction whose trigger is
// "evict", counted under `evictions`, never a second row. `context.evict` stays ENGRAM's
// pointer-level manifest for J1 (what pointer compaction moved out, one level below a
// compaction.run row); this module does not read it.
//
// THE READ PATH NEVER TOUCHES A STORE (failures.md M21). The sessions.list row builder calls
// readCompactionLedger, which answers from memory. The history a session has from EARLIER
// processes is seeded lazily: the first read of an unseeded session queues it, and one batched
// request per microtask asks the events writer's worker (queryPriorBootLedger, events/emit.ts).
// The database is never read on the gateway's main thread (logging.md L3).
//
// NO DOUBLE COUNT, WHATEVER THE TIMING. The seed covers rows written by earlier processes only:
// the query leaves out the boot id of every writer this process started, and this process's own
// ends are counted in memory from its first one. A row is therefore counted by exactly one of the
// two halves, even when it reached the database before the seed query ran. (Rejected: flush, then
// query everything. An end emitted between the flush and the query would be counted twice.)
//
// ABSENT, NOT ZERO (P10). Until a session is seeded, readCompactionLedger returns undefined and the
// row carries none of the ledger fields (the UI shows "—"). A seed that gets no answer (writer
// disabled or stopped, worker down, timeout) is retried after COMPACTION_LEDGER_SEED_RETRY_MS: a
// fail-shut gate with no retry would leave the fields absent for the life of the process.
// droppedTokens sums the drops that were measured or derivable; when compactions ran and none of
// them carried one, it is absent rather than a 0 that would read as "dropped nothing".
//
// WINDOW. The seed sees what the events database still holds: `compaction.run` is retention class
// `event` (logging.md §7.4: 180 days, shortened only under the size budget). The entry's own
// SessionEntry.compactionCount, which the session row carries beside these figures, is a lifetime
// counter that only gateway-side executors bump.
//
// ONE STATE ACROSS BUNDLE COPIES. The bridge reaches the A1 owner through a plugin-sdk subpath that
// dist may bundle as a separate copy of this module; the state lives on one globalThis slot,
// resolved per call (the agent-events precedent), so every copy counts into the same ledger.

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CompactionTrigger } from "./compaction-telemetry.js";
import { type EventLedgerGroup, queryPriorBootLedger } from "./events/emit.js";

/** The events-catalog row the ledger IS (logging.md §4.7; src/infra/events/catalog.ts). */
export const COMPACTION_LEDGER_EVENT = "compaction.run";
/** The row label of an end that completed: the only rows the ledger counts. */
export const COMPACTION_LEDGER_COMPLETED = "completed";
/** The row label of an end that did not complete: declined after its start, aborted or failed. */
export const COMPACTION_LEDGER_INCOMPLETE = "incomplete";
/** The EVICT button's trigger: counted under `evictions`, never under `compactions`. */
const EVICTION_TRIGGER: CompactionTrigger = "evict";
/** After a seed that got no answer, the same session is not asked again before this long. */
export const COMPACTION_LEDGER_SEED_RETRY_MS = 60_000;
/** Session keys per seed request, so one listing of a large store stays a handful of messages. */
export const COMPACTION_LEDGER_SEED_BATCH = 500;

/** One `end`, as the A1 owner hands it over. */
export type CompactionLedgerEnd = {
  /** The A1 trigger of the executor that ran it. */
  trigger: string;
  completed: boolean;
  /** compactionLedgerDrop of this end: the same number the row's n3 carries. */
  droppedTokens?: number;
  /** When the owner recorded the end, epoch ms: the same value as the row's ts_ms. */
  atMs: number;
};

/** The session row's ledger figures (A7). A key is present only when the ledger knows its value. */
export type CompactionLedgerView = {
  /** Completed compactions of every executor except the EVICT button. */
  compactions: number;
  /** Completed EVICT-button evictions. */
  evictions: number;
  /** Tokens those removed; absent when some ran and none carried a figure. */
  droppedTokens?: number;
  /** Epoch ms of the latest completed compaction (evictions excluded); absent when none. */
  lastCompactionAt?: number;
};

/** A running total: this process's own ends (live) or earlier processes' rows (seed). */
type LedgerTotals = {
  compactions: number;
  evictions: number;
  droppedTokens: number;
  /** How many counted ends carried a drop figure. */
  droppedKnown: number;
  lastCompactionAt?: number;
};

/** Counted ends of one trigger: a live end is a batch of one, a seed group a batch of many. */
type LedgerBatch = {
  trigger: string | null;
  count: number;
  droppedTokens?: number;
  droppedKnown: number;
  lastAtMs?: number;
};

type SessionLedger = {
  live: LedgerTotals;
  /** Earlier processes' totals, once the worker answered. */
  seed?: LedgerTotals;
  /** A seed request is queued or in flight. */
  seeding: boolean;
  /** After a seed with no answer: no new request before this time. */
  retryAt?: number;
};

type LedgerState = {
  sessions: Map<string, SessionLedger>;
  /** Sessions waiting for the next batched seed request. */
  queued: Map<string, SessionLedger>;
  batch: Promise<void> | undefined;
  inflight: Set<Promise<void>>;
};

const LEDGER_STATE_KEY = Symbol.for("openclaw.compactionLedger.state");

function ledgerState(): LedgerState {
  return resolveGlobalSingleton<LedgerState>(LEDGER_STATE_KEY, () => ({
    sessions: new Map<string, SessionLedger>(),
    queued: new Map<string, SessionLedger>(),
    batch: undefined,
    inflight: new Set<Promise<void>>(),
  }));
}

function emptyTotals(): LedgerTotals {
  return { compactions: 0, evictions: 0, droppedTokens: 0, droppedKnown: 0 };
}

function ledgerKey(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  return key.length > 0 ? key : undefined;
}

function sessionLedger(state: LedgerState, key: string): SessionLedger {
  let ledger = state.sessions.get(key);
  if (ledger === undefined) {
    ledger = { live: emptyTotals(), seeding: false };
    state.sessions.set(key, ledger);
  }
  return ledger;
}

/**
 * The ONE classification rule, for a live end and a seed group alike: trigger "evict" is an
 * eviction, every other trigger a compaction, and only a compaction moves lastCompactionAt.
 */
function addBatch(totals: LedgerTotals, batch: LedgerBatch): void {
  if (batch.count <= 0) {
    return;
  }
  if (batch.trigger === EVICTION_TRIGGER) {
    totals.evictions += batch.count;
  } else {
    totals.compactions += batch.count;
    if (
      batch.lastAtMs !== undefined &&
      (totals.lastCompactionAt === undefined || batch.lastAtMs > totals.lastCompactionAt)
    ) {
      totals.lastCompactionAt = batch.lastAtMs;
    }
  }
  if (batch.droppedKnown > 0 && batch.droppedTokens !== undefined) {
    totals.droppedTokens += batch.droppedTokens;
    totals.droppedKnown += batch.droppedKnown;
  }
}

function viewOf(seed: LedgerTotals, live: LedgerTotals): CompactionLedgerView {
  const view: CompactionLedgerView = {
    compactions: seed.compactions + live.compactions,
    evictions: seed.evictions + live.evictions,
  };
  // A measured 0 when nothing ran at all; absent when something ran and nothing said how much.
  if (seed.droppedKnown + live.droppedKnown > 0 || view.compactions + view.evictions === 0) {
    view.droppedTokens = seed.droppedTokens + live.droppedTokens;
  }
  const last = Math.max(
    seed.lastCompactionAt ?? Number.NEGATIVE_INFINITY,
    live.lastCompactionAt ?? Number.NEGATIVE_INFINITY,
  );
  if (Number.isFinite(last)) {
    view.lastCompactionAt = last;
  }
  return view;
}

/**
 * One end's drop, derived ONCE for the row's n3 and the memory alike: the executor's own measured
 * tokensDropped when it sent one, else tokensBefore minus tokensAfter when both are known and the
 * context did not grow, else undefined. The inputs are the A1 owner's figures AFTER its
 * absent-not-zero rule (compactionTokenCount). The wire payload never carries a derived drop; the
 * ledger is the consumer that derives it.
 */
export function compactionLedgerDrop(figures: {
  tokensBefore?: number;
  tokensAfter?: number;
  tokensDropped?: number;
}): number | undefined {
  if (figures.tokensDropped !== undefined) {
    return figures.tokensDropped;
  }
  if (figures.tokensBefore === undefined || figures.tokensAfter === undefined) {
    return undefined;
  }
  const drop = figures.tokensBefore - figures.tokensAfter;
  return drop >= 0 ? drop : undefined;
}

/**
 * Fold one A1 end into this process's live totals. Called ONLY by the A1 owner
 * (compaction-telemetry.ts), right after it queued the end's `compaction.run` row. An end that did
 * not complete is in the database (its row says incomplete) and counts nothing here.
 */
export function noteCompactionLedgerEnd(sessionKey: string, end: CompactionLedgerEnd): void {
  const key = ledgerKey(sessionKey);
  if (key === undefined || !end.completed) {
    return;
  }
  addBatch(sessionLedger(ledgerState(), key).live, {
    trigger: end.trigger,
    count: 1,
    droppedTokens: end.droppedTokens,
    droppedKnown: end.droppedTokens === undefined ? 0 : 1,
    lastAtMs: end.atMs,
  });
}

/**
 * The session row's ledger figures (A7), from memory only: no store, no database, no await
 * (failures.md M21). Undefined until the session is seeded; the first call for an unseeded session
 * queues its seed, which the events writer's worker answers a moment later.
 */
export function readCompactionLedger(
  sessionKey: string,
  now = Date.now(),
): CompactionLedgerView | undefined {
  const key = ledgerKey(sessionKey);
  if (key === undefined) {
    return undefined;
  }
  const state = ledgerState();
  const ledger = sessionLedger(state, key);
  if (ledger.seed === undefined) {
    requestSeed(state, key, ledger, now);
    return undefined;
  }
  return viewOf(ledger.seed, ledger.live);
}

function requestSeed(state: LedgerState, key: string, ledger: SessionLedger, now: number): void {
  if (ledger.seeding || (ledger.retryAt !== undefined && now < ledger.retryAt)) {
    return;
  }
  ledger.seeding = true;
  state.queued.set(key, ledger);
  // One request per microtask: a sessions.list building every row asks once, not once per row.
  state.batch ??= Promise.resolve()
    .then(() => sendQueuedSeeds(state))
    .catch(logSeedFailure);
}

function sendQueuedSeeds(state: LedgerState): Promise<void> {
  state.batch = undefined;
  const queued = [...state.queued];
  state.queued.clear();
  const sends: Promise<void>[] = [];
  for (let at = 0; at < queued.length; at += COMPACTION_LEDGER_SEED_BATCH) {
    sends.push(track(state, seedBatch(queued.slice(at, at + COMPACTION_LEDGER_SEED_BATCH))));
  }
  return Promise.all(sends).then(() => undefined);
}

/** The ledger objects are captured at send time, so a reset in between cannot be seeded stale. */
async function seedBatch(entries: ReadonlyArray<readonly [string, SessionLedger]>): Promise<void> {
  let answers: ReadonlyMap<string, readonly EventLedgerGroup[]> | null = null;
  try {
    answers = await queryPriorBootLedger({
      name: COMPACTION_LEDGER_EVENT,
      label: COMPACTION_LEDGER_COMPLETED,
      sessionKeys: entries.map(([key]) => key),
    });
  } finally {
    settleSeeds(entries, answers, Date.now());
  }
}

function settleSeeds(
  entries: ReadonlyArray<readonly [string, SessionLedger]>,
  answers: ReadonlyMap<string, readonly EventLedgerGroup[]> | null,
  now: number,
): void {
  for (const [key, ledger] of entries) {
    ledger.seeding = false;
    const groups = answers?.get(key);
    if (groups === undefined) {
      ledger.retryAt = now + COMPACTION_LEDGER_SEED_RETRY_MS;
      continue;
    }
    const seed = emptyTotals();
    for (const group of groups) {
      addBatch(seed, {
        trigger: group.trigger,
        count: group.rows,
        droppedTokens: group.droppedTokens ?? undefined,
        droppedKnown: group.droppedKnown,
        lastAtMs: group.lastTsMs ?? undefined,
      });
    }
    ledger.seed = seed;
    ledger.retryAt = undefined;
  }
}

function track(state: LedgerState, work: Promise<void>): Promise<void> {
  const tracked = work.catch(logSeedFailure);
  state.inflight.add(tracked);
  void tracked.finally(() => {
    state.inflight.delete(tracked);
  });
  return tracked;
}

function logSeedFailure(err: unknown): void {
  // Visible, never thrown: the ledger is an observer, and its seed a read that is retried.
  createSubsystemLogger("compaction-ledger").warn(
    `compaction ledger seed failed (asked again later): ${String(err)}`,
  );
}

/** Resolves once every queued and in-flight seed has settled. Tests only. */
export async function settleCompactionLedgerSeedsForTest(): Promise<void> {
  const state = ledgerState();
  while (state.batch !== undefined || state.inflight.size > 0) {
    await state.batch;
    await Promise.all(state.inflight);
  }
}

/** A process restart as far as this module's memory goes: nothing seeded, nothing live. Tests only. */
export function resetCompactionLedgerForTest(): void {
  const state = ledgerState();
  state.sessions.clear();
  state.queued.clear();
  state.batch = undefined;
  state.inflight.clear();
}
