/**
 * The diagnostic bridge — TINKER_UI_DESIGN_BIBLE/logging.md §7.5 ("The bus bridge") and §9 step 4.
 *
 * Two in-process producers already say what §4 wants recorded. This module turns what they say
 * into catalog rows through emitEvent and does nothing else:
 *
 *  - The diagnostic bus (src/infra/diagnostic-events.ts). ONE listener, subscribed through
 *    onDiagnosticEventTypes to the allow-list BRIDGED_BUS_TYPES, maps each bridged type to its
 *    §4 row: the three §4.1 gateway-health rows, plus — 2026-09-25, §9 step 7 — `lane.wait` from
 *    `queue.lane.dequeue` and `session.state` from the bus event of the same name. The remaining
 *    "bus" rows of §9 step 8 (run.done, tool.done, exec.done) extend the allow-list further.
 *
 *    BOTH NEW PRODUCERS EMIT UNTRUSTED, which is what makes them reachable at all: logLaneDequeue
 *    (src/logging/diagnostic-runtime.ts, called from src/process/command-queue.ts drainLane) and
 *    logSessionStateChange (src/logging/diagnostic.ts) both go through emitDiagnosticEvent, and
 *    onDiagnosticEventTypes drops every TRUSTED event before the listener sees it.
 *
 *    LANE CLASS, NEVER THE LANE NAME (§4.5). A lane is either `session:<session key>` or a global
 *    name (`main`, `cron`, `subagent`, …; src/process/lanes.ts). The raw lane name embeds a session
 *    key, so it is never stored: the label is the CLASS, and the stripped key travels as
 *    `sessionKey`, which the writer hashes into session_hash/session_kind and puts in no column.
 *
 *    VOLUME. `lane.wait` is one row per dequeue — the highest-rate row this bridge carries — and
 *    `session.state` one per transition. Both rates are what §4.5 already declares. The type filter
 *    still keeps `log.record` and every unbridged type off the listener entirely, so the clone below
 *    is paid only for events that become rows.
 *  - The instrument-liveness report (src/infra/instrument-liveness.ts), through its report sink:
 *    `instrument.census` on every 60 s health tick and `instrument.transition` when an
 *    instrument's verdict changes (§4.10). It shares nothing with the bus but this start
 *    function, and keeps writing when the bus is off.
 *
 * COST (L3). The bus hands each listener a structuredClone plus a deep freeze of each event it
 * dispatches to it. onDiagnosticEventTypes runs the type check BEFORE that clone, so the bridge
 * pays nothing for the types it ignores — `log.record`, one per log line, above all. Measured
 * 2026-09-25 (node v22.23.1, synthetic, 3 runs of 20,000 emits per arm, p50): an UNFILTERED no-op
 * listener raises every event it is handed from ~0.6-0.9 µs to ~3.9-4.5 µs, and a log.record burst
 * from ~1.0-1.3 to ~3.3-4.3 µs mean; with the bridge, ignored types stay at ~0.6-0.7 µs and
 * log.record at ~0.9-1.5 µs, and a bridged event costs ~4.0-4.6 µs (the clone and freeze; the
 * benchmark's emit was a counter, the real emitEvent adds its O(1) queue push and an HMAC when the
 * event carries a session key). bridge-diagnostic-bus.test.ts reruns the same three arms. The live
 * `diagnostic.cpuProfile` before/after §9 step 4 asks for needs a gateway running this build: it
 * is owed after the next deploy.
 *
 * DIAGNOSTICS OFF. With `diagnostics.enabled: false` the bus drops every event at its source, so
 * NONE of the five bus rows can occur — `lane.wait` and `session.state` included, and doubly so:
 * their producers (logLaneDequeue, logSessionStateChange) both return on
 * areDiagnosticsEnabledForProcess() before they emit anything at all. The start says so once in the
 * journal; the census, the health sample and gw.boot do not ride the bus and keep writing.
 *
 * PII (L4). The bus carries raw session keys; they reach emitEvent only as `sessionKey`, which the
 * writer hashes (never a column). Labels and the stuck `reason` come from closed unions the bus's
 * own types define. A stuck session known only by its sessionId gets no session columns: the
 * events table has no place for a raw id.
 *
 * Start it AFTER startEventWriter: while no writer runs it installs nothing, by design.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEventTypes,
  type DiagnosticEventPayload,
} from "../diagnostic-events.js";
import {
  setInstrumentLivenessReportSink,
  type InstrumentLivenessReportSink,
  type InstrumentLivenessState,
} from "../instrument-liveness.js";
import { getCatalogEvent } from "./catalog.js";
import { emitEvent, getEventWriterStats, type EmitEventRecord } from "./emit.js";

type EmitEventFn = typeof emitEvent;

const log = createSubsystemLogger("events-bridge");

/** One catalog row, as emitEvent takes it. */
export interface BridgedRow {
  readonly name: string;
  readonly record: EmitEventRecord;
}

/** The allow-list (§7.5): each bridged bus type and the one §4.1 row it becomes. */
export const BRIDGED_BUS_TYPES = {
  "diagnostic.liveness.warning": "gw.liveness.warning",
  "diagnostic.memory.pressure": "gw.memory.pressure",
  "session.stuck": "gw.session.stuck",
  "queue.lane.dequeue": "lane.wait",
  "session.state": "session.state",
} as const satisfies Partial<Record<DiagnosticEventPayload["type"], string>>;

/**
 * The session-lane prefix src/agents/embedded-agent-runner/lanes.ts builds (`session:<key>`); every
 * other lane is global. A literal rather than an import: infra must not depend on the agent runner,
 * and there is no strip helper there to reuse. bridge-diagnostic-bus.test.ts drives the REAL path —
 * a lane built by resolveSessionLane, admitted by command-queue.ts enqueueCommandInLane (drainLane
 * → logLaneDequeue) — so a renamed prefix fails there rather than quietly relabelling every session
 * lane as global.
 */
const SESSION_LANE_PREFIX = "session:";

/** §4.5: the label is the lane CLASS. The raw lane name never leaves this module. */
export function laneClass(lane: string): "session" | "global" {
  return lane.startsWith(SESSION_LANE_PREFIX) ? "session" : "global";
}

type BridgedBusType = keyof typeof BRIDGED_BUS_TYPES;

const BRIDGED_BUS_TYPE_LIST = Object.keys(BRIDGED_BUS_TYPES) as BridgedBusType[];

/** The row one bus event becomes, or null for any type outside the allow-list. Pure. */
export function mapDiagnosticEvent(evt: DiagnosticEventPayload): BridgedRow | null {
  switch (evt.type) {
    case "diagnostic.liveness.warning":
      return {
        name: BRIDGED_BUS_TYPES[evt.type],
        record: {
          tsMs: evt.ts,
          label: evt.reasons.join("+"),
          n1: evt.eventLoopDelayP99Ms,
          n2: evt.eventLoopDelayMaxMs,
          n3: evt.eventLoopUtilization,
          n4: evt.cpuCoreRatio,
        },
      };
    case "diagnostic.memory.pressure":
      return {
        name: BRIDGED_BUS_TYPES[evt.type],
        record: {
          tsMs: evt.ts,
          label: `${evt.level}:${evt.reason}`,
          n1: evt.memory.rssBytes,
          n2: evt.memory.heapUsedBytes,
          n3: evt.thresholdBytes,
          n4: evt.rssGrowthBytes,
        },
      };
    case "session.stuck":
      return {
        name: BRIDGED_BUS_TYPES[evt.type],
        record: {
          tsMs: evt.ts,
          sessionKey: evt.sessionKey,
          label: evt.state,
          n1: evt.ageMs,
          n2: evt.queueDepth,
          fields: { reason: evt.reason },
        },
      };
    case "queue.lane.dequeue": {
      // §4.5 `lane.wait`: a span whose dur_ms is the wait. label = the lane CLASS; the stripped
      // session key goes to sessionKey (hashed, never a column) and the lane name itself nowhere.
      const session = laneClass(evt.lane) === "session";
      return {
        name: BRIDGED_BUS_TYPES[evt.type],
        record: {
          tsMs: evt.ts,
          sessionKey: session ? evt.lane.slice(SESSION_LANE_PREFIX.length) : undefined,
          label: session ? "session" : "global",
          durMs: evt.waitMs,
          n1: evt.queueSize,
        },
      };
    }
    case "session.state":
      // §4.5 `session.state`: label = the state entered, fields.from = the one left. `reason` is a
      // caller-supplied token; the writer's id rule drops anything outside the closed shape and
      // counts it in invalidValues, so no free text can reach the database through this row (L4).
      return {
        name: BRIDGED_BUS_TYPES[evt.type],
        record: {
          tsMs: evt.ts,
          sessionKey: evt.sessionKey,
          label: evt.state,
          n1: evt.queueDepth,
          fields: { from: evt.prevState, reason: evt.reason },
        },
      };
    default:
      return null;
  }
}

/**
 * Whether catalog row `instrument.transition` declares the verdict an instrument moved TO. §4.10
 * spends `label` on the instrument id, so the §4 kind convention (label = the new state) leaves the
 * destination verdict with no slot of its own: it has to be a declared field.
 *
 * DECLARED 2026-09-25, so this reads true in production: the emitter below writes both verdicts,
 * and each instrument's first verdict in this process as well (`to` alone, no `from`). The false
 * arm is kept, and exercised by bridge-diagnostic-bus.test.ts, because it is what keeps the emitter
 * from ever writing an undeclared key: if the row lost `to` again, transitions would fall back to
 * `from` alone instead of being dropped by the writer and counted as undeclaredKeys.
 */
function transitionRecordsTo(): boolean {
  return "to" in (getCatalogEvent("instrument.transition")?.fields ?? {});
}

export interface InstrumentReportBridgeOptions {
  /** Test seam; defaults to whether the catalog declares `to` on instrument.transition. */
  readonly recordsTo?: boolean;
}

/**
 * The instrument-liveness report as rows (§4.10). `instrument.census`, every tick, carries the
 * counts the `[instrument-liveness] declared=…` line prints (so its `stale` is the report's count,
 * which an idle process folds into `idle`). `instrument.transition` compares each instrument's
 * verdict (`state`) with the previous tick's: label = the instrument id, fields.from = the verdict
 * it left, fields.to = the one it entered. With `to` declared, an instrument's first verdict in
 * this process is written as well (no `from`), so the state each boot starts from is on record.
 */
export function createInstrumentReportBridge(
  emit: EmitEventFn,
  options: InstrumentReportBridgeOptions = {},
): InstrumentLivenessReportSink {
  const recordsTo = options.recordsTo ?? transitionRecordsTo();
  let previous: ReadonlyMap<string, InstrumentLivenessState> = new Map();
  return ({ nowMs, counts, states }) => {
    emit("instrument.census", {
      tsMs: nowMs,
      n1: counts.declared,
      n2: counts.live,
      n3: counts.never,
      n4: counts.stale,
      fields: { pending: counts.pending, idle: counts.idle, by_config: counts.byConfig },
    });
    for (const [id, state] of states) {
      const from = previous.get(id);
      if (from === state) {
        continue;
      }
      if (recordsTo) {
        emit("instrument.transition", { tsMs: nowMs, label: id, fields: { from, to: state } });
      } else if (from !== undefined) {
        emit("instrument.transition", { tsMs: nowMs, label: id, fields: { from } });
      }
    }
    previous = states;
  };
}

export interface DiagnosticBusBridgeOptions {
  /** Test seam: where rows go. Omitted, they go to the process-wide emitEvent. */
  readonly emit?: EmitEventFn;
}

/**
 * Starts the bridge — the filtered bus listener and the instrument report sink — and returns its
 * stop function (idempotent). Without an injected `emit` it starts only while the process-wide
 * writer is enabled, and otherwise installs nothing and returns a no-op.
 */
export function startDiagnosticBusBridge(options: DiagnosticBusBridgeOptions = {}): () => void {
  if (options.emit === undefined && !getEventWriterStats().enabled) {
    return () => {};
  }
  const emit = options.emit ?? emitEvent;
  if (!areDiagnosticsEnabledForProcess()) {
    log.info(
      "diagnostics are off for this process (diagnostics.enabled=false): the bus carries no " +
        "events, so gw.liveness.warning, gw.memory.pressure, gw.session.stuck, lane.wait and " +
        "session.state will not be recorded (logging.md §4.1, §4.5)",
    );
  }
  const unsubscribe = onDiagnosticEventTypes(BRIDGED_BUS_TYPE_LIST, (evt) => {
    const row = mapDiagnosticEvent(evt);
    if (row !== null) {
      emit(row.name, row.record);
    }
  });
  const clearReportSink = setInstrumentLivenessReportSink(createInstrumentReportBridge(emit));
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unsubscribe();
    clearReportSink();
  };
}
