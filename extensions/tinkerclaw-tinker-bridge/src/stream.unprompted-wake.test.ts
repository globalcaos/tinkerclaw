import { beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-01 — bug-log [monitor-notify-idle-session-lost]. The run a worker's wake starts
// (unprompted-turn.ts) must TAKE the turn the CLI started on its own and send the CLI nothing: the
// CLI has already answered, and the wake text written to it would make it answer a second time.
// Driven end to end through the real stream fn against a fake worker pool, like
// stream.compact-boundary.test.ts.
//
// CONTROL. Before this change the stream fn sent every prompt, the wake's included: the first and
// third tests fail on `sendCalls`.

const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state = {
    heldId: null as string | null,
    lines: [] as unknown[],
    sendCalls: [] as string[],
    takeCalls: [] as string[],
  };
  const makeWorker = () => {
    const listeners = new Set<StreamLineListener>();
    const play = () => {
      for (const line of state.lines) {
        for (const listener of listeners) {
          listener({ type: "stream_line", line });
        }
      }
      return state.lines.find((line) => (line as { type?: unknown }).type === "result");
    };
    return {
      sessionKey: "tinker-sp-wake",
      sessionId: "s",
      thinkLevel: undefined as string | undefined,
      on: (_event: string, listener: StreamLineListener) => {
        listeners.add(listener);
      },
      off: (_event: string, listener: StreamLineListener) => {
        listeners.delete(listener);
      },
      kill: () => undefined,
      steer: () => false,
      unpromptedTurn: () =>
        state.heldId ? { id: state.heldId, finished: true, startedAt: 0 } : null,
      takeUnpromptedTurn: async ({ id }: { id: string }) => {
        state.takeCalls.push(id);
        return play();
      },
      send: async ({ userText }: { userText: string }) => {
        state.sendCalls.push(userText);
        return play();
      },
    };
  };
  return { state, makeWorker };
});

vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    getOrCreate: () => harness.makeWorker(),
    takeThinkLevelPending: () => undefined,
  }),
}));

import { createClaudeCodeStreamFn } from "./stream.js";
import { UNPROMPTED_TURN_GONE_TEXT } from "./unprompted-turn.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const INIT = { type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" };
const ASSISTANT = {
  type: "assistant",
  session_id: SESSION,
  message: { role: "assistant", content: [{ type: "text", text: "WOKE" }] },
};
const RESULT = {
  type: "result",
  subtype: "success",
  session_id: SESSION,
  is_error: false,
  num_turns: 1,
  duration_ms: 1400,
  result: "WOKE",
};
const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };

async function runTurn(prompt: string): Promise<string> {
  harness.state.lines = [INIT, ASSISTANT, RESULT];
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    {
      systemPrompt: "unprompted wake test",
      messages: [{ role: "user", content: prompt }],
    } as never,
    { __openclawRunId: "run-wake", __openclawSessionKey: "agent:main:tinker:wake" } as never,
  );
  const message = (await stream.result()) as { content?: Array<{ type: string; text?: string }> };
  return (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

beforeEach(() => {
  harness.state.heldId = null;
  harness.state.sendCalls = [];
  harness.state.takeCalls = [];
});

describe("the run a worker's wake starts", () => {
  it("takes the turn the CLI started on its own and sends the CLI nothing", async () => {
    harness.state.heldId = "bgt-k-1";
    const text = await runTurn(
      "⟦AGENT:⏱ Background⟧ Background task: “x” completed. [bg-turn bgt-k-1]",
    );
    expect(harness.state.sendCalls).toEqual([]);
    expect(harness.state.takeCalls).toEqual(["bgt-k-1"]);
    expect(text).toContain("WOKE");
  });

  it("leaves an ordinary prompt alone: it is sent as before", async () => {
    harness.state.heldId = "bgt-k-2";
    await runTurn("hello");
    expect(harness.state.sendCalls).toHaveLength(1);
    expect(harness.state.sendCalls[0]).toContain("hello");
    expect(harness.state.takeCalls).toEqual([]);
  });

  it("sends the CLI nothing when the turn is gone, and says so in one line", async () => {
    const text = await runTurn("⟦AGENT:⏱ Background⟧ x [bg-turn bgt-gone-3]");
    expect(harness.state.sendCalls).toEqual([]);
    expect(harness.state.takeCalls).toEqual([]);
    expect(text).toContain(UNPROMPTED_TURN_GONE_TEXT);
  });
});
