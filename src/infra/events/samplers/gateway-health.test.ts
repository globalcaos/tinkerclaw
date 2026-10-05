/**
 * logging.md §9 step 4 — gw.health.sample and gw.boot (samplers/gateway-health.ts).
 *
 * CONTROL: before this change neither row was written anywhere (the module did not exist). These
 * tests show each row appear on its cadence, in the shape its catalog entry declares.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_HEARTBEAT_INTERVAL_MS } from "../../../logging/diagnostic.js";
import { getCatalogEvent } from "../catalog.js";
import { getEventWriterStats, type EmitEventRecord } from "../emit.js";
import {
  CONFIG_HASH_ID_CHARS,
  createGcWindowSource,
  emitGatewayBoot,
  GATEWAY_HEALTH_SAMPLE_INTERVAL_MS,
  startGatewayHealthSampler,
  type GatewayHealthSampler,
  type GcWindowSource,
} from "./gateway-health.js";

type Row = { name: string; record: EmitEventRecord };

const LOOP = { delayP99Ms: 12.5, delayMaxMs: 40, utilization: 0.31, cpuCoreRatio: 0.22 };
const WORK = { active: 1, waiting: 0, queued: 3 };

const samplers: GatewayHealthSampler[] = [];

afterEach(() => {
  for (const sampler of samplers.splice(0)) {
    sampler.stop();
  }
  vi.useRealTimers();
});

function collector(): { rows: Row[]; emit: (name: string, record?: EmitEventRecord) => void } {
  const rows: Row[] = [];
  return {
    rows,
    emit: (name, record = {}) => {
      rows.push({ name, record });
    },
  };
}

function fakeGc(): GcWindowSource & { readonly stops: number } {
  let stops = 0;
  return {
    get stops() {
      return stops;
    },
    take: () => ({ count: 4, totalMs: 9.5, maxPauseMs: 3.2 }),
    stop: () => {
      stops += 1;
    },
  };
}

/** Every slot, label and field key a row carries is one its catalog entry declares. */
function expectDeclared(row: Row): void {
  const entry = getCatalogEvent(row.name);
  if (entry === undefined) {
    throw new Error(`${row.name} is not in the catalog`);
  }
  for (const slot of ["n1", "n2", "n3", "n4"] as const) {
    if (typeof row.record[slot] === "number") {
      expect(entry[slot], `${row.name}.${slot}`).not.toBeNull();
    }
  }
  if (typeof row.record.label === "string") {
    expect(entry.label, `${row.name}.label`).not.toBeNull();
  }
  const undeclared = Object.keys(row.record.fields ?? {}).filter((key) => !(key in entry.fields));
  expect(undeclared, `${row.name} undeclared field keys`).toEqual([]);
}

describe("gw.health.sample (logging.md §4.1)", () => {
  it("samples at the heartbeat's period, on a timer of its own", () => {
    expect(GATEWAY_HEALTH_SAMPLE_INTERVAL_MS).toBe(DIAGNOSTIC_HEARTBEAT_INTERVAL_MS);
  });

  it("CONTROL: no row before the first tick, one per tick on a fake clock, none after stop", () => {
    vi.useFakeTimers();
    const { rows, emit } = collector();
    const sampler = startGatewayHealthSampler({
      readLoopHealth: () => LOOP,
      readWork: () => WORK,
      gc: fakeGc(),
      emit,
    });
    samplers.push(sampler);
    vi.advanceTimersByTime(GATEWAY_HEALTH_SAMPLE_INTERVAL_MS - 1);
    expect(rows).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(rows).toHaveLength(1);
    vi.advanceTimersByTime(2 * GATEWAY_HEALTH_SAMPLE_INTERVAL_MS);
    expect(rows).toHaveLength(3);
    sampler.stop();
    sampler.stop();
    vi.advanceTimersByTime(10 * GATEWAY_HEALTH_SAMPLE_INTERVAL_MS);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.name === "gw.health.sample")).toBe(true);
  });

  it("writes the loop reading to n1..n4 and GC plus work counts to its declared fields", () => {
    const { rows, emit } = collector();
    const sampler = startGatewayHealthSampler({
      readLoopHealth: () => LOOP,
      readWork: () => WORK,
      gc: fakeGc(),
      emit,
      now: () => 1_700_000_000_000,
      intervalMs: 3_600_000,
    });
    samplers.push(sampler);
    sampler.sample();
    expect(rows).toEqual([
      {
        name: "gw.health.sample",
        record: {
          tsMs: 1_700_000_000_000,
          n1: 12.5,
          n2: 40,
          n3: 0.31,
          n4: 0.22,
          fields: {
            gc_count: 4,
            gc_ms: 9.5,
            gc_max_pause_ms: 3.2,
            active: 1,
            waiting: 0,
            queued: 3,
          },
        },
      },
    ]);
    expectDeclared(rows[0]);
  });

  it("L10: a missing or throwing reading leaves NULL slots in a row that is still written", () => {
    const { rows, emit } = collector();
    const sampler = startGatewayHealthSampler({
      readLoopHealth: () => undefined,
      readWork: () => {
        throw new Error("work counts unavailable");
      },
      gc: { take: () => undefined, stop: () => {} },
      emit,
      intervalMs: 3_600_000,
    });
    samplers.push(sampler);
    sampler.sample();
    expect(rows).toHaveLength(1);
    const record = rows[0]?.record;
    expect([record?.n1, record?.n2, record?.n3, record?.n4]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(record?.fields).toEqual({});
  });

  it("leaves an injected GC source to its owner", () => {
    const gc = fakeGc();
    const sampler = startGatewayHealthSampler({
      readLoopHealth: () => LOOP,
      gc,
      emit: collector().emit,
      intervalMs: 3_600_000,
    });
    sampler.stop();
    expect(gc.stops).toBe(0);
  });

  it("stays inert while no writer runs: nothing is read and nothing is emitted", () => {
    const before = getEventWriterStats().dropped;
    let reads = 0;
    const sampler = startGatewayHealthSampler({
      readLoopHealth: () => {
        reads += 1;
        return LOOP;
      },
    });
    samplers.push(sampler);
    sampler.sample();
    expect(reads).toBe(0);
    expect(getEventWriterStats().dropped).toBe(before);
  });

  it("the real GC source reports a window while observing (a quiet one is zeros, not a gap)", () => {
    const source = createGcWindowSource();
    const window = source.take();
    expect(window).toEqual({
      count: expect.any(Number),
      totalMs: expect.any(Number),
      maxPauseMs: expect.any(Number),
    });
    source.stop();
    expect(source.take()).toBeUndefined();
  });
});

describe("gw.boot (logging.md §4.1)", () => {
  it("records the commit, node version, loaded-plugin count and a config-hash prefix", () => {
    const { rows, emit } = collector();
    emitGatewayBoot(
      {
        commit: () => "4586979",
        pluginCount: () => 12,
        configHash: () => "ab".repeat(32),
        nodeVersion: "v22.23.1",
      },
      emit,
    );
    expect(rows).toEqual([
      {
        name: "gw.boot",
        record: {
          label: "4586979",
          fields: {
            node_version: "v22.23.1",
            plugin_count: 12,
            config_hash: "ab".repeat(CONFIG_HASH_ID_CHARS / 2),
          },
        },
      },
    ]);
    expectDeclared(rows[0]);
  });

  it("a source that is unknown or throws is a NULL — never a guess, never a failed boot", () => {
    const { rows, emit } = collector();
    expect(() =>
      emitGatewayBoot(
        {
          commit: () => {
            throw new Error("no git metadata");
          },
          pluginCount: () => {
            throw new Error("no registry");
          },
          configHash: () => null,
        },
        emit,
      ),
    ).not.toThrow();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record.label).toBeNull();
    expect(rows[0]?.record.fields).toEqual({ node_version: process.version });
  });
});
