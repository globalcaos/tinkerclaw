import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { allocateCallIndex, buildCallEventData } from "openclaw/plugin-sdk/fork-telemetry";
import { describe, expect, it } from "vitest";
import type { CcStreamStdoutLine } from "./protocol.js";
import { createBridgeCallTelemetry, createBridgeCallTracker } from "./stream.js";

// FORK 2026-09-24 (A8, TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 and §6.0 a) — the
// cc-bridge producer of the per-model-call contract (the call stream).
//
// MIRROR RETIRED 2026-09-24. The tracker now produces the owner's CallTelemetryEvent, and the
// payloads below come from the owner's own buildCallEventData (openclaw/plugin-sdk/fork-telemetry)
// instead of the bridge's deleted copy; not one expected payload changed, which is the proof the
// two builders agreed. Publishing is watched on the REAL agent-event bus (onAgentEvent), not a
// mock: the owner imports emitAgentEvent from core, so a mock of the SDK's re-export would see
// nothing.
//
// PROVENANCE OF THE FIXTURES. The line sequence and every field NAME are the Step 0 capture
// (claude CLI 2.1.281, run with the bridge's own output flags): system/init, system/status,
// message_start, content_block_start, content_block_delta, assistant, content_block_stop,
// message_delta, message_stop, rate_limit_event, result. The NUMBERS are synthetic, because the
// capture recorded names only, so these tests pin the mapping's shape and nothing else.

const SESSION = "00000000-0000-4000-8000-000000000001";

const asLine = (value: Record<string, unknown>): CcStreamStdoutLine => value as CcStreamStdoutLine;

const streamEvent = (
  event: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): CcStreamStdoutLine =>
  asLine({
    type: "stream_event",
    uuid: "uuid-stream",
    session_id: SESSION,
    parent_tool_use_id: null,
    ttft_ms: 900,
    event,
    ...envelope,
  });

const INIT = asLine({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  model: "claude-opus-5",
});
const REQUESTING = asLine({
  type: "system",
  subtype: "status",
  status: "requesting",
  uuid: "uuid-status",
  session_id: SESSION,
});
const PROMPT_USAGE = {
  input_tokens: 6,
  cache_read_input_tokens: 140_000,
  cache_creation_input_tokens: 2_100,
};
const MESSAGE_START = streamEvent({
  type: "message_start",
  message: { id: "msg_1", role: "assistant", usage: { ...PROMPT_USAGE, output_tokens: 1 } },
});
const messageDelta = (stopReason: string, outputTokens: number): CcStreamStdoutLine =>
  streamEvent({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { ...PROMPT_USAGE, output_tokens: outputTokens },
  });
const TOOL_RESULT = asLine({
  type: "user",
  session_id: SESSION,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  },
});
const RESULT = asLine({ type: "result", subtype: "success", session_id: SESSION, num_turns: 1 });

const ONE_CALL_TURN: CcStreamStdoutLine[] = [
  INIT,
  REQUESTING,
  MESSAGE_START,
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
  asLine({
    type: "assistant",
    session_id: SESSION,
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }] },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  messageDelta("end_turn", 1_900),
  streamEvent({ type: "message_stop" }),
  asLine({ type: "rate_limit_event" }),
  RESULT,
];

const CC = { lane: "cc-bridge", provenance: "exact" } as const;
const PROMPT = { input: 6, cacheRead: 140_000, cacheWrite: 2_100 };

/**
 * Replays lines through a fresh tracker at t = 1000, 1001, ... and then closes it, the way the
 * stream fn's `finally` does; returns the wire payloads.
 */
function replay(lines: CcStreamStdoutLine[]): Record<string, unknown>[] {
  let next = 0;
  const tracker = createBridgeCallTracker(() => next++);
  const frames = lines.flatMap((line, i) => tracker.observe(line, 1_000 + i));
  frames.push(...tracker.close(1_000 + lines.length));
  return frames.map(buildCallEventData);
}

describe("cc-bridge call telemetry (stream:call)", () => {
  it("maps one API call to send, usage and end, at the lines that carry them", () => {
    // The usage frame has no `output`: message_start's output_tokens is a first-byte count.
    expect(replay(ONE_CALL_TURN)).toEqual([
      { phase: "send", callIndex: 0, t: 1_001, ...CC },
      { phase: "usage", callIndex: 0, t: 1_002, ...CC, ...PROMPT },
      {
        phase: "end",
        callIndex: 0,
        t: 1_007,
        ...CC,
        ...PROMPT,
        output: 1_900,
        stopReason: "end_turn",
      },
    ]);
  });

  it("gives every API call of a tool loop its own index", () => {
    const frames = replay([
      INIT,
      REQUESTING,
      MESSAGE_START,
      messageDelta("tool_use", 80),
      TOOL_RESULT,
      REQUESTING,
      MESSAGE_START,
      messageDelta("end_turn", 1_900),
      RESULT,
    ]);
    expect(frames.map((frame) => [frame.phase, frame.callIndex, frame.stopReason])).toEqual([
      ["send", 0, undefined],
      ["usage", 0, undefined],
      ["end", 0, "tool_use"],
      ["send", 1, undefined],
      ["usage", 1, undefined],
      ["end", 1, "end_turn"],
    ]);
  });

  it("omits what the stream did not carry and keeps a reported 0", () => {
    expect(
      replay([
        REQUESTING,
        streamEvent({ type: "message_start", message: { id: "msg_2", role: "assistant" } }),
        streamEvent({
          type: "message_delta",
          delta: { stop_reason: null },
          usage: {
            input_tokens: null,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: -1,
            output_tokens: 5,
          },
        }),
      ]),
    ).toEqual([
      { phase: "send", callIndex: 0, t: 1_000, ...CC },
      { phase: "end", callIndex: 0, t: 1_002, ...CC, cacheRead: 0, output: 5 },
    ]);
  });

  it("ends a call it can no longer follow instead of leaving it open", () => {
    // A retried request (a second `requesting` before any response), then a response the stream
    // stops short of: both calls end, each with only what was measured.
    expect(replay([REQUESTING, REQUESTING, MESSAGE_START])).toEqual([
      { phase: "send", callIndex: 0, t: 1_000, ...CC },
      { phase: "end", callIndex: 0, t: 1_001, ...CC },
      { phase: "send", callIndex: 1, t: 1_001, ...CC },
      { phase: "usage", callIndex: 1, t: 1_002, ...CC, ...PROMPT },
      { phase: "end", callIndex: 1, t: 1_003, ...CC },
    ]);
  });

  it("opens a call on message_start when no requesting line came, and invents no send", () => {
    expect(
      replay([MESSAGE_START, messageDelta("end_turn", 12)]).map((frame) => [
        frame.phase,
        frame.callIndex,
      ]),
    ).toEqual([
      ["usage", 0],
      ["end", 0],
    ]);
  });

  it("does not read a subagent's stream events as this session's calls", () => {
    const subagent = { parent_tool_use_id: "toolu_task_1" };
    expect(
      replay([
        REQUESTING,
        streamEvent(
          { type: "message_start", message: { id: "msg_sub", usage: PROMPT_USAGE } },
          subagent,
        ),
        streamEvent(
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 9 },
          },
          subagent,
        ),
        RESULT,
      ]),
    ).toEqual([
      { phase: "send", callIndex: 0, t: 1_000, ...CC },
      { phase: "end", callIndex: 0, t: 1_003, ...CC },
    ]);
  });

  describe("sub-agent call counting (THALAMUS v4 D5, design F7)", () => {
    const sub = { parent_tool_use_id: "toolu_task_1" };
    const SUB_TURN = [
      REQUESTING,
      streamEvent(
        {
          type: "message_start",
          message: { id: "msg_sub", model: "claude-haiku-4-5", usage: PROMPT_USAGE },
        },
        sub,
      ),
      streamEvent(
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
        sub,
      ),
      RESULT,
    ];

    it("changes nothing the tracker returns: the per-call feed is the same with and without a counter", () => {
      const run = (withCounter: boolean) => {
        let next = 0;
        const tracker = createBridgeCallTracker(
          () => next++,
          withCounter ? () => undefined : undefined,
        );
        const frames = SUB_TURN.flatMap((line, i) => tracker.observe(line, 1_000 + i));
        frames.push(...tracker.close(2_000));
        return frames;
      };
      expect(run(true)).toEqual(run(false));
    });

    it("tells the counter each sub-agent call's model and counts, keyed by the parent tool call", () => {
      const seen: unknown[] = [];
      let next = 0;
      const tracker = createBridgeCallTracker(
        () => next++,
        (e) => seen.push(e),
      );
      SUB_TURN.forEach((line, i) => tracker.observe(line, 1_000 + i));
      expect(seen).toEqual([
        {
          phase: "start",
          parentToolUseId: "toolu_task_1",
          t: 1_001,
          model: "claude-haiku-4-5",
          input: 6,
          cacheRead: 140_000,
          cacheWrite: 2_100,
        },
        { phase: "end", parentToolUseId: "toolu_task_1", t: 1_002, output: 9 },
      ]);
    });

    it("never tells it about a main-thread call", () => {
      const seen: unknown[] = [];
      const tracker = createBridgeCallTracker(
        () => 0,
        (e) => seen.push(e),
      );
      ONE_CALL_TURN.forEach((line, i) => tracker.observe(line, 1_000 + i));
      expect(seen).toEqual([]);
    });

    it("reaches a registered worker provider through the telemetry path, and does nothing with none", () => {
      const SLOT = Symbol.for("openclaw.thalamus.workerProvider");
      const noted: unknown[] = [];
      const g = globalThis as Record<symbol, unknown>;
      try {
        const none = createBridgeCallTelemetry("run-sub", "sess-a");
        SUB_TURN.forEach((l) => none.observe(l));
        g[SLOT] = { noteSubagentCall: (e: unknown) => noted.push(e) };
        const t = createBridgeCallTelemetry("run-sub", "sess-a");
        SUB_TURN.forEach((l) => t.observe(l));
        t.close();
        expect(noted).toMatchObject([
          { sessionKey: "sess-a", phase: "start", model: "claude-haiku-4-5", inputTokens: 6 },
          { sessionKey: "sess-a", phase: "end", outputTokens: 9 },
        ]);
      } finally {
        delete g[SLOT];
      }
    });
  });

  it("ignores every line that is not a call marker", () => {
    expect(
      replay([
        INIT,
        asLine({ type: "system", subtype: "status", status: "compacting", session_id: SESSION }),
        asLine({ type: "system", subtype: "compact_boundary", session_id: SESSION }),
        TOOL_RESULT,
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x" },
        }),
        // A message_delta with no call open has nothing to end.
        messageDelta("end_turn", 3),
        streamEvent({ type: "message_stop" }),
      ]),
    ).toEqual([]);
  });

  it("publishes through the A8 owner with the session key, numbers calls per RUN, and needs a runId", () => {
    const seen: Array<{
      runId: string;
      stream: string;
      sessionKey?: string;
      data: Record<string, unknown>;
    }> = [];
    const unsubscribe = onAgentEvent((event) => {
      seen.push({
        runId: event.runId,
        stream: event.stream,
        sessionKey: event.sessionKey,
        data: event.data,
      });
    });
    try {
      createBridgeCallTelemetry(undefined, "agent:main:main").observe(REQUESTING);
      expect(seen).toEqual([]);

      // Two stream-fn invocations of ONE run (a retried attempt) continue the numbering.
      const runId = "run-bridge-call-telemetry";
      const firstAttempt = createBridgeCallTelemetry(runId, "agent:main:main");
      firstAttempt.observe(REQUESTING);
      firstAttempt.close();
      createBridgeCallTelemetry(runId, "agent:main:main").observe(REQUESTING);

      expect(seen.map((event) => [event.stream, event.data.phase, event.data.callIndex])).toEqual([
        ["call", "send", 0],
        ["call", "end", 0],
        ["call", "send", 1],
      ]);
      expect(seen[0]).toMatchObject({
        runId,
        sessionKey: "agent:main:main",
        data: { lane: "cc-bridge", provenance: "exact" },
      });
    } finally {
      unsubscribe();
    }
  });

  describe("composition from the CLI transcript (FORK 2026-10-02, cli-context.ts)", () => {
    const COMPOSITION = {
      moralCode: 0,
      systemPrompt: 40_000,
      injectedFiles: 9_000,
      skills: 8_000,
      toolSchemas: 33_000,
      conversation: 30_000,
      toolResults: 20_000,
      userMessage: 2_106,
    };

    /** Frames published for one run while `body` runs, as wire payloads. */
    function capture(runId: string, body: () => void): Record<string, unknown>[] {
      const frames: Record<string, unknown>[] = [];
      const unsubscribe = onAgentEvent((event) => {
        if (event.runId === runId && event.stream === "call") {
          frames.push(event.data);
        }
      });
      try {
        body();
      } finally {
        unsubscribe();
      }
      return frames;
    }

    it("puts the reader's composition of the billed prompt on the usage frame, and only there", () => {
      const calls: string[] = [];
      const reader = {
        refresh: () => {
          calls.push("refresh");
        },
        compose: (billed: number) => {
          calls.push(`compose:${billed}`);
          return COMPOSITION;
        },
      };
      let resolved = 0;
      const frames = capture("run-composition", () => {
        const t = createBridgeCallTelemetry("run-composition", "agent:main:main", () => {
          resolved++;
          return reader;
        });
        ONE_CALL_TURN.forEach((line) => t.observe(line));
        t.close();
      });
      expect(frames.map((frame) => [frame.phase, frame.composition])).toEqual([
        ["send", undefined],
        ["usage", COMPOSITION],
        ["end", undefined],
      ]);
      // Resolved, refreshed and composed once, for the usage frame, with input + cacheRead + cacheWrite.
      expect(resolved).toBe(1);
      expect(calls).toEqual(["refresh", "compose:142106"]);
    });

    it("sends the usage frame without a composition when there is no transcript yet", () => {
      const frames = capture("run-composition-none", () => {
        const t = createBridgeCallTelemetry(
          "run-composition-none",
          "agent:main:main",
          () => undefined,
        );
        ONE_CALL_TURN.forEach((line) => t.observe(line));
      });
      expect(frames.map((frame) => frame.phase)).toEqual(["send", "usage", "end"]);
      expect(frames.every((frame) => !("composition" in frame))).toBe(true);
    });

    it("never lets a failing reader break the call stream", () => {
      const throwing = [
        () => {
          throw new Error("resolver failed");
        },
        () => ({
          refresh: () => {
            throw new Error("EIO: transcript unreadable");
          },
          compose: () => COMPOSITION,
        }),
        () => ({
          refresh: () => undefined,
          compose: () => {
            throw new Error("compose failed");
          },
        }),
      ];
      throwing.forEach((contextFor, i) => {
        const runId = `run-composition-throws-${i}`;
        const frames = capture(runId, () => {
          const t = createBridgeCallTelemetry(runId, "agent:main:main", contextFor);
          expect(() => ONE_CALL_TURN.forEach((line) => t.observe(line))).not.toThrow();
        });
        expect(frames.map((frame) => frame.phase)).toEqual(["send", "usage", "end"]);
        expect(frames[1]).toMatchObject({ phase: "usage", ...PROMPT });
        expect(frames[1]).not.toHaveProperty("composition");
      });
    });
  });

  it("numbers the cc-bridge lane on its own: the embedded lane's calls of the same run do not shift it", () => {
    // A run that failed over: core's embedded producer has already numbered two calls of it.
    const runId = "run-bridge-call-lane";
    expect([allocateCallIndex(runId), allocateCallIndex(runId)]).toEqual([0, 1]);
    const indexes: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId) {
        indexes.push(event.data.callIndex);
      }
    });
    try {
      createBridgeCallTelemetry(runId, "agent:main:main").observe(REQUESTING);
    } finally {
      unsubscribe();
    }
    expect(indexes).toEqual([0]);
    // ...and the bridge's call did not advance the embedded lane's count either.
    expect(allocateCallIndex(runId)).toBe(2);
  });
});
