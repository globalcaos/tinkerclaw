/**
 * FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/logging.md §4.9 (§9 step 5): the worker-resources
 * sampler. Every source is a fixture — a temp cgroup tree, a temp /proc tree, a scripted systemctl
 * — so nothing here reads the host or names a real unit, pid or path. The rows go to a recorder;
 * the trend query runs against a real events database built by the schema module.
 *
 * CONTROL. None existed: before this change there is no sampler, no worker.* row and no trend
 * query, so every test here fails on a missing module.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FtsWorkerThreadStats } from "../../../memory/engram/fts-worker-client.js";
import type { EmitEventRecord, EventWriterThreadStats } from "../emit.js";
import { openEventsDatabase } from "../schema.js";
import type { RunCommand } from "./cgroup-reader.js";
import {
  classifyWorkerExit,
  createWorkerResourceSampler,
  eventsWriterReading,
  isOrphanWorkerUnit,
  noteWorkerExit,
  noteWorkerSpawn,
  readGatewayProcess,
  resetWorkerResourcesForTest,
  resolveWhatsmeowComms,
  shouldEmitWorkerSample,
  startWorkerResourceSampler,
  WORKER_MEMORY_TREND_7D_SQL,
  WORKER_SAMPLE_ACTIVE_INTERVAL_MS,
  WORKER_SAMPLE_IDLE_INTERVAL_MS,
  type WorkerResourceSampler,
  type WorkerResourceSamplerOptions,
} from "./worker-resources.js";

const MiB = 1024 * 1024;
const HOUR_MS = 3_600_000;
/** Fixture identities: none names a real unit, pid or path. */
const SELF_PID = 4100;
const UNIT = "tinkerclaw-worker-4100-lx0f1x70-aa11bb";
const CONTROL_GROUP = `/user.slice/app.slice/${UNIT}.service`;

interface Row {
  readonly name: string;
  readonly record: EmitEventRecord;
}

let rows: Row[];
let root: string;
const emit = (name: string, record: EmitEventRecord): void => {
  rows.push({ name, record });
};

beforeEach(() => {
  rows = [];
  root = mkdtempSync(join(tmpdir(), "worker-resources-"));
  resetWorkerResourcesForTest(emit);
});

afterEach(() => {
  resetWorkerResourcesForTest();
  rmSync(root, { recursive: true, force: true });
});

function writeCgroup(
  controlGroup: string,
  values: { current: number; peak?: number; usageUsec?: number; pids?: number },
): void {
  const dir = join(root, "cgroup", controlGroup);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.current"), `${values.current}\n`);
  if (values.peak !== undefined) {
    writeFileSync(join(dir, "memory.peak"), `${values.peak}\n`);
  }
  if (values.usageUsec !== undefined) {
    writeFileSync(
      join(dir, "cpu.stat"),
      `usage_usec ${values.usageUsec}\nuser_usec 0\nsystem_usec 0\n`,
    );
  }
  if (values.pids !== undefined) {
    writeFileSync(join(dir, "pids.current"), `${values.pids}\n`);
  }
}

/** A scripted systemctl: `show` answers from `controlGroups` (empty when absent), `list-units` lists `units`. */
function systemctl(
  controlGroups: Record<string, string>,
  units: readonly string[] = [],
): { run: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunCommand = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("show")) {
      const unit = (args.at(-1) ?? "").replace(/\.service$/, "");
      return `${controlGroups[unit] ?? ""}\n`;
    }
    if (args.includes("list-units")) {
      return units.map((u) => `${u}.service loaded active running fixture worker`).join("\n");
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  return { run, calls };
}

function clock(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A sampler whose other sources are silent, so each test sees only what it arranged. */
function makeSampler(options: WorkerResourceSamplerOptions): WorkerResourceSampler {
  return createWorkerResourceSampler({
    emit,
    cgroupRoot: join(root, "cgroup"),
    procRoot: join(root, "proc"),
    selfPid: SELF_PID,
    processStartMs: 0,
    isPidAlive: () => true,
    readGateway: () => null,
    readFtsThread: async () => null,
    readWriterThread: async () => null,
    whatsmeowComms: ["whatsmeow-node"],
    run: systemctl({}).run,
    ...options,
  });
}

function samplesOf(workerType: string): Row[] {
  return rows.filter((row) => row.name === "worker.sample" && row.record.label === workerType);
}

function spawnFixtureWorker(): void {
  noteWorkerSpawn({ workerType: "tinker_bridge", workerId: UNIT, resumed: false });
}

describe("tinker-bridge workers — the unit's cgroup, never the wrapper's pid", () => {
  it("charts the cgroup systemd names for the unit, asking systemd once per worker", async () => {
    const { run, calls } = systemctl({ [UNIT]: CONTROL_GROUP });
    writeCgroup(CONTROL_GROUP, { current: 200 * MiB, peak: 250 * MiB, usageUsec: 4e6, pids: 7 });
    spawnFixtureWorker();
    const time = clock(Date.now()); // after the spawn, so the age below is at least one interval
    const sampler = makeSampler({ now: time.now, run });
    await sampler.sampleOnce();
    time.advance(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
    writeCgroup(CONTROL_GROUP, { current: 220 * MiB, peak: 250 * MiB, usageUsec: 5.5e6, pids: 7 });
    await sampler.sampleOnce();

    const samples = samplesOf("tinker_bridge");
    expect(samples).toHaveLength(2);
    // First row: CPU since the worker started; after that, CPU since the previous row.
    expect(samples[0].record).toMatchObject({
      workerId: UNIT,
      n1: 200 * MiB,
      n2: 4_000,
      n4: 250 * MiB,
      fields: { source: "cgroup", pids: 7 },
    });
    expect(samples[1].record).toMatchObject({ n1: 220 * MiB, n2: 1_500, n4: 250 * MiB });
    expect(samples[1].record.n3).toBeGreaterThanOrEqual(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
    expect(calls.filter((call) => call.includes("show"))).toHaveLength(1);
  });

  it("says source=unavailable — no numbers, not zeros — when systemd has no cgroup for the unit", async () => {
    const time = clock(Date.now());
    const { run, calls } = systemctl({}); // ControlGroup= comes back empty
    spawnFixtureWorker();
    const sampler = makeSampler({ now: time.now, run });
    for (let tick = 0; tick < 5; tick++) {
      await sampler.sampleOnce();
      time.advance(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
    }

    const samples = samplesOf("tinker_bridge");
    // 5 ticks span 120 s: the gap is written once, then rides the 300 s idle floor.
    expect(samples).toHaveLength(1);
    expect(samples[0].record.fields).toEqual({ source: "unavailable" });
    for (const slot of ["n1", "n2", "n3", "n4"] as const) {
      expect(samples[0].record[slot]).toBeUndefined();
    }
    // Asked a bounded number of times, never on every tick forever.
    expect(calls.filter((call) => call.includes("show"))).toHaveLength(3);
  });
});

describe("the idle-cadence switch", () => {
  it("drops an unchanged worker to one row per idle interval, and returns to every tick when it moves", async () => {
    const time = clock(Date.now());
    const { run } = systemctl({ [UNIT]: CONTROL_GROUP });
    writeCgroup(CONTROL_GROUP, { current: 100 * MiB, usageUsec: 1_000_000 });
    spawnFixtureWorker();
    const sampler = makeSampler({ now: time.now, run });

    await sampler.sampleOnce(); // t=0: the first row
    for (let tick = 1; tick <= 9; tick++) {
      time.advance(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
      await sampler.sampleOnce(); // t=30..270: idle, read but not written
    }
    expect(samplesOf("tinker_bridge")).toHaveLength(1);

    time.advance(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
    await sampler.sampleOnce(); // t=300: the idle floor
    expect(samplesOf("tinker_bridge")).toHaveLength(2);

    writeCgroup(CONTROL_GROUP, { current: 100 * MiB, usageUsec: 2_000_000 }); // one CPU-second
    time.advance(WORKER_SAMPLE_ACTIVE_INTERVAL_MS);
    await sampler.sampleOnce(); // active again: written on the very next tick
    const samples = samplesOf("tinker_bridge");
    expect(samples).toHaveLength(3);
    expect(samples[2].record.n2).toBe(1_000);
  });

  it("decides from memory (1 %) and CPU (a share of one core) against the last WRITTEN row", () => {
    const cadence = {
      activeIntervalMs: WORKER_SAMPLE_ACTIVE_INTERVAL_MS,
      idleIntervalMs: WORKER_SAMPLE_IDLE_INTERVAL_MS,
    };
    const prev = { atMs: 0, memBytes: 100 * MiB, cpuMs: 1_000 };
    const at = (atMs: number, memBytes: number | null, cpuMs: number | null) => ({
      atMs,
      memBytes,
      cpuMs,
    });
    expect(shouldEmitWorkerSample(null, at(0, 1, 1), cadence)).toBe(true);
    expect(shouldEmitWorkerSample(prev, at(30_000, 100 * MiB + MiB / 2, 1_010), cadence)).toBe(
      false,
    );
    expect(shouldEmitWorkerSample(prev, at(30_000, 102 * MiB, 1_000), cadence)).toBe(true);
    expect(shouldEmitWorkerSample(prev, at(30_000, 100 * MiB, 1_031), cadence)).toBe(true);
    expect(shouldEmitWorkerSample(prev, at(285_000, 100 * MiB, 1_000), cadence)).toBe(true);
    // An unavailable worker is written on the idle floor only.
    expect(shouldEmitWorkerSample(prev, at(30_000, null, null), cadence)).toBe(false);
  });
});

describe("worker.spawn and worker.exit", () => {
  it("writes a spawn row, then one exit row carrying the last sampled memory and the lifetime peak", async () => {
    const time = clock(Date.now());
    const { run } = systemctl({ [UNIT]: CONTROL_GROUP });
    writeCgroup(CONTROL_GROUP, { current: 150 * MiB, peak: 180 * MiB, usageUsec: 10 });
    noteWorkerSpawn({ workerType: "tinker_bridge", workerId: UNIT, resumed: true });
    await makeSampler({ now: time.now, run }).sampleOnce();

    noteWorkerExit({
      workerId: UNIT,
      code: null,
      signal: "SIGTERM",
      killCause: "Error: Reply operation aborted by user",
      turnsServed: 4,
    });
    // The 'error' and 'exit' paths may both report one end: the second adds nothing.
    noteWorkerExit({
      workerId: UNIT,
      code: null,
      signal: "SIGTERM",
      killCause: null,
      turnsServed: 4,
    });

    const spawns = rows.filter((row) => row.name === "worker.spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].record).toMatchObject({
      workerId: UNIT,
      label: "tinker_bridge",
      fields: { resumed: true },
    });
    const exits = rows.filter((row) => row.name === "worker.exit");
    expect(exits).toHaveLength(1);
    expect(exits[0].record).toMatchObject({
      workerId: UNIT,
      label: "killed.user-abort",
      n1: null,
      n3: 150 * MiB,
      n4: 180 * MiB,
      fields: { signal: "SIGTERM", turns_served: 4 },
    });
    expect(exits[0].record.n2).toBeGreaterThanOrEqual(0);
    // The cause TEXT is in no column (logging.md L4).
    expect(JSON.stringify(exits[0].record)).not.toContain("aborted by user");

    rows.length = 0;
    await makeSampler({ now: time.now, run }).sampleOnce();
    expect(samplesOf("tinker_bridge")).toHaveLength(0); // an exited worker is sampled no more
  });

  it("reads a new worker just after its spawn, so one that exits before the first tick still has a size", async () => {
    const { run } = systemctl({ [UNIT]: CONTROL_GROUP });
    writeCgroup(CONTROL_GROUP, { current: 120 * MiB, peak: 130 * MiB, usageUsec: 5 });
    const sampler = makeSampler({
      now: () => Date.now(),
      run,
      firstSampleDelayMs: 0,
      activeIntervalMs: HOUR_MS, // no tick will come round during this test
      orphanScanIntervalMs: HOUR_MS,
    });
    sampler.start();
    try {
      spawnFixtureWorker();
      await vi.waitFor(() => {
        expect(samplesOf("tinker_bridge")).toHaveLength(1);
      });
      noteWorkerExit({ workerId: UNIT, code: 0, signal: null, killCause: null, turnsServed: 1 });
      const exit = rows.find((row) => row.name === "worker.exit");
      expect(exit?.record).toMatchObject({ label: "clean", n3: 120 * MiB, n4: 130 * MiB });
    } finally {
      sampler.stop();
    }
  });

  it("classifies an exit into the closed set", () => {
    expect(classifyWorkerExit({ code: 0, signal: null, killCause: null })).toBe("clean");
    expect(classifyWorkerExit({ code: 1, signal: null, killCause: null })).toBe("crash");
    expect(classifyWorkerExit({ code: null, signal: null, killCause: null })).toBe("crash");
    expect(classifyWorkerExit({ code: null, signal: "SIGKILL", killCause: null })).toBe("signal");
    expect(
      classifyWorkerExit({ code: null, signal: "SIGTERM", killCause: "fast-fail-init-stall" }),
    ).toBe("init_stall");
    expect(
      classifyWorkerExit({
        code: null,
        signal: "SIGTERM",
        killCause: "Error: Reply operation aborted for restart",
      }),
    ).toBe("killed.gateway-shutdown");
    // The pool kills without a reason: an empty cause claims nothing.
    expect(classifyWorkerExit({ code: null, signal: "SIGTERM", killCause: "" })).toBe(
      "killed.unknown",
    );
  });
});

describe("the other worker types", () => {
  it("samples the gateway as a process and the FTS thread as its own isolate, unavailable when the probe is late", async () => {
    const time = clock(Date.now());
    let fts: FtsWorkerThreadStats | null = {
      workerId: "fts-fixture-1",
      spawnedAtMs: time.now() - 60_000,
      requestsServed: 3,
      isolate: {
        usedHeapBytes: 40 * MiB,
        totalHeapBytes: 60 * MiB,
        heapLimitBytes: 2_100 * MiB,
        externalBytes: 4 * MiB,
        cpuUsec: 2_500_000,
        uptimeMs: 60_000,
      },
      memBytes: 64 * MiB,
      peakBytes: 70 * MiB,
    };
    const sampler = makeSampler({
      now: time.now,
      readGateway: () => ({
        source: "process",
        memBytes: 300 * MiB,
        cpuMs: 5_000,
        ageMs: 60_000,
        peakBytes: 320 * MiB,
        heapUsedBytes: 90 * MiB,
        heapLimitBytes: 4_096 * MiB,
      }),
      readFtsThread: async () => fts,
    });
    await sampler.sampleOnce();
    expect(samplesOf("gateway")[0]?.record).toMatchObject({
      workerId: `gateway-${SELF_PID}`,
      n1: 300 * MiB,
      n2: 5_000,
      n4: 320 * MiB,
      fields: { source: "process", heap_used_bytes: 90 * MiB, heap_limit_bytes: 4_096 * MiB },
    });
    expect(samplesOf("fts_thread")[0]?.record).toMatchObject({
      workerId: "fts-fixture-1",
      n1: 64 * MiB,
      n2: 2_500,
      n3: 60_000,
      n4: 70 * MiB,
      fields: { source: "isolate", heap_used_bytes: 40 * MiB, heap_limit_bytes: 2_100 * MiB },
    });

    fts = fts === null ? null : { ...fts, isolate: null, memBytes: null };
    time.advance(WORKER_SAMPLE_IDLE_INTERVAL_MS);
    await sampler.sampleOnce();
    expect(samplesOf("fts_thread")[1]?.record.fields).toEqual({ source: "unavailable" });
  });

  it("finds whatsmeow among this process's children by its binary name, and ignores the rest", async () => {
    const proc = join(root, "proc");
    const task = join(proc, String(SELF_PID), "task", String(SELF_PID));
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, "children"), "4201 4202 ");
    writeFileSync(join(proc, "uptime"), "1000.00 3000.00\n");
    const child = (pid: number, comm: string, rssKb: number, hwmKb: number, startTicks: number) => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${pid} (${comm}) S ${SELF_PID} ${pid} ${pid} 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 ${startTicks} 123456789 2048 0\n`,
      );
      writeFileSync(
        join(proc, String(pid), "status"),
        `Name:\t${comm}\nState:\tS (sleeping)\nVmHWM:\t${hwmKb} kB\nVmRSS:\t${rssKb} kB\nThreads:\t12\n`,
      );
    };
    child(4201, "whatsmeow-node", 51_200, 61_440, 40_000);
    child(4202, "systemd-run", 2_048, 2_048, 90_000); // a bridge wrapper: never charted as a worker

    await makeSampler({ now: () => Date.now() }).sampleOnce();
    const samples = samplesOf("whatsmeow");
    expect(samples).toHaveLength(1);
    expect(samples[0].record).toMatchObject({
      workerId: "whatsmeow-4201",
      n1: 50 * MiB,
      n2: 3_000, // 300 ticks at USER_HZ 100
      n3: 600_000, // uptime 1000 s − start 400 s
      n4: 60 * MiB,
      fields: { source: "process" },
    });
  });

  it("names an overridden whatsmeow binary the way the kernel does (15 characters)", () => {
    expect(
      resolveWhatsmeowComms({ OPENCLAW_WHATSMEOW_BINARY: "/opt/fixture/whatsmeow-rebuilt-binary" }),
    ).toEqual(["whatsmeow-node", "whatsmeow-rebui"]);
    expect(resolveWhatsmeowComms({})).toEqual(["whatsmeow-node"]);
  });

  it("reads the real gateway process with plausible numbers", () => {
    const reading = readGatewayProcess();
    expect(reading.source).toBe("process");
    expect(reading.memBytes).toBeGreaterThan(0);
    expect(reading.peakBytes).toBeGreaterThanOrEqual(reading.memBytes);
    expect(reading.heapLimitBytes ?? 0).toBeGreaterThan(reading.heapUsedBytes ?? 0);
  });
});

describe("the orphan scan", () => {
  it("reports a unit whose gateway is gone — once — and charts it until it disappears", async () => {
    const time = clock(Date.now());
    const spawnedAtMs = time.now() - 2 * HOUR_MS;
    const ours = `tinkerclaw-worker-${SELF_PID}-${time.now().toString(36)}-fx0001`;
    const orphan = `tinkerclaw-worker-4999-${spawnedAtMs.toString(36)}-fx0002`;
    const sibling = `tinkerclaw-worker-4998-${spawnedAtMs.toString(36)}-fx0003`; // a live gateway's
    const reused = `tinkerclaw-worker-4997-${spawnedAtMs.toString(36)}-fx0004`; // pid now someone else's
    const orphanGroup = `/user.slice/app.slice/${orphan}.service`;
    writeCgroup(orphanGroup, { current: 400 * MiB, peak: 900 * MiB, usageUsec: 1 });
    // Boot 10 h before the spawns: 4998 started 1 h after boot (before them, so it can own them);
    // 4997 started 11 h after boot — AFTER the unit it supposedly owns, so its pid was reused.
    const proc = join(root, "proc");
    const bootSec = Math.floor((spawnedAtMs - 10 * HOUR_MS) / 1000);
    mkdirSync(proc, { recursive: true });
    writeFileSync(join(proc, "stat"), `cpu  1 2 3 4\nbtime ${bootSec}\nprocesses 1\n`);
    const procStat = (pid: number, startTicks: number) => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 ${startTicks} 0 0\n`,
      );
    };
    procStat(4998, (1 * HOUR_MS) / 10);
    procStat(4997, (11 * HOUR_MS) / 10);
    const { run } = systemctl({ [orphan]: orphanGroup }, [ours, orphan, sibling, reused]);
    const sampler = makeSampler({
      now: time.now,
      run,
      processStartMs: time.now() - 60_000,
      isPidAlive: (pid) => pid === 4998 || pid === 4997,
    });

    await sampler.scanOrphans();
    await sampler.scanOrphans(); // the hourly rescan finds them again: still one row each
    const orphans = rows.filter((row) => row.name === "worker.orphan");
    expect(orphans.map((row) => row.record.workerId)).toEqual([orphan, reused]);
    expect(orphans[0].record).toMatchObject({ n1: 2 * HOUR_MS, n2: 400 * MiB });
    expect(orphans[1].record.n2).toBeNull(); // systemd has no cgroup for it: no number, not a zero

    await sampler.sampleOnce();
    expect(samplesOf("tinker_bridge").map((row) => row.record.workerId)).toEqual([orphan]);

    rmSync(join(root, "cgroup", orphanGroup), { recursive: true }); // stopped by hand
    time.advance(WORKER_SAMPLE_IDLE_INTERVAL_MS);
    await sampler.sampleOnce();
    expect(samplesOf("tinker_bridge")).toHaveLength(1); // gone: not an endless unavailable series
  });

  it("an orphan is a dead owner, a reused pid, or our own pid on a unit older than this process", () => {
    const unit = (ownerPid: number, spawnedAtMs: number) => ({ unit: "u", ownerPid, spawnedAtMs });
    const ctx = (ownerAlive: boolean, ownerStartMs: number | null) => ({
      selfPid: SELF_PID,
      processStartMs: 1_000_000,
      ownerAlive,
      ownerStartMs,
    });
    expect(isOrphanWorkerUnit(unit(4999, 2_000_000), ctx(false, null))).toBe(true);
    expect(isOrphanWorkerUnit(unit(4998, 2_000_000), ctx(true, 1_500_000))).toBe(false);
    expect(isOrphanWorkerUnit(unit(4997, 2_000_000), ctx(true, 9_000_000))).toBe(true);
    // A start time that cannot be read is no evidence: not reported.
    expect(isOrphanWorkerUnit(unit(4996, 2_000_000), ctx(true, null))).toBe(false);
    expect(isOrphanWorkerUnit(unit(SELF_PID, 2_000_000), ctx(true, null))).toBe(false);
    expect(isOrphanWorkerUnit(unit(SELF_PID, 500_000), ctx(true, null))).toBe(true);
  });
});

describe("the events writer thread (worker_type events_writer)", () => {
  /**
   * CONTROL: before this change WORKER_TYPES has no `events_writer`, there is no `readWriterThread`
   * seam and no `eventsWriterReading` export, so both tests here fail — the first finds no
   * `events_writer` row (the option is ignored), the second calls an undefined import — and the
   * sampler could not reach that isolate's memory at all.
   */
  it("charts its own isolate, says unavailable when the probe is late, and never starts one", async () => {
    const time = clock(Date.now());
    let thread: EventWriterThreadStats | null = {
      workerId: "events-writer-4100-1",
      isolate: {
        usedHeapBytes: 12 * MiB,
        totalHeapBytes: 20 * MiB,
        heapLimitBytes: 2_100 * MiB,
        externalBytes: 2 * MiB,
        cpuUsec: 1_500_000,
        uptimeMs: 45_000,
      },
      memBytes: 22 * MiB,
      peakBytes: 26 * MiB,
    };
    const sampler = makeSampler({ now: time.now, readWriterThread: async () => thread });
    await sampler.sampleOnce();
    // Committed heap + external, never the RSS it shares with the gateway.
    expect(samplesOf("events_writer")[0]?.record).toMatchObject({
      workerId: "events-writer-4100-1",
      n1: 22 * MiB,
      n2: 1_500,
      n3: 45_000,
      n4: 26 * MiB,
      fields: { source: "isolate", heap_used_bytes: 12 * MiB, heap_limit_bytes: 2_100 * MiB },
    });

    // The thread still runs, but its probe queued behind a maintenance pass: a gap, not a zero.
    thread = thread === null ? null : { ...thread, isolate: null, memBytes: null };
    time.advance(WORKER_SAMPLE_IDLE_INTERVAL_MS);
    await sampler.sampleOnce();
    expect(samplesOf("events_writer")[1]?.record.fields).toEqual({ source: "unavailable" });

    // No writer thread at all: no row, and the probe never spawns one to measure.
    thread = null;
    time.advance(WORKER_SAMPLE_IDLE_INTERVAL_MS);
    await sampler.sampleOnce();
    expect(samplesOf("events_writer")).toHaveLength(2);
  });

  it("eventsWriterReading carries the isolate's own numbers and nothing invented", () => {
    expect(
      eventsWriterReading({
        workerId: "events-writer-4100-2",
        isolate: {
          usedHeapBytes: 1,
          totalHeapBytes: 2,
          heapLimitBytes: 3,
          externalBytes: 4,
          cpuUsec: null,
          uptimeMs: 5,
        },
        memBytes: 6,
        peakBytes: null,
      }),
    ).toEqual({
      source: "isolate",
      memBytes: 6,
      // A Node without threadCpuUsage reports NO cpu, never the process's under the thread's name.
      cpuMs: null,
      ageMs: 5,
      peakBytes: null,
      heapUsedBytes: 1,
      heapLimitBytes: 3,
    });
  });
});

describe("the process-wide sampler", () => {
  it("starts nothing while the events writer is disabled — no writer runs under a test runner", () => {
    expect(startWorkerResourceSampler()).toBe(false);
  });
});

describe("the 7-day memory trend query", () => {
  it("runs against the real catalog view and ranks a growing worker first", () => {
    const handle = openEventsDatabase(join(root, "logs", "events.sqlite"), {
      walMaintenance: { checkpointIntervalMs: 0 },
    });
    try {
      const insert = handle.db.prepare(
        "INSERT INTO events (ts_ms, name, kind, boot_id, worker_id, label, n1, n4, fields) " +
          "VALUES (?, 'worker.sample', 'sample', 'boot-fixture', ?, ?, ?, ?, ?)",
      );
      const CGROUP = '{"source":"cgroup"}';
      const PROCESS = '{"source":"process"}';
      const start = Date.now() - 24 * HOUR_MS;
      for (let hour = 0; hour <= 10; hour++) {
        const ts = start + hour * HOUR_MS;
        insert.run(ts, "fixture-growing", "tinker_bridge", (100 + hour) * MiB, 120 * MiB, CGROUP);
        insert.run(ts, "fixture-flat", "gateway", 300 * MiB, 310 * MiB, PROCESS);
      }
      // A gap carries no number, and a row older than the window is outside it.
      insert.run(start, "fixture-flat", "gateway", null, null, '{"source":"unavailable"}');
      const stale = Date.now() - 8 * 24 * HOUR_MS;
      insert.run(stale, "fixture-stale", "whatsmeow", 50 * MiB, 50 * MiB, PROCESS);

      const result = handle.db.prepare(WORKER_MEMORY_TREND_7D_SQL).all() as Array<
        Record<string, unknown>
      >;
      expect(result.map((row) => row.worker_id)).toEqual(["fixture-growing", "fixture-flat"]);
      expect(result[0]).toMatchObject({
        worker_type: "tinker_bridge",
        samples: 11,
        span_hours: 10,
        peak_mem_mib: 120,
        mib_per_hour: 1,
      });
      expect(result[1]).toMatchObject({ worker_type: "gateway", samples: 11, mib_per_hour: 0 });
    } finally {
      handle.close();
    }
  });

  /**
   * The gate that catches the defect instead of describing it. An `expect(a).toBe(b)` between two
   * byte-equal copies PASSES — string equality is by value — so only the source text can prove
   * there is one owner. CONTROL: against the pre-change file each assertion fails on its own (no
   * re-export line; an `export const WORKER_MEMORY_TREND_7D_SQL =` declaration).
   */
  it("has ONE owner: the sampler re-exports the registry's SQL and never re-declares it", () => {
    const source = readFileSync(new URL("./worker-resources.ts", import.meta.url), "utf8");
    expect(source).toContain('export { WORKER_MEMORY_TREND_7D_SQL } from "../saved-queries.js";');
    expect(source).not.toMatch(/const WORKER_MEMORY_TREND_7D_SQL\s*=/);
  });
});
