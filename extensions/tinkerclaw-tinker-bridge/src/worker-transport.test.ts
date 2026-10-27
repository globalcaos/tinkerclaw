import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exitStatusToCodeSignal,
  FileChannel,
  freezeUnit,
  prepareWorkerDir,
  readUnitState,
  readUnitStates,
  readWorkerMeta,
  resolveBridgeTransport,
  thawUnit,
  type UnitCommand,
  writeWorkerMeta,
} from "./worker-transport.js";

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeSystemctl(state = "ActiveState=active\nFreezerState=running\n") {
  const calls: string[][] = [];
  const run: UnitCommand = async (args) => {
    calls.push(args);
    return { ok: true, stdout: args[0] === "show" ? state : "" };
  };
  return { calls, run };
}

/** A systemctl that answers `show` for any number of units, one block each, from `states`. */
function fakeUnits(states: Record<string, string>) {
  const calls: string[][] = [];
  const sys = {
    calls,
    states,
    fail: false,
    run: (async () => ({ ok: true, stdout: "" })) as UnitCommand,
  };
  sys.run = async (args) => {
    calls.push(args);
    if (sys.fail) {
      return { ok: false, stdout: "" };
    }
    if (args[0] !== "show") {
      return { ok: true, stdout: "" };
    }
    const units = args.slice(7);
    const blocks = units.map((u) => `ActiveState=${states[u] ?? "inactive"}\nFreezerState=running`);
    return { ok: true, stdout: `${blocks.join("\n\n")}\n` };
  };
  return sys;
}

/**
 * systemd that lost track of a unit's freezer (no inotify watch on its `cgroup.events`, 2026-10-18):
 * `show` answers `props` (and the bare ControlGroup for `--value`), and the verbs in `refuse` fail.
 */
function systemdLostTrack(props: string, refuse: string[] = []) {
  const calls: string[][] = [];
  const cg = /ControlGroup=(\S+)/.exec(props)?.[1] ?? "";
  const run: UnitCommand = async (args) => {
    calls.push(args);
    if (args[0] === "show") {
      return { ok: true, stdout: args.includes("--value") ? `${cg}\n` : props };
    }
    return { ok: !refuse.includes(args[0]), stdout: "" };
  };
  return { calls, run };
}

let runtimeDir: string;
let previousRuntime: string | undefined;
let cgroupDir: string;
let previousCgroupRoot: string | undefined;
const channels: FileChannel[] = [];

/** A unit's cgroup under the fake cgroup root, its `cgroup.freeze` set to `freeze`. */
function fakeCgroup(unit: string, freeze: "0" | "1"): string {
  const cg = `/user.slice/app.slice/${unit}.service`;
  fs.mkdirSync(path.join(cgroupDir, cg), { recursive: true });
  fs.writeFileSync(path.join(cgroupDir, cg, "cgroup.freeze"), freeze);
  return cg;
}

const freezeFile = (cg: string) =>
  fs.readFileSync(path.join(cgroupDir, cg, "cgroup.freeze"), "utf8").trim();

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-transport-"));
  previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // Never the host's /sys/fs/cgroup: a test that wrote a real cgroup.freeze would freeze a real unit.
  cgroupDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cgroup-"));
  previousCgroupRoot = process.env.TINKERCLAW_CGROUP_ROOT;
  process.env.TINKERCLAW_CGROUP_ROOT = cgroupDir;
});

afterEach(() => {
  for (const ch of channels.splice(0)) {
    ch.detach();
  }
  if (previousRuntime === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = previousRuntime;
  }
  if (previousCgroupRoot === undefined) {
    delete process.env.TINKERCLAW_CGROUP_ROOT;
  } else {
    process.env.TINKERCLAW_CGROUP_ROOT = previousCgroupRoot;
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(cgroupDir, { recursive: true, force: true });
});

describe("worker file transport", () => {
  it("defaults to the pipe, and the env var wins over the config", () => {
    const prev = process.env.TINKERCLAW_BRIDGE_TRANSPORT;
    delete process.env.TINKERCLAW_BRIDGE_TRANSPORT;
    expect(resolveBridgeTransport(undefined)).toBe("pipe");
    expect(resolveBridgeTransport("file")).toBe("file");
    process.env.TINKERCLAW_BRIDGE_TRANSPORT = "pipe";
    expect(resolveBridgeTransport("file")).toBe("pipe");
    if (prev === undefined) {
      delete process.env.TINKERCLAW_BRIDGE_TRANSPORT;
    } else {
      process.env.TINKERCLAW_BRIDGE_TRANSPORT = prev;
    }
  });

  it("reads a shell exit status as code or signal", () => {
    expect(exitStatusToCodeSignal(0)).toEqual({ code: 0, signal: null });
    expect(exitStatusToCodeSignal(1)).toEqual({ code: 1, signal: null });
    expect(exitStatusToCodeSignal(143)).toEqual({ code: null, signal: "SIGTERM" });
    expect(exitStatusToCodeSignal(137)).toEqual({ code: null, signal: "SIGKILL" });
    expect(exitStatusToCodeSignal(null)).toEqual({ code: null, signal: null });
  });

  it("reads a unit's active and freezer state", async () => {
    const { run } = fakeSystemctl("ActiveState=active\nFreezerState=frozen\n");
    expect(await readUnitState("u", run)).toEqual({ active: true, frozen: true });
    const gone = fakeSystemctl("ActiveState=inactive\nFreezerState=running\n");
    expect(await readUnitState("u", gone.run)).toEqual({ active: false, frozen: false });
  });

  it("keeps a worker's meta beside its FIFO and output files", () => {
    const dir = prepareWorkerDir("tinkerclaw-worker-t1");
    expect(fs.statSync(path.join(dir, "in")).isFIFO()).toBe(true);
    expect(readWorkerMeta(dir)).toBeNull();
    writeWorkerMeta(dir, {
      version: 1,
      unit: "tinkerclaw-worker-t1",
      sessionKey: "tinker-sp-1",
      cwd: "/",
      createdAt: 1,
      turn: { startOffset: 42, startedAt: 2 },
    });
    expect(readWorkerMeta(dir)?.turn?.startOffset).toBe(42);
  });

  it("writes stdin into the FIFO, tails stdout, and exits only after the last line is read", async () => {
    const unit = "tinkerclaw-worker-t2";
    const dir = prepareWorkerDir(unit);
    const { run } = fakeSystemctl();
    const ch = FileChannel.attach(unit, dir, 0, run);
    channels.push(ch);

    // stdin reaches the FIFO (read back through a second read-write descriptor)
    const reader = fs.openSync(path.join(dir, "in"), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    ch.stdin.write("hello\n");
    let got = "";
    await waitFor(() => {
      try {
        const b = Buffer.alloc(64);
        got += b.subarray(0, fs.readSync(reader, b)).toString();
      } catch {
        // EAGAIN: not there yet
      }
      return got === "hello\n";
    });
    fs.closeSync(reader);

    const events: string[] = [];
    ch.stdout.setEncoding("utf8");
    ch.stdout.on("data", (c: string) => events.push(`data:${c.trim()}`));
    ch.on("exit", (code, signal) => events.push(`exit:${code}:${signal}`));
    fs.appendFileSync(path.join(dir, "out"), '{"type":"a"}\n');
    await waitFor(() => events.includes('data:{"type":"a"}'));

    // the last line and the exit land together: the line must still come first
    fs.appendFileSync(path.join(dir, "out"), '{"type":"result"}\n');
    fs.writeFileSync(path.join(dir, "exit"), "143");
    await waitFor(() => events.some((e) => e.startsWith("exit")));
    expect(events).toEqual(['data:{"type":"a"}', 'data:{"type":"result"}', "exit:null:SIGTERM"]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("thaws a frozen unit before killing it, and a detached one reports no exit", async () => {
    const unit = "tinkerclaw-worker-t3";
    const dir = prepareWorkerDir(unit);
    const { calls, run } = fakeSystemctl();
    const ch = FileChannel.attach(unit, dir, 0, run);
    channels.push(ch);
    ch.frozen = true;
    expect(ch.kill("SIGTERM")).toBe(true);
    await waitFor(() => calls.some((c) => c[0] === "kill"));
    expect(calls.filter((c) => c[0] !== "show").map((c) => c[0])).toEqual(["thaw", "kill"]);
    expect(calls.find((c) => c[0] === "kill")).toEqual(["kill", "--signal=SIGTERM", unit]);

    let exited = false;
    ch.on("exit", () => {
      exited = true;
    });
    ch.detach();
    fs.writeFileSync(path.join(dir, "exit"), "0");
    await new Promise((r) => setTimeout(r, 400));
    expect(exited).toBe(false);
    expect(fs.existsSync(dir)).toBe(true); // the unit's dir stays for the next gateway
  });

  it("reads several units from one call; a failed or misaligned answer is unknown", async () => {
    const two: UnitCommand = async () => ({
      ok: true,
      stdout:
        "ActiveState=active\nFreezerState=frozen\n\nActiveState=inactive\nFreezerState=running\n",
    });
    expect(await readUnitStates(["u1", "u2"], two)).toEqual(
      new Map([
        ["u1", { active: true, frozen: true }],
        ["u2", { active: false, frozen: false }],
      ]),
    );
    expect(await readUnitStates(["u1", "u2", "u3"], two)).toBeNull();
    expect(await readUnitStates(["u1"], async () => ({ ok: false, stdout: "" }))).toBeNull();
  });

  it("checks every attached unit with ONE systemctl call, and only two real misses end a channel", async () => {
    const sys = fakeUnits({ "tinkerclaw-worker-a": "active", "tinkerclaw-worker-b": "active" });
    const a = FileChannel.attach(
      "tinkerclaw-worker-a",
      prepareWorkerDir("tinkerclaw-worker-a"),
      0,
      sys.run,
    );
    const b = FileChannel.attach(
      "tinkerclaw-worker-b",
      prepareWorkerDir("tinkerclaw-worker-b"),
      0,
      sys.run,
    );
    channels.push(a, b);
    const exits: string[] = [];
    a.on("exit", () => exits.push("a"));
    b.on("exit", () => exits.push("b"));

    await FileChannel.checkUnits();
    expect(sys.calls.filter((c) => c[0] === "show")).toEqual([
      [
        "show",
        "-p",
        "ActiveState",
        "-p",
        "FreezerState",
        "-p",
        "ControlGroup",
        "tinkerclaw-worker-a",
        "tinkerclaw-worker-b",
      ],
    ]);

    // a systemctl that fails (a timeout under load) is no answer, not a miss
    sys.states["tinkerclaw-worker-a"] = "inactive";
    sys.fail = true;
    await FileChannel.checkUnits();
    await FileChannel.checkUnits();
    sys.fail = false;
    await new Promise((r) => setTimeout(r, 600));
    expect(exits).toEqual([]);

    // two real misses in a row end that channel and only that one
    await FileChannel.checkUnits();
    await FileChannel.checkUnits();
    await waitFor(() => exits.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(exits).toEqual(["a"]);
  });
});

// FORK 2026-10-18 (bible bug-log `freeze-stuck-freezing`): with the user's inotify budget spent,
// systemd could not watch a worker unit's cgroup.events, kept it at FreezerState=freezing after the
// kernel froze it, and refused its thaw. The adopted turn then waited out the 600 s idle timeout.
describe("the kernel's freezer is the truth, systemd's FreezerState only a cache", () => {
  it("reads a unit's freeze from its cgroup, not from a FreezerState systemd stopped updating", async () => {
    const cg = fakeCgroup("u", "1");
    const frozenBehindSystemd = systemdLostTrack(
      `ActiveState=active\nFreezerState=running\nControlGroup=${cg}\n`,
    );
    expect(await readUnitState("u", frozenBehindSystemd.run)).toEqual({
      active: true,
      frozen: true,
    });
    expect(frozenBehindSystemd.calls[0]).toEqual([
      "show",
      "-p",
      "ActiveState",
      "-p",
      "FreezerState",
      "-p",
      "ControlGroup",
      "u",
    ]);

    fs.writeFileSync(path.join(cgroupDir, cg, "cgroup.freeze"), "0");
    const stuckFreezing = systemdLostTrack(
      `ActiveState=active\nFreezerState=freezing\nControlGroup=${cg}\n`,
    );
    expect(await readUnitState("u", stuckFreezing.run)).toEqual({ active: true, frozen: false });
  });

  it("thaws through the cgroup when systemd refuses the thaw of a unit it left at freezing", async () => {
    const cg = fakeCgroup("u", "1");
    const sys = systemdLostTrack(
      `ActiveState=active\nFreezerState=freezing\nControlGroup=${cg}\n`,
      ["thaw"],
    );
    expect(await thawUnit("u", sys.run)).toBe(true);
    expect(freezeFile(cg)).toBe("0");
    expect(sys.calls[0]).toEqual(["thaw", "u"]); // systemd is still asked first
  });

  it("a freeze systemd never confirmed but the kernel took is a freeze; one systemd refused is written", async () => {
    // systemd wrote cgroup.freeze, then systemctl timed out waiting for an event it could not see
    const taken = fakeCgroup("a", "1");
    const timedOut = systemdLostTrack(`ActiveState=active\nControlGroup=${taken}\n`, ["freeze"]);
    expect(await freezeUnit("a", timedOut.run)).toBe(true);
    expect(freezeFile(taken)).toBe("1");

    // systemd refused before asking the kernel (a unit it believes is mid-thaw)
    const loose = fakeCgroup("b", "0");
    const refused = systemdLostTrack(`ActiveState=active\nControlGroup=${loose}\n`, ["freeze"]);
    expect(await freezeUnit("b", refused.run)).toBe(true);
    expect(freezeFile(loose)).toBe("1");
  });

  it("with no cgroup to read (another host's layout), systemd's answer stands", async () => {
    const refusing = systemdLostTrack("ActiveState=active\nFreezerState=freezing\n", [
      "thaw",
      "freeze",
    ]);
    expect(await thawUnit("u", refusing.run)).toBe(false);
    expect(await freezeUnit("u", refusing.run)).toBe(false);
    const fine = systemdLostTrack("ActiveState=active\nFreezerState=frozen\n");
    expect(await thawUnit("u", fine.run)).toBe(true);
  });

  it("a channel whose thaw systemd refuses still thaws before the kill, so the signal lands", async () => {
    const unit = "tinkerclaw-worker-t4";
    const cg = fakeCgroup(unit, "1");
    const sys = systemdLostTrack(
      `ActiveState=active\nFreezerState=freezing\nControlGroup=${cg}\n`,
      ["thaw"],
    );
    const ch = FileChannel.attach(unit, prepareWorkerDir(unit), 0, sys.run);
    channels.push(ch);
    ch.frozen = true;
    expect(ch.kill("SIGTERM")).toBe(true);
    await waitFor(() => sys.calls.some((c) => c[0] === "kill"));
    expect(freezeFile(cg)).toBe("0");
    expect(ch.frozen).toBe(false);
  });
});
