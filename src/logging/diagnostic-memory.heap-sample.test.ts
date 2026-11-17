/**
 * The heap sample a critical memory pressure event starts (diagnostic-memory.ts, FORK 2026-10-29).
 * Every test drives the real producer, emitDiagnosticMemorySample. A fake inspector session, passed
 * through the `heapSample.openSession` seam, covers the throttle, the bounded stop and the failure
 * paths; one test runs the real node:inspector session. Rows are captured at the emit.ts module
 * boundary, the diagnostic-cpu-profile.events.test.ts pattern. CONTROL: a warning-level event, or
 * any event with diagnostics off, starts no sample.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { MAX_FIELDS_JSON_CHARS } from "../infra/events/emit.js";
import {
  emitDiagnosticMemorySample,
  HEAP_SAMPLE_MIN_INTERVAL_MS,
  HEAP_SAMPLE_TOP_SITES,
  HEAP_SAMPLE_WINDOW_MS,
  resetDiagnosticMemoryForTest,
  summarizeHeapSamplingProfile,
  type DiagnosticHeapSampleSession,
  type DiagnosticHeapSampleSite,
  type HeapSamplingProfileNode,
} from "./diagnostic-memory.js";
import { diagnosticLogger } from "./diagnostic-runtime.js";

type Row = { name: string; record: Record<string, unknown> };

/** vi.hoisted: the mock factory runs above the imports, so its sink is created there too. */
const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("../infra/events/emit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/events/emit.js")>()),
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    rows.push({ name, record });
  },
}));

const MB = 1024 * 1024;
const HEAP_SAMPLE_ROW = "gw.memory.heap_sample";
const THRESHOLDS = { rssWarningBytes: 1_000, rssCriticalBytes: 3_000, pressureRepeatMs: 60_000 };

type CallFrame = HeapSamplingProfileNode["callFrame"];

function frame(functionName: string, url = "", lineNumber = -1): CallFrame {
  return { functionName, url, lineNumber };
}

function node(
  callFrame: CallFrame,
  selfSize: number,
  children: HeapSamplingProfileNode[] = [],
): HeapSamplingProfileNode {
  return { callFrame, selfSize, children };
}

// Invented paths; only their shape matters: build chunks, a bundled plugin, a pnpm package.
const APP = "file:///opt/app";
const TOK_LEX = `${APP}/node_modules/.pnpm/tok@1.0.0/node_modules/tok/lib/lex.js`;
const FIXTURE_HEAD = node(frame("(root)"), 0, [
  node(frame("main", `${APP}/dist/index.js`, 9), 0, [
    node(frame("loadStore", `${APP}/dist/store-AbC123.js`, 40), 8 * MB, [
      node(frame("parse"), 64 * MB),
    ]),
    node(frame("renderReply", `${APP}/dist/extensions/demo-plugin/index.js`, 6), 2 * MB),
    node(frame("lex", TOK_LEX, 3), 5 * MB),
    node(frame("readFile", "node:internal/fs/promises", 99), MB),
  ]),
  node(frame("main", `${APP}/dist/index.js`, 9), 0, [
    node(frame("loadStore", `${APP}/dist/store-AbC123.js`, 40), 4 * MB),
  ]),
  node(frame("(V8 API)"), 3 * MB),
  ...Array.from({ length: 22 }, (_, i) =>
    node(frame(`filler${i}`, `${APP}/dist/filler.js`, i), (i + 1) * 1_000),
  ),
]);
/** 64 + 8 + 4 + 5 + 3 + 2 + 1 MB of named sites, plus 1..22 times 1,000 bytes of fillers. */
const FIXTURE_TOTAL_BYTES = 87 * MB + 253_000;

type FakeSessionOptions = { failOn?: string; stopResult?: unknown; disconnectThrows?: boolean };

function fakeSession(options: FakeSessionOptions = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let disconnects = 0;
  const session: DiagnosticHeapSampleSession = {
    post: async (method, params) => {
      calls.push({ method, params });
      if (method === options.failOn) {
        throw new Error(`${method} failed`);
      }
      if (method !== "HeapProfiler.stopSampling") {
        return {};
      }
      return "stopResult" in options ? options.stopResult : { profile: { head: FIXTURE_HEAD } };
    },
    disconnect: () => {
      disconnects += 1;
      if (options.disconnectThrows) {
        throw new Error("disconnect failed");
      }
    },
  };
  return {
    session,
    methods: () => calls.map((call) => call.method),
    params: (method: string) => calls.find((call) => call.method === method)?.params,
    disconnects: () => disconnects,
  };
}

function memoryUsage(overrides: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage {
  return { rss: 100, heapTotal: 80, heapUsed: 40, external: 10, arrayBuffers: 5, ...overrides };
}

/** One heartbeat with RSS past the critical line, so a critical:rss_threshold pressure event. */
function criticalSample(now: number, openSession?: () => DiagnosticHeapSampleSession | null) {
  emitDiagnosticMemorySample({
    now,
    emitSample: false,
    memoryUsage: memoryUsage({ rss: 4_000, heapUsed: 2_500 }),
    thresholds: THRESHOLDS,
    heapSample: { openSession },
  });
}

function heapRows(): Row[] {
  return rows.filter((row) => row.name === HEAP_SAMPLE_ROW);
}

function logged(level: "info" | "warn"): string[] {
  return vi.mocked(diagnosticLogger[level]).mock.calls.map(([message]) => message);
}

/** Named so the profile can be searched for it: 64 KiB arrays that are garbage at once. */
function allocateTransientForHeapSampleTest(megabytes: number): number {
  let total = 0;
  for (let i = 0; i < megabytes * 16; i += 1) {
    total += new Array<number>(8192).fill(i).length;
  }
  return total;
}

const UNAVAILABLE: Array<[string, () => DiagnosticHeapSampleSession | null]> = [
  ["has no Session", () => null],
  [
    "throws as it loads",
    () => {
      throw Object.assign(new Error("Inspector is not available"), {
        code: "ERR_INSPECTOR_NOT_AVAILABLE",
      });
    },
  ],
];

const FAILURES: Array<[string, FakeSessionOptions]> = [
  ["startSampling rejects", { failOn: "HeapProfiler.startSampling" }],
  ["stopSampling rejects", { failOn: "HeapProfiler.stopSampling" }],
  ["stopSampling answers without a profile", { stopResult: {} }],
  [
    "startSampling rejects and disconnect throws",
    { failOn: "HeapProfiler.startSampling", disconnectThrows: true },
  ],
];

describe("heap sample on critical memory pressure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rows.length = 0;
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    vi.spyOn(diagnosticLogger, "info").mockImplementation(() => {});
    vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
  });

  it("samples at most once an hour: two critical events in one hour give one sample", async () => {
    const pressure: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.memory.pressure") {
        pressure.push(event);
      }
    });
    const openSession = vi.fn(() => fakeSession().session);

    criticalSample(1_000, openSession);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
    criticalSample(1_000 + 30 * 60 * 1000, openSession);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);

    expect(pressure).toHaveLength(2);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(heapRows()).toHaveLength(1);

    // An hour after the first start, the next critical event samples again.
    criticalSample(1_000 + HEAP_SAMPLE_MIN_INTERVAL_MS, openSession);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
    stop();

    expect(pressure).toHaveLength(3);
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(heapRows()).toHaveLength(2);
  });

  it("never runs two samples at once, even after the hour has passed", async () => {
    const openSession = vi.fn(() => fakeSession().session);

    criticalSample(1_000, openSession);
    // Two hours later on the caller's clock, while the first window is still open.
    criticalSample(1_000 + 2 * HEAP_SAMPLE_MIN_INTERVAL_MS, openSession);
    expect(openSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
    criticalSample(1_000 + 3 * HEAP_SAMPLE_MIN_INTERVAL_MS, openSession);
    expect(openSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
    expect(heapRows()).toHaveLength(2);
  });

  it("stops the profiler after one bounded window: one row and one log line", async () => {
    const fake = fakeSession();
    criticalSample(5_000, () => fake.session);

    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS - 1);
    expect(fake.methods()).toEqual(["HeapProfiler.startSampling"]);
    expect(fake.disconnects()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    // Start and stop only: never HeapProfiler.takeHeapSnapshot, which stalls for seconds.
    expect(fake.methods()).toEqual(["HeapProfiler.startSampling", "HeapProfiler.stopSampling"]);
    expect(fake.disconnects()).toBe(1);
    // V8's default interval (no samplingInterval), with freed objects kept in the profile.
    expect(fake.params("HeapProfiler.startSampling")).toEqual({
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });

    expect(heapRows()).toHaveLength(1);
    const { record } = heapRows()[0];
    expect(record).toMatchObject({
      tsMs: 5_000,
      label: "critical:rss_threshold",
      durMs: HEAP_SAMPLE_WINDOW_MS,
      n1: FIXTURE_TOTAL_BYTES,
      n2: 2_500,
      n4: 0,
    });
    expect(record.n3).toBeGreaterThan(0);
    const fields = record.fields as { top: DiagnosticHeapSampleSite[] };
    expect(fields.top).toEqual(summarizeHeapSamplingProfile({ head: FIXTURE_HEAD }).sites);
    expect(JSON.stringify(fields).length).toBeLessThanOrEqual(MAX_FIELDS_JSON_CHARS);

    const lines = logged("info").filter((line) => line.startsWith("heap sample critical:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("window=30000ms");
    expect(lines[0]).toContain("1) 64.0MB parse (native) via store-AbC123.js:41");
    expect(lines[0]).not.toContain("\n");
  });

  it("keeps the top sites by self size, sums a site across paths, drops host paths", () => {
    const { totalBytes, sites } = summarizeHeapSamplingProfile({ head: FIXTURE_HEAD });

    expect(totalBytes).toBe(FIXTURE_TOTAL_BYTES);
    expect(sites).toHaveLength(HEAP_SAMPLE_TOP_SITES);
    expect(sites.slice(0, 6)).toEqual([
      { fn: "parse", site: "(native) via store-AbC123.js:41", bytes: 64 * MB },
      { fn: "loadStore", site: "store-AbC123.js:41", bytes: 12 * MB },
      { fn: "lex", site: "tok/lib/lex.js:4", bytes: 5 * MB },
      { fn: "(V8 API)", site: "(native)", bytes: 3 * MB },
      { fn: "renderReply", site: "extensions/demo-plugin/index.js:7", bytes: 2 * MB },
      { fn: "readFile", site: "node:internal/fs/promises:100 via index.js:10", bytes: MB },
    ]);
    // The 14 slots left go to the largest fillers; the 8 smallest fall off.
    expect(sites.slice(6).map((entry) => entry.fn)).toEqual(
      Array.from({ length: 14 }, (_, i) => `filler${21 - i}`),
    );
    for (const { site } of sites) {
      expect(site).not.toContain("/opt/");
      expect(site).not.toContain("file:");
    }
  });

  it("names a transient allocation through the real node:inspector session", async () => {
    criticalSample(1_000);
    expect(allocateTransientForHeapSampleTest(32)).toBe(32 * 16 * 8192);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);

    expect(logged("warn")).toEqual([]);
    expect(heapRows()).toHaveLength(1);
    const { record } = heapRows()[0];
    // Garbage before the stop's forced GC, still counted: the flags a transient burst needs.
    expect(record.n1).toBeGreaterThanOrEqual(16 * MB);
    const { top } = record.fields as { top: DiagnosticHeapSampleSite[] };
    expect(top.map((entry) => entry.fn)).toContain("allocateTransientForHeapSampleTest");
    for (const { site } of top) {
      expect(site).not.toContain(process.cwd());
    }
  });

  it.each(UNAVAILABLE)("is a no-op, logged once, when the inspector %s", async (_name, open) => {
    const openSession = vi.fn(open);
    const later = 1_000 + 2 * HEAP_SAMPLE_MIN_INTERVAL_MS;

    expect(() => criticalSample(1_000, openSession)).not.toThrow();
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
    expect(() => criticalSample(later, openSession)).not.toThrow();
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(heapRows()).toEqual([]);
    expect(logged("info").filter((line) => line.startsWith("heap sample off"))).toHaveLength(1);
    expect(logged("warn")).toEqual([]);
  });

  it.each(FAILURES)(
    "never throws when %s: one warn line, the session released, no row",
    async (_name, options) => {
      const fake = fakeSession(options);

      expect(() => criticalSample(1_000, () => fake.session)).not.toThrow();
      await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);

      expect(fake.disconnects()).toBe(1);
      expect(heapRows()).toEqual([]);
      const failed = logged("warn").filter((line) => line.startsWith("heap sample failed"));
      expect(failed).toHaveLength(1);

      // The failed run gave its slot back: an hour later the next critical event samples again.
      const next = fakeSession();
      criticalSample(1_000 + HEAP_SAMPLE_MIN_INTERVAL_MS, () => next.session);
      expect(next.methods()).toEqual(["HeapProfiler.startSampling"]);
      await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);
      expect(heapRows()).toHaveLength(1);
    },
  );

  it("CONTROL: a warning-level event, or diagnostics off, starts no sample", async () => {
    const openSession = vi.fn(() => fakeSession().session);

    emitDiagnosticMemorySample({
      now: 1_000,
      emitSample: false,
      memoryUsage: memoryUsage({ rss: 2_000 }),
      thresholds: THRESHOLDS,
      heapSample: { openSession },
    });
    setDiagnosticsEnabledForProcess(false);
    criticalSample(2_000, openSession);
    await vi.advanceTimersByTimeAsync(HEAP_SAMPLE_WINDOW_MS);

    expect(openSession).not.toHaveBeenCalled();
    expect(heapRows()).toEqual([]);
  });
});
