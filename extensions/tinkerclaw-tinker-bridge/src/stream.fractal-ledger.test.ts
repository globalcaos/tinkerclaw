import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-09 (Fractal v2 M4, fractal-ledger.ts) — the stream.ts hook at a run's result line.
// Whole turns go through the real stream fn against a fake worker pool (the harness of
// stream.channel-reply.test.ts). A `fractal-<P>` run must leave one ledger row under
// <stateDir>/data/fractal and a `fractal-check` event; any other run must leave nothing; and a hook
// that throws must not cost the turn its answer.
const harness = vi.hoisted(() => {
  type StreamLineListener = (evt: { type: string; line: unknown }) => void;
  const state: { lines: unknown[]; cwd: string; hookThrows: boolean; hookCalls: number } = {
    lines: [],
    cwd: "/",
    hookThrows: false,
    hookCalls: 0,
  };
  const makeWorker = () => {
    const listeners = new Set<StreamLineListener>();
    return {
      thinkLevel: undefined as string | undefined,
      get cwd() {
        return state.cwd;
      },
      on: (_event: string, listener: StreamLineListener) => {
        listeners.add(listener);
      },
      off: (_event: string, listener: StreamLineListener) => {
        listeners.delete(listener);
      },
      kill: () => undefined,
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
    get: () => undefined,
    getOrCreate: () => harness.makeWorker(),
    takeThinkLevelPending: () => undefined,
  }),
}));

vi.mock("./fractal-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fractal-ledger.js")>();
  return {
    ...actual,
    scheduleFractalLedger: (...args: Parameters<typeof actual.scheduleFractalLedger>) => {
      harness.state.hookCalls += 1;
      if (harness.state.hookThrows) {
        throw new Error("synthetic ledger failure");
      }
      return actual.scheduleFractalLedger(...args);
    },
  };
});

import { ledgerPathFor } from "./fractal-ledger.js";
import type { CcStreamStdoutLine } from "./protocol.js";
import { createClaudeCodeStreamFn } from "./stream.js";
import { consumeToolEventsForRun } from "./tool-buffer.js";

const SESSION = "00000000-0000-4000-8000-0000000000f1";
const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5-5" };
const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;

function writeTurn(file: string, answer: string): CcStreamStdoutLine[] {
  return [
    asLine({ type: "system", subtype: "init", session_id: SESSION, model: MODEL.id }),
    asLine({
      type: "assistant",
      session_id: SESSION,
      message: {
        id: "msg_0",
        role: "assistant",
        content: [
          { type: "text", text: "Writing the recipe step." },
          { type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: file } },
        ],
      },
    }),
    asLine({
      type: "user",
      session_id: SESSION,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "ok", is_error: false }],
      },
    }),
    asLine({
      type: "assistant",
      session_id: SESSION,
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: answer }] },
    }),
    asLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: answer,
      num_turns: 2,
      duration_ms: 9_000,
      session_id: SESSION,
      usage: {
        input_tokens: 7,
        output_tokens: 300,
        cache_read_input_tokens: 4_050_000,
        cache_creation_input_tokens: 2_000,
      },
    }),
  ];
}

async function runTurn(runId: string, prompt: string) {
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    { systemPrompt: "fractal-ledger test", messages: [{ role: "user", content: prompt }] } as never,
    { __openclawRunId: runId, __openclawSessionKey: `agent:main:fractal:${runId}` } as never,
  );
  return (await stream.result()) as unknown as { content: Array<{ type: string; text?: string }> };
}

const textOf = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

async function waitFor<T>(probe: () => T | undefined, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("stream.ts → Fractal ledger", () => {
  let stateDir: string;
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-fractal-ledger-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    harness.state.cwd = stateDir;
    harness.state.hookThrows = false;
    harness.state.hookCalls = 0;
  });
  afterEach(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes the row of a fractal-<P> run and emits fractal-check, the tool buffer left whole", async () => {
    const file = path.join(stateDir, "recipe.md");
    fs.writeFileSync(file, "step");
    const answer = `🌿 FRACTAL ACTION: recipe step added in \`${file}\`; also \`${path.join(stateDir, "ghost.md")}\`.`;
    harness.state.lines = writeTurn(file, answer);
    const events: Array<{ stream: string; runId: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => {
      if (evt.stream === "fractal-check") {
        events.push(evt);
      }
    });
    try {
      const message = await runTurn("fractal-P9", "Triggers: friction — 1 tool error\n\nreflect");
      expect(textOf(message)).toContain("FRACTAL ACTION");

      const event = await waitFor(() => events[0]);
      expect(event.runId).toBe("fractal-P9");
      const lines = fs.readFileSync(ledgerPathFor(stateDir), "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]);
      expect(row).toEqual(event.data);
      expect(row).toMatchObject({
        v: 1,
        runId: "fractal-P9",
        parentRunId: "P9",
        sessionKey: "agent:main:fractal:fractal-P9",
        model: "claude-opus-5-5",
        durationMs: 9_000,
        usage: { cacheRead: 4_050_000, cacheWrite: 2_000, input: 7, output: 300 },
        triggers: ["friction"],
        writes: [file],
        commits: [],
        verdict: "unverified",
        firstLine: answer,
      });
      expect(row.claims).toEqual([
        { ref: file, kind: "path", ok: true, byThisRun: true, why: "written by this run" },
        {
          ref: path.join(stateDir, "ghost.md"),
          kind: "path",
          ok: false,
          byThisRun: false,
          why: "not on disk",
        },
      ]);
      // The turn-end drain (attempt-hooks.ts) still finds both events of the Write call.
      expect(consumeToolEventsForRun("fractal-P9")).toHaveLength(2);
    } finally {
      off();
    }
  });

  it("skips every run that is not a Fractal run", async () => {
    const file = path.join(stateDir, "x.md");
    harness.state.lines = writeTurn(file, `done in \`${file}\``);
    await runTurn("plain-run-1", "hi");
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.state.hookCalls).toBe(0);
    expect(fs.existsSync(ledgerPathFor(stateDir))).toBe(false);
    consumeToolEventsForRun("plain-run-1");
  });

  it("keeps the turn's answer when the ledger hook throws", async () => {
    harness.state.hookThrows = true;
    const file = path.join(stateDir, "y.md");
    harness.state.lines = writeTurn(file, "🌿 FRACTAL CLEAN: nothing to change");
    const message = await runTurn("fractal-P10", "reflect");
    expect(harness.state.hookCalls).toBe(1);
    expect(textOf(message)).toContain("FRACTAL CLEAN");
    expect(textOf(message)).not.toContain("__ERR_ENV__");
    consumeToolEventsForRun("fractal-P10");
  });
});
