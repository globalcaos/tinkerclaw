import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDetachedLaunch,
  buildFanoutWakeMessage,
  deliverFanoutWake,
  fanoutUnitName,
  isValidFanoutId,
  newFanoutId,
  readFanoutStatus,
  statusExitCode,
  writeJsonAtomic,
} from "../../scripts/lib/fanout-unit.mjs";

// FORK 2026-10-01 — bug-log [fanout-dies-with-its-worker]. On 2026-10-01 a build worker's
// background Workflow died with the worker's process at 14:29 (the pool's idle sweep), and nobody
// noticed for 43 minutes: the waiter only looked for report files, never asked whether the fan-out
// was alive. `openclaw-orchestrate --detach` now hosts a fan-out on its own systemd unit, and
// `--status` tells running from dead.
//
// CONTROL. Before this change scripts/lib/fanout-unit.mjs does not exist and the orchestrate CLI
// has no --status: every test here fails.

const ORCHESTRATE = path.resolve(__dirname, "../../scripts/openclaw-orchestrate.mjs");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-unit-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(id: string, done?: Record<string, unknown>): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, "job.json"), { id, label: "probe", startedAt: 1_000 });
  if (done) {
    writeJsonAtomic(path.join(dir, "done.json"), done);
  }
  return dir;
}

describe("is the fan-out alive", () => {
  it("is running while its unit is active and it wrote no done marker", () => {
    fixture("a-1");
    const s = readFanoutStatus("a-1", { root, isActive: () => "active" });
    expect(s.state).toBe("running");
    expect(statusExitCode(s.state)).toBe(0);
  });

  it("is dead when its unit is gone and it never wrote a done marker", () => {
    fixture("a-2");
    const s = readFanoutStatus("a-2", { root, isActive: () => "inactive" });
    expect(s.state).toBe("dead");
    expect(statusExitCode(s.state)).toBe(3);
  });

  it("is done or failed once it wrote its done marker, whatever the unit says", () => {
    fixture("a-3", { ok: true, exitCode: 0, finishedAt: 2_000 });
    fixture("a-4", { ok: false, exitCode: 1, finishedAt: 2_000, error: "boom" });
    const ok = readFanoutStatus("a-3", { root, isActive: () => "inactive" });
    const bad = readFanoutStatus("a-4", { root, isActive: () => "inactive" });
    expect(ok.state).toBe("done");
    expect(statusExitCode(ok.state)).toBe(0);
    expect(bad).toMatchObject({ state: "failed", error: "boom" });
    expect(statusExitCode(bad.state)).toBe(1);
  });

  it("does not know an id with no directory", () => {
    const s = readFanoutStatus("nope", { root, isActive: () => "active" });
    expect(s.state).toBe("unknown");
    expect(statusExitCode(s.state)).toBe(2);
  });

  it("answers from the CLI: --status prints the state and exits 3 for a dead fan-out", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-home-"));
    try {
      const id = "dead-probe-1";
      const dir = path.join(home, ".openclaw", "fanout", id);
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, "job.json"), { id, label: "probe", startedAt: 1_000 });
      const r = spawnSync(process.execPath, [ORCHESTRATE, "--status", id], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ id, state: "dead" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the detached launch", () => {
  it("runs the same script as its own user unit, logging and answering into the fan-out's folder", () => {
    const dir = path.join(root, "build-x");
    const { unit, argv } = buildDetachedLaunch({
      id: "build-x",
      dir,
      cwd: "/tmp",
      nodeBin: "/opt/node/bin/node",
      scriptPath: "/repo/scripts/openclaw-orchestrate.mjs",
      argsJson: '{"q":1}',
      attributionSession: "agent:main:orchestrator",
      label: "build x",
      timeoutS: 7200,
      wakeSession: "agent:main:tinker:abc",
      env: { HOME: "/home/u", PATH: "/opt/node/bin:/usr/bin" },
    });
    expect(unit).toBe(fanoutUnitName("build-x"));
    expect(argv.slice(0, 4)).toEqual(["systemd-run", "--user", `--unit=${unit}`, "--collect"]);
    expect(argv).toContain(`--property=StandardOutput=append:${path.join(dir, "run.log")}`);
    expect(argv).toContain("--setenv=PATH=/opt/node/bin:/usr/bin");
    const inner = argv.slice(argv.indexOf("/opt/node/bin/node"));
    expect(inner).toEqual([
      "/opt/node/bin/node",
      "/repo/scripts/openclaw-orchestrate.mjs",
      "--script-file",
      path.join(dir, "plan.js"),
      "--args",
      '{"q":1}',
      "--session",
      "agent:main:orchestrator",
      "--label",
      "build x",
      "--timeout",
      "7200",
      "--json",
      "--result-dir",
      dir,
      "--wake-session",
      "agent:main:tinker:abc",
    ]);
  });

  it("makes ids a unit name accepts", () => {
    const id = newFanoutId("SV2 build: Phase 3!", 1_790_000_000_000);
    expect(isValidFanoutId(id)).toBe(true);
    expect(id.startsWith("sv2-build-phase-3-")).toBe(true);
    expect(isValidFanoutId("../etc")).toBe(false);
  });
});

describe("the wake", () => {
  it("names the fan-out, the outcome and where the result is", () => {
    const msg = buildFanoutWakeMessage({
      id: "build-x",
      label: "build x",
      ok: false,
      startedAt: 0,
      finishedAt: 5 * 60_000,
      resultFile: "/f/result.json",
      error: "gateway connection closed",
    });
    expect(msg.startsWith("⟦AGENT:")).toBe(true);
    expect(msg).toContain("build x");
    expect(msg).toContain("failed after 5 min");
    expect(msg).toContain("/f/result.json");
  });

  it("retries a failed chat.send and logs each attempt", async () => {
    const wakeLog = path.join(root, "wake.log");
    let calls = 0;
    const sent = await deliverFanoutWake({
      call: async (method: string) => {
        calls += 1;
        expect(method).toBe("chat.send");
        if (calls === 1) {
          throw new Error("gateway restarting");
        }
      },
      sessionKey: "agent:main:tinker:abc",
      message: "m",
      idempotencyKey: "k",
      wakeLog,
      retryMs: 1,
    });
    expect(sent).toBe(true);
    expect(calls).toBe(2);
    expect(fs.readFileSync(wakeLog, "utf8")).toMatch(
      /attempt 1 failed[\s\S]*wake sent \(attempt 2\)/,
    );
  });
});
