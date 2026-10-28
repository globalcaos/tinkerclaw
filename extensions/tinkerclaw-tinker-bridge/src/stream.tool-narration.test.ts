import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";

// Drives whole turns through the real stream fn against a fake worker pool (the same harness
// as stream.channel-reply.test.ts).
const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state: { lines: unknown[] } = { lines: [] };
  const makeWorker = () => {
    const listeners = new Set<StreamLineListener>();
    return {
      thinkLevel: undefined as string | undefined,
      on: (_event: string, listener: StreamLineListener) => {
        listeners.add(listener);
      },
      off: (_event: string, listener: StreamLineListener) => {
        listeners.delete(listener);
      },
      kill: () => undefined,
      send: async () => {
        for (const line of state.lines) {
          for (const listener of [...listeners]) {
            listener({ type: "stream_line", line });
          }
        }
        return state.lines.find((line) => (line as { type?: unknown }).type === "result");
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

import type { CcStreamStdoutLine } from "./protocol.js";
import { createClaudeCodeStreamFn } from "./stream.js";

// FORK 2026-10-27 (the architect: "Every tool call shown in the chat says 'performing an action'").
// Journal 2026-10-27: 618 of 618 `tool.start` lines had `narration.len=0`. With partial
// messages on, the sentence before a tool arrives as content_block_delta events; that arm
// marked the text seen but never fed the narration buffer, so the cumulative frame found
// nothing new and every tool row fell back to the mechanical title.

const SESSION = "00000000-0000-4000-8000-000000000027";
const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };
const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;
const streamEvent = (event: Record<string, unknown>): CcStreamStdoutLine =>
  asLine({ type: "stream_event", session_id: SESSION, parent_tool_use_id: null, event });

const FIRST = "Counting today's tool calls that arrived with no narration.";
const SECOND = "Reading the delta branch in stream.ts to see why.";

/** One API call: narration streamed as deltas, then the cumulative frame with the tool_use. */
function streamedStep(i: number, narration: string): CcStreamStdoutLine[] {
  const msgId = `msg_${i}`;
  const toolId = `toolu_${i}`;
  return [
    streamEvent({ type: "message_start", message: { id: msgId, role: "assistant" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: narration.slice(0, 20) },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: narration.slice(20) },
    }),
    asLine({
      type: "assistant",
      session_id: SESSION,
      message: {
        id: msgId,
        role: "assistant",
        content: [
          { type: "text", text: narration },
          { type: "tool_use", id: toolId, name: "Bash", input: { command: "true" } },
        ],
      },
    }),
    asLine({
      type: "user",
      session_id: SESSION,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: "ok", is_error: false }],
      },
    }),
  ];
}

describe("tool narration with streamed text deltas", () => {
  it("hands each tool start the sentence streamed before it", async () => {
    const sessionKey = "agent:main:tinker:tool-narration";
    const runId = "run-tool-narration";
    harness.state.lines = [
      asLine({ type: "system", subtype: "init", session_id: SESSION, model: MODEL.id }),
      ...streamedStep(0, FIRST),
      ...streamedStep(1, SECOND),
      asLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        num_turns: 3,
        session_id: SESSION,
      }),
    ];
    const purposes: unknown[] = [];
    const off = onAgentEvent((evt) => {
      const data = evt.data as { phase?: string; purpose?: unknown } | undefined;
      if (evt.runId === runId && evt.stream === "tool" && data?.phase === "start") {
        purposes.push(data.purpose);
      }
    });
    try {
      const streamFn = createClaudeCodeStreamFn();
      const stream = await streamFn(
        MODEL as never,
        {
          systemPrompt: "tool narration test",
          messages: [{ role: "user", content: "hi" }],
        } as never,
        { __openclawRunId: runId, __openclawSessionKey: sessionKey } as never,
      );
      await stream.result();
    } finally {
      off();
    }
    expect(purposes).toEqual([FIRST, SECOND]);
  });
});
