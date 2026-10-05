/**
 * FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/logging.md §4.9 (§9 step 5): the kernel accounting
 * readers, against FIXTURE trees in a temp dir — never the host's /sys or /proc — and a scripted
 * systemctl. No fixture names a real unit, pid or path.
 *
 * CONTROL. None existed: before this change there is no cgroup reader, so every test here fails on
 * a missing module.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cgroupDirFor,
  listChildPids,
  parseCpuStatUsageUsec,
  parseProcStat,
  parseWorkerUnitList,
  parseWorkerUnitName,
  readCgroup,
  readProcessStartMs,
  readProcProcess,
  readProcUptimeMs,
  resolveUnitControlGroup,
  type RunCommand,
} from "./cgroup-reader.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cgroup-reader-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

describe("readCgroup — a cgroup v2 directory", () => {
  it("reads memory.current, memory.peak, cpu.stat usage_usec and pids.current", async () => {
    const dir = join(root, "user.slice", "app.slice", "fixture-worker.service");
    writeFiles(dir, {
      "memory.current": "209715200\n",
      "memory.peak": "262144000\n",
      "cpu.stat": "usage_usec 4000000\nuser_usec 3000000\nsystem_usec 1000000\n",
      "pids.current": "7\n",
    });
    await expect(readCgroup(dir)).resolves.toEqual({
      memoryCurrentBytes: 209_715_200,
      memoryPeakBytes: 262_144_000,
      cpuUsageUsec: 4_000_000,
      pidsCurrent: 7,
    });
  });

  it("keeps a reading without memory.peak (a kernel before 5.19), and reads 'max' as no number", async () => {
    const dir = join(root, "older-kernel");
    writeFiles(dir, { "memory.current": "1048576\n", "pids.current": "max\n" });
    await expect(readCgroup(dir)).resolves.toEqual({
      memoryCurrentBytes: 1_048_576,
      memoryPeakBytes: null,
      cpuUsageUsec: null,
      pidsCurrent: null,
    });
  });

  it("is null when memory.current cannot be read: the cgroup is gone, or it is not v2", async () => {
    await expect(readCgroup(join(root, "never-existed"))).resolves.toBeNull();
    const dir = join(root, "garbled");
    writeFiles(dir, { "memory.current": "not a number\n" });
    await expect(readCgroup(dir)).resolves.toBeNull();
  });

  it("parses usage_usec wherever it sits in cpu.stat", () => {
    expect(parseCpuStatUsageUsec("user_usec 1\nusage_usec 42\n")).toBe(42);
    expect(parseCpuStatUsageUsec("user_usec 1\n")).toBeNull();
  });
});

describe("cgroupDirFor — only an absolute cgroup path below the root", () => {
  it("joins an absolute path under the root", () => {
    expect(cgroupDirFor("/user.slice/app.slice/x.service\n", "/fixture/cgroup")).toBe(
      "/fixture/cgroup/user.slice/app.slice/x.service",
    );
  });

  it("refuses a relative path, a dot segment, a NUL and the root cgroup", () => {
    expect(cgroupDirFor("user.slice/x.service", "/fixture/cgroup")).toBeNull();
    expect(cgroupDirFor("/user.slice/../../etc", "/fixture/cgroup")).toBeNull();
    expect(cgroupDirFor("/user.slice/./x.service", "/fixture/cgroup")).toBeNull();
    expect(cgroupDirFor("/user.slice/x\0.service", "/fixture/cgroup")).toBeNull();
    expect(cgroupDirFor("/", "/fixture/cgroup")).toBeNull();
    expect(cgroupDirFor("", "/fixture/cgroup")).toBeNull();
  });
});

describe("the tinker-bridge unit", () => {
  it("reads the owner pid and the spawn time out of the unit name worker.ts builds", () => {
    const spawnedAtMs = 1_790_000_000_000;
    const unit = `tinkerclaw-worker-4100-${spawnedAtMs.toString(36)}-ab12cd`;
    expect(parseWorkerUnitName(unit)).toEqual({ unit, ownerPid: 4100, spawnedAtMs });
    expect(parseWorkerUnitName(`${unit}.service`)).toBeNull();
    expect(parseWorkerUnitName("llm-client-4100-abc-def")).toBeNull();
    expect(parseWorkerUnitName("tinkerclaw-worker-x-abc-def")).toBeNull();
  });

  it("lists only live worker units out of systemctl list-units", () => {
    const text = [
      "tinkerclaw-worker-4100-lx0f1x70-aa11bb.service loaded active running fixture",
      "tinkerclaw-worker-4101-lx0f1x71-cc22dd.service loaded failed failed fixture",
      "tinkerclaw-worker-4102-lx0f1x72-ee33ff.service loaded deactivating stop-sigterm fixture",
      "other-unit.service loaded active running fixture",
      "",
    ].join("\n");
    expect(parseWorkerUnitList(text)).toEqual([
      "tinkerclaw-worker-4100-lx0f1x70-aa11bb",
      "tinkerclaw-worker-4102-lx0f1x72-ee33ff",
    ]);
  });

  it("asks systemd for the unit's cgroup, and reads an empty answer or a failure as none", async () => {
    const calls: Array<readonly string[]> = [];
    const answer =
      (out: string | Error): RunCommand =>
      async (_file, args) => {
        calls.push(args);
        if (out instanceof Error) {
          throw out;
        }
        return out;
      };
    await expect(
      resolveUnitControlGroup("fixture-unit", answer("/user.slice/fixture-unit.service\n")),
    ).resolves.toBe("/user.slice/fixture-unit.service");
    expect(calls[0]).toEqual([
      "--user",
      "show",
      "--property=ControlGroup",
      "--value",
      "fixture-unit.service",
    ]);
    await expect(resolveUnitControlGroup("fixture-unit", answer("\n"))).resolves.toBeNull();
    await expect(
      resolveUnitControlGroup("fixture-unit", answer(new Error("no user manager"))),
    ).resolves.toBeNull();
  });

  it("never hands systemctl a name that reads as an option", async () => {
    let ran = false;
    const run: RunCommand = async () => {
      ran = true;
      return "/";
    };
    await expect(resolveUnitControlGroup("--help", run)).resolves.toBeNull();
    expect(ran).toBe(false);
  });
});

describe("/proc — a direct child process", () => {
  it("splits stat after the LAST ')', so a name with spaces and parentheses cannot shift the fields", () => {
    const stat =
      "4201 (odd) name) S 4100 4201 4201 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 40000 1 2 3\n";
    expect(parseProcStat(stat)).toEqual({
      comm: "odd) name",
      ppid: 4100,
      cpuTicks: 300,
      startTicks: 40_000,
    });
    expect(parseProcStat("4201 (truncated) S 4100\n")).toBeNull();
  });

  it("reads RSS, peak RSS and CPU of a live process, and nothing of a zombie", async () => {
    const proc = join(root, "proc");
    writeFiles(join(proc, "4201"), {
      stat: "4201 (whatsmeow-node) S 4100 4201 4201 0 -1 0 0 0 0 0 250 50 0 0 20 0 12 0 40000 1 2\n",
      status: "Name:\twhatsmeow-node\nVmHWM:\t   61440 kB\nVmRSS:\t   51200 kB\n",
    });
    writeFiles(join(proc, "4202"), {
      stat: "4202 (defunct) Z 4100 4202 4202 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 50000 0 0\n",
      status: "Name:\tdefunct\nState:\tZ (zombie)\n",
    });
    await expect(readProcProcess(4201, proc)).resolves.toEqual({
      pid: 4201,
      comm: "whatsmeow-node",
      rssBytes: 51_200 * 1024,
      peakRssBytes: 61_440 * 1024,
      cpuMs: 3_000,
      startTicks: 40_000,
    });
    await expect(readProcProcess(4202, proc)).resolves.toBeNull();
    await expect(readProcProcess(4203, proc)).resolves.toBeNull();
  });

  it("lists the children of every thread, once each", async () => {
    const proc = join(root, "proc");
    writeFiles(join(proc, "4100", "task", "4100"), { children: "4201 4202 " });
    writeFiles(join(proc, "4100", "task", "4105"), { children: "4202 4300" });
    writeFiles(join(proc, "4100", "task", "4106"), { children: "" });
    await expect(listChildPids(4100, proc)).resolves.toEqual([4201, 4202, 4300]);
    await expect(listChildPids(4999, proc)).resolves.toEqual([]);
  });

  it("dates a process's start from btime plus its starttime — what tells a reused pid apart", async () => {
    const proc = join(root, "proc");
    writeFiles(proc, { stat: "cpu  1 2 3 4\nbtime 1790000000\nprocesses 42\n" });
    writeFiles(join(proc, "4998"), {
      stat: "4998 (node) S 1 4998 4998 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 360000 0 0\n",
    });
    await expect(readProcessStartMs(4998, proc)).resolves.toBe(1_790_000_000_000 + 3_600_000);
    await expect(readProcessStartMs(4999, proc)).resolves.toBeNull();
    await expect(readProcessStartMs(4998, join(root, "no-proc"))).resolves.toBeNull();
  });

  it("reads the time since boot", async () => {
    const proc = join(root, "proc");
    writeFiles(proc, { uptime: "1000.50 3000.00\n" });
    await expect(readProcUptimeMs(proc)).resolves.toBe(1_000_500);
    await expect(readProcUptimeMs(join(root, "missing"))).resolves.toBeNull();
  });
});
