import { describe, expect, it, vi } from "vitest";

// FORK 2026-10-10 (J-series Phase 1.5): turns of one chat whose system prompts differ only below core's cache boundary
// reuse one worker, spawned on the stable prefix; the volatile section reaches the CLI in front of every prompt.
// Same fake-pool harness as stream.channel-reply.test.ts, recording what each turn asked the pool and the worker for.
const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state = {
    spawns: [] as Array<{ sessionKey: string; systemPromptAppend?: string }>,
    sent: [] as string[],
  };
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    num_turns: 1,
    duration_ms: 10,
    session_id: "00000000-0000-4000-8000-00000000000a",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
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
      send: async (params: { userText: string }) => {
        state.sent.push(params.userText);
        for (const listener of [...listeners]) {
          listener({ type: "stream_line", line: result });
        }
        return result;
      },
    };
  };
  return { state, makeWorker };
});

vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    getOrCreate: (params: { sessionKey: string; systemPromptAppend?: string }) => {
      harness.state.spawns.push({
        sessionKey: params.sessionKey,
        systemPromptAppend: params.systemPromptAppend,
      });
      return harness.makeWorker();
    },
    get: () => undefined,
    takeThinkLevelPending: () => undefined,
  }),
}));

import { createClaudeCodeStreamFn } from "./stream.js";
import { splitWorkerSystemPrompt } from "./turn-context.js";

const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };
const STABLE = "# Persona: Jarvis\n\n## Skills\n- one\n- two";
// What core hands the bridge: the marker stripped to one newline, the runtime section after it.
const promptWith = (thinking: string) =>
  `${STABLE}\n\n## Runtime\nRuntime: agent=main | channel=webchat | thinking=${thinking}`;

async function turn(params: {
  systemPrompt: string;
  stableChars?: number;
  sessionKey: string;
  text: string;
}) {
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    {
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.text }],
    } as never,
    {
      __openclawRunId: `run-${harness.state.sent.length}`,
      __openclawSessionKey: params.sessionKey,
      __openclawSessionId: "sid-turn-context",
      ...(params.stableChars === undefined
        ? {}
        : { __openclawStablePromptChars: params.stableChars }),
    } as never,
  );
  await stream.result();
}

describe("per-turn system context on a warm worker (Phase 1.5)", () => {
  it("keys and spawns on the stable prefix, and sends this turn's runtime section with the prompt", async () => {
    harness.state.spawns.length = 0;
    harness.state.sent.length = 0;
    const chat = "agent:main:tinker:turn-context";
    await turn({
      systemPrompt: promptWith("low"),
      stableChars: STABLE.length,
      sessionKey: chat,
      text: "first",
    });
    await turn({
      systemPrompt: promptWith("high"),
      stableChars: STABLE.length,
      sessionKey: chat,
      text: "second",
    });

    const [a, b] = harness.state.spawns;
    expect(a.sessionKey).toBe(b.sessionKey);
    expect(b.systemPromptAppend).toBe(STABLE);
    expect(harness.state.sent[0]).toMatch(
      /^<turn_context>[\s\S]*thinking=low[\s\S]*<\/turn_context>\n\nfirst/,
    );
    expect(harness.state.sent[1]).toContain("thinking=high");
    expect(harness.state.sent[1]).not.toContain("thinking=low");
  });

  it("CONTROL: without core's count the whole prompt is the key, as before, and nothing rides the turn", async () => {
    harness.state.spawns.length = 0;
    harness.state.sent.length = 0;
    const chat = "agent:main:tinker:turn-context-control";
    await turn({ systemPrompt: promptWith("low"), sessionKey: chat, text: "first" });
    await turn({ systemPrompt: promptWith("high"), sessionKey: chat, text: "second" });

    const [a, b] = harness.state.spawns;
    expect(a.sessionKey).not.toBe(b.sessionKey);
    expect(b.systemPromptAppend).toBe(promptWith("high"));
    expect(harness.state.sent[1]).not.toContain("<turn_context>");
  });

  it("a subagent keeps its whole prompt: its task sits below the boundary", async () => {
    harness.state.spawns.length = 0;
    harness.state.sent.length = 0;
    await turn({
      systemPrompt: promptWith("low"),
      stableChars: STABLE.length,
      sessionKey: "agent:main:subagent:1234",
      text: "Begin.",
    });
    expect(harness.state.spawns[0].systemPromptAppend).toBe(promptWith("low"));
    expect(harness.state.sent[0]).not.toContain("<turn_context>");
  });
});

describe("splitWorkerSystemPrompt", () => {
  it("falls back to the whole prompt when the count does not land on the stripped marker's newline", () => {
    const prompt = promptWith("low");
    expect(splitWorkerSystemPrompt(prompt, STABLE.length - 3)).toEqual({
      stable: prompt,
      volatile: "",
    });
    expect(splitWorkerSystemPrompt(prompt, prompt.length)).toEqual({
      stable: prompt,
      volatile: "",
    });
    expect(splitWorkerSystemPrompt(prompt, "12")).toEqual({ stable: prompt, volatile: "" });
    expect(splitWorkerSystemPrompt(prompt, STABLE.length)).toEqual({
      stable: STABLE,
      volatile: "## Runtime\nRuntime: agent=main | channel=webchat | thinking=low",
    });
  });
});
