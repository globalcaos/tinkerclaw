import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exitStatusToCodeSignal,
  FileChannel,
  prepareWorkerDir,
  readUnitState,
  readWorkerMeta,
  resolveBridgeTransport,
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

let runtimeDir: string;
let previousRuntime: string | undefined;
const channels: FileChannel[] = [];

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-transport-"));
  previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
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
  fs.rmSync(runtimeDir, { recursive: true, force: true });
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
    expect(calls.map((c) => c[0])).toEqual(["thaw", "kill"]);
    expect(calls[1]).toEqual(["kill", "--signal=SIGTERM", unit]);

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
});
