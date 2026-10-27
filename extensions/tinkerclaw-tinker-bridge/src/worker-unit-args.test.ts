import { describe, expect, it } from "vitest";
import { WORKER_OOM_SCORE_ADJUST, workerUnitBaseArgs } from "./worker-unit-args.js";

// FORK 2026-10-19: on the JarvisPi the kernel OOM killer took the gateway (oom_score_adj 200, the
// user manager's default) while 26 idle workers survived. Every worker unit now starts with
// OOMScoreAdjust=500 so the kernel takes a resumable worker first. Apart from that property, the
// flags must stay exactly what worker.ts built before; one test writes the old lists out by hand.

const UNIT = "tinkerclaw-worker-4242-mgx1k2a-q7w3e9";
const DIR = `/run/user/1000/tinkerclaw-workers/${UNIT}`;
const OOM = "--property=OOMScoreAdjust=500";

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
});
