import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitAgentEventMock = vi.hoisted(() => vi.fn());

// Partial mock: the embedded producer's module graph uses other agent-events exports too.
vi.mock("./agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-events.js")>()),
  emitAgentEvent: (...args: unknown[]) => emitAgentEventMock(...args),
}));

import {
  closeEmbeddedCall,
  noteEmbeddedCallUsage,
  openEmbeddedCall,
} from "../agents/embedded-agent-subscribe.handlers.messages.js";
import {
  allocateCallIndex,
  buildCallEventData,
  callLaneForProvider,
  emitCallTelemetry,
  resetCallIndexesForTest,
} from "./call-telemetry.js";

// FORK 2026-09-24 (A8, context-window-panel.md §6.1): the stream:"call" contract has ONE owner.
// The first block pins its shape and the absent-not-zero rule. The second drives the EMBEDDED
// producer with pi assistant messages shaped like the ones pi-ai streams: usage zero-initialised
// at `start`, the prompt side filled once the provider reports it. The numbers are synthetic; the
// shapes are pi-ai's AssistantMessage and Usage.

type BusEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

const emitted = (): BusEvent[] => emitAgentEventMock.mock.calls.map(([event]) => event as BusEvent);

describe("call telemetry contract", () => {
  beforeEach(() => {
    emitAgentEventMock.mockReset();
  });

  it("emits one end event with the full contract on the bus", () => {
    emitCallTelemetry(
      { runId: "run-1", sessionKey: "agent:main:main" },
      {
        phase: "end",
        callIndex: 3,
        t: 1_764_000_000_000,
        lane: "cc-bridge",
        provenance: "exact",
        input: 6,
        cacheRead: 140_000,
        cacheWrite: 2_100,
        output: 1_900,
        stopReason: "end_turn",
      },
    );
    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      stream: "call",
      data: {
        phase: "end",
        callIndex: 3,
        t: 1_764_000_000_000,
        lane: "cc-bridge",
        provenance: "exact",
        input: 6,
        cacheRead: 140_000,
        cacheWrite: 2_100,
        output: 1_900,
        stopReason: "end_turn",
      },
    });
  });

  it("a send carries its identity and an estimate, never a count or a stop reason", () => {
    expect(
      buildCallEventData({
        phase: "send",
        callIndex: 0,
        t: 10,
        lane: "cc-bridge",
        provenance: "exact",
      }),
    ).toEqual({ phase: "send", callIndex: 0, t: 10, lane: "cc-bridge", provenance: "exact" });
    expect(
      buildCallEventData({
        phase: "send",
        callIndex: 0,
        t: 10,
        lane: "embedded",
        provenance: "estimated",
        promptTokensEstimate: 6_012,
      }),
    ).toEqual({
      phase: "send",
      callIndex: 0,
      t: 10,
      lane: "embedded",
      provenance: "estimated",
      promptTokensEstimate: 6_012,
    });
  });

  it("omits an unknown count instead of zeroing it", () => {
    for (const unknownValue of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const data = buildCallEventData({
        phase: "end",
        callIndex: 1,
        t: 20,
        lane: "embedded",
        provenance: "exact",
        input: unknownValue,
        cacheRead: unknownValue,
        cacheWrite: unknownValue,
        output: unknownValue,
      });
      for (const key of ["input", "cacheRead", "cacheWrite", "output"]) {
        expect(key in data, `${key} for ${String(unknownValue)}`).toBe(false);
      }
    }
  });

  it("keeps a measured 0: absent means unknown, 0 means measured nothing", () => {
    expect(
      buildCallEventData({
        phase: "usage",
        callIndex: 1,
        t: 20,
        lane: "embedded",
        provenance: "exact",
        input: 0,
        cacheRead: 0,
      }),
    ).toEqual({
      phase: "usage",
      callIndex: 1,
      t: 20,
      lane: "embedded",
      provenance: "exact",
      input: 0,
      cacheRead: 0,
    });
  });

  // FORK 2026-10-02 — a usage frame may carry the call's itemised prompt (CallComposition).
  it("carries a usage frame's composition on the panel's keys, measured values only", () => {
    const data = buildCallEventData({
      phase: "usage",
      callIndex: 3,
      t: 10,
      lane: "cc-bridge",
      provenance: "exact",
      cacheRead: 90_000,
      composition: {
        moralCode: 12_000,
        systemPrompt: 40_000,
        toolResults: 38_000,
        conversation: 0,
        userMessage: Number.NaN,
        // A key outside the contract never reaches the wire.
        ...({ unitemised: 5 } as Record<string, number>),
      },
    });
    expect(data.composition).toEqual({
      moralCode: 12_000,
      systemPrompt: 40_000,
      conversation: 0,
      toolResults: 38_000,
    });
    // Nothing measured: no composition key at all, never an empty object.
    expect(
      buildCallEventData({
        phase: "usage",
        callIndex: 3,
        t: 10,
        lane: "cc-bridge",
        provenance: "exact",
        composition: { skills: -1 },
      }),
    ).not.toHaveProperty("composition");
    // Only `usage` carries it.
    expect(
      buildCallEventData({
        phase: "end",
        callIndex: 3,
        t: 11,
        lane: "cc-bridge",
        provenance: "exact",
        ...({ composition: { skills: 5 } } as object),
      }),
    ).not.toHaveProperty("composition");
  });

  it("drops a blank stop reason, and emits nothing without a runId", () => {
    expect(
      buildCallEventData({
        phase: "end",
        callIndex: 1,
        t: 20,
        lane: "embedded",
        provenance: "exact",
        stopReason: "   ",
      }),
    ).toEqual({ phase: "end", callIndex: 1, t: 20, lane: "embedded", provenance: "exact" });
    emitCallTelemetry(
      { runId: "" },
      { phase: "send", callIndex: 0, t: 1, lane: "cc-bridge", provenance: "exact" },
    );
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("leaves sessionKey off the bus event when the producer has none", () => {
    emitCallTelemetry(
      { runId: "run-2" },
      { phase: "send", callIndex: 0, t: 1, lane: "cc-bridge", provenance: "exact" },
    );
    expect("sessionKey" in (emitAgentEventMock.mock.calls[0]?.[0] as object)).toBe(false);
  });

  it("numbers calls per run from 0, independently for each run", () => {
    resetCallIndexesForTest();
    expect([
      allocateCallIndex("run-a"),
      allocateCallIndex("run-a"),
      allocateCallIndex("run-b"),
      allocateCallIndex("run-a"),
    ]).toEqual([0, 1, 0, 2]);
  });

  it("names the cc-bridge lane by the bridge's provider id and nothing else", () => {
    expect(callLaneForProvider("claude-code")).toBe("cc-bridge");
    expect(callLaneForProvider("anthropic")).toBe("embedded");
    expect(callLaneForProvider(undefined)).toBe("embedded");
  });
});

type Counts = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** pi-ai's Usage: every field present, zero until the provider reports a value. */
function piUsage(counts: Counts = {}) {
  const input = counts.input ?? 0;
  const output = counts.output ?? 0;
  const cacheRead = counts.cacheRead ?? 0;
  const cacheWrite = counts.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(fields: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5",
    usage: piUsage(),
    stopReason: "stop",
    timestamp: 0,
    ...fields,
  } as unknown as AgentMessage;
}

const producerCtx = (runId: string) => ({ params: { runId, sessionKey: "agent:main:main" } });

const PROMPT = { input: 6, cacheRead: 140_000, cacheWrite: 2_100 };

describe("the embedded producer (embedded-agent-subscribe.handlers.messages.ts)", () => {
  beforeEach(() => {
    emitAgentEventMock.mockReset();
    resetCallIndexesForTest();
  });

  it("emits usage at the first update that carries a prompt, and end at message_end", () => {
    const ctx = producerCtx("run-embedded-1");
    openEmbeddedCall(ctx, assistant());
    // pi-ai's `start` partial: usage zero-initialised, nothing measured yet.
    noteEmbeddedCallUsage(ctx, assistant());
    expect(emitAgentEventMock).not.toHaveBeenCalled();
    // The SSE message_start has filled the prompt side; later updates must not repeat it.
    noteEmbeddedCallUsage(ctx, assistant({ usage: piUsage({ ...PROMPT, output: 1 }) }));
    noteEmbeddedCallUsage(ctx, assistant({ usage: piUsage({ ...PROMPT, output: 40 }) }));
    closeEmbeddedCall(
      ctx,
      assistant({ usage: piUsage({ ...PROMPT, output: 1_900 }), stopReason: "toolUse" }),
    );

    const events = emitted();
    expect(events.map((event) => event.stream)).toEqual(["call", "call"]);
    expect(events[0]).toMatchObject({ runId: "run-embedded-1", sessionKey: "agent:main:main" });
    expect(events[0]?.data).toEqual({
      phase: "usage",
      callIndex: 0,
      t: expect.any(Number),
      lane: "embedded",
      provenance: "exact",
      ...PROMPT,
    });
    expect(events[1]?.data).toEqual({
      phase: "end",
      callIndex: 0,
      t: expect.any(Number),
      lane: "embedded",
      provenance: "exact",
      ...PROMPT,
      output: 1_900,
      stopReason: "toolUse",
    });
  });

  it("still sends usage before end when the provider reports usage only as the call ends", () => {
    const ctx = producerCtx("run-embedded-2");
    const openai = { api: "openai-completions", provider: "openai" };
    openEmbeddedCall(ctx, assistant(openai));
    noteEmbeddedCallUsage(ctx, assistant(openai));
    closeEmbeddedCall(
      ctx,
      assistant({ ...openai, usage: piUsage({ input: 900, cacheRead: 3_000, output: 120 }) }),
    );
    expect(emitted().map((event) => [event.data.phase, event.data.callIndex])).toEqual([
      ["usage", 0],
      ["end", 0],
    ]);
    expect(emitted()[1]?.data).toMatchObject({
      input: 900,
      cacheRead: 3_000,
      cacheWrite: 0,
      output: 120,
      stopReason: "stop",
    });
  });

  it("ends a call that died unmeasured with its stop reason and no fabricated zeros", () => {
    const ctx = producerCtx("run-embedded-3");
    openEmbeddedCall(ctx, assistant());
    closeEmbeddedCall(ctx, assistant({ stopReason: "error" }));
    expect(emitted().map((event) => event.data)).toEqual([
      {
        phase: "end",
        callIndex: 0,
        t: expect.any(Number),
        lane: "embedded",
        provenance: "exact",
        stopReason: "error",
      },
    ]);
  });

  it("numbers the calls of one run in the order they began", () => {
    const ctx = producerCtx("run-embedded-4");
    for (const stopReason of ["toolUse", "stop"]) {
      openEmbeddedCall(ctx, assistant());
      closeEmbeddedCall(ctx, assistant({ stopReason }));
    }
    expect(emitted().map((event) => [event.data.callIndex, event.data.stopReason])).toEqual([
      [0, "toolUse"],
      [1, "stop"],
    ]);
  });

  it("skips the claude-code lane: its pi message is a turn aggregate, the bridge reports its calls", () => {
    const ctx = producerCtx("run-embedded-5");
    const turn = assistant({
      provider: "claude-code",
      usage: piUsage({ input: 6_448_106, output: 9_000 }),
    });
    openEmbeddedCall(ctx, turn);
    noteEmbeddedCallUsage(ctx, turn);
    closeEmbeddedCall(ctx, turn);
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });
});
