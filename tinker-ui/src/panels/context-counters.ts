// FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.2 step B3; principles P5, P6,
// P10, P11; findings F3d, F3e, F4, F7) — the THIS SESSION counters of the CONTEXT WINDOW panel: one
// pure reducer over the live facts the session row cannot carry, and one pure projection that
// joins them with the row and the call store. app.ts gathers the inputs and paints the answer;
// context-counters.test.ts pins every branch, because app.ts has no unit harness.
//
// THE RULES, each with the defect it ends:
//   1. THE COUNTS ARE THE SESSION ROW'S (P6). `compactions`, `evictions` and `dropped` are A7's
//      fields on the session's sessions.list row: the compaction LEDGER's compactions, evictions
//      and droppedTokens, and its lastCompactionAt. A reload, another tab or another browser reads
//      the same row and shows the same numbers. They were a client tally that a reload restarted
//      at 0 (F3e), seeded from the anatomy row's per-ATTEMPT compaction counter, which is ≈ always
//      0 (F3d). THE LEDGER'S COUNT, not the row's `compactionCount` (FORK 2026-09-25): that one is
//      the session entry's own lifetime counter, which the claude CLI's own compactions (trigger
//      "cli-internal") and the EVICT button never bump — so the number A7 put on the row never
//      reached this panel. `compactionCount` is read only when the row carries no ledger at all,
//      and the projection then FLAGS it (`compactionsLifetime`), because the two count different
//      things and which one a cell shows is part of the number (P5).
//   2. ABSENT IS NOT ZERO (P10). A field the row does not carry (a gateway without A7, no row read
//      yet) stays undefined and paints "—". The tally started at 0, so "0 compactions" was on
//      screen before anything had been read.
//   3. ONE INCREMENT PATH. Nothing here counts a compaction: the A1 `end` and the sessions.compact
//      reply only make the host re-read the row. One manual press used to be counted twice, by the
//      reply AND by the A1 `end` its executor publishes (A2 / A5).
//   4. EACH DROP IS SIZED ONCE, by a producer that measured it (P11). An A1 `end` sizes its drop
//      with `tokensDropped` (EVICT sends it), or with tokensBefore − tokensAfter only when its
//      provenance is "exact" (the claude CLI's own compaction, A3). The gateway's COMPACT path
//      sends "estimated" parts whose tokensBefore is a store-wide running total (sessions.ts
//      measured 7,855,029 on a 175,850-token session: subtracting reports a 61× lie), so a press's
//      drop takes the reply's `evictedTokens`, the engine's own count, when its `end` had no size.
//      The `end` and the reply of one press are two HALVES of one drop: the first to arrive with a
//      size sizes it, the other adds nothing, in either order. They pair by the button's trigger and
//      by time (DROP_PAIR_WINDOW_MS), each button in its own slot, so an EVICT and a COMPACT in
//      flight together never take each other's half, and a stale half (a /compact typed an hour
//      ago, a runner compaction that fell through to "manual") cannot swallow a later press.
//   5. TURNS ARE TURNS, CALLS ARE CALLS (F7). Both are the call timeline store's totals(): the
//      record that the one `stream:"call"` reader (parseCallFrame) and its §5.4 fallbacks feed.
//      `turns` used to be +1 per `cache` event, which is a call on the embedded pipe and a whole
//      turn on cc-bridge, seeded from the anatomy's user-message count: three units, one label.
//   6. SAVED INTEGRATES PER DROP (F4): the sum, over the drops this page watched, of the tokens
//      dropped × the model calls made since that drop. It was the dropped total × ALL turns, the
//      turns before the drop included. Two running sums keep the state O(1) however many drops.
//
// MECHANISM: CODE (design-principles #22). Every input has a structural producer (the row, the A1
// stream, the call store, the RPC reply) and the want is the same number every time.
//
// NOT HERE: the DOM, the clock, app.ts state, the markup. Every input is a parameter, the time an
// event arrived included, so the tests need no fake timers.

import type { CacheAct } from "./context-buttons.js";

/** A finite number >= 0, else undefined: the A1 owner's absent-not-zero rule, mirrored. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ── rule 1: the session row ──

/** A7's fields on a sessions.list row. Every one optional: missing means UNKNOWN (P10), never 0. */
export interface RowCounters {
  /**
   * THE count (rule 1): the compaction LEDGER's figure for this session
   * (src/infra/compaction-ledger.ts) — completed compactions of every executor except the EVICT
   * button, earlier gateway processes' rows inside the events table's retention window plus this
   * process's own.
   *
   * Absent ONLY when the row carries no ledger AT ALL, which is why this one field is the whole
   * test: `readCompactionLedger` returns nothing until the ledger is seeded for the session (the
   * first sessions.list after a gateway start queues the seed and builds its rows without it), and
   * session-utils.ts spreads the whole view or nothing (`...compactionLedger`). A seeded ledger
   * always sends this AND `evictions`, a measured 0 included — CompactionLedgerView declares both
   * non-optional and `viewOf` always sets them, while droppedTokens and lastCompactionAt are the
   * conditional ones. Scanning all four would be dead machinery.
   */
  compactions?: number;
  /**
   * The session entry's own durable LIFETIME counter (SessionEntry.compactionCount), which is NOT
   * the same quantity: only gateway-side executors bump it, so the claude CLI's own compactions
   * (trigger "cli-internal") and the EVICT button never reach it. Read only as `compactions`'
   * fallback, and never without the flag that says which of the two a cell is showing.
   */
  compactionCount?: number;
  evictions?: number;
  droppedTokens?: number;
  /**
   * Epoch ms of the session's last completed COMPACTION.
   *
   * CORRECTION 2026-09-25: this said "compaction or eviction". An eviction does not move it. The
   * ledger excludes the EVICT trigger from it (compaction-ledger.ts: "only a compaction moves
   * lastCompactionAt"), session-utils.types.ts says "evictions excluded", and the A7 test pins it.
   */
  lastCompactionAt?: number;
}

const ROW_COUNTER_FIELDS = [
  // `compactions` belongs in this LIST, not only on the interface above: rowCountersKey is the
  // host's repaint trigger, and the ledger count moves on its own — a compaction whose `end`
  // carried no measured drop moves `compactions` and `lastCompactionAt` and nothing else. Left
  // out, the panel would go on painting the stale number.
  "compactions",
  "compactionCount",
  "evictions",
  "droppedTokens",
  "lastCompactionAt",
] as const;

/**
 * A7's five fields off a sessions.list row: a finite value >= 0 is kept (a measured 0 is a real
 * 0), anything else is left out. No row, a row from a gateway without A7, or something that is not
 * an object reads as nothing known.
 */
export function readRowCounters(row: unknown): RowCounters {
  const out: RowCounters = {};
  if (!row || typeof row !== "object") {
    return out;
  }
  const r = row as Record<string, unknown>;
  for (const field of ROW_COUNTER_FIELDS) {
    const v = count(r[field]);
    if (v !== undefined) {
      out[field] = v;
    }
  }
  return out;
}

/**
 * The five fields as one comparable string, unknown spelled apart from 0, so the host repaints
 * when the row MOVED rather than on every row push of a turn.
 */
export function rowCountersKey(c: RowCounters): string {
  return ROW_COUNTER_FIELDS.map((f) => (c[f] === undefined ? "-" : String(c[f]))).join("|");
}

// ── rule 4: what one A1 `end` dropped ──

/** Where a drop's size came from (P5): the producer's own figures, or a local chars-per-token count. */
export type DropProvenance = "exact" | "estimated";

/** One completed compaction, as its A1 `end` reports it. */
export interface CompactionDrop {
  /** Who ran it (the A1 trigger), so a press's reply pairs with its own `end` only. */
  trigger?: string;
  /** Tokens it removed, when a measuring producer said so (rule 4). Undefined: not measured. */
  tokens?: number;
  /** The event's own provenance; a missing one claims the weaker. */
  provenance: DropProvenance;
}

/**
 * What one A1 `stream:"compaction"` payload means for the counters. Only a COMPLETED `end` dropped
 * anything, so this is null for a `start`; for an `end` with completed:false (a compaction that
 * did not happen: pi's retry, a refused eviction, or a failed CLI compaction, which the bridge's A3
 * reports from a status line rather than a boundary); for an `end` whose `completed` is not the
 * boolean true (the A1 owner always sends a boolean); and for anything that is not the contract.
 * Whether a `start` came first does not matter: nothing here reads the start.
 */
export function compactionDrop(data: unknown): CompactionDrop | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (d.phase !== "end" || d.completed !== true) {
    return null;
  }
  const provenance: DropProvenance = d.provenance === "exact" ? "exact" : "estimated";
  const drop: CompactionDrop = { provenance };
  const trigger = typeof d.trigger === "string" ? d.trigger.trim() : "";
  if (trigger) {
    drop.trigger = trigger;
  }
  const measured = count(d.tokensDropped);
  if (measured !== undefined) {
    drop.tokens = measured;
  } else if (provenance === "exact") {
    const before = count(d.tokensBefore);
    const after = count(d.tokensAfter);
    if (before !== undefined && after !== undefined && before >= after) {
      drop.tokens = before - after;
    }
  }
  return drop;
}

// ── the reducer ──

/** The triggers whose drops come in two halves: an A1 `end` and a sessions.compact reply. */
type PressTrigger = "manual" | "evict";

/** The A1 trigger each button's executor publishes (compaction-telemetry.ts CompactionTrigger). */
const TRIGGER_OF_ACT: Readonly<Record<CacheAct, PressTrigger>> = {
  compact: "manual",
  evict: "evict",
};

function pressTrigger(trigger: string | undefined): PressTrigger | undefined {
  return trigger === "manual" || trigger === "evict" ? trigger : undefined;
}

/**
 * How long one half of a press's drop waits for the other. Both come out of the same
 * sessions.compact call, milliseconds to seconds apart (the executor emits the `end`, then the
 * gateway updates the store and replies); a half older than this belongs to something else.
 */
export const DROP_PAIR_WINDOW_MS = 30_000;

/** The half of a press's drop that arrived first, held for the other half. */
export interface DropHalf {
  readonly half: "end" | "reply";
  /** It carried a size and the drop was folded in with it, so the other half adds nothing. */
  readonly sized: boolean;
  /** When it arrived (the host's clock, handed in with the event). */
  readonly at: number;
  /** liveCalls when it arrived, so a size that comes with the other half integrates from here. */
  readonly callsAt: number;
}

/** One slot per button: an EVICT and a COMPACT in flight together never take each other's half. */
export type PendingHalves = Readonly<Partial<Record<PressTrigger, DropHalf>>>;

/** The live facts one session's counters need that its row does not carry. */
export interface CountersState {
  /** Model calls the session's call store gained on the LIVE feed (its history excluded). */
  readonly liveCalls: number;
  /** Completed drops of a known, non-zero size this page watched. */
  readonly dropsWatched: number;
  /** The sum of tokens over those drops. */
  readonly droppedWatched: number;
  /** The sum of tokens × liveCalls-at-that-drop over those drops: savedTokens' subtrahend. */
  readonly dropCallWeight: number;
  /** THIS CALL's `evicted`: the LAST drop's size. Undefined: none watched, or its size unknown. */
  readonly lastDropped?: number;
  readonly lastDroppedProvenance?: DropProvenance;
  /** First halves of press drops, waiting for the other half (at most DROP_PAIR_WINDOW_MS). */
  readonly pending?: PendingHalves;
  /** The call store's history backfill came back, so a 0 is a measured 0 (P10). */
  readonly historyRead: boolean;
  /** Calls the history added. Each is one TURN drawn as one call, so `calls` is then a floor. */
  readonly historyCalls: number;
  /** The history came back at its row limit, so older turns were left out: `turns` is a floor. */
  readonly historyTruncated: boolean;
}

/** The state of a session this page has heard nothing about. Frozen: the reducer never mutates. */
export const EMPTY_COUNTERS: CountersState = Object.freeze({
  liveCalls: 0,
  dropsWatched: 0,
  droppedWatched: 0,
  dropCallWeight: 0,
  historyRead: false,
  historyCalls: 0,
  historyTruncated: false,
});

export type CounterEvent =
  /** The session's call store gained `added` calls on the live feed. */
  | { kind: "calls"; added: number }
  /** The call store's history backfill came back: the calls it added, whether it hit its limit. */
  | { kind: "history"; calls: number; truncated: boolean }
  /** One A1 `stream:"compaction"` payload, any phase, and when it arrived (epoch ms). */
  | { kind: "compaction"; data: unknown; at: number }
  /** The reply to an EVICT / COMPACT press (sessions.compact), and when it arrived (epoch ms). */
  | { kind: "reply"; act: CacheAct; reply: unknown; at: number };

/** Fold a drop of known size in, as having happened when liveCalls was `callsAt`. */
function withDrop(
  s: CountersState,
  tokens: number,
  provenance: DropProvenance,
  callsAt: number,
): CountersState {
  if (tokens <= 0) {
    // A measured zero: THIS CALL's `evicted` says 0, and there is nothing to integrate.
    return { ...s, lastDropped: 0, lastDroppedProvenance: provenance };
  }
  return {
    ...s,
    dropsWatched: s.dropsWatched + 1,
    droppedWatched: s.droppedWatched + tokens,
    dropCallWeight: s.dropCallWeight + tokens * callsAt,
    lastDropped: tokens,
    lastDroppedProvenance: provenance,
  };
}

/** `pending` with one slot set, or cleared (undefined when no slot is left). */
function withSlot(
  pending: PendingHalves | undefined,
  slot: PressTrigger,
  half: DropHalf | undefined,
): PendingHalves | undefined {
  const next: Partial<Record<PressTrigger, DropHalf>> = { ...pending };
  if (half) {
    next[slot] = half;
  } else {
    delete next[slot];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * One half of a drop (rule 4). `tokens` is its size, undefined when this half measured none; `at`
 * is when it arrived.
 */
function withHalf(
  s: CountersState,
  half: DropHalf["half"],
  trigger: string | undefined,
  tokens: number | undefined,
  provenance: DropProvenance,
  at: number,
): CountersState {
  const slot = pressTrigger(trigger);
  const other = slot ? s.pending?.[slot] : undefined;
  // Without a usable arrival time on either half, the button alone pairs them: a missed pairing
  // would count an EVICT twice (both its halves carry a size), a wrong one only moves callsAt.
  const inWindow =
    other !== undefined &&
    (!Number.isFinite(at) ||
      !Number.isFinite(other.at) ||
      Math.abs(at - other.at) <= DROP_PAIR_WINDOW_MS);
  if (slot && other && other.half !== half && inWindow) {
    // The other half of the press whose first half is waiting: ONE drop, sized once.
    const rest: CountersState = { ...s, pending: withSlot(s.pending, slot, undefined) };
    return other.sized || tokens === undefined
      ? rest
      : withDrop(rest, tokens, provenance, other.callsAt);
  }
  // A first half, or a drop no press made. Size unknown: THIS CALL's `evicted` describes the LAST
  // drop, so it goes blank rather than keep the previous drop's number.
  const next: CountersState =
    tokens === undefined
      ? { ...s, lastDropped: undefined, lastDroppedProvenance: undefined }
      : withDrop(s, tokens, provenance, s.liveCalls);
  return slot
    ? {
        ...next,
        pending: withSlot(s.pending, slot, {
          half,
          sized: tokens !== undefined,
          at,
          callsAt: s.liveCalls,
        }),
      }
    : next;
}

/**
 * The one reducer. Pure; returns the SAME object when an event changes nothing, so the host can
 * skip the write.
 */
export function reduceCounters(s: CountersState, e: CounterEvent): CountersState {
  if (e.kind === "calls") {
    const added = Math.floor(count(e.added) ?? 0);
    return added > 0 ? { ...s, liveCalls: s.liveCalls + added } : s;
  }
  if (e.kind === "history") {
    const historyCalls = s.historyCalls + Math.floor(count(e.calls) ?? 0);
    const historyTruncated = s.historyTruncated || e.truncated === true;
    if (
      s.historyRead &&
      historyCalls === s.historyCalls &&
      historyTruncated === s.historyTruncated
    ) {
      return s;
    }
    return { ...s, historyRead: true, historyCalls, historyTruncated };
  }
  if (e.kind === "compaction") {
    const drop = compactionDrop(e.data);
    return drop === null ? s : withHalf(s, "end", drop.trigger, drop.tokens, drop.provenance, e.at);
  }
  const r = e.reply && typeof e.reply === "object" ? (e.reply as Record<string, unknown>) : {};
  // Only a press that compacted dropped anything: a refusal or a no-op is not half of a drop.
  if (r.ok === false || r.compacted !== true) {
    return s;
  }
  // EVICT's figure is the anatomy's chars/3.5 estimate, COMPACT's the engram executor's own
  // count: neither is a provider's, so both are "estimated".
  return withHalf(s, "reply", TRIGGER_OF_ACT[e.act], count(r.evictedTokens), "estimated", e.at);
}

/**
 * Rule 6: the sum over watched drops of tokens × (calls now − calls at that drop), computed from
 * two running sums as liveCalls × droppedWatched − dropCallWeight. liveCalls only grows, so no
 * term is negative; the clamp guards float noise only.
 */
export function savedTokens(s: CountersState): number {
  return Math.max(0, s.liveCalls * s.droppedWatched - s.dropCallWeight);
}

// ── the projection ──

/** The call store's two totals for the session (CallTimelineStore.totals()). */
export interface TimelineTotals {
  turns: number;
  calls: number;
}

/**
 * What the THIS SESSION section paints (context-cache.ts). Every value optional: undefined paints
 * "—", and an `...AtLeast` flag paints "≥" (P5: whether a number is a count or a floor is part of
 * the number).
 */
export interface SessionCounters {
  turns?: number;
  /** `turns` is a floor: the history is not read yet, or came back cut at its row limit. */
  turnsAtLeast?: boolean;
  calls?: number;
  /** `calls` is a floor: the history is not read yet, or holds turns drawn as one call each. */
  callsAtLeast?: boolean;
  /**
   * Compactions on this session: the row's LEDGER count, else — only when the row carries no
   * ledger — the entry's lifetime `compactionCount`, with `compactionsLifetime` set to say which.
   */
  compactions?: number;
  /**
   * `compactions` above is the entry's LIFETIME counter, not the ledger's, so the cell must say it
   * misses the CLI's own compactions and every eviction and therefore reads LOW (P5: which count a
   * number is, is part of the number). Always set, so a reader cannot take a missing key for "it
   * is the ledger's" — the same reason the deleted `savedPerDrop` was a flag: a key holding
   * undefined does not survive a JSON round trip or an undefined-stripping copy.
   *
   * ITS ONE CONSUMER IS context-cache.ts's `compactions` tooltip, which is outside this unit's
   * writes and lands as a follow-up. If that follow-up does not land, DELETE this field rather
   * than leave a produced-and-unread flag — that is precisely what `savedPerDrop` had become.
   */
  compactionsLifetime?: boolean;
  evictions?: number;
  /**
   * Tokens dropped by every compaction AND eviction: A7's droppedTokens. The name is the
   * renderer's older one, kept because context-cache.test.ts pins the `evictedTokens` input.
   */
  evictedTokens?: number;
  /** ESTIMATE (rule 6), over the drops this page watched. Undefined: unknown. */
  saved?: number;
  /** Epoch ms of the last completed COMPACTION, from the row; an eviction does not move it
   *  (RowCounters.lastCompactionAt, corrected 2026-09-25). */
  lastCompactionAt?: number;
}

/**
 * The projection: the row's counts (rule 1), the store's turns and calls (rule 5), `saved` from the
 * watched drops (rule 6). Nothing is claimed before its source holds it (rule 2): with no history
 * read and no live turn yet, the store's 0 means "not loaded", not a count.
 */
export function sessionCounters(input: {
  row?: RowCounters;
  state?: CountersState;
  totals?: TimelineTotals;
}): SessionCounters {
  const row = input.row ?? {};
  const s = input.state ?? EMPTY_COUNTERS;
  const t = input.totals;
  const known =
    t !== undefined &&
    count(t.turns) !== undefined &&
    count(t.calls) !== undefined &&
    (s.historyRead || t.turns > 0);
  const turns = known && t ? t.turns : undefined;
  const calls = known && t ? t.calls : undefined;
  let saved: number | undefined;
  if (s.dropsWatched > 0) {
    saved = savedTokens(s);
  } else if (row.droppedTokens === 0) {
    // The row says nothing was ever dropped on this session, so nothing was saved: a real 0.
    saved = 0;
  }
  // Rule 1: the LEDGER is the count. A row that carries none — its ledger was not seeded when the
  // row was built — falls back to the entry's LIFETIME counter, FLAGGED, because that counter
  // misses the CLI's own compactions and every eviction, and painting it unlabelled as
  // "compactions" is the P5 mislabel. A seeded ledger always sends `compactions`, so its absence
  // ALONE is "no ledger on this row"; the other three need no testing. Neither present: "—" (P10).
  const ledger = row.compactions;
  const compactions = ledger ?? row.compactionCount;
  return {
    turns,
    turnsAtLeast: turns !== undefined && (!s.historyRead || s.historyTruncated),
    calls,
    callsAtLeast: calls !== undefined && (!s.historyRead || s.historyCalls > 0),
    compactions,
    compactionsLifetime: ledger === undefined && compactions !== undefined,
    evictions: row.evictions,
    evictedTokens: row.droppedTokens,
    saved,
    lastCompactionAt: row.lastCompactionAt,
  };
}
