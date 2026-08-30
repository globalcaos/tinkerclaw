import { beforeEach, describe, expect, it, vi } from "vitest";

const emitAgentEventMock = vi.hoisted(() => vi.fn());

vi.mock("./agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => emitAgentEventMock(...args),
}));

import { type CacheTelemetrySample, emitCacheTelemetry } from "./cache-telemetry.js";

type EmittedEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

function sample(overrides: Partial<CacheTelemetrySample> = {}): CacheTelemetrySample {
  return {
    runId: "run-1",
    sessionKey: "agent:main:main",
    model: "claude-opus-4-8",
    provider: "anthropic",
    input: 120,
    output: 42,
    cacheRead: 8000,
    cacheWrite: 1500,
    promptTokens: 9620,
    contextTokens: 200000,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function lastEvent(): EmittedEvent {
  const call = emitAgentEventMock.mock.calls.at(-1);
  return call?.[0] as EmittedEvent;
}

describe("emitCacheTelemetry", () => {
  beforeEach(() => {
    emitAgentEventMock.mockReset();
  });

  it('emits one stream:"cache" event carrying the per-call payload', () => {
    emitCacheTelemetry(sample());

    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.stream).toBe("cache");
    expect(event.runId).toBe("run-1");
    expect(event.sessionKey).toBe("agent:main:main");
    expect(event.data).toStrictEqual({
      phase: "call",
      model: "claude-opus-4-8",
      provider: "anthropic",
      input: 120,
      output: 42,
      cacheRead: 8000,
      cacheWrite: 1500,
      promptTokens: 9620,
      contextTokens: 200000,
      timestampMs: 1_700_000_000_000,
    });
  });

  it("omits optional fields instead of sending explicit undefined", () => {
    emitCacheTelemetry({
      runId: "run-2",
      model: "gpt-5.6-sol",
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 10,
      timestampMs: 5,
    });

    const event = lastEvent();
    expect("sessionKey" in event).toBe(false);
    expect(event.data).toStrictEqual({
      phase: "call",
      model: "gpt-5.6-sol",
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 10,
      timestampMs: 5,
    });
  });

  it("drops the sample when runId is missing", () => {
    emitCacheTelemetry(sample({ runId: "" }));
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("drops the sample when model is missing", () => {
    emitCacheTelemetry(sample({ model: "" }));
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("drops the sample when promptTokens is 0 (nothing to show)", () => {
    emitCacheTelemetry(sample({ promptTokens: 0 }));
    emitCacheTelemetry(sample({ promptTokens: -1 }));
    emitCacheTelemetry(sample({ promptTokens: Number.NaN }));
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("coerces non-finite, negative and NaN counters to 0", () => {
    emitCacheTelemetry(
      sample({
        input: -5,
        output: Number.NaN,
        cacheRead: Number.POSITIVE_INFINITY,
        cacheWrite: -0.5,
        contextTokens: Number.NaN,
        timestampMs: Number.NEGATIVE_INFINITY,
      }),
    );

    expect(lastEvent().data).toStrictEqual({
      phase: "call",
      model: "claude-opus-4-8",
      provider: "anthropic",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 9620,
      contextTokens: 0,
      timestampMs: 0,
    });
  });

  it("never throws into the serving path when emitAgentEvent throws", () => {
    emitAgentEventMock.mockImplementation(() => {
      throw new Error("listener blew up");
    });

    expect(() => emitCacheTelemetry(sample())).not.toThrow();
    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
  });
});
