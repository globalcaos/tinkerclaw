import { beforeEach, describe, expect, it, vi } from "vitest";

// The stream fn is driven end to end against a fake worker pool, and the A1 owner's emitter is
// spied on through the very subpath the bridge imports it from. Everything else in that subpath
// stays real: compactionTokenCount, and the call telemetry that runs beside the reader.
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
      // Like worker.ts: every parsed stdout line, the `result` line included, goes out as a
      // stream_line, and send() then resolves with that result line.
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
  return { state, makeWorker, emitCompactionTelemetry: vi.fn() };
});

vi.mock("./worker-pool.js", () => ({
  getPool: () => ({
    getOrCreate: () => harness.makeWorker(),
    takeThinkLevelPending: () => undefined,
  }),
}));

vi.mock("openclaw/plugin-sdk/fork-telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fork-telemetry")>()),
  emitCompactionTelemetry: (...args: unknown[]) => harness.emitCompactionTelemetry(...args),
}));

import type { CcStreamStdoutLine } from "./protocol.js";
import { createClaudeCodeStreamFn, createCompactionLineReader } from "./stream.js";

// FORK 2026-09-24 (A3, TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1, finding F3a) — the
// claude CLI's OWN compaction, heard by the bridge and published through the A1 owner.
//
// PROVENANCE OF THE FIXTURES. The line shapes and every field NAME are Step 0's (§6.0 b): the
// CLI's own stream-json schema (claude CLI 2.1.281) and the compact_metadata keys of the 62
// transcript records it read. The failed / success status shape is the one the installed CLI's
// compaction paths send. The NUMBERS are synthetic, because Step 0 recorded names only, so these
// tests pin the mapping's shape and nothing else.
//
// CONTROL. On the tree before this reader, createCompactionLineReader does not exist and
// handleLine has no `system` arm: every test here fails there, the wiring tests on 0 emissions.

const SESSION = "00000000-0000-4000-8000-000000000002";
const SESSION_KEY = "agent:main:main";

const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;

const INIT = asLine({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  model: "claude-opus-5",
});
const COMPACTING = asLine({
  type: "system",
  subtype: "status",
  status: "compacting",
  uuid: "uuid-status-compacting",
  session_id: SESSION,
});
const BOUNDARY = asLine({
  type: "system",
  subtype: "compact_boundary",
  uuid: "uuid-boundary",
  session_id: SESSION,
  logical_parent_uuid: "uuid-parent",
  compact_metadata: {
    trigger: "auto",
    pre_tokens: 167_500,
    post_tokens: 21_300,
    duration_ms: 142_000,
    // A running total across every earlier compaction: it must never become tokensDropped.
    cumulative_dropped_tokens: 512_000,
    messages_summarized: 40,
    precomputed: false,
  },
});
const compactStatus = (result: "success" | "failed"): CcStreamStdoutLine =>
  asLine({
    type: "system",
    subtype: "status",
    status: null,
    compact_result: result,
    ...(result === "failed" ? { compact_error: "synthetic" } : {}),
    uuid: `uuid-status-${result}`,
    session_id: SESSION,
  });
const REQUESTING = asLine({
  type: "system",
  subtype: "status",
  status: "requesting",
  uuid: "uuid-status-requesting",
  session_id: SESSION,
});
const streamEvent = (event: Record<string, unknown>): CcStreamStdoutLine =>
  asLine({
    type: "stream_event",
    uuid: "uuid-stream",
    session_id: SESSION,
    parent_tool_use_id: null,
    ttft_ms: 900,
    event,
  });
/** One ordinary API call with no compaction anywhere near it. */
const QUIET_CALL: CcStreamStdoutLine[] = [
  REQUESTING,
  streamEvent({
    type: "message_start",
    message: { id: "msg_1", role: "assistant", usage: { input_tokens: 6, output_tokens: 1 } },
  }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  }),
  streamEvent({ type: "message_stop" }),
];
const RESULT = asLine({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  num_turns: 1,
  duration_ms: 1_000,
  session_id: SESSION,
  usage: { input_tokens: 6, output_tokens: 2 },
});

const CLI = { trigger: "cli-internal", lane: "cc-bridge", provenance: "exact" } as const;
const START = { phase: "start", ...CLI };
const EXACT_END = {
  phase: "end",
  completed: true,
  ...CLI,
  tokensBefore: 167_500,
  tokensAfter: 21_300,
  durationMs: 142_000,
};

function readAll(lines: CcStreamStdoutLine[]) {
  const reader = createCompactionLineReader();
  return lines.flatMap((line) => reader.read(line));
}

describe("createCompactionLineReader (A3, pure)", () => {
  it("maps one compaction to one start and one end with the CLI's exact numbers", () => {
    // `compacting` is re-sent every 30 s while a precomputed compaction is pending: one start.
    expect(readAll([INIT, COMPACTING, COMPACTING, COMPACTING, BOUNDARY])).toStrictEqual([
      START,
      EXACT_END,
    ]);
  });

  it("never reads cumulative_dropped_tokens and never sets tokensDropped", () => {
    const [end] = readAll([BOUNDARY]);
    expect(end).not.toHaveProperty("tokensDropped");
    expect(JSON.stringify(end)).not.toContain("512000");
  });

  it("resets the start latch on the boundary, so the next compaction starts again", () => {
    expect(
      readAll([COMPACTING, BOUNDARY, COMPACTING, COMPACTING, BOUNDARY]).map((event) => event.phase),
    ).toEqual(["start", "end", "start", "end"]);
  });

  it("omits a figure the boundary did not carry, keeps a measured 0, and reads snake_case only", () => {
    const partial = asLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: SESSION,
      compact_metadata: { trigger: "manual", pre_tokens: 0, post_tokens: null, duration_ms: -1 },
    });
    // The TRANSCRIPT's camelCase spelling is not the stream's: nothing is read from it.
    const camelCase = asLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: SESSION,
      compactMetadata: { preTokens: 167_500, postTokens: 21_300, durationMs: 142_000 },
    });
    expect(readAll([partial, camelCase])).toStrictEqual([
      { phase: "end", completed: true, ...CLI, tokensBefore: 0 },
      { phase: "end", completed: true, ...CLI },
    ]);
  });

  it("ends a compaction the CLI gave up on as not completed, and never counts a success status as an end", () => {
    expect(readAll([COMPACTING, compactStatus("failed"), COMPACTING])).toStrictEqual([
      START,
      { phase: "end", completed: false, ...CLI },
      START,
    ]);
    // A success status neither ends the compaction nor resets the latch: the boundary does both.
    expect(readAll([COMPACTING, compactStatus("success"), COMPACTING, BOUNDARY])).toStrictEqual([
      START,
      EXACT_END,
    ]);
  });

  it("ignores every line that is not a compaction marker", () => {
    expect(readAll([INIT, ...QUIET_CALL, asLine({ type: "rate_limit_event" }), RESULT])).toEqual(
      [],
    );
  });
});

const MODEL = { api: "anthropic-messages", provider: "claude-code", id: "claude-opus-5" };

/** Drives one whole turn through the real stream fn against the fake worker above. */
async function runTurn(lines: CcStreamStdoutLine[], runId: string | undefined): Promise<void> {
  harness.state.lines = lines;
  const streamFn = createClaudeCodeStreamFn();
  const stream = await streamFn(
    MODEL as never,
    { systemPrompt: "compact-boundary test", messages: [{ role: "user", content: "hi" }] } as never,
    { __openclawRunId: runId, __openclawSessionKey: SESSION_KEY } as never,
  );
  // Resolves on the turn's `done` event; every line was routed before send() resolved.
  await stream.result();
}

describe("the stream fn publishes the CLI's compaction through the A1 owner (A3 wiring)", () => {
  beforeEach(() => {
    harness.emitCompactionTelemetry.mockReset();
  });

  it("emits exactly one end, with the CLI's exact numbers, for a compaction inside a turn", async () => {
    const runId = "run-compact-boundary";
    await runTurn([INIT, COMPACTING, COMPACTING, BOUNDARY, ...QUIET_CALL, RESULT], runId);
    const target = { runId, sessionKey: SESSION_KEY };
    const calls = harness.emitCompactionTelemetry.mock.calls;
    const ends = calls.filter(([, event]) => (event as { phase?: unknown }).phase === "end");
    expect(ends).toStrictEqual([[target, EXACT_END]]);
    expect(calls).toStrictEqual([
      [target, START],
      [target, EXACT_END],
    ]);
  });

  it("emits nothing on a quiet turn", async () => {
    await runTurn([INIT, ...QUIET_CALL, RESULT], "run-compact-quiet");
    expect(harness.emitCompactionTelemetry).not.toHaveBeenCalled();
  });

  it("emits nothing without a runId, like every other agent event of the bridge", async () => {
    await runTurn([INIT, COMPACTING, BOUNDARY, RESULT], undefined);
    expect(harness.emitCompactionTelemetry).not.toHaveBeenCalled();
  });
});
