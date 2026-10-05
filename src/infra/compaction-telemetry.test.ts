import { beforeEach, describe, expect, it, vi } from "vitest";

const emitAgentEventMock = vi.hoisted(() => vi.fn());
const emitEventMock = vi.hoisted(() => vi.fn());

vi.mock("./agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => emitAgentEventMock(...args),
}));

// A4: the events writer's emit, spied — the ledger row an `end` writes (compaction-ledger.test.ts
// runs the real writer on a temp database).
vi.mock("./events/emit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./events/emit.js")>()),
  emitEvent: (...args: unknown[]) => emitEventMock(...args),
}));

import {
  buildCompactionEventData,
  compactionTokenCount,
  emitCompactionTelemetry,
} from "./compaction-telemetry.js";
import { getCatalogEvent } from "./events/catalog.js";

// FORK 2026-09-24 (A1, context-window-panel.md §6.1): the stream:"compaction" contract has ONE
// owner. These pin its shape and the absent-not-zero rule. pi-auto is on the full contract too
// (its payload is pinned by embedded-agent-subscribe.handlers.compaction.test.ts), so the legacy
// emitter and its tests are gone.
describe("compaction telemetry contract", () => {
  beforeEach(() => {
    emitAgentEventMock.mockReset();
    emitEventMock.mockReset();
  });

  it("emits one end event with the full contract, to the bus and to the run-local listener", () => {
    const listener = vi.fn();
    emitCompactionTelemetry(
      { runId: "run-1", sessionKey: "agent:main:main", onAgentEvent: listener },
      {
        phase: "end",
        trigger: "cli-internal",
        lane: "cc-bridge",
        provenance: "exact",
        completed: true,
        tokensBefore: 981_000,
        tokensAfter: 15_300,
        durationMs: 121_000,
      },
    );

    const data = {
      phase: "end",
      trigger: "cli-internal",
      lane: "cc-bridge",
      provenance: "exact",
      completed: true,
      tokensBefore: 981_000,
      tokensAfter: 15_300,
      durationMs: 121_000,
    };
    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      stream: "compaction",
      data,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ stream: "compaction", data });
  });

  it("a start event says who compacted and carries no end-only field", () => {
    expect(
      buildCompactionEventData({
        phase: "start",
        trigger: "manual",
        lane: "embedded",
        provenance: "estimated",
      }),
    ).toEqual({ phase: "start", trigger: "manual", lane: "embedded", provenance: "estimated" });
  });

  it("omits an unknown number instead of zeroing it", () => {
    for (const unknownValue of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const data = buildCompactionEventData({
        phase: "end",
        trigger: "evict",
        lane: "embedded",
        provenance: "estimated",
        completed: true,
        tokensBefore: unknownValue,
        tokensAfter: unknownValue,
        tokensDropped: unknownValue,
        durationMs: unknownValue,
      });
      for (const key of ["tokensBefore", "tokensAfter", "tokensDropped", "durationMs"]) {
        expect(key in data, `${key} for ${String(unknownValue)}`).toBe(false);
      }
    }
  });

  it("keeps a measured zero: absent means unknown, 0 means measured nothing", () => {
    const data = buildCompactionEventData({
      phase: "end",
      trigger: "evict",
      lane: "embedded",
      provenance: "estimated",
      completed: false,
      tokensDropped: 0,
    });
    expect(data.tokensDropped).toBe(0);
    expect(data.completed).toBe(false);
  });

  it("leaves sessionKey off the bus event when the producer has none", () => {
    emitCompactionTelemetry(
      { runId: "run-2" },
      { phase: "start", trigger: "preemptive", lane: "embedded", provenance: "estimated" },
    );
    const event = emitAgentEventMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("sessionKey" in event).toBe(false);
  });

  it("A4: an end writes ONE compaction.run row in the shape its catalog row declares; a start none", () => {
    const target = { runId: "run-3", sessionKey: " agent:main:tinker:a4 " };
    emitCompactionTelemetry(target, {
      phase: "start",
      trigger: "manual",
      lane: "embedded",
      provenance: "estimated",
    });
    expect(emitEventMock).not.toHaveBeenCalled();

    emitCompactionTelemetry(target, {
      phase: "end",
      trigger: "manual",
      lane: "embedded",
      provenance: "estimated",
      completed: true,
      tokensBefore: 1_000,
      tokensAfter: 250,
      durationMs: 40,
    });
    expect(emitEventMock).toHaveBeenCalledTimes(1);
    const [name, record] = emitEventMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("compaction.run");
    expect(record).toEqual({
      tsMs: expect.any(Number),
      sessionKey: "agent:main:tinker:a4",
      runId: "run-3",
      label: "completed",
      durMs: 40,
      n1: 1_000,
      n2: 250,
      n3: 750,
      fields: { trigger: "manual", lane: "embedded", provenance: "estimated" },
    });
    // Every slot and field key it fills is one the catalog declares (the writer drops the rest).
    const declared = getCatalogEvent("compaction.run");
    expect(declared?.kind).toBe("span");
    for (const slot of ["label", "durMs", "n1", "n2", "n3"] as const) {
      expect(declared?.[slot], slot).not.toBeNull();
    }
    expect(Object.keys(record.fields as object).filter((key) => !declared?.fields[key])).toEqual(
      [],
    );
  });

  it("A4: an unknown figure is written as NULL, never 0, and an incomplete end says so", () => {
    emitCompactionTelemetry(
      { runId: "run-4" },
      {
        phase: "end",
        trigger: "pi-auto",
        lane: "embedded",
        provenance: "estimated",
        completed: false,
      },
    );
    expect(emitEventMock).toHaveBeenCalledTimes(1);
    const [, record] = emitEventMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(record).toMatchObject({
      sessionKey: null,
      label: "incomplete",
      durMs: null,
      n1: null,
      n2: null,
      n3: null,
    });
  });

  it("compactionTokenCount is the single absent-not-zero rule", () => {
    expect(compactionTokenCount(12)).toBe(12);
    expect(compactionTokenCount(0)).toBe(0);
    expect(compactionTokenCount("12")).toBeUndefined();
    expect(compactionTokenCount(-5)).toBeUndefined();
    expect(compactionTokenCount(Number.NaN)).toBeUndefined();
  });
});
