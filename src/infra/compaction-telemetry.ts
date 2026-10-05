// FORK 2026-09-24 (the CONTEXT WINDOW panel, TINKER_UI_DESIGN_BIBLE/context-window-panel.md
// §6.1 step A1) — single owner of the `stream:"compaction"` agent-event contract.
//
// WHY ONE OWNER (P7 in that optic). A compaction can be decided and run by many executors — pi's
// own decider, the runner's preemptive / overflow / timeout / tool-loop gates, the queued path,
// the manual RPC, eviction, and the claude CLI's internal compaction — and before this file only
// pi's decider emitted anything on the gateway's own lanes, and engram mode switches that one
// off. The panel's permanent "compactions 0" was a PRODUCER defect. So every executor that RUNS a
// compaction emits the same start / end pair, built here, exactly once per compaction. A gate that
// only decides and hands off is heard through the executor it hands off to, under that executor's
// trigger (see "overflow" below).
//
// PRODUCERS TODAY, and the trigger each sends (the CompactionTrigger members below):
//   - pi's own decider: embedded-agent-subscribe.handlers.compaction.ts -> "pi-auto".
//   - the runner (A2): the leaf compactEmbeddedPiSessionDirect (compact.ts) and the engine-owned
//     branch of compact.queued.ts, through resolveRunnerCompactionTrigger -> "overflow",
//     "timeout", "queued", "preemptive", "manual".
//   - the EVICT button (A5): src/gateway/session-eviction.ts -> "evict".
//   - the claude CLI's own compaction, heard by the tinker-bridge (A3,
//     extensions/tinkerclaw-tinker-bridge/src/stream.ts) through the
//     openclaw/plugin-sdk/fork-telemetry re-export of this module -> "cli-internal".
// The src/ producers all send provenance "estimated" and the bridge "exact" (the CLI's own
// compact_metadata); see CompactionProvenance. The upstream codex projector still writes its own
// trigger-less payload, outside this owner (the gate-7 note below), so it never reaches the ledger.
//
// This is the only shipped file allowed to write the `stream: "compaction"` literal. Verify gate 7
// of context-window-panel.md fails on any other, bar the upstream codex projector, which is listed
// there by name until it is re-pointed.
//
// ABSENT, NOT ZERO (P10). Every token count and the duration are optional and OMITTED when the
// producer does not know them. A finite value >= 0 is kept (a measured 0 is a real 0); undefined,
// NaN, ±Infinity and negatives are dropped, never coerced to 0 — a fabricated 0 reads as
// "compacted nothing", absence reads as "unknown". This deliberately differs from
// cache-telemetry.ts's toCount, which zeroes: that contract has required counts, this one has none.
//
// PARTS, NOT A DELTA. tokensBefore / tokensAfter go out as parts so the consumer can check the
// subtraction (the cache-telemetry rule). tokensDropped is a separate figure, sent only by an
// executor that measured it itself; it is never derived on the wire. Today that is the EVICT
// button (session-eviction.ts, its evictedTokens) and a runner executor that hands the pair its
// result's own measured drop (compact.queued.ts readMeasuredCompactionDrop: engram's
// tokensEvicted). The ledger (next paragraph) is a consumer: its row's n3 derives before minus
// after when no measured drop came, and its catalog meaning says so.
//
// THE LEDGER (A4, 2026-09-24; logging.md §4.7). This owner is also the single writer of the
// compaction ledger: on every `end`, and only on an end, it queues ONE `compaction.run` row on the
// events database (src/infra/events/emit.ts) and folds the same figures into the in-memory
// per-session totals that the sessions.list row reads (src/infra/compaction-ledger.ts, A7). A
// start writes nothing: a compaction is one row, and its span is the end's durationMs. The session
// is the key the producer put on its target, never emitAgentEvent's per-run fallback, so an end
// whose target carries none is still a row and counts for no session. Every producer puts the key
// it knows there (pi-auto since 2026-09-25; before that its rows counted for no session).
//
// Consumers today (re-derived 2026-09-25):
//   - the ledger above: trigger, lane, provenance, completed, the three token figures and
//     durationMs, keyed by the target's session.
//   - tinker-ui app.ts, three readers. The CONTEXT WINDOW panel's pulse (compactionPulseStep,
//     panels/context-buttons.ts): phase and trigger. THIS SESSION's counters (B3, compactionDrop
//     in panels/context-counters.ts): phase, completed, trigger, provenance and tokensDropped, and
//     tokensBefore / tokensAfter only on "exact" provenance. The drop sizes `saved`; a completed
//     end only makes the host re-read the sessions.list row, whose A7 figures are the counts, so
//     nothing in the UI counts a compaction off this stream. The call timeline's compaction band
//     (CallTimelineStore.compactionStart / compactionEnd, panels/call-timeline.ts): trigger,
//     completed, provenance, durationMs and the three token figures.
//   - the auto-reply runners (agent-runner-execution.ts, followup-runner.ts and
//     agent-runner-memory.ts read phase and completed).
// willRetry is sent by pi-auto alone (pi retries the request after an overflow compaction); no
// shipped consumer reads it, and the pi-auto handler tests pin it.
import { emitAgentEvent } from "./agent-events.js";
import {
  COMPACTION_LEDGER_COMPLETED,
  COMPACTION_LEDGER_EVENT,
  COMPACTION_LEDGER_INCOMPLETE,
  compactionLedgerDrop,
  noteCompactionLedgerEnd,
} from "./compaction-ledger.js";
import { emitEvent } from "./events/emit.js";

export type CompactionPhase = "start" | "end";

/**
 * WHO ran the compaction, as the producer that emits it names it (the header maps producer to
 * trigger). A new executor adds its value HERE (this file is the single owner) instead of sending
 * a free-form string, and only together with the producer that sends it: a member nothing emits
 * reads as a compaction class the panel could hear, and it cannot.
 */
export type CompactionTrigger =
  /** pi's own AgentSession decider (embedded-agent-subscribe.handlers.compaction.ts). */
  | "pi-auto"
  /**
   * cli-compaction.ts's budget gate, run over a CLI session's gateway transcript (runner trigger
   * "cli_budget"). NOT attempt.ts's preemptive precheck, which reports "overflow".
   */
  | "preemptive"
  /**
   * run.ts's recovery after a context-overflow error (runner trigger "overflow"). Three deciders
   * reach it as overflow errors and all report this: a provider overflow, attempt.ts's preemptive
   * precheck (PREEMPTIVE_OVERFLOW_ERROR_TEXT) and the tool-result context guard
   * (PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE, the `tool-loop-guard` diagnostic gate). run.ts, a tier-1
   * merge-driver file, does not pass down which, so neither gate has a member of its own here:
   * "tool-loop-guard" was removed 2026-09-24 because no producer could send it. Give a gate its
   * member back only in the change that makes run.ts send it.
   */
  | "overflow"
  /** run.ts's recovery after a timeout (runner trigger "timeout_recovery"). */
  | "timeout"
  /**
   * The preflight compaction in agent-runner-memory.ts (runner trigger "budget"), the queued
   * path's automatic caller.
   */
  | "queued"
  /**
   * sessions.compact (the COMPACT button) and /compact. Also where resolveRunnerCompactionTrigger
   * sends a missing or unlisted runner trigger.
   */
  | "manual"
  /** sessions.compact with keepFraction — the EVICT button (src/gateway/session-eviction.ts). */
  | "evict"
  /**
   * The claude CLI's own compaction (`system/compact_boundary` on its stream-json stdout), sent by
   * the tinker-bridge (context-window-panel.md §6.1 A3, extensions/tinkerclaw-tinker-bridge/src/
   * stream.ts) through the openclaw/plugin-sdk/fork-telemetry re-export of this module. The one
   * member no src/ producer sends.
   */
  | "cli-internal";

/**
 * The serving lane of the session whose context was compacted. On `cc-bridge` the model reads the
 * CLI's own transcript, so only a `cli-internal` compaction shrinks what it sees there; any other
 * trigger on that lane compacted the gateway's mirror (context-window-panel.md F1 / F2).
 */
export type CompactionLane = "embedded" | "cc-bridge";

/**
 * Where the token figures come from (P5): reported by the provider / CLI ("exact"), or a local
 * estimate ("estimated", e.g. ceil(chars / 3.5)). An event claims no more than its weakest figure.
 * Every src/ producer sends "estimated" today; "exact" is A3's (the CLI's compact_metadata).
 *
 * P5's "aggregate" (a turn-level sum) and "apportioned" are deliberately NOT members: no
 * producer's figure is either. pi-auto's tokensBefore starts from the last assistant usage, which
 * on the cc-bridge lane is the CLI's turn aggregate, but adds a chars/4 estimate of every later
 * message, so it is "estimated". Add "aggregate" in the change that wires the first producer whose
 * figure is a bare turn sum.
 */
export type CompactionProvenance = "exact" | "estimated";

type CompactionEventCommon = {
  trigger: CompactionTrigger;
  lane: CompactionLane;
  provenance: CompactionProvenance;
  /** Context size before compacting, when the executor knows it. */
  tokensBefore?: number;
};

export type CompactionStartEvent = CompactionEventCommon & { phase: "start" };

export type CompactionEndEvent = CompactionEventCommon & {
  phase: "end";
  /** True only when the compaction produced a result and was not aborted. */
  completed: boolean;
  /** pi only: the framework retries the request after this compaction. */
  willRetry?: boolean;
  /** Context size after compacting, when the executor knows it. */
  tokensAfter?: number;
  /**
   * Tokens THIS compaction removed, only when the executor measured that itself. Never derived
   * from before minus after (the consumer does that), and never the CLI's
   * `cumulative_dropped_tokens`, which is a running total across every earlier compaction.
   */
  tokensDropped?: number;
  /** Wall time of the compaction, when the executor measured it. */
  durationMs?: number;
};

export type CompactionTelemetryEvent = CompactionStartEvent | CompactionEndEvent;

/** Where an event goes: the global agent-event bus, plus the run-local listener when one exists. */
export type CompactionEmitTarget = {
  runId: string;
  /**
   * Omitted: emitAgentEvent falls back to the session key registered for the run, but the ledger
   * row does not (header: THE LEDGER), so a producer that knows the key sends it.
   */
  sessionKey?: string;
  /** The run's own listener (the runners count completed compactions from it). */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
};

/**
 * The one absent-not-zero rule: a finite number >= 0 is kept, anything else becomes `undefined`,
 * so the field is omitted instead of zeroed.
 */
export function compactionTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function putMeasured(data: Record<string, unknown>, key: string, value: unknown): void {
  const measured = compactionTokenCount(value);
  if (measured !== undefined) {
    data[key] = measured;
  }
}

/** The wire payload (`data`) of one compaction event. Pure. */
export function buildCompactionEventData(event: CompactionTelemetryEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {
    phase: event.phase,
    trigger: event.trigger,
    lane: event.lane,
    provenance: event.provenance,
  };
  putMeasured(data, "tokensBefore", event.tokensBefore);
  if (event.phase === "end") {
    data.completed = event.completed === true;
    if (typeof event.willRetry === "boolean") {
      data.willRetry = event.willRetry;
    }
    putMeasured(data, "tokensAfter", event.tokensAfter);
    putMeasured(data, "tokensDropped", event.tokensDropped);
    putMeasured(data, "durationMs", event.durationMs);
  }
  return data;
}

/**
 * Publish one payload on both channels, in the order the pre-A1 handler used: the global bus
 * first, then the run-local listener. Neither call is wrapped: the run-local listener is part of
 * the run (the runners count compactions from it), so its failure is the run's, not noise to hide.
 */
function publishCompactionEvent(target: CompactionEmitTarget, data: Record<string, unknown>): void {
  emitAgentEvent({
    runId: target.runId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    stream: "compaction",
    data,
  });
  void target.onAgentEvent?.({ stream: "compaction", data });
}

/**
 * A4: the ledger half of one `end` (header: THE LEDGER). ONE `compaction.run` row in the shape its
 * catalog row declares (label, dur_ms, n1..n3, fields), then the same figures into the session's
 * in-memory totals. Every figure passes the absent-not-zero rule first, so an unknown one lands as
 * NULL, never as 0; the drop is derived once (compactionLedgerDrop), so the row and the memory add
 * the same number.
 */
function recordCompactionLedgerEnd(target: CompactionEmitTarget, event: CompactionEndEvent): void {
  const atMs = Date.now();
  const sessionKey = target.sessionKey?.trim() || undefined;
  const tokensBefore = compactionTokenCount(event.tokensBefore);
  const tokensAfter = compactionTokenCount(event.tokensAfter);
  const droppedTokens = compactionLedgerDrop({
    tokensBefore,
    tokensAfter,
    tokensDropped: compactionTokenCount(event.tokensDropped),
  });
  const completed = event.completed;
  emitEvent(COMPACTION_LEDGER_EVENT, {
    tsMs: atMs,
    sessionKey: sessionKey ?? null,
    runId: target.runId,
    label: completed ? COMPACTION_LEDGER_COMPLETED : COMPACTION_LEDGER_INCOMPLETE,
    durMs: compactionTokenCount(event.durationMs) ?? null,
    n1: tokensBefore ?? null,
    n2: tokensAfter ?? null,
    n3: droppedTokens ?? null,
    fields: { trigger: event.trigger, lane: event.lane, provenance: event.provenance },
  });
  if (sessionKey !== undefined) {
    noteCompactionLedgerEnd(sessionKey, { trigger: event.trigger, completed, droppedTokens, atMs });
  }
}

/**
 * Emit one compaction event. Every producer through this owner calls it — pi-auto, the A2 runner,
 * A5 eviction and A3's bridge (through the plugin-sdk re-export); this file exports no other
 * publisher. The type requires `trigger`, `lane` and `provenance`, so an executor cannot forget to
 * say who it is. An `end` also writes the ledger (recordCompactionLedgerEnd), after the event is
 * published.
 */
export function emitCompactionTelemetry(
  target: CompactionEmitTarget,
  event: CompactionTelemetryEvent,
): void {
  publishCompactionEvent(target, buildCompactionEventData(event));
  if (event.phase === "end") {
    recordCompactionLedgerEnd(target, event);
  }
}
