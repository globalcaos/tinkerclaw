import type { EventEmitter } from "node:events";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-09 (effort per turn). On an adaptive-effort model (Claude 5.x, Fable, Opus 4.7+) a
// MAX_THINKING_TOKENS budget swaps the effort for a legacy fixed budget, and the effort the CLI then
// runs comes from the host's settings whatever the slider says (measured on claude CLI 2.1.295).
// The worker now leaves the budget out on those models and applies each turn's level as an effort
// on the live process: an `apply_flag_settings` control request written BEFORE the turn's prompt,
// whose `control_response` is the worker's own and never reaches the stream. The subprocess is a
// stand-in (node:child_process.spawn is mocked) and the prompt loaders are stubbed, as in
// worker.lifecycle-events.test.ts.
//
// CONTROL. Before this change every test here fails: the spawn carried MAX_THINKING_TOKENS and the
// first line on stdin was the prompt.

type FakeStream = EventEmitter & { writes: string[] };
type FakeChild = EventEmitter & {
  pid: number | undefined;
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
};

const harness = vi.hoisted(() => ({
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
        pid: 4242,
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

import { THALAMUS_ENV_ALLOWLIST, THALAMUS_WORKER_SLOT } from "./thalamus-worker-seam.js";
import {
  ClaudeCodeWorker,
  EFFORT_CONTROL_TIMEOUT_MS,
  effortToApply,
  type WorkerEvent,
} from "./worker.js";

type SentLine = {
  type: string;
  request_id?: string;
  request?: { subtype?: string; settings?: unknown };
  message?: { content?: unknown };
};

const RESULT = {
  type: "result",
  subtype: "success",
  session_id: "s",
  is_error: false,
  num_turns: 1,
  result: "ok",
};

beforeEach(() => {
  harness.spawns.length = 0;
  harness.children.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Every line the worker wrote to the child's stdin, parsed. */
const sent = (child: FakeChild): SentLine[] =>
  child.stdin.writes.map((w) => JSON.parse(w) as SentLine);
const lastSent = (child: FakeChild): SentLine | undefined => sent(child).at(-1);
const emit = (child: FakeChild, line: object): void => {
  child.stdout.emit("data", `${JSON.stringify(line)}\n`);
};
/** The CLI's answer to one control request, nested as CLI 2.1.295 prints it. */
const answer = (child: FakeChild, requestId: string | undefined, response: object = {}): void => {
  emit(child, {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
};
/** Let the worker's promise chain run. setImmediate stays real under the fake timers used below. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

function adaptiveWorker(): { worker: ClaudeCodeWorker; seen: unknown[] } {
  const worker = new ClaudeCodeWorker({
    sessionKey: "tinker-sp-effort",
    cwd: os.tmpdir(),
    model: "claude-opus-5-5",
  });
  const seen: unknown[] = [];
  worker.on("stream_line", (e: WorkerEvent) => {
    if (e.type === "stream_line") {
      seen.push(e.line);
    }
  });
  return { worker, seen };
}

describe("the turn's effort on an adaptive-effort worker", () => {
  it("is applied before the prompt, awaited, and its answer never reaches the stream", async () => {
    const { worker, seen } = adaptiveWorker();
    const turn = worker.send({ userText: "hello", thinkLevel: "low", thinkSource: "thalamus" });
    await settle();
    const child = harness.children[0];
    expect(sent(child)).toHaveLength(1);
    const [apply] = sent(child);
    expect(apply).toMatchObject({
      type: "control_request",
      request: {
        subtype: "apply_flag_settings",
        settings: { effortLevel: "low", ultracode: false },
      },
    });
    // No answer yet: the prompt waits.
    await settle();
    expect(sent(child).some((l) => l.type === "user")).toBe(false);

    answer(child, apply.request_id);
    await settle();
    const lines = sent(child);
    const userAt = lines.findIndex((l) => l.type === "user");
    expect(userAt).toBeGreaterThan(0);
    // The read-back goes out ahead of the prompt as well, and does not hold it.
    const verifyAt = lines.findIndex((l) => l.request?.subtype === "get_settings");
    expect(verifyAt).toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(userAt);
    answer(child, lines[verifyAt].request_id, { applied: { effort: "low", ultracode: false } });

    emit(child, RESULT);
    await expect(turn).resolves.toMatchObject({ result: "ok" });
    expect(seen).toEqual([RESULT]);
  });

  it("asks for ultracode at max effort when the turn names no level", async () => {
    const { worker } = adaptiveWorker();
    const turn = worker.send({ userText: "rewrite the scheduler", ultracode: true });
    await settle();
    const child = harness.children[0];
    const [apply] = sent(child);
    expect(apply.request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: "max", ultracode: true },
    });
    answer(child, apply.request_id);
    await settle();
    expect(lastSent(child)?.type).toBe("user");
    emit(child, RESULT);
    await turn;
  });

  it("sends nothing when the process already runs the turn's effort, and applies again on a change", async () => {
    const { worker } = adaptiveWorker();
    const first = worker.send({ userText: "one", thinkLevel: "high" });
    await settle();
    const child = harness.children[0];
    answer(child, sent(child)[0].request_id);
    await settle();
    emit(child, RESULT);
    await first;

    // Same effort: the prompt is written in the same tick, nothing ahead of it.
    let before = child.stdin.writes.length;
    const second = worker.send({ userText: "two", thinkLevel: "high" });
    expect(
      sent(child)
        .slice(before)
        .map((l) => l.type),
    ).toEqual(["user"]);
    emit(child, RESULT);
    await second;

    // A new level: applied again before its prompt.
    before = child.stdin.writes.length;
    const third = worker.send({ userText: "three", thinkLevel: "medium" });
    await settle();
    expect(
      sent(child)
        .slice(before)
        .map((l) => l.request),
    ).toEqual([
      { subtype: "apply_flag_settings", settings: { effortLevel: "medium", ultracode: false } },
    ]);
    answer(child, sent(child)[before].request_id);
    await settle();
    expect(lastSent(child)?.type).toBe("user");
    emit(child, RESULT);
    await third;

    // No level any more: the effort goes back to the host's own.
    before = child.stdin.writes.length;
    const fourth = worker.send({ userText: "four" });
    await settle();
    expect(sent(child)[before]?.request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: null, ultracode: false },
    });
    answer(child, sent(child)[before].request_id);
    await settle();
    expect(lastSent(child)?.type).toBe("user");
    emit(child, RESULT);
    await fourth;
  });

  it("writes the prompt anyway when the CLI does not answer in time, and sends again next turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { worker, seen } = adaptiveWorker();
    const turn = worker.send({ userText: "hello", thinkLevel: "xhigh" });
    await settle();
    const child = harness.children[0];
    const [apply] = sent(child);
    expect(apply.request?.subtype).toBe("apply_flag_settings");
    await vi.advanceTimersByTimeAsync(EFFORT_CONTROL_TIMEOUT_MS - 1);
    await settle();
    expect(lastSent(child)?.type).toBe("control_request");
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(lastSent(child)?.type).toBe("user");
    // Nothing was confirmed, so nothing is read back.
    expect(sent(child).some((l) => l.request?.subtype === "get_settings")).toBe(false);
    // The late answer is nobody's: dropped, never streamed.
    answer(child, apply.request_id);
    emit(child, RESULT);
    await expect(turn).resolves.toMatchObject({ result: "ok" });
    expect(seen).toEqual([RESULT]);

    // Unconfirmed: the next turn sends again, even for the same level.
    const before = child.stdin.writes.length;
    const again = worker.send({ userText: "again", thinkLevel: "xhigh" });
    await settle();
    expect(sent(child)[before]?.request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: "xhigh", ultracode: false },
    });
    answer(child, sent(child)[before].request_id);
    await settle();
    expect(lastSent(child)?.type).toBe("user");
    emit(child, RESULT);
    await again;
  });

  it("keeps a prompt steered in during the wait behind the turn's own prompt", async () => {
    const { worker } = adaptiveWorker();
    const turn = worker.send({ userText: "first", thinkLevel: "high" });
    await settle();
    const child = harness.children[0];
    expect(worker.steer("and also this")).toBe(true);
    expect(sent(child).map((l) => l.type)).toEqual(["control_request"]);
    answer(child, sent(child)[0].request_id);
    await settle();
    const prompts = sent(child)
      .filter((l) => l.type === "user")
      .map((l) => l.message?.content);
    expect(prompts).toEqual(["first", "and also this"]);
    emit(child, RESULT);
    await turn;
  });

  it("CONTROL: an older model gets no control request; its prompt goes first", async () => {
    const worker = new ClaudeCodeWorker({
      sessionKey: "tinker-sp-older",
      cwd: os.tmpdir(),
      model: "claude-sonnet-4-6",
    });
    const turn = worker.send({ userText: "hello", thinkLevel: "high", ultracode: true });
    await settle();
    const child = harness.children[0];
    expect(sent(child).map((l) => l.type)).toEqual(["user"]);
    emit(child, RESULT);
    await turn;
  });
});

describe("the spawn environment", () => {
  const SLOT = Symbol.for(THALAMUS_WORKER_SLOT);
  const allowlist = THALAMUS_ENV_ALLOWLIST as string[];
  let hostBudget: string | undefined;

  beforeEach(() => {
    hostBudget = process.env.MAX_THINKING_TOKENS;
    // A host-level budget, which the env allowlist copies, and a Thalamus provider offering the
    // effort pin through the one route that could carry it onto a worker.
    process.env.MAX_THINKING_TOKENS = "31999";
    allowlist.push("CLAUDE_CODE_EFFORT_LEVEL");
    (globalThis as Record<symbol, unknown>)[SLOT] = {
      spawnExtras: () => ({ env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } }),
    };
  });

  afterEach(() => {
    if (hostBudget === undefined) {
      delete process.env.MAX_THINKING_TOKENS;
    } else {
      process.env.MAX_THINKING_TOKENS = hostBudget;
    }
    allowlist.length = 0;
    delete (globalThis as Record<symbol, unknown>)[SLOT];
  });

  const setenv = (args: string[], name: string): string[] =>
    args.filter((a) => a.startsWith(`--setenv=${name}=`));

  it("gives a claude-opus-5-5 child neither MAX_THINKING_TOKENS nor CLAUDE_CODE_EFFORT_LEVEL", async () => {
    await new ClaudeCodeWorker({
      sessionKey: "tinker-sp-env",
      cwd: os.tmpdir(),
      model: "claude-opus-5-5",
      thinkLevel: "high",
    }).start();
    const args = harness.spawns[0]?.args ?? [];
    expect(args).toContain("--model");
    expect(setenv(args, "MAX_THINKING_TOKENS")).toEqual([]);
    expect(setenv(args, "CLAUDE_CODE_EFFORT_LEVEL")).toEqual([]);
  });

  it("CONTROL: an older model keeps the budget of its spawn level, and still never the effort pin", async () => {
    await new ClaudeCodeWorker({
      sessionKey: "tinker-sp-env-older",
      cwd: os.tmpdir(),
      model: "claude-sonnet-4-6",
      thinkLevel: "high",
    }).start();
    const args = harness.spawns[0]?.args ?? [];
    expect(setenv(args, "MAX_THINKING_TOKENS")).toEqual(["--setenv=MAX_THINKING_TOKENS=16000"]);
    expect(setenv(args, "CLAUDE_CODE_EFFORT_LEVEL")).toEqual([]);
  });
});

describe("effortToApply", () => {
  it("asks for what the turn names", () => {
    expect(effortToApply({ thinkLevel: "minimal" }, "none")).toEqual({
      effortLevel: "low",
      ultracode: false,
    });
    expect(effortToApply({ ultracode: true }, "none")).toEqual({
      effortLevel: "max",
      ultracode: true,
    });
    expect(effortToApply({ thinkLevel: "high", ultracode: true }, "none")).toEqual({
      effortLevel: "high",
      ultracode: true,
    });
  });

  it("sends nothing for a turn that names nothing on a process where nothing was applied", () => {
    expect(effortToApply({}, "none")).toBeNull();
    expect(effortToApply({ thinkLevel: "off" }, "none")).toBeNull();
  });

  it("hands the effort back to the host once something was, or may have been, applied", () => {
    expect(effortToApply({}, { effortLevel: "low", ultracode: false })).toEqual({
      effortLevel: null,
      ultracode: false,
    });
    expect(effortToApply({}, "unknown")).toEqual({ effortLevel: null, ultracode: false });
    expect(effortToApply({}, { effortLevel: null, ultracode: false })).toBeNull();
  });

  it("sends nothing when the process already runs exactly that, both keys compared", () => {
    expect(
      effortToApply({ thinkLevel: "high" }, { effortLevel: "high", ultracode: false }),
    ).toBeNull();
    expect(effortToApply({ thinkLevel: "high" }, { effortLevel: "high", ultracode: true })).toEqual(
      {
        effortLevel: "high",
        ultracode: false,
      },
    );
    expect(effortToApply({ thinkLevel: "high" }, "unknown")).toEqual({
      effortLevel: "high",
      ultracode: false,
    });
  });
});
