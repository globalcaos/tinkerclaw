import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-09-30 (THALAMUS v4, design unit D5). Every main chat runs through this worker, so the proof that matters
// is the negative one: with no provider registered, or one that offers nothing usable, the argument list handed to
// systemd-run is the one the worker builds today. The positive cases show what a provider can add.

type FakeStream = EventEmitter & { writes: string[] };
type FakeChild = EventEmitter & {
  pid: number | undefined;
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
};

const harness = vi.hoisted(() => ({
  childPid: 4242 as number | undefined,
  spawns: [] as Array<{ file: string; args: string[] }>,
  children: [] as FakeChild[],
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
  harness.childPid = 4242;
  harness.spawns.length = 0;
  harness.children.length = 0;
});

import {
  THALAMUS_ENV_ALLOWLIST,
  THALAMUS_WORKER_SLOT,
  thalamusSpawnExtras,
} from "./thalamus-worker-seam.js";

const SLOT = Symbol.for(THALAMUS_WORKER_SLOT);
const setProvider = (p: unknown) => {
  (globalThis as Record<symbol, unknown>)[SLOT] = p;
};

beforeEach(() => {
  harness.childPid = 4242;
  harness.spawns.length = 0;
  harness.children.length = 0;
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

// The unit name and the worker dir carry a counter and a random suffix; everything else must match exactly.
const normalise = (args: string[]): string[] =>
  args.map((a) => a.replace(/tinkerclaw-worker-\d+-[0-9a-z]+-[0-9a-z]+/g, "<unit>"));

async function spawnArgs(model?: string): Promise<string[]> {
  harness.spawns.length = 0;
  const worker = new ClaudeCodeWorker({ sessionKey: "tinker-sp-fixture", cwd: os.tmpdir(), model });
  await worker.start();
  return normalise(harness.spawns[0]!.args);
}

describe("the worker's spawn with a THALAMUS worker provider", () => {
  it("is byte-for-byte today's argument list with no provider, and with a provider that offers nothing usable", async () => {
    const baseline = await spawnArgs("claude-opus-5");
    expect(baseline).toContain("--model");
    expect(baseline).not.toContain("--agents");

    for (const p of [
      {},
      { spawnExtras: () => undefined },
      { spawnExtras: () => ({}) },
      { spawnExtras: () => ({ agentsJson: "not json", env: { "bad key": "x", OK: 1 } }) },
      { spawnExtras: () => ({ agentsJson: "[1,2]" }) },
      {
        spawnExtras: () => {
          throw new Error("provider broke");
        },
      },
      "a string, not a provider",
    ]) {
      setProvider(p);
      expect(await spawnArgs("claude-opus-5")).toEqual(baseline);
    }
  });

  it("adds --agents after --model, the extra environment, and the per-spawn model when a provider offers them", async () => {
    const agents = JSON.stringify({ scout: { description: "reads files", model: "haiku" } });
    setProvider({
      spawnExtras: () => ({
        agentsJson: agents,
        env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
        model: "claude-sonnet-5-5",
      }),
    });
    const args = await spawnArgs("claude-opus-5");
    const i = args.indexOf("--model");
    expect(args[i + 1]).toBe("claude-sonnet-5-5");
    expect(args).not.toContain("claude-opus-5");
    expect(args[i + 2]).toBe("--agents");
    expect(args[i + 3]).toBe(agents);
    // The allowlist is empty, so the environment the provider offered is dropped.
    expect(args.some((a) => a.includes("CLAUDE_CODE_SUBAGENT_MODEL"))).toBe(false);
  });

  it("changes nothing in the spawn when a provider offers the session key, a credential or the API base URL", async () => {
    const baseline = await spawnArgs("claude-opus-5");
    setProvider({
      spawnExtras: () => ({
        env: {
          TC_SESSION_KEY: "agent:main:main",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
          ANTHROPIC_API_KEY: "sk-x",
          CLAUDE_CODE_OAUTH_TOKEN: "tok",
        },
      }),
    });
    expect(await spawnArgs("claude-opus-5")).toEqual(baseline);
  });

  it("passes an allowlisted name, and never overwrites a variable the bridge already set", async () => {
    THALAMUS_ENV_ALLOWLIST.push("THALAMUS_TEST_FLAG", "TC_SESSION_KEY");
    try {
      setProvider({
        spawnExtras: () => ({ env: { THALAMUS_TEST_FLAG: "1", TC_SESSION_KEY: "hijacked" } }),
      });
      const args = await spawnArgs("claude-opus-5");
      expect(args).toContain("--setenv=THALAMUS_TEST_FLAG=1");
      expect(args.some((a) => a.includes("hijacked"))).toBe(false);
      expect(args.some((a) => a.startsWith("--setenv=TC_SESSION_KEY="))).toBe(true);
    } finally {
      THALAMUS_ENV_ALLOWLIST.length = 0;
    }
  });
});

describe("thalamusSpawnExtras", () => {
  it("passes the provider the session key and the model the worker would use today", () => {
    const spawnExtras = vi.fn(() => undefined);
    setProvider({ spawnExtras });
    thalamusSpawnExtras({ sessionKey: "s", model: "m" });
    expect(spawnExtras).toHaveBeenCalledWith({ sessionKey: "s", model: "m" });
  });
  it("keeps only allowlisted names with string values; the default allowlist is empty", () => {
    setProvider({ spawnExtras: () => ({ env: { A_B: "1", lower: "2", C: 3 } }) });
    expect(THALAMUS_ENV_ALLOWLIST).toEqual([]);
    expect(thalamusSpawnExtras({ sessionKey: "s" }).env).toEqual({});
    THALAMUS_ENV_ALLOWLIST.push("A_B", "C");
    try {
      expect(thalamusSpawnExtras({ sessionKey: "s" }).env).toEqual({ A_B: "1" });
    } finally {
      THALAMUS_ENV_ALLOWLIST.length = 0;
    }
  });
});

describe("the slot key", () => {
  it("equals the registry's in core, so a provider registered there is the one read here", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const core = fs.readFileSync(
      path.resolve(here, "../../../src/infra/thalamus-call-router.ts"),
      "utf8",
    );
    expect(core).toContain(`WORKER_PROVIDER_SLOT = "${THALAMUS_WORKER_SLOT}"`);
  });
});
