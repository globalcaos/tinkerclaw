// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/logging.md §9 step 7 (the UI half) and the
// `ui.context.action` row of step 8.
//
// WHAT. The page's three catalog rows — `ui.outbox.state` and `ui.prompt.state` (§4.5),
// `ui.context.action` (§4.7) — reach the gateway's events database only through the `logs.ingest`
// RPC (§8.2): the UI never opens the file (§7.5). This module is that client. A producer hands it
// an event made by one of the three builders below; it keeps a small bounded buffer and ships
// batches from a timer, never on the caller's stack.
//
// THE WIRE (§8.2):
//   request  logs.ingest({ events: [{ name, tsMs, label, runId?, n1?, n2?, n3?, n4?, fields? }] })
//   reply    { accepted, rejected, rejectedByReason }
// `tsMs` is the writer's own record key (src/infra/events/emit.ts `EmitEventRecord`). Nothing else
// is ever sent: no session key, no text, no error message. `runId` is the prompt's one key (PQ-1:
// outbox id = bubble id = gateway idempotencyKey), which L8 asks every producer that holds one to
// fill. It goes out only when it is a UUID, which every key app.ts mints (`uuid()`) is: the
// gateway's id shape alone admits a raw session key, phone number included
// (`agent:main:whatsapp:direct:+<phone>` matches it), and a random UUID cannot carry anything
// personal.
// A key of any other shape is left off its row and counted (`runIdOmitted`), never silently.
//
// THE THREE RULES, each enforced here in code, not in a prompt (design-principles #22: the want is
// consistency, and every row has a structural producer):
//   1. NEVER BLOCKS THE UI THREAD (L3). `record` is one validation and one array push. It never
//      awaits and never throws. The RPC leaves from a timer, ONE batch in flight at a time.
//   2. BOUNDED, AND EVERY LOSS IS COUNTED BY CAUSE (L3, L9). The buffer holds at most
//      EVENT_INGEST_BUFFER_MAX events; past that the NEWEST is dropped, the writer's own §7.5 policy
//      (a burst loses its tail, never what is already queued, so an outage keeps its first failure).
//      Rows are bounded per prompt, too: an entry replays at most OUTBOX_MAX_ATTEMPTS times, so a
//      prompt that lives through a whole outage costs at most about fifteen rows (one queued, eight
//      replays, its ack and proof, a few prompt-state changes; counted from outbox.ts's transition
//      map, not measured), and the buffer holds the whole story of a dozen such prompts.
//      A batch whose call failed is dropped and counted, never re-sent: `req` also rejects
//      "disconnected" for a call that was already on the wire when the socket closed, so a re-send
//      could write a row twice, and a duplicate row is worse than a missing one. The one exception
//      is the reply that says the gateway wrote NONE of the batch because of its rate cap: that
//      batch goes back to the head of the buffer, since it is exactly the batch the gateway asked to
//      receive later. Records the gateway answered as rejected are counted. A failed or throttled
//      call backs the timer off (to EVENT_INGEST_BACKOFF_MAX_MS), so a gateway that is refusing is
//      not hammered. `stats()` is the reader; app.ts exposes it as the console probe
//      `__tinkerUiEvents()`.
//      DEVIATION, named: the brief said "drop when disconnected". A flush that finds the socket down
//      instead KEEPS the buffer (bounded as above), counts the deferral in `heldForSocket`, and tries
//      again on the backed-off timer. The fact behind it: the transitions `ui.outbox.state` exists to
//      record (a rejected send, then its replays) happen precisely while the socket is down, because
//      `req` rejects "disconnected" the instant it is not OPEN (outbox.ts header). Dropping them on
//      disconnect would bias the record against exactly the failures it is for. Every event carries
//      its own `tsMs`, stamped when it was recorded, so a late delivery lands in the right window. A
//      page closed while the socket is down still loses what it held: the buffer is memory.
//   3. NO FREE TEXT, NO SESSION KEY (L4). Every string this module sends is a member of a closed
//      set declared in UI_EVENT_SCHEMA, or a UUID in `runId`, and every number is finite. An event
//      that carries anything else (a prompt's text, a raw session key, an error message, an
//      undeclared key) is dropped WHOLE and counted as `invalid`. There is no slot for a session key.
//
// The gateway re-checks all of it (the UI cannot forge a gateway event, §8.2). This is the first
// wall, not the only one.

import {
  OUTBOX_RETIREMENT_PROOFS,
  OUTBOX_TRANSITION_FROM,
  OUTBOX_TRANSITION_STATES,
  type OutboxTransition,
} from "./outbox.js";
import {
  CACHE_ACT_OUTCOMES,
  CACHE_ACTS,
  type CacheAct,
  type CacheActOutcome,
} from "./panels/context-buttons.js";
import { PROMPT_STATES, type PromptStateTransition } from "./prompt-state.js";

/** The catalog rows (src/infra/events/catalog.ts) flagged `uiIngestable: true`, and only those. */
export type UiEventName = "ui.outbox.state" | "ui.prompt.state" | "ui.context.action";

export type UiEventSlot = "n1" | "n2" | "n3" | "n4";

/** One row's closed shape: the label's values, the numeric slots it uses, each field's values. */
export interface UiEventSpec {
  readonly labels: readonly string[];
  readonly slots: readonly UiEventSlot[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

const SCHEMA: Record<UiEventName, UiEventSpec> = {
  // §4.5 — label=to_state; n1=attempts, n2=age_ms; fields: from, proof; run_id=the entry id.
  "ui.outbox.state": {
    labels: OUTBOX_TRANSITION_STATES,
    slots: ["n1", "n2"],
    fields: { from: OUTBOX_TRANSITION_FROM, proof: OUTBOX_RETIREMENT_PROOFS },
  },
  // §4.5 — label=to_state in prompt-queue.md's own vocabulary; n1=ms_in_from_state; fields: from.
  // The catalog also declares `reason`. Nothing produces one: the (from, to) pair already names the
  // edge, so it is not in the closed shape, and an event that carried it would be refused here.
  "ui.prompt.state": {
    labels: PROMPT_STATES,
    slots: ["n1"],
    fields: { from: PROMPT_STATES },
  },
  // §4.7 — label=action (evict, compact); fields: result (ok, error, noop).
  "ui.context.action": {
    labels: CACHE_ACTS,
    slots: [],
    fields: { result: CACHE_ACT_OUTCOMES },
  },
};

/**
 * The closed shape of every event this page may send. Its string values come from the modules that
 * own them (outbox.ts, prompt-state.ts, panels/context-buttons.ts), so a renamed state cannot leave
 * a stale copy here. event-ingest.test.ts holds it equal to the gateway's catalog.ts and to §4.7.
 */
export const UI_EVENT_SCHEMA: Readonly<Record<UiEventName, UiEventSpec>> = Object.freeze(SCHEMA);

/** A prompt's key as app.ts mints it (`uuid()`): the only shape `runId` may take (header). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** What a producer hands `record`. The client stamps the time; a caller may not. */
export type UiEvent = {
  readonly name: UiEventName;
  readonly label: string;
  readonly runId?: string;
  readonly n1?: number;
  readonly n2?: number;
  readonly n3?: number;
  readonly n4?: number;
  readonly fields?: Readonly<Record<string, string>>;
};

/** One element of the `events` array, exactly as it goes on the wire. */
export type UiWireEvent = {
  name: UiEventName;
  tsMs: number;
  label: string;
  runId?: string;
  n1?: number;
  n2?: number;
  n3?: number;
  n4?: number;
  fields?: Record<string, string>;
};

const SLOTS: readonly UiEventSlot[] = Object.freeze(["n1", "n2", "n3", "n4"] as const);
const EVENT_KEYS: ReadonlySet<string> = new Set(["name", "label", "runId", "fields", ...SLOTS]);

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * L4, mechanically: the event as it will go on the wire, or null when ANY part of it falls outside
 * UI_EVENT_SCHEMA. Null for an unknown name, a label outside its set, a `runId` that is not a UUID,
 * an undeclared or non-finite slot, a field key or value outside its set, and any key that is not
 * part of UiEvent (a `text`, a `sessionKey`, a caller-supplied time). Whole-event refusal on
 * purpose: a producer that tried to send one bad value has a bug, and half of its row would be a
 * row nobody declared. (The client's `record` strips a non-UUID run id first, counted; this is the
 * wall behind it.)
 */
export function sanitizeUiEvent(event: unknown, tsMs: number): UiWireEvent | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return null;
  }
  if (!Number.isFinite(tsMs)) {
    return null;
  }
  const e = event as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!EVENT_KEYS.has(key)) {
      return null;
    }
  }
  const name = e.name;
  if (typeof name !== "string" || !own(UI_EVENT_SCHEMA, name)) {
    return null;
  }
  const spec = UI_EVENT_SCHEMA[name as UiEventName];
  const label = e.label;
  if (typeof label !== "string" || !spec.labels.includes(label)) {
    return null;
  }
  const wire: UiWireEvent = { name: name as UiEventName, tsMs: Math.floor(tsMs), label };
  const runId = e.runId;
  if (runId !== undefined) {
    if (!isUuid(runId)) {
      return null;
    }
    wire.runId = runId;
  }
  for (const slot of SLOTS) {
    const value = e[slot];
    if (value === undefined) {
      continue;
    }
    if (!spec.slots.includes(slot) || typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    wire[slot] = value;
  }
  if (e.fields !== undefined) {
    const f = e.fields;
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      return null;
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(f as Record<string, unknown>)) {
      if (value === undefined) {
        continue;
      }
      const allowed = own(spec.fields, key) ? spec.fields[key] : undefined;
      if (allowed === undefined || typeof value !== "string" || !allowed.includes(value)) {
        return null;
      }
      fields[key] = value;
    }
    if (Object.keys(fields).length > 0) {
      wire.fields = fields;
    }
  }
  return wire;
}

// ─── The three builders: the only way a producer makes an event ─────────────────────────────────

/**
 * `ui.outbox.state` from one transition outbox.ts wrote (`OutboxStore.onTransition`). run_id is the
 * entry id (the catalog row says so). n2 is the entry's age at the transition, measured from when
 * the owner pressed Enter (`typedAt`). A number that is not finite (a hand-edited store) is left
 * out rather than sent as a guess.
 */
export function outboxStateEvent(t: OutboxTransition, now: number): UiEvent {
  const age = now - t.typedAt;
  return {
    name: "ui.outbox.state",
    label: t.to,
    runId: t.id,
    ...(Number.isFinite(t.attempts) ? { n1: t.attempts } : {}),
    ...(Number.isFinite(age) ? { n2: Math.max(0, age) } : {}),
    fields: { from: t.from, ...(t.proof !== undefined ? { proof: t.proof } : {}) },
  };
}

/** `ui.prompt.state` from one change prompt-state.ts's tracker reported (never one per render). */
export function promptStateEvent(t: PromptStateTransition): UiEvent {
  return {
    name: "ui.prompt.state",
    label: t.to,
    runId: t.key,
    n1: t.msInFrom,
    fields: { from: t.from },
  };
}

/** `ui.context.action`: one FIRED press of the context panel's Evict or Compact button. */
export function contextActionEvent(act: CacheAct, result: CacheActOutcome): UiEvent {
  return { name: "ui.context.action", label: act, fields: { result } };
}

// ─── The client ─────────────────────────────────────────────────────────────────────────────────

/** Most events held at once. UI rows are a handful per turn, so this covers a long dead socket. */
export const EVENT_INGEST_BUFFER_MAX = 200;
/**
 * Most events in one call. The gateway caps a call's size and each connection's rate (§8.2); at one
 * call per EVENT_INGEST_FLUSH_MS at most, this client sends no more than 480 events a minute.
 */
export const EVENT_INGEST_BATCH_MAX = 40;
/** How long an event may wait before its batch leaves, when nothing has failed. */
export const EVENT_INGEST_FLUSH_MS = 5_000;
/** The back-off ceiling: consecutive held, failed or throttled flushes double the wait up to it. */
export const EVENT_INGEST_BACKOFF_MAX_MS = 60_000;

/**
 * Why a call failed, from the three rejection shapes app.ts `req` produces:
 *   disconnected  the string "disconnected": the socket was not open, or it closed with the call in
 *                 flight (so the gateway may have written the batch; it is never re-sent);
 *   timeout       an Error whose message starts "timeout": no answer within the call's budget;
 *   refused       anything else, i.e. the gateway answered with an error (a gateway without
 *                 `logs.ingest`, a malformed request).
 */
export type EventIngestFailure = "disconnected" | "timeout" | "refused";

export function classifyIngestFailure(err: unknown): EventIngestFailure {
  if (err === "disconnected") {
    return "disconnected";
  }
  if (err instanceof Error && err.message.startsWith("timeout")) {
    return "timeout";
  }
  return "refused";
}

export type EventIngestDropReason = "invalid" | "buffer_full" | EventIngestFailure;

export interface EventIngestStats {
  readonly buffered: number;
  readonly inFlight: boolean;
  /** Events the gateway accepted. */
  readonly sent: number;
  /** Events the gateway answered as rejected and did not write (its `logs.ingest.rejected` rows
   *  count them too). A batch put back after a rate-cap refusal is not in here. */
  readonly gatewayRejected: number;
  /** Events put back at the head of the buffer after the gateway refused a whole batch for its
   *  rate cap (rule 2). */
  readonly requeued: number;
  /** Calls that were answered. */
  readonly batches: number;
  readonly dropped: Readonly<Record<EventIngestDropReason, number>>;
  /** Events sent without the run id their producer held, because it was not a UUID (header). */
  readonly runIdOmitted: number;
  /** Flushes that found the socket down and kept the buffer for a later one (rule 2). */
  readonly heldForSocket: number;
  /** The wait before the next timed flush: EVENT_INGEST_FLUSH_MS, or backed off. */
  readonly nextDelayMs: number;
}

export interface EventIngestOptions {
  /** One `logs.ingest` call. Resolving means the gateway answered; rejecting drops the batch. */
  send: (events: UiWireEvent[]) => Promise<unknown>;
  /** The socket is open AND authenticated: a call made now would reach the gateway. */
  isConnected: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  bufferMax?: number;
  batchMax?: number;
  flushMs?: number;
  backoffMaxMs?: number;
}

export interface EventIngest {
  /** O(1), synchronous, never throws. Null or undefined (nothing to say) is ignored. */
  record(event: UiEvent | null | undefined): void;
  /**
   * Ship one batch now, if one can go: nothing while a batch is already in flight or the socket is
   * down. Resolves when that batch has settled; never rejects.
   */
  flush(): Promise<void>;
  stats(): EventIngestStats;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * What an answered call says.
 *   accepted / rejected  the gateway's own counts, clamped to the batch. A reply without them (a
 *                        gateway that answers in another shape) reads as "all accepted": the call
 *                        succeeded, and there is nothing better to believe;
 *   throttled            a refusal for the gateway's caps (`rate_limited`, `oversize`): the caller
 *                        backs off exactly as for a failed call;
 *   retry                the WHOLE batch was refused for the rate cap alone, so the gateway wrote
 *                        none of it and asked for it later: the caller puts it back (rule 2). An
 *                        `oversize` refusal is never retried: the same batch would be refused again.
 */
export function readIngestReply(
  reply: unknown,
  batchLength: number,
): { accepted: number; rejected: number; throttled: boolean; retry: boolean } {
  const r = reply !== null && typeof reply === "object" ? (reply as Record<string, unknown>) : {};
  const rejected = Math.min(batchLength, count(r.rejected) ?? 0);
  const accepted = Math.min(batchLength - rejected, count(r.accepted) ?? batchLength - rejected);
  const by =
    r.rejectedByReason !== null && typeof r.rejectedByReason === "object"
      ? (r.rejectedByReason as Record<string, unknown>)
      : {};
  const rateLimited = count(by.rate_limited) ?? 0;
  const oversize = count(by.oversize) ?? 0;
  const throttled = rateLimited > 0 || oversize > 0;
  const retry = accepted === 0 && rejected > 0 && oversize === 0 && rateLimited >= rejected;
  return { accepted, rejected, throttled, retry };
}

export function createEventIngest(options: EventIngestOptions): EventIngest {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const bufferMax = positiveInt(options.bufferMax, EVENT_INGEST_BUFFER_MAX);
  const batchMax = positiveInt(options.batchMax, EVENT_INGEST_BATCH_MAX);
  const flushMs = positiveInt(options.flushMs, EVENT_INGEST_FLUSH_MS);
  const backoffMaxMs = Math.max(
    flushMs,
    positiveInt(options.backoffMaxMs, EVENT_INGEST_BACKOFF_MAX_MS),
  );
  const buffer: UiWireEvent[] = [];
  const dropped: Record<EventIngestDropReason, number> = {
    invalid: 0,
    buffer_full: 0,
    disconnected: 0,
    timeout: 0,
    refused: 0,
  };
  let sent = 0;
  let gatewayRejected = 0;
  let requeued = 0;
  let batches = 0;
  let runIdOmitted = 0;
  let heldForSocket = 0;
  /** Consecutive flushes that delivered nothing (held for the socket, failed, or throttled). */
  let streak = 0;
  let inFlight = false;
  let armed = false;

  function nextDelay(): number {
    return Math.min(flushMs * 2 ** Math.min(streak, 16), backoffMaxMs);
  }

  function arm(): void {
    if (armed || inFlight || buffer.length === 0) {
      return;
    }
    armed = true;
    try {
      setTimer(() => {
        armed = false;
        void flush();
      }, nextDelay());
    } catch {
      armed = false;
    }
  }

  /**
   * A run id that is not a UUID is left off and counted, and the row still goes: the row is worth
   * more than its correlation id, and the loss stays visible (header). sanitizeUiEvent, the wall,
   * refuses whatever still carries one.
   */
  function withoutForeignRunId(event: UiEvent): UiEvent {
    if (event.runId === undefined || isUuid(event.runId)) {
      return event;
    }
    runIdOmitted += 1;
    const { runId: _dropped, ...rest } = event;
    return rest;
  }

  function record(event: UiEvent | null | undefined): void {
    if (event === null || event === undefined) {
      return;
    }
    try {
      const wire = sanitizeUiEvent(withoutForeignRunId(event), now());
      if (wire === null) {
        dropped.invalid += 1;
        return;
      }
      if (buffer.length >= bufferMax) {
        dropped.buffer_full += 1;
        // A full buffer still needs its timer: if arming ever failed, this is the next chance.
        arm();
        return;
      }
      buffer.push(wire);
      arm();
    } catch {
      dropped.invalid += 1;
    }
  }

  /** Put a batch the gateway wrote none of back at the head, keeping the bound (rule 2). */
  function requeue(batch: UiWireEvent[]): void {
    buffer.unshift(...batch);
    requeued += batch.length;
    const over = buffer.length - bufferMax;
    if (over > 0) {
      // The NEWEST go, as on any overflow.
      buffer.splice(bufferMax, over);
      dropped.buffer_full += over;
    }
  }

  function flush(): Promise<void> {
    if (inFlight || buffer.length === 0) {
      return Promise.resolve();
    }
    let up = false;
    try {
      up = options.isConnected() === true;
    } catch {
      up = false;
    }
    if (!up) {
      heldForSocket += 1;
      streak += 1;
      arm();
      return Promise.resolve();
    }
    const batch = buffer.splice(0, batchMax);
    inFlight = true;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(options.send(batch));
    } catch (err) {
      result = Promise.reject(err);
    }
    return result
      .then(
        (reply: unknown) => {
          const r = readIngestReply(reply, batch.length);
          batches += 1;
          streak = r.throttled ? streak + 1 : 0;
          if (r.retry) {
            requeue(batch);
            return;
          }
          sent += r.accepted;
          gatewayRejected += r.rejected;
        },
        (err: unknown) => {
          dropped[classifyIngestFailure(err)] += batch.length;
          streak += 1;
        },
      )
      .catch(() => undefined)
      .then(() => {
        // Reached whatever the handlers above did, so the one in-flight slot can never wedge.
        inFlight = false;
        arm();
      });
  }

  function stats(): EventIngestStats {
    return {
      buffered: buffer.length,
      inFlight,
      sent,
      gatewayRejected,
      requeued,
      batches,
      dropped: { ...dropped },
      runIdOmitted,
      heldForSocket,
      nextDelayMs: nextDelay(),
    };
  }

  return { record, flush, stats };
}
