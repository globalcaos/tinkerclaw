import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-09 — a Tinker turn the Claude usage limit ended must leave ONE wake armed for that
// chat (limit-resume.ts). Driven end to end through the real stream fn against a fake worker pool,
// like stream.unprompted-wake.test.ts, with the CLI's own result line from the 19:37 incident.
//
// CONTROL. Before the hook in the `is_error` arm, the turn produced the envelope and armed nothing:
// the first test fails on `readLimitResumes()`.

const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state = { lines: [] as unknown[] };
  const makeWorker = () => {
    const listeners = new Set<StreamLineListener>();
    return {
      sessionKey: "tinker-sp-limit",
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
      unpromptedTurn: () => null,
      takeUnpromptedTurn: async () => undefined,
      send: async () => {
        for (const line of state.lines) {
          for (const listener of listeners) {
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

import { __resetLimitResumeTimersForTest, readLimitResumes } from "./limit-resume.js";
import { createClaudeCodeStreamFn } from "./stream.js";

const SESSION = "00000000-0000-4000-8000-000000000009";
const INIT = { type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" };
const LIMIT_TEXT = "You've hit your session limit · resets 8:30pm (Europe/Madrid)";
const LIMIT_RESULT = {
  type: "result",
  subtype: "success",
  session_id: SESSION,
  is_error: true,
  num_turns: 57,
  duration_ms: 2265770,
  result: LIMIT_TEXT,
};
const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };

async function runLimitTurn(openclawSessionKey: string): Promise<string> {
  harness.state.lines = [INIT, LIMIT_RESULT];
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    { systemPrompt: "limit test", messages: [{ role: "user", content: "go" }] } as never,
    { __openclawRunId: "run-limit", __openclawSessionKey: openclawSessionKey } as never,
  );
  const message = (await stream.result()) as { content?: Array<{ type: string; text?: string }> };
  return (message.content ?? []).map((b) => b.text ?? "").join("");
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-limit-resume-"));
  process.env.OPENCLAW_TINKER_BRIDGE_LIMIT_RESUME = path.join(dir, "limit-resume.json");
});

afterEach(() => {
  __resetLimitResumeTimersForTest();
  delete process.env.OPENCLAW_TINKER_BRIDGE_LIMIT_RESUME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a Tinker turn the usage limit ended", () => {
  it("still shows the rate-limit envelope, and arms one wake for that chat", async () => {
    const text = await runLimitTurn("agent:main:tinker:muwizxjp");
    expect(text.startsWith("__ERR_ENV__:")).toBe(true);
    expect(text).toContain('"category":"rate_limit"');
    const wakes = readLimitResumes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].sessionKey).toBe("agent:main:tinker:muwizxjp");
    expect(wakes[0].raw).toBe(LIMIT_TEXT);
    expect(wakes[0].fireAt - wakes[0].resetAt).toBe(2 * 60_000);
  });

  it("arms nothing for a subagent's turn", async () => {
    await runLimitTurn("agent:main:subagent:fda3d5df-815f-4bd1-b248-4b8c955d5ce2");
    expect(readLimitResumes()).toEqual([]);
  });
});
