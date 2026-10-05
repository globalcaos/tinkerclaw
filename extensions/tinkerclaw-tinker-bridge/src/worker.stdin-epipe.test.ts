import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeWorker } from "./worker.js";
import type { WorkerSpawnParams } from "./worker.js";

// FORK 2026-09-14 — the gateway crash class from the morning of 2026-09-14 (07:49, 07:52, 08:00):
// `Uncaught exception: Error: write EPIPE` raised as an 'error' EVENT on the claude child's stdin
// after the child had already died. The worker's constructor is inert (no spawn), so the private
// guard is driven directly with EventEmitter stand-ins for the child's pipes.

function makeWorker(): ClaudeCodeWorker {
  return new ClaudeCodeWorker({ sessionKey: "k", cwd: "/tmp" } as WorkerSpawnParams);
}

describe("ClaudeCodeWorker stdin EPIPE guard", () => {
  it("an async stdin 'error' fails the live turn instead of throwing out of emit()", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const reject = vi.fn();
    wAny.currentTurn = { resolve() {}, reject, aborted: false };

    wAny.attachChildStreamGuards({ stdin, stdout, stderr });

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => stdin.emit("error", epipe)).not.toThrow();
    expect(reject).toHaveBeenCalledOnce();
    expect(String(reject.mock.calls[0][0])).toMatch(/stdin closed before the turn/);
    expect(String(reject.mock.calls[0][0])).toMatch(/write EPIPE/);
    // The turn is released exactly once: the exit handler that follows must find nothing to reject.
    expect(wAny.currentTurn).toBeNull();
  });

  it("stdout/stderr errors are logged only — the turn keeps running", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const reject = vi.fn();
    const turn = { resolve() {}, reject, aborted: false };
    wAny.currentTurn = turn;

    wAny.attachChildStreamGuards({ stdin, stdout, stderr });

    expect(() => stdout.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(() => stderr.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(reject).not.toHaveBeenCalled();
    expect(wAny.currentTurn).toBe(turn);
  });

  it("a stdin error with no live turn is absorbed silently", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    const stdin = new EventEmitter();
    wAny.currentTurn = null;
    wAny.attachChildStreamGuards({ stdin });
    expect(() => stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    expect(wAny.currentTurn).toBeNull();
  });
});
