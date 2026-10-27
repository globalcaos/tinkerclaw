// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md, UI lane step U1.
//
// THE DEFECT this module exists to end. A prompt between Enter and its answer was described, until
// step U2 (2026-09-24), by THREE display lanes stacked on each other rather than merged
// (prompt-queue.md §3):
//   M-A  grey dashed `QUEUED`           — the client deferral (a PLACEMENT choice, `queued-sends.ts`)
//   M-B  amber `not delivered · will retry` / `accepted · not in history` — the durable outbox
//   M-C  orange `retry n/6, retrying in …` — the recoverable-error ladder
// M-B REUSED M-A's two render slots (app.ts before U2, at ac2160c717b: "the undelivered state
// reuses these two slots"), and `_queued` WON that precedence. So a deferred prompt whose
// `chat.send` was REJECTED — a prompt no gateway has ever seen — rendered the word `queued`, which
// asserts the opposite (contradiction C1; PQ-2 "one state, one indicator" and PQ-4 "four questions
// at a glance").
//
// THE FIX, in two pure functions:
//   derivePromptState(inputs) — the §2 lifecycle: the plain facts of one prompt in, exactly ONE
//                               state out.
//   promptIndicator(state)    — the §6.1 table: one state in, exactly ONE indicator out.
// Between them there is no room for two opinions about one prompt, which is the whole point.
//
// SCOPE — U1 wrote the two functions. U2 (2026-09-24) renders every user bubble through them
// (msg-order.ts `promptBubbleMarks`, the render path's importer) and retired the `_queued` /
// `_undelivered` / `_undeliveredAcked` flag triple for one `_promptState`, flipping the C1 gap pin
// in prompt-queue.md's `verify:` block to a positive check. U3 records the gateway's `disposition`
// as a fact (app.ts `onPromptDispositionFinal`), which derives STEERED or BEHIND here. U4 (the
// section at the end of this file) adds the gateway's evidence (`gatewayHolderFacts`: the G5
// `pendingPrompts` snapshot plus the outbox) and the owner's actions on a LOST prompt
// (`promptActionsHtml`: Resend, Dismiss). U5 draws the orange retry countdown through the RETRYING
// row (app.ts `renderRetryWarningBubble`).
//
// MECHANISM — CODE, NOT PROMPT (prompt-queue.md §8, design-principles.md #22). Every want here is
// CONSISTENCY: the same prompt state must look the same on every turn, and the next model must not
// be able to skip it. There is a structural producer to hang it on (the one render function, the one
// outbox, the one gateway disposition), and nothing here benefits from plasticity. So it is a pure
// module with a table, not a sentence in a prompt.
//
// PURE by construction, same precedent as `queued-sends.ts`, `outbox.ts` and `retry-lifecycle.ts`:
// no DOM, no globals, no clock, and no import from `app.ts` (which is an un-testable browser entry).
// Every input is plain data the caller already holds. The ONE import is the attempt cap, taken from
// its single owner so this file cannot drift into a second copy of the number 8.
//
// FORK 2026-09-24 (logging.md §4.5, §9 step 7) — ONE piece here has memory:
// `createPromptStateTracker`, after the derivation, remembers the last state it saw per prompt key
// so that the derived state's CHANGES can be recorded as `ui.prompt.state` rows, not its every
// paint. The memory lives in the instance its caller owns (app.ts), never in this module, and `now`
// is still a parameter.

import { OUTBOX_MAX_ATTEMPTS } from "./outbox.js";

/**
 * The §2 lifecycle states.
 *
 * ANSWERED is in this union although it has no row of its own in the §6.1 table: §2 gives it the
 * indicator "none" (the transcript speaks for itself), and a caller needs to be able to say "this
 * prompt is done" and get nothing back rather than have to special-case it before calling.
 */
export type PromptStateName =
  | "SAVED"
  | "SENDING"
  | "UNSENT"
  | "ACCEPTED"
  | "BEHIND"
  | "STEERED"
  | "PREPARING"
  | "RUNNING"
  | "RETRYING"
  | "ANSWERED"
  | "FAILED"
  | "CANCELLED"
  | "LOST";

/** Every state, in §2 lifecycle order. Exported so a test can prove the table is exhaustive. */
export const PROMPT_STATES: readonly PromptStateName[] = Object.freeze([
  "SAVED",
  "SENDING",
  "UNSENT",
  "ACCEPTED",
  "BEHIND",
  "STEERED",
  "PREPARING",
  "RUNNING",
  "RETRYING",
  "ANSWERED",
  "FAILED",
  "CANCELLED",
  "LOST",
] as const);

/**
 * F2 TRANSPORT (§1) — the ONE fact the browser alone owns, as its latest outcome.
 *
 *   "not-issued" — `chat.send` has not been called yet (the outbox + journal write of `send()`,
 *                  before the first await). Microseconds in the happy path; a whole page load after
 *                  a reload that caught `send()` mid-await.
 *   "in-flight"  — issued, no answer yet: the `sending` latch is up.
 *   "rejected"   — the RPC rejected, or the socket was not OPEN. The gateway does NOT hold it.
 *   "acked"      — `chat.send` resolved (`app.ts` records it through `notePromptFacts` and calls
 *                  `markAcked`).
 *
 * ACK IS NOT DURABILITY (outbox.ts, 2026-08-24): "acked" means the gateway holds this
 * idempotencyKey, NOT that the turn was persisted. That is why "acked" hands the prompt to the
 * gateway lane below rather than retiring it — only a keyed transcript row retires an outbox entry
 * (PQ-9), and that retirement is `outbox.ts`'s job, not this table's.
 */
export type PromptTransport = "not-issued" | "in-flight" | "rejected" | "acked";

/** F3 DISPOSITION (§6.3) — what the gateway DID with an accepted prompt. Reported on the early
 *  `final` from the `!agentRunStarted` branch. ABSENT means an old gateway, never "run now". */
export type PromptDisposition = "steered" | "backlogged" | "dropped";

/** §6.3 — one entry of the `sessions.list` row's `pendingPrompts` snapshot. This is what PQ-11
 *  ("state survives the tab") re-derives from after a reload, and the FRESHEST gateway fact there
 *  is, so it outranks the one-shot `disposition` below. */
export type PendingPromptPhase = "behind" | "steered" | "preparing" | "running";

/** The bubble's tone. "none" is §6.1's "—": this state puts NOTHING on the prompt bubble, and its
 *  whole indicator lives in `other`. PQ-4 fixes the meanings: grey = the gateway has it, wait;
 *  amber = only your browser has it, or the gateway lost it. */
export type IndicatorTone = "none" | "normal" | "grey" | "amber";

/** §6.1's placement half. Deferral is a PLACEMENT choice and nothing else (§1, PQ-8). */
export type IndicatorPlacement = "in-place" | "trailing";

/** §6.1's "other surface" column. Each value names one existing surface; none is new. */
export type IndicatorSurface =
  | "none"
  | "pill-sending"
  | "pill-preparing-context"
  /** the gateway's own phase label + elapsed time; past turn-latency.md's measured normal the pill
   *  adds `waiting for the gateway · 4m`. */
  | "pill-gateway-phase"
  | "thinking"
  /** the orange pulsing countdown bubble under the failed answer (M-C), with Stop retrying. */
  | "retry-countdown"
  | "error-bubble";

/** PQ-12 — "action where the problem is". A state that needs the owner offers its action ON the
 *  prompt. No copy may promise work that no code will do (that is contradiction C7). */
export type PromptAction = "resend" | "dismiss" | "report-bug" | "stop-retrying";

/** One row of the §6.1 state → indicator table. */
export interface PromptIndicator {
  state: PromptStateName;
  /** §6.1 "badge on the prompt". `null` is the table's "—": this state gets no badge at all. */
  badge: string | null;
  tone: IndicatorTone;
  placement: IndicatorPlacement;
  /** §6.1 is explicit that BEHIND is dimmed and STEERED is NOT — a steered prompt IS part of the
   *  running turn now, so dimming it would say the opposite. */
  dimmed: boolean;
  /** The amber lane's two states are told apart by this: UNSENT is "amber, dashed" (still moving),
   *  LOST is "amber, solid" (it has stopped, and it wants you). */
  dashed: boolean;
  other: IndicatorSurface;
  actions: readonly PromptAction[];
  /** §6.1's "cleared by" column, carried in the row on purpose. PQ-5 — no indicator outlives its
   *  state — is a claim about exactly this column, so it belongs next to the badge it governs and
   *  not in a comment three files away. */
  clearedBy: string;
}

/**
 * The plain facts of ONE prompt. Every field is derived from a source that exists TODAY; none of
 * them is a clock, and none of them is a guess.
 *
 * OLD-GATEWAY RULE (§6.3, and the reason every gateway field is optional): an absent field means
 * "this gateway does not report that yet", which is NOT the same as a negative answer. An absent
 * `disposition` leaves the prompt in ACCEPTED — it never lets this module invent BEHIND or STEERED,
 * because PQ-8 says disposition is REPORTED, not guessed, and inferring it is precisely how `queued`
 * ended up shown for a prompt the gateway was already running.
 */
export interface PromptStateInputs {
  /** F2. See `PromptTransport`. */
  transport: PromptTransport;

  /** Outbox `attempts` — how many times this entry has been handed to the transport. Only consulted
   *  while unacked, to tell "still replaying" (UNSENT) from "replays exhausted" (LOST). */
  attempts?: number;
  /** Defaults to the outbox's own `OUTBOX_MAX_ATTEMPTS`, which stays this number's single owner. */
  maxAttempts?: number;

  /**
   * The deferral predicate's verdict (`shouldQueue`, queued-sends.ts) — PLACEMENT ONLY.
   *
   * PQ-8: "the UI's deferral predicate chooses only the PLACEMENT while that report is outstanding".
   * So it is honoured for the states BEFORE a gateway report (SAVED, SENDING, UNSENT, ACCEPTED) and
   * ignored afterwards, where §6.1's own placement column is authoritative. It never changes WHICH
   * state a prompt is in — that is the C1 fix.
   */
  deferred?: boolean;

  /** §6.3 `chat` event `disposition`. Absent = old gateway. */
  disposition?: PromptDisposition;
  /** §6.3 `sessions.list` row `pendingPrompts[].state` for this key. Absent = old gateway, or the
   *  gateway holds nothing pending for this prompt (which is evidence for LOST, but the CALLER
   *  decides that — see `noGatewayHolder`). */
  pending?: PendingPromptPhase;

  /** A keyed `chat` `aborted` arrived for this prompt: stop, `sessions.delete` or `sessions.reset`
   *  (§6.2 steps 2 and 4). PQ-7 — a terminal ends only the prompt it names. Recorded on the prompt
   *  whose OWN run it ends (app.ts `notePromptTerminal`, queued-sends.ts `ownRunTerminal`) and on
   *  the prompts keyed to that run (app.ts `endPromptsKeyedToRun`). */
  cancelled?: boolean;

  /** F5 RETRY — the recoverable-error ladder is counting down for this prompt
   *  (`retry-lifecycle.ts` / `retry-policy.ts`). UI-owned (PQ-3). */
  retrying?: boolean;
  /** The turn failed unrecoverably, or the ladder gave up. */
  failed?: boolean;
  /** The turn reached its terminal with an answer: the prompt's own `final` (queued-sends.ts
   *  `ownRunTerminal`) or a keyed run's (`terminalPromptFacts`), recorded on the live bubble. Since
   *  2026-10-01 also the outbox entry's `answeredAt` (`gatewayHolderFacts`), so it outlives the
   *  bubble: a re-drawn or other-tab copy of an answered prompt reads ANSWERED, never LOST. */
  answered?: boolean;

  /**
   * DERIVED LOST evidence for an ACKED prompt: no gateway holder has it (its key is absent from the
   * §6.3 `pendingPrompts` snapshot) AND no transcript row proves it.
   *
   * U4 records it through `gatewayHolderFacts` (the end of this file), on the ONE activity clock.
   *
   * THIS IS NOT A TIMEOUT, and nothing may make it one. done-signals.md R2 and §6.4 both forbid a
   * UI timer that expires a pending indicator; PQ-5 says LOST is DERIVED from the gateway snapshot
   * plus the outbox. For a session row with no `pendingPrompts` report, `strandedQueuedEntries`
   * (queued-sends.ts) is one input of that derivation: a statement that the run the prompt waited
   * on is gone, not about elapsed time alone.
   *
   * Only consulted while `transport === "acked"`. An unacked prompt reaches LOST the other way, by
   * exhausting its replays (§2's `UNSENT → LOST` edge).
   */
  noGatewayHolder?: boolean;
}

/** Defaults every row shares, so each row below states only what §6.1 gives it. */
function row(
  state: PromptStateName,
  spec: Partial<Omit<PromptIndicator, "state">> &
    Pick<PromptIndicator, "badge" | "tone" | "clearedBy">,
): Readonly<PromptIndicator> {
  return Object.freeze({
    state,
    placement: "in-place" as IndicatorPlacement,
    dimmed: false,
    dashed: false,
    other: "none" as IndicatorSurface,
    actions: Object.freeze([]) as readonly PromptAction[],
    ...spec,
  });
}

/**
 * THE §6.1 TABLE, transcribed. One row per state; one state per row.
 *
 * Copy changes belong HERE and nowhere else — the whole cost of the three-lane mess was the same
 * claim written in several places and edited in one of them.
 */
const INDICATORS: Readonly<Record<PromptStateName, Readonly<PromptIndicator>>> = Object.freeze({
  // §6.1 row "SAVED / SENDING": no badge, a normal bubble, and the pill says `sending`.
  SAVED: row("SAVED", {
    badge: null,
    tone: "normal",
    other: "pill-sending",
    clearedBy: "ack / reject",
  }),
  SENDING: row("SENDING", {
    badge: null,
    tone: "normal",
    other: "pill-sending",
    clearedBy: "ack / reject",
  }),
  // The honest half of today's amber lane. Note the text: "retrying", present tense, and it is only
  // ever shown while replays REMAIN — the moment they are exhausted the state is LOST, which is how
  // contradiction C7 ("will retry" on an entry `dueForReplay` will never return again) is closed.
  UNSENT: row("UNSENT", {
    badge: "not sent · retrying",
    tone: "amber",
    dashed: true,
    clearedBy: "ack → ACCEPTED; exhaustion → LOST",
  }),
  // The gateway holds it but has not said what it did with it. NO badge: guessing here is PQ-8's
  // exact failure. The deferral placement is still honoured, because that much is true.
  ACCEPTED: row("ACCEPTED", {
    badge: null,
    tone: "normal",
    other: "pill-preparing-context",
    clearedBy: "disposition",
  }),
  BEHIND: row("BEHIND", {
    badge: "waiting for the current turn",
    tone: "grey",
    placement: "trailing",
    dimmed: true,
    clearedBy: "linked follow-up run starts",
  }),
  // NOT dimmed and NOT trailing: it was folded into the running turn, so it is committed in place.
  STEERED: row("STEERED", {
    badge: "added to the current turn",
    tone: "grey",
    clearedBy: "host turn's terminal",
  }),
  PREPARING: row("PREPARING", {
    badge: null,
    tone: "normal",
    other: "pill-gateway-phase",
    clearedBy: "first model event",
  }),
  RUNNING: row("RUNNING", {
    badge: null,
    tone: "normal",
    other: "thinking",
    clearedBy: "chat terminal",
  }),
  // The prompt bubble itself gets nothing (§6.1 "—"): M-C's orange countdown under the FAILED
  // ANSWER is the whole indicator, and PQ-2 forbids describing one state twice.
  RETRYING: row("RETRYING", {
    badge: null,
    tone: "none",
    other: "retry-countdown",
    actions: Object.freeze(["stop-retrying"]) as readonly PromptAction[],
    clearedBy: "fire / exhausted / stop / success",
  }),
  // §2's terminal. The transcript is the indicator.
  ANSWERED: row("ANSWERED", {
    badge: null,
    tone: "none",
    clearedBy: "— (history)",
  }),
  // §6.1 lists no action on this row; the red bubble owns whatever the owner does next. PQ-12 names
  // FAILED among the states that need the owner, and that is served by the error bubble's own
  // affordance in app.ts, not by a second control on the prompt.
  FAILED: row("FAILED", {
    badge: null,
    tone: "none",
    other: "error-bubble",
    clearedBy: "— (history)",
  }),
  CANCELLED: row("CANCELLED", {
    badge: "stopped · not answered",
    tone: "grey",
    clearedBy: "— (history)",
  }),
  // Amber SOLID, against UNSENT's amber dashed: this one has stopped moving and wants the owner.
  // Resend deliberately sends a NEW key — an acked entry replayed with its original key only draws
  // the gateway's dedupe echo of a finished run (65ba434b5c9). Dismiss is the ONE non-proof
  // retirement of an outbox entry (PQ-9), and the journal keeps the text either way.
  LOST: row("LOST", {
    badge: "not in history",
    tone: "amber",
    // FORK 2026-09-26 (the architect: "add a bug icon button, which should log that this particular prompt
    // feature did not work correctly"). The 🐛 retires nothing: it records why this prompt reads
    // LOST (app.ts `reportPromptBug` → prompt-bug-report.ts → prod-ui /api/bug-report).
    actions: Object.freeze(["resend", "dismiss", "report-bug"]) as readonly PromptAction[],
    clearedBy: "the owner's action",
  }),
});

/** The states for which the deferral predicate still owns the placement (PQ-8: "while that report
 *  is outstanding"). After a gateway report, §6.1's own placement column is authoritative. */
const DEFERRAL_OWNS_PLACEMENT: readonly PromptStateName[] = Object.freeze([
  "SAVED",
  "SENDING",
  "UNSENT",
  "ACCEPTED",
] as const);

/**
 * §2 — the plain facts of one prompt in, exactly ONE state out.
 *
 * The ladder is ordered, and the order is the design:
 *   1-3. TERMINALS the owner can see the consequences of (failed, retrying, cancelled) outrank
 *        everything, because they describe the TURN and not the transport.
 *   4.   ANSWERED next — but AFTER cancelled, so a stopped prompt that left a transcript row still
 *        reads "stopped · not answered" rather than claiming an answer it never got.
 *   5-7. The browser's own lane (PQ-3: SAVED, SENDING, UNSENT are the browser's).
 *   8.   The gateway's lane. From the ack onwards every state comes from a GATEWAY FACT, never from
 *        the UI's run map (PQ-3, PQ-8).
 */
export function derivePromptState(inputs: PromptStateInputs): PromptStateName {
  if (inputs.failed) {
    return "FAILED";
  }
  if (inputs.retrying) {
    return "RETRYING";
  }
  // A keyed `chat` aborted, or a gateway that reports it dropped the prompt outright. Both are
  // §2's CANCELLED, and both are keyed to THIS prompt (PQ-7) — a session-wide terminal must never
  // reach here, which is step U3's job upstream.
  if (inputs.cancelled || inputs.disposition === "dropped") {
    return "CANCELLED";
  }
  if (inputs.answered) {
    return "ANSWERED";
  }

  switch (inputs.transport) {
    case "not-issued":
      return "SAVED";
    case "in-flight":
      return "SENDING";
    case "rejected": {
      const attempts = Number.isFinite(inputs.attempts) ? (inputs.attempts as number) : 0;
      const maxAttempts = Number.isFinite(inputs.maxAttempts)
        ? (inputs.maxAttempts as number)
        : OUTBOX_MAX_ATTEMPTS;
      // §2's `UNSENT → LOST` edge: "automatic replays exhausted". The entry is NOT dropped — PQ-9,
      // text outlives every indicator — it stops claiming it will retry and starts asking for help.
      return attempts >= maxAttempts ? "LOST" : "UNSENT";
    }
    case "acked":
    default:
      break;
  }

  // ── From here on, every state is the GATEWAY's (§2's note on ACCEPTED) ──────────────────────
  //
  // §2's `ACCEPTED → LOST` and `BEHIND → LOST` edges: no holder, no terminal, no transcript row.
  // Checked BEFORE the reports because a gateway restart leaves a stale `disposition` in the page
  // while the in-memory follow-up queue that backed it is gone (C11).
  if (inputs.noGatewayHolder) {
    return "LOST";
  }
  // The snapshot is the FRESHER fact and therefore wins: it is how a BEHIND prompt becomes
  // PREPARING when its linked follow-up run starts (§6.3 `promptKeys`, gateway step G3/G5), and how
  // a reloaded tab re-derives state with no event of its own (PQ-11).
  if (inputs.pending) {
    switch (inputs.pending) {
      case "behind":
        return "BEHIND";
      case "steered":
        return "STEERED";
      case "preparing":
        return "PREPARING";
      case "running":
        return "RUNNING";
    }
  }
  if (inputs.disposition === "steered") {
    return "STEERED";
  }
  if (inputs.disposition === "backlogged") {
    return "BEHIND";
  }
  // No report at all — an old gateway, or one that has not answered yet. ACCEPTED is the honest
  // answer: the gateway holds it, and we do not yet know what it did with it.
  return "ACCEPTED";
}

/**
 * §6.1 — one state in, exactly ONE indicator out.
 *
 * `deferred` is the ONLY modifier, and it moves nothing but the placement (PQ-8). Returns a fresh
 * object so a render site cannot mutate the shared table.
 */
export function promptIndicator(
  state: PromptStateName,
  opts: { deferred?: boolean } = {},
): PromptIndicator {
  const base = INDICATORS[state];
  const placement: IndicatorPlacement =
    opts.deferred && DEFERRAL_OWNS_PLACEMENT.includes(state) ? "trailing" : base.placement;
  return { ...base, placement, actions: [...base.actions] };
}

/** The pair, for the render site that has the inputs and wants the row. */
export function derivePromptIndicator(inputs: PromptStateInputs): PromptIndicator {
  return promptIndicator(derivePromptState(inputs), { deferred: inputs.deferred });
}

// ─── ui.prompt.state — the derived state's TRANSITIONS ─────────────────────────────────────────
//
// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/logging.md §4.5 and §9 step 7. `derivePromptState` is a
// pure function of a bubble's facts and runs on every paint (msg-order.ts `promptBubbleMarks`, from
// app.ts renderMsg), so recording "each time it runs" would record every render. The tracker turns
// that stream of verdicts into CHANGES: it remembers the last state it saw per prompt key (PQ-1's
// one identity) and answers only when a verdict differs. app.ts feeds it where a prompt's facts are
// written (notePromptFactsById) and where its state is derived for the paint (renderMsg).
//
// What a row means, exactly:
//   - the FIRST sighting of a key is a baseline and reports nothing. A page reload re-derives every
//     re-drawn prompt, and "this page first saw it" is not a transition of the prompt;
//   - `msInFrom` is the time between the observation that first saw `from` and the one that saw
//     `to`. Observations happen at every fact write and every paint, so it is the state's duration
//     as this page saw it, never an estimate of time before the page existed;
//   - two changes between two observations are one row, from the first state to the last.
// Memory is bounded: past PROMPT_TRACKER_MAX_KEYS the least recently CHANGED key is forgotten, and
// its next sighting is a new baseline.

/** How many prompt keys a tracker remembers. A page holds a few dozen live prompts at most. */
export const PROMPT_TRACKER_MAX_KEYS = 500;

/** One change of one prompt's derived state. */
export interface PromptStateTransition {
  /** The prompt's one key (PQ-1). event-ingest.ts sends it as the row's run_id only if a UUID. */
  readonly key: string;
  readonly from: PromptStateName;
  readonly to: PromptStateName;
  /** Time between the observation that first saw `from` and the one that saw `to`, ms. */
  readonly msInFrom: number;
}

export interface PromptStateTracker {
  /** The transition this verdict makes for `key`, or null (first sighting, no change, bad input). */
  observe(key: string, state: PromptStateName, now: number): PromptStateTransition | null;
  /** The state last remembered for `key`: the cheap check a caller makes before reading a clock. */
  last(key: string): PromptStateName | undefined;
  /** Keys remembered, for tests and probes. */
  size(): number;
}

export function createPromptStateTracker(
  maxKeys: number = PROMPT_TRACKER_MAX_KEYS,
): PromptStateTracker {
  const cap = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : PROMPT_TRACKER_MAX_KEYS;
  const seen = new Map<string, { state: PromptStateName; since: number }>();
  return {
    observe(key: string, state: PromptStateName, now: number): PromptStateTransition | null {
      if (typeof key !== "string" || key.length === 0) {
        return null;
      }
      if (!PROMPT_STATES.includes(state) || !Number.isFinite(now)) {
        return null;
      }
      const prev = seen.get(key);
      if (prev !== undefined && prev.state === state) {
        return null;
      }
      // Re-inserted, so Map order is "least recently changed first" and eviction takes the oldest.
      seen.delete(key);
      seen.set(key, { state, since: now });
      if (seen.size > cap) {
        const oldest = seen.keys().next();
        if (!oldest.done) {
          seen.delete(oldest.value);
        }
      }
      if (prev === undefined) {
        return null;
      }
      return { key, from: prev.state, to: state, msInFrom: Math.max(0, now - prev.since) };
    },
    last(key: string): PromptStateName | undefined {
      return seen.get(key)?.state;
    },
    size(): number {
      return seen.size;
    },
  };
}

// ─── U4 — LOST from the gateway's evidence, and the owner's actions ─────────────────────────────
//
// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step U4 (PQ-5, PQ-11, PQ-12; gaps C4
// and C7). Two more pure pieces, which app.ts wires to THE ONE activity clock and to the one badge
// slot of the user bubble:
//   gatewayHolderFacts — the gateway's evidence about one prompt in, the facts it proves out: the
//                        phase a `pendingPrompts` snapshot names for the key, or LOST.
//   promptActionsHtml  — the §6.1 row's actions (Resend, Dismiss) as the controls drawn ON the
//                        prompt, wired by app.ts's delegated click handler.

/** The four §6.3 phases, to validate a snapshot the wire hands over as `unknown`. */
const PENDING_PROMPT_PHASES: readonly PendingPromptPhase[] = Object.freeze([
  "behind",
  "steered",
  "preparing",
  "running",
] as const);

/**
 * What the UI last read about ONE session from the gateway: its `sessions.list` row (G5,
 * src/gateway/session-utils.types.ts `GatewaySessionRow`).
 */
export interface PendingPromptSnapshot {
  /**
   * When the `sessions.list` REQUEST whose reply holds the row was sent (app.ts
   * `sessionsListAskedAt`), ms epoch. The request, not the reply: the gateway builds the row after
   * the request reaches it, so a row asked for after the ack was built after it, while one that
   * merely ARRIVED after the ack may have been built before (sessions.list takes seconds).
   */
  at: number;
  /**
   * The row's `pendingPrompts`, as served, so it is validated here. ABSENT means nothing is pending
   * OR the gateway predates G5: the gateway omits the field rather than send `[]`, so the field alone
   * cannot tell those two apart. That is why only a row that CARRIES it backs a LOST verdict
   * without the stranded age bound (`gatewayHolderFacts`). A `sessions.changed` push that carried
   * the gateway's whole row has replaced it, present or absent (session-rows-live.ts).
   */
  pendingPrompts?: unknown;
  /** The row's `run.live`: the run set holds a run of this session right now. */
  runLive?: boolean;
  /** The row's `updatedAt`: the session's last recorded write (gateway clock), ms epoch. */
  updatedAt?: number;
}

/** The phase a snapshot names for `key`, or undefined when it names none or is malformed. */
export function heldPromptPhase(
  pendingPrompts: unknown,
  key: string,
): PendingPromptPhase | undefined {
  if (!Array.isArray(pendingPrompts) || !key) {
    return undefined;
  }
  for (const p of pendingPrompts) {
    if (typeof p !== "object" || p === null || (p as { key?: unknown }).key !== key) {
      continue;
    }
    const state = (p as { state?: unknown }).state;
    return PENDING_PROMPT_PHASES.includes(state as PendingPromptPhase)
      ? (state as PendingPromptPhase)
      : undefined;
  }
  return undefined;
}

/** Everything `gatewayHolderFacts` weighs about ONE prompt. Plain data; the caller gathers it. */
export interface GatewayHolderEvidence {
  /** The prompt's one identity (PQ-1): outbox id = bubble id = gateway idempotencyKey. */
  key: string;
  /**
   * Its outbox entry, or null when there is none: proven by a keyed transcript row, dismissed, or
   * never protected. `ackedAt` is when the gateway acked it; `lastProofCheckAt` is when the last
   * transcript read for its session (outbox.ts `markProofChecked`) left it unproven; `answeredAt`
   * is when the prompt's OWN run delivered its successful `final` (outbox.ts `markAnswered`).
   */
  outbox: { ackedAt?: number; lastProofCheckAt?: number; answeredAt?: number } | null;
  /** Its session's row from the last `sessions.list`, or null when that list has no such row. */
  snapshot: PendingPromptSnapshot | null;
  /** queued-sends.ts `strandedQueuedEntries` says so: typed more than QUEUED_STRANDED_MS ago, and no
   *  fresh run or pre-model window is left for it to be waiting on. Weighed only for a row with no
   *  `pendingPrompts` report (the fallback, see `gatewayHolderFacts`). */
  stranded: boolean;
  /**
   * The page's OWN liveness evidence for the prompt's session: it is the viewed session, and this
   * page holds no fresh client run and no open pre-model window for it (app.ts
   * `viewedSessionBusy() || viewedSessionPending()`, the boolean `strandedQueuedEntries`
   * short-circuits on). `stranded` implies it. A verdict backed by a `pendingPrompts` report
   * needs it on its own, without the age bound. Absent means unknown, and unknown is not idle.
   */
  clientIdle?: boolean;
  /**
   * A follow-up run gateway step G3 linked to this key has STARTED (step U3: app.ts
   * `onFollowupRunStart` recorded its link). That start event is a fresher gateway fact than any
   * `sessions.list` row this page holds, and G5's follow-up item outlives its run's start (drain.ts),
   * so a snapshot would still call the prompt BEHIND. Absent or false: no such start was seen.
   */
  followupStarted?: boolean;
}

/**
 * The facts `gatewayHolderFacts` proves. `pending` is always present, so recording it (app.ts,
 * through msg-order.ts `notePromptFacts`) also CLEARS a phase the snapshot no longer names.
 * `noGatewayHolder` is present only when the evidence decides it. Absent means "no verdict", and the
 * bubble keeps what it had: a live bubble stays ACCEPTED, and a re-drawn outbox copy stays LOST
 * (msg-order.ts `outboxPromptFacts`, U2's rule for an acked entry that nothing on the page proves).
 * `answered` is present only when the outbox entry records the prompt's own answer (`answeredAt`,
 * FORK 2026-10-01), and then `noGatewayHolder` is false: an answered prompt had a holder.
 */
export type GatewayHolderFacts = {
  pending: PendingPromptPhase | undefined;
  noGatewayHolder?: boolean;
  answered?: true;
};

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * U4 — the gateway's evidence about ONE prompt in, the facts it proves out (PQ-5, PQ-11).
 *
 *   ANSWERED the outbox entry records that the prompt's OWN run delivered its successful `final`
 *          (`answeredAt`, outbox.ts `markAnswered`; FORK 2026-10-01): `answered`, and a holder
 *          existed. It outranks every branch below, the follow-up start included, because an
 *          answered prompt is done (PQ-6) and no older row or phase may draw it again. It is what
 *          keeps a copy that never saw the `final` (a re-draw after a fresh history merge, another
 *          tab's bubble) from reading LOST: bug-log.md [chat-divergence], cause 1.
 *   STARTED a linked follow-up run has started for the key (U3): PREPARING, or RUNNING when the
 *          snapshot already says so, and a holder exists. Nothing older may pull it back to BEHIND.
 *   HELD   the snapshot names the key: record that phase (BEHIND, STEERED, PREPARING, RUNNING), and
 *          that a holder exists. This is how a prompt still BEHIND a running turn survives a reload
 *          as BEHIND instead of LOST (the known limit U2 left, prompt-queue.md §3.2).
 *   LOST   ALL of these, each a fact something other than a UI clock reported:
 *            - the gateway acked it (an unacked prompt reaches LOST by exhausting its replays);
 *            - the row was asked for AFTER that ack (an older row cannot know about the prompt);
 *            - the row names no holder for the key, and its run set is NOT live;
 *            - a transcript read made after the ack, and no earlier than the session's last recorded
 *              write (`updatedAt`), did not prove it. So an answer that is written but not yet read
 *              back is never called LOST;
 *          and one more, which depends on what backs the verdict (prompt-queue.md §7 U4):
 *            - REPORT, the row carries a `pendingPrompts` list (gateway G5): this page holds no
 *              fresh run and no open pre-model window for the session (`clientIdle`);
 *            - FALLBACK, it carries none (an old gateway, or a G5 one with nothing pending, which
 *              omits the field rather than send `[]`, so the two look alike):
 *              `strandedQueuedEntries` calls it stranded, which is `clientIdle` plus the
 *              QUEUED_STRANDED_MS age bound.
 *   else   no verdict: `noGatewayHolder` is left out.
 *
 * THE AGE BOUND IS THE FALLBACK'S ALONE (FORK 2026-09-25). U4 applied it, and the `run.live` veto,
 * to every verdict, because production G5 then reported only BEHIND prompts, so a key's absence
 * could not tell a lost prompt from one in preflight compaction. Gateway commit 7989149571e wired
 * the rest: runReplyAgent and the follow-up runner create their reply operation with the turn's
 * `promptKeys`, and session-utils.ts `deriveSessionPendingPrompts` reports those keys PREPARING
 * (phases queued, preflight_compacting, memory_flushing), then RUNNING, plus STEERED and BEHIND. A
 * report that leaves the key out now speaks for the whole reply lane, so it needs no age bound.
 *
 * THE TWO LIVENESS VETOES STAY ON BOTH PATHS (a named deviation from U4's "drop both"). The gap
 * they cover: between chat.send's ack and runReplyAgent, get-reply runs media and link
 * understanding and the prepared-reply setup first (get-reply.ts, get-reply-run.ts), and the
 * steer, the backlog and the reply operation all happen inside runReplyAgent (agent-runner.ts),
 * also while another turn of the session runs. turn-latency.md measured 15 s from chat.send to the
 * preflight compaction gate on a congested gateway, and the reply operation is created inside that
 * span. Only the chat abort controller holds the prompt through it (prompt-queue.md §4, holder C).
 *
 * CORRECTION 2026-09-25 — this said "and G5 does not read it". It does now. The gateway commit
 * `git log --grep='report an accepted chat.send prompt as PREPARING'` marks the key from right
 * after the ack until the reply pipeline places it (session-utils.ts trackAcceptedChatSend), and
 * deriveSessionPendingPrompts reports a marked key PREPARING — after every other holder, and never
 * for a key the reply operation already names. On such a gateway a row asked for mid-span NAMES
 * the prompt, so `held` is defined and the LOST branch below is never reached: the gap is closed
 * at its source.
 *
 * THEY STAY ANYWAY, and that is a choice, not an oversight. This page cannot tell a gateway that
 * marks holder C from one that does not: both serve a `pendingPrompts` array, so `reported` is
 * true either way, and on an unmarked gateway a row asked for mid-span still lists the other
 * prompts and not this one. Retiring the vetoes would call that prompt LOST and offer a Resend for
 * a prompt about to run — the false LOST this deviation exists to prevent — and a page outlives
 * the gateway it is talking to (a deployment lags its tree, and a restart can move the tip under a
 * live page). They cost a current gateway nothing, and they are facts, not clocks: the run set is
 * live, or this page still watches a run or a pre-model window for the session. They narrow the
 * window to a session with no live run that this page is not waiting on. Retire them when the row
 * itself carries the gateway's capability, not on a date.
 *
 * NOT A TIMER THAT CLEARS STATE (done-signals.md R2a, §6.4). This derives a DISPLAY fact. It ends
 * nothing: the outbox entry stays, the run set is untouched, and only the owner's click retires the
 * prompt. The stranded bound says the run the prompt waited on is gone, never elapsed time alone.
 *
 * A prompt with no outbox entry is never LOST here: the entry is the prompt's durable copy, and PQ-9
 * retires it only on transcript proof or the owner's Dismiss. Its phase is cleared too: a proven
 * prompt is in the transcript, and G5's follow-up item outlives its run's start (drain.ts), so the
 * snapshot would still call a running follow-up BEHIND.
 */
export function gatewayHolderFacts(ev: GatewayHolderEvidence): GatewayHolderFacts {
  if (isMs(ev.outbox?.answeredAt)) {
    return { pending: undefined, noGatewayHolder: false, answered: true };
  }
  const s = ev.snapshot;
  const held = s === null ? undefined : heldPromptPhase(s.pendingPrompts, ev.key);
  if (ev.followupStarted === true) {
    return { pending: held === "running" ? "running" : "preparing", noGatewayHolder: false };
  }
  if (ev.outbox === null) {
    return { pending: undefined };
  }
  if (held !== undefined) {
    return { pending: held, noGatewayHolder: false };
  }
  const ackedAt = ev.outbox.ackedAt;
  const proofAt = ev.outbox.lastProofCheckAt;
  // The facts every LOST verdict needs, whatever backs it.
  const unproven =
    isMs(ackedAt) &&
    s !== null &&
    isMs(s.at) &&
    s.at > ackedAt &&
    s.runLive !== true &&
    isMs(proofAt) &&
    proofAt > ackedAt &&
    !(isMs(s.updatedAt) && proofAt < s.updatedAt);
  if (!unproven) {
    return { pending: undefined };
  }
  // REPORT: the row carries G5's list, so the key's absence from it is the gateway's own answer,
  // and only the page's liveness veto is added. FALLBACK: no list, so the stranded bound governs.
  const reported = Array.isArray(s?.pendingPrompts);
  const lost = reported ? ev.clientIdle === true : ev.stranded;
  return lost ? { pending: undefined, noGatewayHolder: true } : { pending: undefined };
}

/**
 * The actions whose control sits ON the prompt bubble. §6.1 gives LOST three: Resend, Dismiss and
 * the 🐛 bug report (2026-09-26).
 * `stop-retrying` is RETRYING's, and it is drawn on the orange countdown bubble under the failed
 * answer (app.ts `data-retry-stop`), never on the prompt: PQ-2, one state and one indicator.
 */
export const PROMPT_BUBBLE_ACTIONS: readonly PromptAction[] = Object.freeze([
  "resend",
  "dismiss",
  "report-bug",
] as const);

/** The controls' copy, here and nowhere else (the same rule as the badge text). */
const PROMPT_ACTION_COPY: Readonly<Record<PromptAction, { label: string; title: string }>> =
  Object.freeze({
    resend: {
      label: "Resend",
      title:
        "Send this text again as a new prompt, under a new key. The journal keeps the original.",
    },
    dismiss: {
      label: "Dismiss",
      title: "Stop showing this prompt. Its text stays in the prompt journal.",
    },
    "report-bug": {
      label: "🐛",
      title:
        "Report a bug: this prompt should not read 'not in history'. Saves what the page and the gateway know about it to ~/.openclaw/data/bug-reports/.",
    },
    "stop-retrying": {
      label: "stop retrying",
      title: "Cancel the automatic retry of this turn.",
    },
  });

function escActionAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * U4 / PQ-12 — the §6.1 row's actions for `state`, as the controls drawn ON the prompt bubble. ""
 * for every state whose row has none (all but LOST), and for a bubble with no id to act on.
 *
 * Each control is a `<button>` carrying `data-prompt-action` and `data-prompt-id` (the prompt's one
 * identity, PQ-1), handled by app.ts's delegated #messages click handler: Resend → resendLostPrompt,
 * Dismiss → dismissLostPrompt, 🐛 → reportPromptBug. A control is drawn only for an action that handler serves, so no copy
 * promises work that no code does (contradiction C7).
 *
 * The tone comes from the row, keyed at base.css's ONE pending-prompt declaration site
 * (`.prompt-actions.prompt-tone-<tone> .prompt-action`).
 */
export function promptActionsHtml(state: PromptStateName | null, promptId: unknown): string {
  if (state === null || typeof promptId !== "string" || promptId.length === 0) {
    return "";
  }
  const ind = INDICATORS[state];
  if (!ind) {
    return "";
  }
  const actions = ind.actions.filter((a) => PROMPT_BUBBLE_ACTIONS.includes(a));
  if (actions.length === 0) {
    return "";
  }
  const id = escActionAttr(promptId);
  const buttons = actions
    .map((a) => {
      const copy = PROMPT_ACTION_COPY[a];
      return (
        `<button type="button" class="prompt-action" data-prompt-action="${a}" ` +
        `data-prompt-id="${id}" title="${escActionAttr(copy.title)}">` +
        `${escActionAttr(copy.label)}</button>`
      );
    })
    .join("");
  return `<span class="prompt-actions prompt-tone-${ind.tone}">${buttons}</span>`;
}
