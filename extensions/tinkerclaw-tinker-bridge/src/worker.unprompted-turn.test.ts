import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUnpromptedWakeMessage,
  parseUnpromptedWakeMarker,
  setUnpromptedWakeSender,
  type UnpromptedWakeRequest,
} from "./unprompted-turn.js";
import { ClaudeCodeWorker, UNPROMPTED_KEEP_MS } from "./worker.js";
import type { WorkerSpawnParams } from "./worker.js";

// FORK 2026-10-01 — bug-log [monitor-notify-idle-session-lost]. When a background task or a
// Monitor fires while no turn is open, claude CLI 2.1.286 starts a turn ON ITS OWN: it prints
// `task_notification` (a Monitor event skips it), a fresh `init`, the answer and its own `result`.
// Measured live 2026-10-01 20:05 (/tmp/bgwake-repro): `sleep 6` in the background, turn ended with
// "started", and 4.6 s later init → "WOKE" → result with nobody prompting. The worker read those
// lines with no turn open and no listener, so the whole turn was thrown away: it never reached
// the chat, and a worker waiting for its job could not end its turn and be woken.
//
// The fixtures below are the shapes of that run, trimmed.
//
// CONTROL. Before this change every test here fails: the worker had no unpromptedTurn(), no
// takeUnpromptedTurn(), never asked for a wake, and called a worker with live background tasks idle.

const BG_STARTED = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [{ task_id: "bswfvo30f", task_type: "local_bash", description: "sleep 6; echo BGDONE" }],
};
const BG_NONE = { type: "system", subtype: "background_tasks_changed", tasks: [] };
const NOTICE = {
  type: "system",
  subtype: "task_notification",
  task_id: "bswfvo30f",
  status: "completed",
  output_file: "/tmp/x.output",
};
const INIT = { type: "system", subtype: "init", session_id: "s" };
const ASSISTANT = {
  type: "assistant",
  session_id: "s",
  message: { role: "assistant", content: [{ type: "text", text: "WOKE" }] },
};
const RESULT = {
  type: "result",
  subtype: "success",
  session_id: "s",
  is_error: false,
  num_turns: 1,
  duration_ms: 1400,
  result: "WOKE",
};

let wakes: UnpromptedWakeRequest[];

beforeEach(() => {
  wakes = [];
  setUnpromptedWakeSender(async (req) => {
    wakes.push(req);
  });
});

afterEach(() => {
  setUnpromptedWakeSender(null);
  vi.useRealTimers();
});

function idleWorker(): {
  w: ClaudeCodeWorker;
  feed: (...lines: object[]) => void;
  written: string[];
} {
  const w = new ClaudeCodeWorker({
    sessionKey: "tinker-sp-1",
    cwd: "/tmp",
    model: "claude-opus-5-5",
    openclawSessionKey: "agent:main:tinker:abc",
  } as WorkerSpawnParams);
  const written: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
  const wAny = w as any;
  wAny.running = true;
  wAny.proc = { stdin: { write: (s: string) => written.push(s) }, kill: () => true };
  const feed = (...lines: object[]) =>
    wAny.onStdoutChunk(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { w, feed, written };
}

function listen(w: ClaudeCodeWorker): unknown[] {
  const seen: unknown[] = [];
  w.on("stream_line", (evt: { line: unknown }) => seen.push(evt.line));
  return seen;
}

describe("a turn the CLI starts on its own", () => {
  it("keeps it, asks the owning chat for a wake, and hands it whole to the run that takes it", async () => {
    const { w, feed } = idleWorker();
    feed(BG_STARTED, BG_NONE, NOTICE, INIT, ASSISTANT, RESULT);

    const held = w.unpromptedTurn();
    expect(held).toMatchObject({ finished: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      sessionKey: "agent:main:tinker:abc",
      model: "claude-code/claude-opus-5-5",
    });
    expect(parseUnpromptedWakeMarker(wakes[0].message)).toBe(held?.id);
    expect(wakes[0].message).toContain("sleep 6; echo BGDONE");

    const seen = listen(w);
    const result = await w.takeUnpromptedTurn({ id: held?.id ?? "" });
    expect(result).toMatchObject({ result: "WOKE", num_turns: 1 });
    expect(seen).toEqual([INIT, ASSISTANT, RESULT]);
    expect(w.unpromptedTurn()).toBeNull();
  });

  it("lets a run take a turn still in progress and ends it on that turn's result", async () => {
    const { w, feed } = idleWorker();
    feed(INIT, ASSISTANT);
    const held = w.unpromptedTurn();
    expect(held).toMatchObject({ finished: false });

    const seen = listen(w);
    const taken = w.takeUnpromptedTurn({ id: held?.id ?? "" });
    expect(seen).toEqual([INIT, ASSISTANT]);
    feed(RESULT);
    await expect(taken).resolves.toMatchObject({ result: "WOKE" });
    expect(seen).toEqual([INIT, ASSISTANT, RESULT]);
  });

  it("does not start one on background bookkeeping lines alone", () => {
    const { w, feed } = idleWorker();
    feed(BG_STARTED, NOTICE, BG_NONE, { type: "rate_limit_event" });
    expect(w.unpromptedTurn()).toBeNull();
    expect(wakes).toHaveLength(0);
  });

  it("does not start one from the lines of a turn the bridge sent", async () => {
    const { w, feed, written } = idleWorker();
    const sent = w.send({ userText: "hi" });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    feed(INIT, ASSISTANT, RESULT);
    await expect(sent).resolves.toMatchObject({ result: "WOKE" });
    expect(w.unpromptedTurn()).toBeNull();
    expect(wakes).toHaveLength(0);
  });

  it("joins a prompt that arrives mid-way to the CLI's turn instead of losing either", async () => {
    const { w, feed, written } = idleWorker();
    feed(INIT, ASSISTANT);
    const seen = listen(w);
    const sent = w.send({ userText: "and now?" });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("and now?");
    expect(seen).toEqual([INIT, ASSISTANT]);
    feed(RESULT);
    await expect(sent).resolves.toMatchObject({ result: "WOKE" });
    expect(w.unpromptedTurn()).toBeNull();
  });

  it("refuses a take for another turn's id", async () => {
    const { w, feed } = idleWorker();
    feed(INIT, ASSISTANT, RESULT);
    await expect(w.takeUnpromptedTurn({ id: "bgt-other" })).rejects.toThrow(/no unprompted turn/);
    expect(w.unpromptedTurn()).not.toBeNull();
  });
});

describe("busy while the CLI still owns work", () => {
  it("counts live background tasks as busy, so the pool's sweep leaves the worker alone", () => {
    const { w, feed } = idleWorker();
    expect(w.isBusy()).toBe(false);
    feed(BG_STARTED);
    expect(w.isBusy()).toBe(true);
    feed(BG_NONE);
    expect(w.isBusy()).toBe(false);
  });

  it("stays busy while a finished turn waits for its run, and lets go after the keep window", () => {
    vi.useFakeTimers();
    const { w, feed } = idleWorker();
    feed(INIT, ASSISTANT, RESULT);
    expect(w.isBusy()).toBe(true);
    vi.advanceTimersByTime(UNPROMPTED_KEEP_MS + 1);
    expect(w.isBusy()).toBe(false);
  });

  it("forgets the background tasks and the held turn when the child exits", () => {
    const { w, feed } = idleWorker();
    feed(BG_STARTED, INIT, ASSISTANT);
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    (w as any).onExit(0, null, null);
    expect(w.unpromptedTurn()).toBeNull();
    expect(w.isBusy()).toBe(false);
  });
});

describe("the wake message", () => {
  it("names the tasks that finished and carries the turn id", () => {
    const msg = buildUnpromptedWakeMessage({
      id: "bgt-abc-1",
      notices: [{ taskId: "t1", status: "completed", description: "pnpm test" }],
      liveTasks: [],
    });
    expect(msg.startsWith("⟦AGENT:")).toBe(true);
    expect(msg).toContain("pnpm test");
    expect(msg).toContain("completed");
    expect(parseUnpromptedWakeMarker(msg)).toBe("bgt-abc-1");
  });

  it("names the live watch when no task finished (a Monitor event)", () => {
    const msg = buildUnpromptedWakeMessage({
      id: "bgt-abc-2",
      notices: [],
      liveTasks: ["tail the build log"],
    });
    expect(msg).toContain("tail the build log");
  });

  it("finds no marker in an ordinary prompt", () => {
    expect(parseUnpromptedWakeMarker("please continue [bg-turn]")).toBeNull();
  });
});

describe("a wake that reaches a live turn", () => {
  it("is refused while its turn is still kept, so it runs as its own turn and takes it", () => {
    const { w, feed, written } = idleWorker();
    feed(INIT, ASSISTANT, RESULT);
    const id = w.unpromptedTurn()?.id ?? "";
    // biome-ignore lint/suspicious/noExplicitAny: a live turn of ours
    (w as any).currentTurn = { resolve: () => {}, reject: () => {}, aborted: false };
    expect(w.steer(`⟦AGENT:⏱ Background⟧ x [bg-turn ${id}]`)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("is swallowed when its turn was already joined, and nothing reaches the CLI", () => {
    const { w, written } = idleWorker();
    // biome-ignore lint/suspicious/noExplicitAny: a live turn of ours
    (w as any).currentTurn = { resolve: () => {}, reject: () => {}, aborted: false };
    expect(w.steer("⟦AGENT:⏱ Background⟧ x [bg-turn bgt-gone-1]")).toBe(true);
    expect(written).toHaveLength(0);
    expect(w.steer("an ordinary aside")).toBe(true);
    expect(written).toHaveLength(1);
  });
});
