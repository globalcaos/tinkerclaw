import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adoptLeftoverWorkers,
  createBridgeDrainParticipant,
  markReattachClaimed,
  resumedTurnFields,
} from "./restart-reattach.js";
import { createClaudeCodeStreamFn } from "./stream.js";
import { getPool, SessionWorkerPool } from "./worker-pool.js";
import {
  prepareWorkerDir,
  readWorkerMeta,
  type UnitCommand,
  type WorkerMeta,
  workersRoot,
  writeWorkerMeta,
} from "./worker-transport.js";
import type { ClaudeCodeWorker, WorkerEvent, WorkerTurnMetaWithRun } from "./worker.js";

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Reattach = { pending: Map<string, { unit: string; state: string }>; ready?: Promise<void> };
function reattachRegistry(): Reattach {
  return (globalThis as Record<symbol, Reattach>)[Symbol.for("openclaw.bridgeReattach")];
}

/** A fake `systemctl --user`: unit states by name, every call recorded. */
function fakeSystemctl(states: Record<string, { active: boolean; frozen?: boolean }>) {
  const calls: string[][] = [];
  const run: UnitCommand = async (args) => {
    calls.push(args);
    if (args[0] === "show") {
      const s = states[args[args.length - 1]] ?? { active: false };
      return {
        ok: true,
        stdout: `ActiveState=${s.active ? "active" : "inactive"}\nFreezerState=${s.frozen ? "frozen" : "running"}\n`,
      };
    }
    return { ok: true, stdout: "" };
  };
  return { calls, run };
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const MESSAGE_START = line({
  type: "stream_event",
  event: { type: "message_start", message: { id: "m1" } },
});
const MESSAGE_STOP_TOOL = line({
  type: "stream_event",
  event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
});
const RESULT = line({ type: "result", subtype: "success", is_error: false, result: "done" });

function meta(unit: string, over: Partial<WorkerMeta> = {}): WorkerMeta {
  return {
    version: 1,
    unit,
    sessionKey: `tinker-sp-${unit.slice(-2)}`,
    openclawSessionKey: `agent:main:tinker:${unit.slice(-2)}`,
    cwd: "/",
    createdAt: 1,
    turn: null,
    ...over,
  };
}

function leftover(unit: string, over: Partial<WorkerMeta> = {}, out = ""): string {
  const dir = prepareWorkerDir(unit);
  writeWorkerMeta(dir, meta(unit, over));
  if (out) {
    fs.appendFileSync(path.join(dir, "out"), out);
  }
  return dir;
}

let runtimeDir: string;
let previousRuntime: string | undefined;
let pool: SessionWorkerPool;

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-reattach-"));
  previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  reattachRegistry()?.pending.clear();
  pool = new SessionWorkerPool();
});

afterEach(() => {
  pool.killAll(); // detaches the adopted units (file transport): nothing is killed
  if (previousRuntime === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = previousRuntime;
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

describe("cc-bridge restart reattach", () => {
  it("adopts live workers, lists a turn in flight for recovery, and clears the dead", async () => {
    leftover("tinkerclaw-worker-aa");
    leftover("tinkerclaw-worker-bb", { turn: { startOffset: 0, startedAt: 1 } });
    const dead = leftover("tinkerclaw-worker-cc");
    const { run } = fakeSystemctl({
      "tinkerclaw-worker-aa": { active: true },
      "tinkerclaw-worker-bb": { active: true, frozen: true },
    });

    const report = await adoptLeftoverWorkers(pool, { run });

    expect(report).toEqual({ adopted: 2, pendingTurns: 1, removed: 1 });
    expect(fs.existsSync(dead)).toBe(false);
    expect(pool.get("tinker-sp-aa")?.hasPendingTurn()).toBe(false);
    expect(pool.get("tinker-sp-bb")?.hasPendingTurn()).toBe(true);
    expect(pool.get("tinker-sp-bb")?.isBusy()).toBe(true); // never evicted while it waits
    expect(reattachRegistry().pending.get("agent:main:tinker:bb")).toEqual({
      unit: "tinkerclaw-worker-bb",
      state: "pending",
    });
    markReattachClaimed("agent:main:tinker:bb");
    expect(reattachRegistry().pending.get("agent:main:tinker:bb")?.state).toBe("claimed");
  });

  it("replays a frozen turn from its start, thaws it, and settles on its result", async () => {
    leftover(
      "tinkerclaw-worker-dd",
      { turn: { startOffset: 0, startedAt: 1 }, frozenAt: 5 },
      MESSAGE_START + MESSAGE_STOP_TOOL,
    );
    const { calls, run } = fakeSystemctl({
      "tinkerclaw-worker-dd": { active: true, frozen: true },
    });
    await adoptLeftoverWorkers(pool, { run });
    const worker = pool.get("tinker-sp-dd") as ClaudeCodeWorker;

    const seen: string[] = [];
    worker.on("stream_line", (e: WorkerEvent) => {
      if (e.type === "stream_line") {
        const l = e.line as { type: string; event?: { type: string } };
        seen.push(l.event?.type ?? l.type);
      }
    });
    const result = worker.resumeTurn();
    // the unit goes on after the thaw: its next output arrives as it would have
    fs.appendFileSync(
      path.join(runtimeDir, "tinkerclaw-workers", "tinkerclaw-worker-dd", "out"),
      RESULT,
    );
    await expect(result).resolves.toMatchObject({ type: "result", result: "done" });
    expect(seen).toEqual(["message_start", "message_delta", "result"]);
    expect(calls.some((c) => c[0] === "thaw" && c[1] === "tinkerclaw-worker-dd")).toBe(true);
    expect(worker.hasPendingTurn()).toBe(false);
  });

  it("holds a live turn at the end of the API call that is streaming, then releases it", async () => {
    const dir = leftover("tinkerclaw-worker-ee");
    const { calls, run } = fakeSystemctl({ "tinkerclaw-worker-ee": { active: true } });
    await adoptLeftoverWorkers(pool, { run });
    const worker = pool.get("tinker-sp-ee") as ClaudeCodeWorker;
    const out = path.join(dir, "out");

    const turn = worker.send({ userText: "go" });
    await waitFor(() => worker.isBusy());
    fs.appendFileSync(out, MESSAGE_START);
    // the call is streaming: the drain waits for its end instead of cutting it
    await new Promise((r) => setTimeout(r, 400));
    const drain = createBridgeDrainParticipant(() => pool).drain(3000);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c[0] === "freeze")).toBe(false);
    fs.appendFileSync(out, MESSAGE_STOP_TOOL);
    await expect(drain).resolves.toEqual({
      held: ["agent:main:tinker:ee"],
      ended: [],
      unfinished: [],
    });
    expect(calls.some((c) => c[0] === "freeze" && c[1] === "tinkerclaw-worker-ee")).toBe(true);

    await createBridgeDrainParticipant(() => pool).release();
    expect(calls.some((c) => c[0] === "thaw")).toBe(true);
    fs.appendFileSync(out, RESULT);
    await expect(turn).resolves.toMatchObject({ type: "result" });
  });

  it("stops a leftover whose session already has a live worker, rather than run two claudes", async () => {
    const dir = leftover("tinkerclaw-worker-gg", { turn: { startOffset: 0, startedAt: 1 } });
    const { calls, run } = fakeSystemctl({
      "tinkerclaw-worker-gg": { active: true, frozen: true },
    });
    const live = {
      sessionKey: "tinker-sp-gg",
      sessionId: null,
      isAlive: () => true,
      isBusy: () => true,
      kill: () => undefined,
      on: () => undefined,
    };
    pool.adopt(live, {});

    const report = await adoptLeftoverWorkers(pool, { run });

    expect(report).toEqual({ adopted: 0, pendingTurns: 0, removed: 1 });
    expect(pool.get("tinker-sp-gg")).toBe(live);
    expect(calls.filter((c) => c[0] !== "show").map((c) => c[0])).toEqual(["thaw", "stop"]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(reattachRegistry()?.pending.has("agent:main:tinker:gg")).toBeFalsy();
  });

  it("also stops a leftover whose session is live under another pool key (the prompt hash moved)", async () => {
    leftover("tinkerclaw-worker-hh", { turn: { startOffset: 0, startedAt: 1 } });
    const { calls, run } = fakeSystemctl({
      "tinkerclaw-worker-hh": { active: true, frozen: true },
    });
    const live = {
      sessionKey: "tinker-sp-other-hash",
      openclawSessionKey: "agent:main:tinker:hh",
      sessionId: null,
      isAlive: () => true,
      isBusy: () => true,
      kill: () => undefined,
      on: () => undefined,
    };
    pool.adopt(live, {});

    const report = await adoptLeftoverWorkers(pool, { run });

    expect(report.removed).toBe(1);
    expect(calls.some((c) => c[0] === "stop")).toBe(true);
    expect(pool.get("tinker-sp-hh")).toBeUndefined();
  });

  it("keeps the worker holding the frozen turn when its session also left an idle duplicate", async () => {
    // directory order puts the idle one first (live 2026-09-30 05:50: the turn's worker was stopped)
    const idle = leftover("tinkerclaw-worker-a1", { openclawSessionKey: "agent:main:tinker:same" });
    leftover("tinkerclaw-worker-z9", {
      openclawSessionKey: "agent:main:tinker:same",
      turn: { startOffset: 0, startedAt: 1 },
    });
    const { calls, run } = fakeSystemctl({
      "tinkerclaw-worker-a1": { active: true },
      "tinkerclaw-worker-z9": { active: true, frozen: true },
    });

    const report = await adoptLeftoverWorkers(pool, { run });

    expect(report).toMatchObject({ adopted: 1, pendingTurns: 1, removed: 1 });
    expect(pool.get("tinker-sp-z9")?.hasPendingTurn()).toBe(true);
    expect(calls.some((c) => c[0] === "stop" && c.includes("tinkerclaw-worker-a1"))).toBe(true);
    expect(fs.existsSync(idle)).toBe(false);
    expect(reattachRegistry().pending.get("agent:main:tinker:same")?.unit).toBe(
      "tinkerclaw-worker-z9",
    );
  });

  it("scans once per process, on first need, whoever asks", async () => {
    leftover("tinkerclaw-worker-ii");
    const scan = await import("./restart-reattach.js");
    let scans = 0;
    const counting = () => {
      scans += 1;
      return pool;
    };
    scan.armAdoptionScan(counting);
    const registry = (globalThis as Record<symbol, { scan?: () => Promise<unknown> }>)[
      Symbol.for("openclaw.bridgeReattach")
    ];
    expect(typeof registry.scan).toBe("function");
    await Promise.all([scan.ensureAdoptionScan(), registry.scan?.(), scan.ensureAdoptionScan()]);
    expect(scans).toBe(1);
  });

  it("leaves a dir it cannot read yet alone: it may be a spawn of this very process", async () => {
    const young = path.join(workersRoot(), "tinkerclaw-worker-ff");
    fs.mkdirSync(young, { recursive: true });
    const { run } = fakeSystemctl({});
    await adoptLeftoverWorkers(pool, { run });
    expect(fs.existsSync(young)).toBe(true);
  });

  // FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [chat-divergence], cause 4): the run that
  // takes a frozen turn has a NEW id and the worker replays the turn from its first byte. Unless that
  // run names the turn, the webchat cannot tie the replay to the prompt it already shows, and a
  // history fill writes the turn's rows a second time (tinker-ui live-continuation.ts ResumedTurn).

  it("records the run a turn belongs to in meta.json, beside the turn's start", async () => {
    const dir = leftover("tinkerclaw-worker-jj");
    const { run } = fakeSystemctl({ "tinkerclaw-worker-jj": { active: true } });
    await adoptLeftoverWorkers(pool, { run });
    const worker = pool.get("tinker-sp-jj") as ClaudeCodeWorker;

    const turn = worker.send({ userText: "go", runId: "run-before-restart" });
    await waitFor(() => readWorkerMeta(dir)?.turn != null);
    expect(readWorkerMeta(dir)?.turn).toMatchObject({
      startOffset: 0,
      runId: "run-before-restart",
    });

    fs.appendFileSync(path.join(dir, "out"), RESULT);
    await expect(turn).resolves.toMatchObject({ type: "result" });
    expect(readWorkerMeta(dir)?.turn).toBeNull();
  });

  it("an adopted turn names its run and its start; one an older gateway left names its start", async () => {
    const recorded: WorkerTurnMetaWithRun = {
      startOffset: 0,
      startedAt: 1_234,
      runId: "run-frozen",
    };
    leftover("tinkerclaw-worker-ll", { turn: recorded });
    leftover("tinkerclaw-worker-mm", { turn: { startOffset: 0, startedAt: 5_678 } });
    const { run } = fakeSystemctl({
      "tinkerclaw-worker-ll": { active: true, frozen: true },
      "tinkerclaw-worker-mm": { active: true, frozen: true },
    });
    await adoptLeftoverWorkers(pool, { run });

    const named = pool.get("tinker-sp-ll") as ClaudeCodeWorker;
    expect(named.frozenTurn()).toEqual({ runId: "run-frozen", startedAt: 1_234 });
    expect(resumedTurnFields(named.frozenTurn())).toEqual({
      resumesRunId: "run-frozen",
      resumesTurnStartedAt: 1_234,
    });
    const older = pool.get("tinker-sp-mm") as ClaudeCodeWorker;
    expect(resumedTurnFields(older.frozenTurn())).toEqual({ resumesTurnStartedAt: 5_678 });
    // No frozen turn, nothing to name: every other run's events are unchanged.
    expect(resumedTurnFields(null)).toEqual({});
    expect(resumedTurnFields({ runId: "", startedAt: Number.NaN })).toEqual({});
  });

  it("the run that takes a frozen turn names it on its lifecycle start and on its later events", async () => {
    const recorded: WorkerTurnMetaWithRun = {
      startOffset: 0,
      startedAt: 1_234,
      runId: "run-frozen",
    };
    leftover(
      "tinkerclaw-worker-nn",
      { turn: recorded, model: "claude-opus-5" },
      MESSAGE_START + RESULT,
    );
    const { run } = fakeSystemctl({ "tinkerclaw-worker-nn": { active: true, frozen: true } });
    const shared = getPool();
    await adoptLeftoverWorkers(shared, { run });

    const starts: Array<Record<string, unknown>> = [];
    const efforts: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId !== "run-after-restart") {
        return;
      }
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        starts.push(event.data);
      } else if (event.stream === "effort") {
        efforts.push(event.data);
      }
    });
    try {
      const stream = await createClaudeCodeStreamFn()(
        { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5" } as never,
        {
          systemPrompt: "reattach naming test",
          messages: [{ role: "user", content: "hi" }],
        } as never,
        {
          __openclawRunId: "run-after-restart",
          __openclawSessionKey: "agent:main:tinker:nn",
          // boot recovery's promptless continue (attempt.ts continueFromTranscript)
          __openclawContinuation: { fallbackText: "resume" },
        } as never,
      );
      await stream.result();
    } finally {
      unsubscribe();
      shared.killAll();
    }
    const named = { resumesRunId: "run-frozen", resumesTurnStartedAt: 1_234 };
    expect(starts).toEqual([expect.objectContaining(named)]);
    // ...and on the run's later events, for a page that reconnected after the start.
    expect(efforts.length).toBeGreaterThan(0);
    for (const data of efforts) {
      expect(data).toMatchObject(named);
    }
  });

  it("CONTROL: a run that takes no frozen turn names none, and records its own run with its turn", async () => {
    const dir = leftover("tinkerclaw-worker-oo", { model: "claude-opus-5" });
    const { run } = fakeSystemctl({ "tinkerclaw-worker-oo": { active: true } });
    const shared = getPool();
    await adoptLeftoverWorkers(shared, { run });

    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-ordinary" &&
        (event.stream === "lifecycle" || event.stream === "effort")
      ) {
        seen.push(event.data);
      }
    });
    try {
      const stream = await createClaudeCodeStreamFn()(
        { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5" } as never,
        {
          systemPrompt: "reattach naming control",
          messages: [{ role: "user", content: "hi" }],
        } as never,
        { __openclawRunId: "run-ordinary", __openclawSessionKey: "agent:main:tinker:oo" } as never,
      );
      await waitFor(
        () =>
          (readWorkerMeta(dir)?.turn as WorkerTurnMetaWithRun | null | undefined)?.runId ===
          "run-ordinary",
      );
      fs.appendFileSync(path.join(dir, "out"), RESULT);
      await stream.result();
    } finally {
      unsubscribe();
      shared.killAll();
    }
    expect(seen.filter((data) => data.phase === "start")).toHaveLength(1);
    for (const data of seen) {
      expect(data).not.toHaveProperty("resumesRunId");
      expect(data).not.toHaveProperty("resumesTurnStartedAt");
    }
  });
});
