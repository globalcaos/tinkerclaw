import { describe, expect, it } from "vitest";
import { ClaudeCodeWorker } from "./worker.js";
import type { WorkerSpawnParams } from "./worker.js";

// steer(text) injects an ADDITIONAL user-message line onto the already-open
// persistent claude-cli stdin during a live turn, WITHOUT aborting/SIGTERMing
// and WITHOUT starting a new turn (the in-flight turn keeps owning the eventual
// `result` line). The constructor is inert (no subprocess spawn), so we drive
// the private state directly to exercise the stdin-write contract.

function makeWorker(): ClaudeCodeWorker {
  return new ClaudeCodeWorker({ sessionKey: "k", cwd: "/tmp" } as WorkerSpawnParams);
}
function liveTurn() {
  return { resolve() {}, reject() {}, aborted: false };
}

describe("ClaudeCodeWorker.steer", () => {
  it("writes a user-message NDJSON line to the live stdin and returns true", () => {
    const w = makeWorker();
    const writes: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.proc = { stdin: { write: (s: string) => writes.push(s) } };
    wAny.running = true;
    wAny.sessionId = "sess-123";
    wAny.currentTurn = liveTurn();

    expect(w.steer("hola")).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0])).toEqual({
      type: "user",
      message: { role: "user", content: "hola" },
      session_id: "sess-123",
    });
  });

  it("does NOT mutate currentTurn and does NOT abort the in-flight turn", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    const turn = liveTurn();
    wAny.proc = { stdin: { write() {} } };
    wAny.running = true;
    wAny.currentTurn = turn;

    w.steer("x");
    expect(wAny.currentTurn).toBe(turn); // same turn keeps owning the result line
    expect(turn.aborted).toBe(false); // never aborted
  });

  it("returns false and writes nothing when no turn is in flight", () => {
    const w = makeWorker();
    let wrote = false;
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.proc = {
      stdin: {
        write: () => {
          wrote = true;
        },
      },
    };
    wAny.running = true;
    wAny.currentTurn = null;

    expect(w.steer("x")).toBe(false);
    expect(wrote).toBe(false);
  });

  it("returns false when the subprocess is gone (proc null / not running)", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.proc = null;
    wAny.running = false;
    wAny.currentTurn = liveTurn();
    expect(w.steer("x")).toBe(false);
  });

  it("returns false (never throws) when the stdin write fails — EPIPE safety", () => {
    const w = makeWorker();
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.proc = {
      stdin: {
        write() {
          throw new Error("write EPIPE");
        },
      },
    };
    wAny.running = true;
    wAny.currentTurn = liveTurn();
    expect(w.steer("x")).toBe(false);
  });

  it("omits session_id before the cli session is established", () => {
    const w = makeWorker();
    const writes: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.proc = { stdin: { write: (s: string) => writes.push(s) } };
    wAny.running = true;
    wAny.sessionId = null;
    wAny.currentTurn = liveTurn();

    w.steer("x");
    expect(JSON.parse(writes[0])).toEqual({
      type: "user",
      message: { role: "user", content: "x" },
    });
  });
});
