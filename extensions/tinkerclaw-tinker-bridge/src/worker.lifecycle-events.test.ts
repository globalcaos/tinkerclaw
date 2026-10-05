import type { EventEmitter } from "node:events";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/logging.md §4.9 (§9 step 5): every claude child the
// bridge starts is reported to the worker-resources owner in core through
// openclaw/plugin-sdk/fork-telemetry — its spawn, with the systemd unit it runs as, and exactly one
// exit with the kill cause it held. The subprocess is a stand-in (node:child_process.spawn is
// mocked, so nothing starts) and the prompt and moral-code loaders are stubbed, so start() writes
// no file. The rows those reports become are core's to test (worker-resources.test.ts).
//
// CONTROL. Before this change worker.ts reports nothing: every test here fails on zero calls.

type FakeStream = EventEmitter & { writes: string[] };
type FakeChild = EventEmitter & {
  pid: number | undefined;
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
};

const harness = vi.hoisted(() => ({
  noteWorkerSpawn: vi.fn(),
  noteWorkerExit: vi.fn(),
  childPid: 4242 as number | undefined,
  spawns: [] as Array<{ file: string; args: string[] }>,
  children: [] as FakeChild[],
}));

vi.mock("openclaw/plugin-sdk/fork-telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fork-telemetry")>()),
  noteWorkerSpawn: (...args: unknown[]) => harness.noteWorkerSpawn(...args),
  noteWorkerExit: (...args: unknown[]) => harness.noteWorkerExit(...args),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  const stream = (): FakeStream => {
    const writes: string[] = [];
    return Object.assign(new Emitter(), {
      writes,
      setEncoding: () => undefined,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => undefined,
    });
  };
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const child: FakeChild = Object.assign(new Emitter(), {
        pid: harness.childPid,
        stdin: stream(),
        stdout: stream(),
        stderr: stream(),
        kill: () => true,
      });
      harness.spawns.push({ file, args });
      harness.children.push(child);
      return child;
    },
  };
});

vi.mock("./moral-code-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./moral-code-delivery.js")>()),
  resolveCorePluginDir: () => "/nonexistent/tinkerclaw-core-fixture",
  readMaterializedMoralCode: () => "",
}));

vi.mock("./prompt-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt-loader.js")>()),
  loadPromptFile: () => "",
}));

import { ClaudeCodeWorker } from "./worker.js";

beforeEach(() => {
  harness.noteWorkerSpawn.mockClear();
  harness.noteWorkerExit.mockClear();
  harness.childPid = 4242;
  harness.spawns.length = 0;
  harness.children.length = 0;
});

function makeWorker(): ClaudeCodeWorker {
  return new ClaudeCodeWorker({ sessionKey: "tinker-sp-fixture", cwd: os.tmpdir() });
}

function spawnedUnit(call = 0): string {
  const [report] = harness.noteWorkerSpawn.mock.calls[call] as [{ workerId: string }];
  return report.workerId;
}

describe("the bridge reports each child to the worker-resources owner", () => {
  it("reports one spawn per child, naming the systemd unit it runs as", async () => {
    const worker = makeWorker();
    await worker.start();
    expect(harness.noteWorkerSpawn).toHaveBeenCalledOnce();
    expect(harness.noteWorkerSpawn).toHaveBeenCalledWith({
      workerType: "tinker_bridge",
      workerId: expect.stringMatching(/^tinkerclaw-worker-\d+-[0-9a-z]+-[0-9a-z]+$/),
      resumed: false,
    });
    // The unit reported is the unit systemd runs — the cgroup the sampler reads — not a 2nd name.
    expect(harness.spawns[0]?.file).toBe("systemd-run");
    expect(harness.spawns[0]?.args).toContain(`--unit=${spawnedUnit()}`);

    await worker.start(); // already running: no second child, no second report
    expect(harness.noteWorkerSpawn).toHaveBeenCalledOnce();
  });

  it("reports the exit once, with its code and the turns the child served", async () => {
    const worker = makeWorker();
    const turn = worker.send({ userText: "hello" });
    await vi.waitFor(() => {
      expect(harness.children[0]?.stdin.writes).toHaveLength(1);
    });
    const child = harness.children[0];
    const result = { type: "result", subtype: "success", is_error: false, result: "ok" };
    child.stdout.emit("data", `${JSON.stringify(result)}\n`);
    await turn;

    child.emit("exit", 0, null);
    child.emit("exit", 0, null); // a repeated event adds nothing
    expect(harness.noteWorkerExit).toHaveBeenCalledOnce();
    expect(harness.noteWorkerExit).toHaveBeenCalledWith({
      workerId: spawnedUnit(),
      code: 0,
      signal: null,
      killCause: null,
      turnsServed: 1,
    });
  });

  it("hands over the kill cause it held, as text, for core to classify", async () => {
    const worker = makeWorker();
    await worker.start();
    worker.kill("SIGTERM", new Error("Reply operation aborted by user"));
    harness.children[0].emit("exit", null, "SIGTERM");
    expect(harness.noteWorkerExit).toHaveBeenCalledWith({
      workerId: spawnedUnit(),
      code: null,
      signal: "SIGTERM",
      killCause: "Error: Reply operation aborted by user",
      turnsServed: 0,
    });
  });

  it("closes the row of a child that never started, whose 'error' may come without an 'exit'", async () => {
    harness.childPid = undefined;
    const worker = makeWorker();
    await worker.start();
    const child = harness.children[0];
    child.emit("error", new Error("spawn systemd-run ENOENT"));
    expect(harness.noteWorkerExit).toHaveBeenCalledOnce();
    expect(harness.noteWorkerExit).toHaveBeenCalledWith({
      workerId: spawnedUnit(),
      code: null,
      signal: null,
      killCause: null,
      turnsServed: 0,
    });
    child.emit("exit", -2, null); // Node may still send one: nothing more is reported
    expect(harness.noteWorkerExit).toHaveBeenCalledOnce();
  });

  it("a respawned child is a new unit, and a late exit of the old one is never the new one's", async () => {
    const worker = makeWorker();
    await worker.start();
    harness.children[0].emit("exit", 1, null);
    await worker.start();
    expect(harness.noteWorkerSpawn).toHaveBeenCalledTimes(2);
    const first = spawnedUnit(0);
    const second = spawnedUnit(1);
    expect(second).not.toBe(first);

    harness.children[0].emit("exit", 1, null); // a stray repeat from the FIRST child
    harness.children[1].emit("exit", 0, null);
    const reported = harness.noteWorkerExit.mock.calls.map(
      ([report]) => (report as { workerId: string; code: number | null }).workerId,
    );
    expect(reported).toEqual([first, second]);
  });
});
