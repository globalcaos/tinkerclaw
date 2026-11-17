import { describe, expect, it } from "vitest";
import {
  isOneShotWorker,
  WORKER_BACKGROUND_CPU_WEIGHT,
  WORKER_OOM_SCORE_ADJUST,
  workerUnitBaseArgs,
} from "./worker-unit-args.js";

// FORK 2026-10-19: on the JarvisPi the kernel OOM killer took the gateway (oom_score_adj 200, the
// user manager's default) while 26 idle workers survived. Every worker unit now starts with
// OOMScoreAdjust=500 so the kernel takes a resumable worker first. Apart from that property, the
// flags must stay exactly what worker.ts built before; one test writes the old lists out by hand.
// FORK 2026-10-29: a one-shot worker's unit (a `temp:*` run, a Fractal turn) also gets
// CPUWeight=10 right after the OOM property, so it yields the CPU to chat workers under
// contention. A chat worker's flags stay exactly the old list.

const UNIT = "tinkerclaw-worker-4242-mgx1k2a-q7w3e9";
const DIR = `/run/user/1000/tinkerclaw-workers/${UNIT}`;
const OOM = "--property=OOMScoreAdjust=500";
const CPU = "--property=CPUWeight=10";

describe("workerUnitBaseArgs", () => {
  it("both transports name the unit and raise its OOM score to 500", () => {
    for (const workerDir of [DIR, null]) {
      const args = workerUnitBaseArgs({ unitId: UNIT, workerDir });
      expect(args).toContain(OOM);
      expect(args).toContain(`--unit=${UNIT}`);
    }
  });

  it("file transport (workerDir set) keeps --collect and TC_WORKER_DIR, and has no --pipe", () => {
    const args = workerUnitBaseArgs({ unitId: UNIT, workerDir: DIR });
    expect(args).toContain("--collect");
    expect(args).toContain(`--setenv=TC_WORKER_DIR=${DIR}`);
    expect(args).not.toContain("--pipe");
  });

  it("pipe transport (workerDir null) keeps --pipe, and has no --collect", () => {
    const args = workerUnitBaseArgs({ unitId: UNIT, workerDir: null });
    expect(args).toContain("--pipe");
    expect(args).not.toContain("--collect");
    expect(args.some((a) => a.startsWith("--setenv=TC_WORKER_DIR="))).toBe(false);
  });

  it("is the pre-change flag list, same order, with only the new property added at the end", () => {
    const oldFile = [
      "--user",
      "--quiet",
      "--collect",
      "--same-dir",
      `--unit=${UNIT}`,
      `--setenv=TC_WORKER_DIR=${DIR}`,
    ];
    const oldPipe = ["--user", "--pipe", "--quiet", "--same-dir", `--unit=${UNIT}`];
    expect(workerUnitBaseArgs({ unitId: UNIT, workerDir: DIR })).toEqual([...oldFile, OOM]);
    expect(workerUnitBaseArgs({ unitId: UNIT, workerDir: null })).toEqual([...oldPipe, OOM]);
  });

  it("the score sits above the user manager's default of 200 and inside the kernel's range", () => {
    expect(WORKER_OOM_SCORE_ADJUST).toBe(500);
    expect(WORKER_OOM_SCORE_ADJUST).toBeGreaterThan(200);
    expect(WORKER_OOM_SCORE_ADJUST).toBeLessThanOrEqual(1000);
  });

  it("background:true appends exactly --property=CPUWeight=10 in both transports", () => {
    expect(workerUnitBaseArgs({ unitId: UNIT, workerDir: DIR, background: true })).toEqual([
      "--user",
      "--quiet",
      "--collect",
      "--same-dir",
      `--unit=${UNIT}`,
      `--setenv=TC_WORKER_DIR=${DIR}`,
      OOM,
      CPU,
    ]);
    expect(workerUnitBaseArgs({ unitId: UNIT, workerDir: null, background: true })).toEqual([
      "--user",
      "--pipe",
      "--quiet",
      "--same-dir",
      `--unit=${UNIT}`,
      OOM,
      CPU,
    ]);
  });

  it("background false or absent gives the old list, with no CPUWeight", () => {
    for (const workerDir of [DIR, null]) {
      const absent = workerUnitBaseArgs({ unitId: UNIT, workerDir });
      expect(workerUnitBaseArgs({ unitId: UNIT, workerDir, background: false })).toEqual(absent);
      expect(absent.some((a) => a.startsWith("--property=CPUWeight="))).toBe(false);
    }
  });

  it("the background weight is 10: below the default 100, within systemd's 1..10000", () => {
    expect(WORKER_BACKGROUND_CPU_WEIGHT).toBe(10);
    expect(WORKER_BACKGROUND_CPU_WEIGHT).toBeLessThan(100);
    expect(WORKER_BACKGROUND_CPU_WEIGHT).toBeGreaterThanOrEqual(1);
  });
});

describe("isOneShotWorker, the background flag worker.ts passes at spawn", () => {
  // In production the pool key is the stream's `tinker-sp-<hash>`, which never names a one-shot.
  const POOL_KEY = "tinker-sp-1a2b3c4d";

  it("a Jev explainer run (temp:jev-explain:<id>) is a one-shot", () => {
    const jev = { sessionKey: POOL_KEY, openclawSessionKey: "temp:jev-explain:run-7f3a" };
    expect(isOneShotWorker(jev)).toBe(true);
  });

  it("a chat (agent:main:tinker:<id>) is not, so its worker keeps the default weight", () => {
    const chat = { sessionKey: POOL_KEY, openclawSessionKey: "agent:main:tinker:tab-42" };
    expect(isOneShotWorker(chat)).toBe(false);
  });

  it("a Fractal turn and a one-shot pool key are one-shots; a bare pool key is not", () => {
    const fractal = { sessionKey: POOL_KEY, openclawSessionKey: "agent:main:fractal:run-9c1d" };
    expect(isOneShotWorker(fractal)).toBe(true);
    expect(isOneShotWorker({ sessionKey: "temp:slug-1" })).toBe(true);
    expect(isOneShotWorker({ sessionKey: POOL_KEY })).toBe(false);
  });
});
