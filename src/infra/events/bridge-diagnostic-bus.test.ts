/**
 * logging.md §9 step 4 — the diagnostic bridge (bridge-diagnostic-bus.ts) and the type-filtered bus
 * subscription it rides (onDiagnosticEventTypes).
 *
 * CONTROL: before this change no bus event and no instrument report became a row — the module did
 * not exist. Each test shows rows appearing only while the bridge runs, in the shape the catalog
 * declares; the shape checks go through the REAL writer's own rules over a fake worker.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalLane, resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  logSessionStateChange,
  logSessionStuck,
  resetDiagnosticStateForTest,
} from "../../logging/diagnostic.js";
import {
  enqueueCommandInLane,
  resetCommandQueueStateForTest,
} from "../../process/command-queue.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  onDiagnosticEventTypes,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventInput,
  type DiagnosticEventPayload,
} from "../diagnostic-events.js";
import {
  declareInstrument,
  logInstrumentLivenessSummary,
  noteInstrumentFired,
  resetInstrumentLivenessForTest,
  setInstrumentLivenessReportSink,
} from "../instrument-liveness.js";
import {
  BRIDGED_BUS_TYPES,
  createInstrumentReportBridge,
  mapDiagnosticEvent,
  startDiagnosticBusBridge,
} from "./bridge-diagnostic-bus.js";
import { getCatalogEvent } from "./catalog.js";
import {
  createEventWriter,
  getEventWriterStats,
  type EmitEventRecord,
  type EventWireRow,
  type EventWriter,
  type EventWriterOptions,
  type WriterWorkerRequest,
  type WriterWorkerResponse,
} from "./emit.js";

type Row = { name: string; record: EmitEventRecord };
type Emit = (name: string, record?: EmitEventRecord) => void;
type BridgedBusType = keyof typeof BRIDGED_BUS_TYPES;

/** A fictional NANP 555-01xx number, the repo's fixture convention: never a real line. */
const PHONE_SESSION_KEY = "agent:main:whatsapp:+15555550142";

const BUS_FIXTURES: Record<BridgedBusType, DiagnosticEventInput> = {
  "diagnostic.liveness.warning": {
    type: "diagnostic.liveness.warning",
    reasons: ["event_loop_delay", "cpu"],
    intervalMs: 30_000,
    eventLoopDelayP99Ms: 1_200.5,
    eventLoopDelayMaxMs: 2_400,
    eventLoopUtilization: 0.97,
    cpuCoreRatio: 0.93,
    active: 1,
    waiting: 0,
    queued: 2,
  },
  "diagnostic.memory.pressure": {
    type: "diagnostic.memory.pressure",
    level: "critical",
    reason: "rss_threshold",
    memory: {
      rssBytes: 3_000_000_000,
      heapTotalBytes: 2_000_000_000,
      heapUsedBytes: 1_500_000_000,
      externalBytes: 10_000_000,
      arrayBuffersBytes: 5_000_000,
    },
    thresholdBytes: 2_500_000_000,
    rssGrowthBytes: 400_000_000,
    windowMs: 600_000,
  },
  "session.stuck": {
    type: "session.stuck",
    sessionKey: PHONE_SESSION_KEY,
    sessionId: "sess-bridge-1",
    state: "processing",
    ageMs: 185_000,
    queueDepth: 2,
    reason: "client-dead",
  },
  // A SESSION lane, so the fixture also proves the raw lane name — which embeds the key — is not
  // what lands in the label, and that its stripped key is hashed like any other session key.
  "queue.lane.dequeue": {
    type: "queue.lane.dequeue",
    lane: `session:${PHONE_SESSION_KEY}`,
    queueSize: 3,
    waitMs: 1_450,
  },
  "session.state": {
    type: "session.state",
    sessionKey: PHONE_SESSION_KEY,
    sessionId: "sess-bridge-2",
    prevState: "idle",
    state: "processing",
    reason: "message_start",
    queueDepth: 1,
  },
};

const HEARTBEAT: DiagnosticEventInput = {
  type: "diagnostic.heartbeat",
  webhooks: { received: 1, processed: 1, errors: 0 },
  active: 0,
  waiting: 0,
  queued: 0,
};

const BRIDGED = Object.keys(BRIDGED_BUS_TYPES) as BridgedBusType[];

let tmpDir: string;
const writers: EventWriter[] = [];
const stops: Array<() => void> = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-bridge-"));
  resetDiagnosticEventsForTest();
  resetInstrumentLivenessForTest();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const stop of stops.splice(0)) {
    stop();
  }
  for (const writer of writers.splice(0)) {
    await writer.stop();
  }
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  resetInstrumentLivenessForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

function collector(): { rows: Row[]; emit: Emit } {
  const rows: Row[] = [];
  return {
    rows,
    emit: (name, record = {}) => {
      rows.push({ name, record });
    },
  };
}

function startBridge(emit: Emit): void {
  stops.push(startDiagnosticBusBridge({ emit }));
}

interface FakeWorker extends EventEmitter {
  postMessage(request: WriterWorkerRequest): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

/**
 * The real writer — its catalog lookup and its slot, label, enum/id and session-key rules — over a
 * fake worker that keeps the wire rows it is handed, so a test reads exactly what would be inserted.
 */
function capturingWriter(overrides: EventWriterOptions = {}): {
  writer: EventWriter;
  wire: EventWireRow[];
} {
  const wire: EventWireRow[] = [];
  const spawn = (): Worker => {
    const fake = new EventEmitter() as FakeWorker;
    fake.ref = () => {};
    fake.unref = () => {};
    fake.terminate = () => Promise.resolve(0);
    fake.postMessage = (request: WriterWorkerRequest) => {
      if (request.type !== "insert") {
        return;
      }
      wire.push(...request.rows);
      const response: WriterWorkerResponse = {
        id: request.id,
        ok: true,
        type: "insert",
        inserted: request.rows.length,
      };
      setImmediate(() => fake.emit("message", response));
    };
    return fake as unknown as Worker;
  };
  const writer = createEventWriter({
    env: { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") },
    spawn,
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
    ...overrides,
  });
  writers.push(writer);
  return { writer, wire };
}

/** The row is its catalog entry's declared shape: its kind, every declared slot filled, no other. */
function expectDeclaredShape(row: EventWireRow): void {
  const entry = getCatalogEvent(row.name);
  if (entry === undefined) {
    throw new Error(`${row.name} is not in the catalog`);
  }
  expect(row.kind, row.name).toBe(entry.kind);
  for (const slot of ["n1", "n2", "n3", "n4"] as const) {
    if (entry[slot] === null) {
      expect(row[slot], `${row.name}.${slot} is undeclared`).toBeNull();
    } else {
      expect(Number.isFinite(row[slot]), `${row.name}.${slot} (${entry[slot]})`).toBe(true);
    }
  }
  if (entry.label === null) {
    expect(row.label, `${row.name}.label is undeclared`).toBeNull();
  } else {
    expect(typeof row.label, `${row.name}.label (${entry.label})`).toBe("string");
  }
  const keys =
    row.fields === null ? [] : Object.keys(JSON.parse(row.fields) as Record<string, unknown>);
  expect(
    keys.filter((key) => !(key in entry.fields)),
    `${row.name} undeclared field keys`,
  ).toEqual([]);
}

function percentiles(
  evt: DiagnosticEventInput,
  samples: number,
  warmup: number,
): { p50: number; p95: number } {
  for (let i = 0; i < warmup; i += 1) {
    emitDiagnosticEvent(evt);
  }
  const us: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = process.hrtime.bigint();
    emitDiagnosticEvent(evt);
    us.push(Number(process.hrtime.bigint() - started) / 1_000);
  }
  const sorted = us.toSorted((a, b) => a - b);
  const at = (q: number): number =>
    Math.round(sorted[Math.min(samples - 1, Math.floor(samples * q))] * 100) / 100;
  return { p50: at(0.5), p95: at(0.95) };
}

describe("onDiagnosticEventTypes (the bridge's subscription)", () => {
  it("skips a filtered listener BEFORE the per-listener clone — CONTROL: an unfiltered one clones", () => {
    // structuredClone throws on a function, so a clone attempt is observable as a listener error.
    const uncloneable = { ...HEARTBEAT, probe: () => undefined } as unknown as DiagnosticEventInput;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    stops.push(onDiagnosticEventTypes(["session.stuck"], (evt) => seen.push(evt.type)));
    emitDiagnosticEvent(uncloneable);
    expect(errors).not.toHaveBeenCalled();
    stops.push(onDiagnosticEvent(() => {}));
    emitDiagnosticEvent(uncloneable);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("delivers only the types asked for, and never a trusted event", () => {
    const seen: string[] = [];
    stops.push(
      onDiagnosticEventTypes(["diagnostic.liveness.warning"], (evt) => seen.push(evt.type)),
    );
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    emitTrustedDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    emitDiagnosticEvent(BUS_FIXTURES["session.stuck"]);
    expect(seen).toEqual(["diagnostic.liveness.warning"]);
  });
});

describe("the diagnostic-bus bridge (logging.md §7.5, §9 step 4)", () => {
  it("CONTROL: a bus event is no row before the bridge starts, one row while it runs, none after", () => {
    const { rows, emit } = collector();
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    expect(rows).toEqual([]);
    const stop = startDiagnosticBusBridge({ emit });
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    expect(rows.map((row) => row.name)).toEqual(["gw.liveness.warning"]);
    stop();
    stop();
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    expect(rows).toHaveLength(1);
  });

  it("each allow-listed bus type becomes exactly one row of its catalog entry's declared shape", async () => {
    const { writer, wire } = capturingWriter();
    startBridge((name, record) => writer.emit(name, record));
    for (const busType of BRIDGED) {
      const before = wire.length;
      emitDiagnosticEvent(BUS_FIXTURES[busType]);
      await writer.flush();
      const added = wire.slice(before);
      expect(
        added.map((row) => row.name),
        busType,
      ).toEqual([BRIDGED_BUS_TYPES[busType]]);
      expectDeclaredShape(added[0]);
    }
    const stats = writer.stats();
    expect(stats.unknownNames).toEqual({});
    expect(stats.undeclaredKeys).toBe(0);
    expect(stats.invalidValues).toBe(0);
  });

  it("maps each payload onto the slots its §4.1 row names; the raw session key reaches no column", async () => {
    const { writer, wire } = capturingWriter();
    startBridge((name, record) => writer.emit(name, record));
    for (const busType of BRIDGED) {
      emitDiagnosticEvent(BUS_FIXTURES[busType]);
    }
    await writer.flush();
    const byName = (name: string): EventWireRow => {
      const row = wire.find((candidate) => candidate.name === name);
      if (row === undefined) {
        throw new Error(`no ${name} row`);
      }
      return row;
    };
    const liveness = byName("gw.liveness.warning");
    expect([liveness.label, liveness.n1, liveness.n2, liveness.n3, liveness.n4]).toEqual([
      "event_loop_delay+cpu",
      1_200.5,
      2_400,
      0.97,
      0.93,
    ]);
    const pressure = byName("gw.memory.pressure");
    expect([pressure.label, pressure.n1, pressure.n2, pressure.n3, pressure.n4]).toEqual([
      "critical:rss_threshold",
      3_000_000_000,
      1_500_000_000,
      2_500_000_000,
      400_000_000,
    ]);
    const stuck = byName("gw.session.stuck");
    expect([stuck.label, stuck.n1, stuck.n2]).toEqual(["processing", 185_000, 2]);
    expect(JSON.parse(stuck.fields ?? "null")).toEqual({ reason: "client-dead" });
    expect(stuck.session_kind).toBe("whatsapp");
    expect(stuck.session_hash).toMatch(/^[0-9a-f]{16}$/);
    // §4.5 lane.wait: a span. label = the CLASS, dur_ms = the wait, n1 = the queue size — and the
    // stripped key hashes to exactly what the session's own rows hash to, so a lane row joins them.
    const lane = byName("lane.wait");
    expect([lane.label, lane.dur_ms, lane.n1]).toEqual(["session", 1_450, 3]);
    expect(lane.session_kind).toBe("whatsapp");
    expect(lane.session_hash).toBe(stuck.session_hash);
    const sessionState = byName("session.state");
    expect([sessionState.label, sessionState.n1]).toEqual(["processing", 1]);
    expect(JSON.parse(sessionState.fields ?? "null")).toEqual({
      from: "idle",
      reason: "message_start",
    });
    // Covers the lane name too: it is `session:<key>`, so a lane row that stored it would show here.
    expect(JSON.stringify(wire)).not.toContain("5555550142");
  });

  it("the real lane and session-state producers write rows, and both go silent with diagnostics off", async () => {
    resetCommandQueueStateForTest();
    const { rows, emit } = collector();
    startBridge(emit);
    // The production paths, end to end. The session lane is built by the embedded runner's own
    // resolveSessionLane and admitted by command-queue.ts (enqueueCommandInLane → drainLane →
    // logLaneDequeue), so a renamed lane prefix fails here. The global lane is the embedded
    // runner's default, `sessions`: no colon, so it must NOT read as a session lane. The reply
    // dispatcher and the embedded runner call logSessionStateChange. Neither bus type is async, so
    // the rows are here synchronously and in order.
    try {
      await enqueueCommandInLane(resolveSessionLane(PHONE_SESSION_KEY), async () => 1);
      await enqueueCommandInLane(resolveGlobalLane(), async () => 2);
      logSessionStateChange({
        sessionKey: PHONE_SESSION_KEY,
        state: "processing",
        reason: "message_start",
      });
      expect(resolveGlobalLane()).toBe("sessions");
      expect(rows.map((row) => [row.name, row.record.label])).toEqual([
        ["lane.wait", "session"],
        ["lane.wait", "global"],
        ["session.state", "processing"],
      ]);
      // The stripped key, not the lane name; n1 = what was still queued behind it (nothing).
      expect([rows[0].record.sessionKey, rows[0].record.n1]).toEqual([PHONE_SESSION_KEY, 0]);
      expect(rows[0].record.durMs).toBeGreaterThanOrEqual(0);
      // A global lane has no session to name — the label is the whole of what it says.
      expect(rows[1].record.sessionKey).toBeUndefined();
      expect(rows[2].record.fields).toEqual({ from: "idle", reason: "message_start" });

      rows.length = 0;
      setDiagnosticsEnabledForProcess(false);
      await enqueueCommandInLane(resolveSessionLane(PHONE_SESSION_KEY), async () => 3);
      logSessionStateChange({
        sessionKey: PHONE_SESSION_KEY,
        state: "idle",
        reason: "run_completed",
      });
      expect(rows).toEqual([]);
    } finally {
      resetCommandQueueStateForTest();
    }
  });

  it("the heartbeat's stuck-session report carries its reason on the bus, and the row stores it", () => {
    const busReasons: Array<string | undefined> = [];
    stops.push(
      onDiagnosticEvent((evt) => {
        if (evt.type === "session.stuck") {
          busReasons.push(evt.reason);
        }
      }),
    );
    const { rows, emit } = collector();
    startBridge(emit);
    logSessionStuck({
      sessionKey: "agent:main:tinker:stuck-a",
      state: "processing",
      ageMs: 200_000,
      clientAlive: false,
    });
    logSessionStuck({
      sessionKey: "agent:main:tinker:stuck-b",
      state: "processing",
      ageMs: 200_000,
    });
    logSessionStuck({
      sessionKey: "agent:main:tinker:stuck-c",
      state: "processing",
      ageMs: 200_000,
      lastProgressAtMs: Date.now() - 600_000,
    });
    const expected = ["client-dead", "no-progress-signal", "no-recent-progress"];
    expect(busReasons).toEqual(expected);
    expect(rows.map((row) => [row.name, row.record.fields])).toEqual(
      expected.map((reason) => ["gw.session.stuck", { reason }]),
    );
  });

  it("ignores every bus type outside the allow-list", () => {
    const { rows, emit } = collector();
    startBridge(emit);
    emitDiagnosticEvent(HEARTBEAT);
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: {
        rssBytes: 1,
        heapTotalBytes: 1,
        heapUsedBytes: 1,
        externalBytes: 1,
        arrayBuffersBytes: 1,
      },
    });
    expect(rows).toEqual([]);
    expect(
      mapDiagnosticEvent({
        type: "log.record",
        ts: 1,
        seq: 1,
        level: "info",
        message: "free text",
      }),
    ).toBeNull();
    expect(
      mapDiagnosticEvent({
        type: "no.such.bus.type",
        ts: 1,
        seq: 1,
      } as unknown as DiagnosticEventPayload),
    ).toBeNull();
  });

  it("subscribes to nothing while no writer runs: no clone is paid for rows nobody keeps", () => {
    const before = getEventWriterStats().dropped;
    stops.push(startDiagnosticBusBridge());
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    declareInstrument({ id: "test:bridge-off", kind: "producer", description: "bridge-off probe" });
    logInstrumentLivenessSummary();
    expect(getEventWriterStats().dropped).toBe(before);
  });

  it("with diagnostics off the bus rows cannot occur, and the census still writes (empty registry too)", () => {
    setDiagnosticsEnabledForProcess(false);
    const { rows, emit } = collector();
    startBridge(emit);
    emitDiagnosticEvent(BUS_FIXTURES["diagnostic.liveness.warning"]);
    logInstrumentLivenessSummary();
    expect(rows.map((row) => row.name)).toEqual(["instrument.census"]);
    expect([
      rows[0]?.record.n1,
      rows[0]?.record.n2,
      rows[0]?.record.n3,
      rows[0]?.record.n4,
    ]).toEqual([0, 0, 0, 0]);
  });

  it("synthetic cost (§9 step 4): µs per bus event with no listener, an unfiltered no-op listener, and the bridge", async () => {
    const { writer } = capturingWriter({
      flushBatchSize: Number.MAX_SAFE_INTEGER,
      queueMax: 1_000_000,
    });
    const samples = 5_000;
    const warmup = 500;
    const logRecord: DiagnosticEventInput = {
      type: "log.record",
      level: "info",
      message: "[gateway] chat.history served rows=40 bytes=120394 ms=12 outcome=delta cursor=1234",
      loggerName: "gateway",
      attributes: { subsystem: "gateway", ok: true },
      code: { line: 42, functionName: "serve" },
    };
    // log.record is dispatched asynchronously (setImmediate), so its arm is a burst mean.
    const logRecordMean = async (): Promise<number> => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < samples; i += 1) {
        emitDiagnosticEvent(logRecord);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Math.round((Number(process.hrtime.bigint() - started) / 1_000 / samples) * 100) / 100;
    };
    const measureArm = async () => ({
      bridged: percentiles(BUS_FIXTURES["session.stuck"], samples, warmup),
      ignored: percentiles(HEARTBEAT, samples, warmup),
      logRecordMean: await logRecordMean(),
    });
    const noListener = await measureArm();
    const noop = onDiagnosticEvent(() => {});
    const unfilteredNoop = await measureArm();
    noop();
    const stop = startDiagnosticBusBridge({ emit: (name, record) => writer.emit(name, record) });
    const bridge = await measureArm();
    stop();
    console.log(
      "[BUS-BRIDGE-BENCH] µs/event",
      JSON.stringify({ node: process.version, samples, noListener, unfilteredNoop, bridge }),
    );
    // Timing is REPORTED, never asserted: a shared CI box makes any bound flaky. What is asserted:
    // every bridged event became exactly one valid row, and nothing else became any.
    const stats = writer.stats();
    expect(stats.queueDepth).toBe(samples + warmup);
    expect(stats.invalidValues).toBe(0);
    expect(stats.undeclaredKeys).toBe(0);
  });
});

describe("instrument-liveness report → instrument.census / instrument.transition (§4.10)", () => {
  const T0 = Date.parse("2026-09-25T10:00:00.000Z");

  /** pending (inside its 1 s tolerance) → never (past it, zero firings) → live (fired) → live. */
  function runProbeLifecycle(emit: Emit, recordsTo: boolean): void {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const clear = setInstrumentLivenessReportSink(
      createInstrumentReportBridge(emit, { recordsTo }),
    );
    stops.push(clear);
    declareInstrument({
      id: "test:bridge-probe",
      kind: "producer",
      description: "bridge test probe",
      expectFireWithinMs: 1_000,
    });
    logInstrumentLivenessSummary(T0 + 500);
    logInstrumentLivenessSummary(T0 + 5_000);
    vi.setSystemTime(T0 + 6_000);
    noteInstrumentFired("test:bridge-probe");
    logInstrumentLivenessSummary(T0 + 6_100);
    logInstrumentLivenessSummary(T0 + 6_200);
    clear();
    logInstrumentLivenessSummary(T0 + 6_300);
  }

  it("writes a census on every tick, with the counts the journal line prints", () => {
    const { rows, emit } = collector();
    runProbeLifecycle(emit, false);
    const census = rows.filter((row) => row.name === "instrument.census");
    expect(census.map(({ record }) => [record.n1, record.n2, record.n3, record.n4])).toEqual([
      [1, 0, 0, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 0],
      [1, 1, 0, 0],
    ]);
    expect(census[0]?.record.fields).toEqual({ pending: 1, idle: 0, by_config: 0 });
  });

  it("the catalog declares `to`, so the production bridge records the destination verdict", () => {
    // The gate for §9 step 4's destination verdict. If this field is dropped from the catalog the
    // emitter silently falls back to `from` alone and every instrument's first verdict stops being
    // recorded — a regression with no error and no dropped row to count. It fails here instead.
    expect(getCatalogEvent("instrument.transition")?.fields).toEqual({
      from: "enum",
      to: "enum",
    });
  });

  it("with the `to` declaration forced off, a transition carries `from` alone and first sightings are skipped", () => {
    const { rows, emit } = collector();
    runProbeLifecycle(emit, false);
    const transitions = rows.filter((row) => row.name === "instrument.transition");
    expect(transitions.map(({ record }) => [record.label, record.fields])).toEqual([
      ["test:bridge-probe", { from: "pending" }],
      ["test:bridge-probe", { from: "never" }],
    ]);
  });

  it("with `to` declared, the first sighting and every change carry the verdicts on both sides", () => {
    const { rows, emit } = collector();
    runProbeLifecycle(emit, true);
    const transitions = rows.filter((row) => row.name === "instrument.transition");
    expect(transitions.map(({ record }) => [record.label, record.fields])).toEqual([
      ["test:bridge-probe", { to: "pending" }],
      ["test:bridge-probe", { from: "pending", to: "never" }],
      ["test:bridge-probe", { from: "never", to: "live" }],
    ]);
  });

  it("its rows are the declared shape, checked by the real writer — never an undeclared key", async () => {
    const { writer, wire } = capturingWriter();
    startBridge((name, record) => writer.emit(name, record));
    declareInstrument({
      id: "test:bridge-shape",
      kind: "producer",
      description: "bridge shape probe",
      expectFireWithinMs: 1_000,
    });
    const now = Date.now();
    logInstrumentLivenessSummary(now + 500);
    logInstrumentLivenessSummary(now + 5_000);
    await writer.flush();
    expect(wire.filter((row) => row.name === "instrument.census")).toHaveLength(2);
    const transitions = wire.filter((row) => row.name === "instrument.transition");
    // The destination verdict LANDS in the stored row — the writer keeps `to` rather than counting
    // it as an undeclared key — including the first verdict of the process, which has no `from`.
    expect(transitions.map((row) => JSON.parse(row.fields ?? "null"))).toEqual([
      { to: "pending" },
      { from: "pending", to: "never" },
    ]);
    for (const row of wire) {
      expectDeclaredShape(row);
    }
    expect(writer.stats().undeclaredKeys).toBe(0);
    expect(writer.stats().invalidValues).toBe(0);
  });
});
