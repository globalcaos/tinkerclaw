// context-window-panel.md §6.1 A2 — the runner's compaction telemetry. Drives the REAL leaf and
// the REAL queued wrapper through compact.hooks.harness.ts (which mocks the runtime around them,
// not the agent-event bus) and reads what reaches the global bus.
//
// CONTROL: on the parent commit neither executor emitted anything, so every case below that
// expects a start / end pair saw [] there (finding F3b). The decline and pre-model cases expect []
// on both sides.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  contextEngineCompactMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
  sessionCompactImpl,
  sessionMessages,
} from "./compact.hooks.harness.js";

type LeafParams = Parameters<typeof import("./compact.js").compactEmbeddedPiSessionDirect>[0];
type QueuedParams = Parameters<typeof import("./compact.queued.js").compactEmbeddedPiSession>[0];
type EngineCompactParams = Parameters<
  typeof import("../../context-engine/delegate.js").delegateCompactionToRuntime
>[0];

let compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
let compactEmbeddedPiSession: typeof import("./compact.queued.js").compactEmbeddedPiSession;
let queued: typeof import("./compact.queued.js");
let delegate: typeof import("../../context-engine/delegate.js");

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";

function leafArgs(overrides: Record<string, unknown> = {}): LeafParams {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_FILE,
    workspaceDir: TEST_WORKSPACE_DIR,
    ...overrides,
  } as LeafParams;
}

function queuedArgs(overrides: Record<string, unknown> = {}): QueuedParams {
  return {
    ...leafArgs(),
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    ...overrides,
  } as QueuedParams;
}

/** Run `run` with a listener on the global bus; return its value and every compaction event. */
async function withCompactionEvents<T>(
  run: () => Promise<T>,
): Promise<{ value: T; events: AgentEventPayload[] }> {
  const events: AgentEventPayload[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.stream === "compaction") {
      events.push(evt);
    }
  });
  try {
    return { value: await run(), events };
  } finally {
    stop();
  }
}

const phases = (events: AgentEventPayload[]) => events.map((evt) => evt.data.phase);

/** An engine whose compact() hands the algorithm back to the runtime, as delegate.ts invites. */
function delegatingEngine(ownsCompaction: boolean) {
  const compact = vi.fn(
    async (params: EngineCompactParams) => await delegate.delegateCompactionToRuntime(params),
  );
  resolveContextEngineMock.mockResolvedValue({ info: { ownsCompaction }, compact } as never);
  return compact;
}

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactEmbeddedPiSessionDirect = loaded.compactEmbeddedPiSessionDirect;
  compactEmbeddedPiSession = loaded.compactEmbeddedPiSession;
  // Imported after the harness's vi.doMock calls, so these are the instances under test.
  queued = await import("./compact.queued.js");
  delegate = await import("../../context-engine/delegate.js");
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("compactEmbeddedPiSessionDirect compaction telemetry (the leaf)", () => {
  it("emits exactly one start and one end for a runner gate's compaction", async () => {
    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(
        leafArgs({ runId: "run-overflow", trigger: "overflow", currentTokenCount: 150_000 }),
      ),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({
      runId: "run-overflow",
      sessionKey: TEST_SESSION_KEY,
      data: {
        phase: "start",
        trigger: "overflow",
        lane: "embedded",
        provenance: "estimated",
        tokensBefore: 150_000,
      },
    });
    expect(events[1]).toMatchObject({
      runId: "run-overflow",
      sessionKey: TEST_SESSION_KEY,
      data: {
        phase: "end",
        trigger: "overflow",
        lane: "embedded",
        provenance: "estimated",
        completed: true,
        tokensBefore: 150_000,
        tokensAfter: 10,
      },
    });
    // The same figures the leaf returns, so the RPC reply and the stream never disagree.
    expect(events[1]?.data.tokensBefore).toBe(result.result?.tokensBefore);
    expect(events[1]?.data.tokensAfter).toBe(result.result?.tokensAfter);
    expect(events[1]?.data.durationMs).toEqual(expect.any(Number));
  });

  it("names each runner trigger and lane in the contract's own terms", () => {
    const trigger = queued.resolveRunnerCompactionTrigger;
    expect(trigger("overflow")).toBe("overflow");
    expect(trigger("timeout_recovery")).toBe("timeout");
    expect(trigger("budget")).toBe("queued");
    expect(trigger("cli_budget")).toBe("preemptive");
    expect(trigger("manual")).toBe("manual");
    expect(trigger(undefined)).toBe("manual");
    const lane = queued.resolveRunnerCompactionLane;
    expect(lane("claude-code")).toBe("cc-bridge");
    expect(lane("Claude-Code")).toBe("cc-bridge");
    expect(lane("anthropic")).toBe("embedded");
    expect(lane("claude-cli")).toBe("embedded");
    expect(lane(undefined)).toBe("embedded");
  });

  it("mints one run id for a compaction outside a run and uses it for both events", async () => {
    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "timeout_recovery" })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[0]?.data).toMatchObject({ trigger: "timeout", lane: "embedded" });
    // No caller-observed count: the start knows nothing yet and says so by omission (P10).
    expect(events[0]?.data).not.toHaveProperty("tokensBefore");
    expect(events[0]?.runId).toMatch(/^compaction:/);
    expect(events[1]?.runId).toBe(events[0]?.runId);
  });

  it("emits nothing when the leaf declines (no real conversation to compact)", async () => {
    sessionMessages.splice(
      0,
      sessionMessages.length,
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "checking" }], timestamp: 2 },
    );

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "overflow", currentTokenCount: 9_000 })),
    );

    expect(result).toMatchObject({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });
    expect(events).toEqual([]);
  });

  it("emits nothing when the leaf fails before any compaction starts", async () => {
    resolveModelMock.mockReturnValue({
      model: undefined,
      error: "Unknown model",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "overflow" })),
    );

    expect(result.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("closes the pair with completed:false when the compaction itself fails", async () => {
    sessionCompactImpl.mockRejectedValue(new Error("provider exploded"));

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "overflow", currentTokenCount: 9_000 })),
    );

    expect(result.ok).toBe(false);
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: false, tokensBefore: 9_000 });
    expect(events[1]?.data).not.toHaveProperty("tokensAfter");
  });

  it("keeps one pair across a reasoning-level retry of the same compaction", async () => {
    sessionCompactImpl.mockRejectedValueOnce(new Error("Reasoning is mandatory for this endpoint"));

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "overflow" })),
    );

    expect(sessionCompactImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: true });
  });
});

describe("compactEmbeddedPiSession compaction telemetry (the engine-owned branch)", () => {
  it("emits one pair around an owning engine's compaction, named by the caller's trigger", async () => {
    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "manual", currentTokenCount: 4_000 })),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({
      sessionKey: TEST_SESSION_KEY,
      data: {
        phase: "start",
        trigger: "manual",
        lane: "embedded",
        provenance: "estimated",
        tokensBefore: 4_000,
      },
    });
    expect(events[0]?.runId).toMatch(/^compaction:/);
    expect(events[1]).toMatchObject({
      runId: events[0]?.runId,
      data: {
        phase: "end",
        trigger: "manual",
        completed: true,
        tokensBefore: 4_000,
        tokensAfter: 50,
      },
    });
  });

  it("puts a tinker-bridge session's compaction on the cc-bridge lane", async () => {
    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(
        queuedArgs({ trigger: "budget", provider: "claude-code", contextTokenBudget: 100_000 }),
      ),
    );

    expect(events.map((evt) => evt.data)).toEqual([
      expect.objectContaining({ phase: "start", trigger: "queued", lane: "cc-bridge" }),
      expect.objectContaining({ phase: "end", lane: "cc-bridge", completed: true }),
    ]);
  });

  it("closes the open pair with completed:false when an owning engine declines", async () => {
    // An owning engine is opaque: its refusal is only visible once compact() returns, after the
    // real-time start. A decline the leaf decides itself comes before its start (see above).
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
      result: undefined,
    });

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: false });
    expect(events[1]?.data).not.toHaveProperty("tokensAfter");
  });

  it("closes the pair with completed:false when an owning engine throws, and rethrows", async () => {
    contextEngineCompactMock.mockRejectedValue(new Error("engine exploded"));

    const { value: thrown, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })).catch((err: unknown) => err),
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: false });
  });

  it("emits one pair, not two, when an owning engine delegates back to the leaf", async () => {
    const compact = delegatingEngine(true);

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    expect(compact).toHaveBeenCalledTimes(1);
    // The leaf really compacted, and stayed silent: the wrapper had already opened the pair.
    expect(sessionCompactImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ trigger: "queued", completed: true, tokensAfter: 10 });
  });

  it("leaves the pair to the leaf when the engine does not own compaction", async () => {
    const compact = delegatingEngine(false);

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget", runId: "run-preflight" })),
    );

    expect(compact).toHaveBeenCalledTimes(1);
    expect(sessionCompactImpl).toHaveBeenCalledTimes(1);
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events.map((evt) => evt.runId)).toEqual(["run-preflight", "run-preflight"]);
  });

  it("emits nothing from the wrapper for an engine that does not own compaction", async () => {
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    // This stand-in engine never reaches the leaf, and the wrapper leaves the pair to the leaf.
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });
});

// FORK 2026-09-25 — the drop a compaction measured itself rides the runner's `end` as
// tokensDropped (the A1 contract takes that figure only from an executor that measured it).
// engram's details.tokensEvicted is that figure, the one sessions.compact already replies with as
// `evictedTokens`; before minus after is not (on the engram path tokensBefore is a store-wide
// running total). Covers BOTH runner executors: the engine-owned branch of compactEmbeddedPiSession
// and the leaf's own completed `end` (compactEmbeddedPiSessionDirect, compact.ts, wired
// 2026-09-25), which the default legacy engine reaches. CONTROL: each "carries" case fails on the
// commit before its executor was wired (the reader and the engine-owned cases on the measured-drop
// fork's parent; the direct-leaf case on this fork's parent); the absent and declined cases pass on
// both sides.
describe("runner compaction telemetry: the measured drop (tokensDropped)", () => {
  const ENGRAM_DETAILS = { engramEventsStored: 48, tokensEvicted: 128_260 };

  it("reads a result's own measured drop off its details, and nothing else", () => {
    const read = queued.readMeasuredCompactionDrop;
    expect(read(ENGRAM_DETAILS)).toBe(128_260);
    // A measured 0 is a real 0 (P10), unlike the RPC reply's `> 0` guard.
    expect(read({ tokensEvicted: 0 })).toBe(0);
    for (const details of [
      undefined,
      null,
      "128260",
      128_260,
      { ok: true },
      { tokensEvicted: -1 },
      { tokensEvicted: Number.NaN },
      { tokensEvicted: "900" },
    ]) {
      expect(read(details)).toBeUndefined();
    }
  });

  it("carries an owning engine's measured drop on its completed end", async () => {
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engram-summary",
        tokensBefore: 7_855_029,
        tokensAfter: 50,
        details: ENGRAM_DETAILS,
      },
    } as never);

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "manual" })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({
      trigger: "manual",
      completed: true,
      tokensDropped: 128_260,
    });
    // The details sessions.compact reads its reply's `evictedTokens` off: one number, two carriers.
    expect(result.result?.details).toEqual(ENGRAM_DETAILS);
  });

  it("carries the leaf's measured drop when an owning engine delegates back to it", async () => {
    delegatingEngine(true);
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { engramEventsStored: 3, tokensEvicted: 900 },
    } as never);

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({
      trigger: "queued",
      completed: true,
      tokensDropped: 900,
    });
  });

  it("carries the leaf's own measured drop on its completed end (the default engine's path)", async () => {
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: ENGRAM_DETAILS,
    } as never);

    const { value: result, events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "manual" })),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({
      trigger: "manual",
      completed: true,
      tokensDropped: 128_260,
    });
    // The leaf returns the same details, so the reply's evictedTokens and the stream agree.
    expect(result.result?.details).toEqual(ENGRAM_DETAILS);
  });

  it("sends no tokensDropped when nothing measured one", async () => {
    // The harness's leaf result has details { ok: true }: no drop measured, so none is sent (P10).
    delegatingEngine(true);

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    expect(events[1]?.data).toMatchObject({ completed: true });
    expect(events[1]?.data).not.toHaveProperty("tokensDropped");
  });

  it("sends no tokensDropped for a compaction that did not happen", async () => {
    // A declined compaction dropped nothing, whatever its details say.
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
      result: { summary: "", tokensBefore: 10, details: ENGRAM_DETAILS },
    } as never);

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSession(queuedArgs({ trigger: "budget" })),
    );

    expect(events[1]?.data).toMatchObject({ completed: false });
    expect(events[1]?.data).not.toHaveProperty("tokensDropped");
  });

  it("sends no tokensDropped from a leaf end whose result measured no drop", async () => {
    // The harness's leaf result has details { ok: true }: nothing measured, so none is sent (P10).
    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "manual" })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: true });
    expect(events[1]?.data).not.toHaveProperty("tokensDropped");
  });

  it("sends no tokensDropped on a leaf end closed as not completed", async () => {
    sessionCompactImpl.mockRejectedValue(new Error("provider exploded"));

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "manual", currentTokenCount: 9_000 })),
    );

    expect(phases(events)).toEqual(["start", "end"]);
    expect(events[1]?.data).toMatchObject({ completed: false });
    expect(events[1]?.data).not.toHaveProperty("tokensDropped");
  });

  it("emits no end at all from a leaf that declines, so no drop rides anywhere", async () => {
    // A decline the leaf decides itself precedes its start (see the leaf describe above).
    sessionMessages.splice(
      0,
      sessionMessages.length,
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "checking" }], timestamp: 2 },
    );

    const { events } = await withCompactionEvents(() =>
      compactEmbeddedPiSessionDirect(leafArgs({ trigger: "manual" })),
    );

    expect(events).toEqual([]);
  });
});
