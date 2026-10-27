import type { EventEmitter } from "node:events";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-25 (fractal-guard.ts): the spawn of a background Fractal's worker carries TC_FRACTAL_GUARD, which arms
// the tinkerclaw-core PreToolUse hook; a chat worker's spawn carries nothing new. Same spawn harness as
// worker.thalamus-seam.test.ts.

type FakeStream = EventEmitter & { writes: string[] };

const harness = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
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
      harness.spawns.push({ file, args });
      return Object.assign(new Emitter(), {
        pid: 4242,
        stdin: stream(),
        stdout: stream(),
        stderr: stream(),
        kill: () => true,
      });
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

import { ClaudeCodeWorker, type WorkerSpawnParams } from "./worker.js";

beforeEach(() => {
  harness.spawns.length = 0;
});

async function spawnArgs(extra: Partial<WorkerSpawnParams>): Promise<string[]> {
  harness.spawns.length = 0;
  const worker = new ClaudeCodeWorker({
    sessionKey: "tinker-sp-fixture",
    cwd: os.tmpdir(),
    ...extra,
  });
  await worker.start();
  return harness.spawns[0].args;
}

const guardArgs = (args: string[]) => args.filter((a) => a.startsWith("--setenv=TC_FRACTAL_GUARD"));

describe("the worker's spawn and the Fractal guard", () => {
  it("arms the guard on a background Fractal's worker, enforcing by default", async () => {
    const args = await spawnArgs({ openclawSessionKey: "agent:main:fractal:run-1" });
    expect(args).toContain("--setenv=TC_FRACTAL_GUARD=enforce");
    expect(args.some((a) => /^--setenv=TC_FRACTAL_GUARD_SINCE=\d+$/.test(a))).toBe(true);
    expect(args).toContain("--setenv=TC_SESSION_KEY=agent:main:fractal:run-1");
  });

  it("passes watch through, and adds nothing when the guard is off", async () => {
    expect(
      guardArgs(
        await spawnArgs({ openclawSessionKey: "agent:main:fractal:run-1", fractalGuard: "watch" }),
      ),
    ).toContain("--setenv=TC_FRACTAL_GUARD=watch");
    expect(
      guardArgs(
        await spawnArgs({ openclawSessionKey: "agent:main:fractal:run-1", fractalGuard: "off" }),
      ),
    ).toEqual([]);
  });

  it("leaves a chat worker's spawn without the guard", async () => {
    expect(guardArgs(await spawnArgs({ openclawSessionKey: "agent:main:main" }))).toEqual([]);
    expect(guardArgs(await spawnArgs({ openclawSessionKey: "agent:main:tinker:abc" }))).toEqual([]);
    expect(guardArgs(await spawnArgs({}))).toEqual([]);
  });
});
