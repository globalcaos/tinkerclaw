import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, EARLY_EMPTY_RESULT_HOLD_MS, isEarlyEmptyResult } from "./worker.js";
import type { WorkerSpawnParams } from "./worker.js";

// FORK 2026-10-01 — bug-log [event-ordering+cleanup-race]. A resumed CLI whose last turn left work
// pending printed `result num_turns=0 duration_ms=189` before it read the new prompt (journal
// 2026-10-01 14:01:45, and 02:44:42 before it). The worker ended the turn on that line, the gateway's
// empty-response retry spawned a second process, and the first one went on working the prompt: two
// workers on one session. The constructor is inert, so these tests drive the stdout parser directly.
//
// CONTROL. Before this change the first test fails: the turn resolves with the empty result.

const EMPTY = {
  type: "result",
  subtype: "success",
  session_id: "s",
  is_error: false,
  num_turns: 0,
  duration_ms: 189,
  result: "",
};
const REAL = {
  type: "result",
  subtype: "success",
  session_id: "s",
  is_error: false,
  num_turns: 3,
  duration_ms: 42_000,
  result: "done",
};
const ASSISTANT = {
  type: "assistant",
  session_id: "s",
  message: { role: "assistant", content: [{ type: "text", text: "working" }] },
};

type Turn = {
  resolve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  aborted: boolean;
};

function liveWorker(): { w: ClaudeCodeWorker; turn: Turn; feed: (...lines: object[]) => void } {
  const w = new ClaudeCodeWorker({ sessionKey: "k", cwd: "/tmp" } as WorkerSpawnParams);
  const turn: Turn = { resolve: vi.fn(), reject: vi.fn(), aborted: false };
  // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
  const wAny = w as any;
  wAny.running = true;
  wAny.currentTurn = turn;
  const feed = (...lines: object[]) =>
    wAny.onStdoutChunk(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { w, turn, feed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("early empty result on a resumed CLI", () => {
  it("does not end the turn on an empty result that comes before any work", () => {
    const { turn, feed } = liveWorker();
    feed(EMPTY);
    expect(turn.resolve).not.toHaveBeenCalled();
    feed(ASSISTANT, REAL);
    expect(turn.resolve).toHaveBeenCalledTimes(1);
    expect(turn.resolve.mock.calls[0][0]).toMatchObject({ num_turns: 3, result: "done" });
  });

  it("ends a silent turn with the held empty result after the hold", () => {
    vi.useFakeTimers();
    const { turn, feed } = liveWorker();
    feed(EMPTY);
    vi.advanceTimersByTime(EARLY_EMPTY_RESULT_HOLD_MS - 1);
    expect(turn.resolve).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(turn.resolve).toHaveBeenCalledTimes(1);
    expect(turn.resolve.mock.calls[0][0]).toMatchObject({ num_turns: 0 });
  });

  it("ends the turn at once on a normal result", () => {
    const { turn, feed } = liveWorker();
    feed(ASSISTANT, REAL);
    expect(turn.resolve).toHaveBeenCalledTimes(1);
  });

  it("ends the turn at once on an empty result that comes after work", () => {
    const { turn, feed } = liveWorker();
    feed(ASSISTANT, EMPTY);
    expect(turn.resolve).toHaveBeenCalledTimes(1);
    expect(turn.resolve.mock.calls[0][0]).toMatchObject({ num_turns: 0 });
  });

  it("answers with the held result when the CLI exits after it", () => {
    vi.useFakeTimers();
    const { w, turn, feed } = liveWorker();
    feed(EMPTY);
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    (w as any).onExit(0, null, null);
    expect(turn.reject).not.toHaveBeenCalled();
    expect(turn.resolve).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(EARLY_EMPTY_RESULT_HOLD_MS);
    expect(turn.resolve).toHaveBeenCalledTimes(1);
  });

  it("records when the child last printed, for the pool's idle sweep", () => {
    const { w, feed } = liveWorker();
    expect(w.lastActivityAt()).toBe(0);
    const before = Date.now();
    feed(ASSISTANT);
    expect(w.lastActivityAt()).toBeGreaterThanOrEqual(before);
  });

  it("calls only a no-turn, no-error, no-text result early and empty", () => {
    expect(isEarlyEmptyResult(EMPTY as never)).toBe(true);
    expect(isEarlyEmptyResult({ ...EMPTY, is_error: true } as never)).toBe(false);
    expect(isEarlyEmptyResult({ ...EMPTY, result: "hi" } as never)).toBe(false);
    expect(isEarlyEmptyResult(REAL as never)).toBe(false);
  });
});
