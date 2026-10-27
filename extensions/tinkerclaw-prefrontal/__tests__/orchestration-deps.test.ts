import { describe, it, expect } from "vitest";
import {
  extractLastAssistantText,
  createProductionOrchestrationRuntime,
  type CallGateway,
} from "../orchestration-deps.js";

describe("extractLastAssistantText", () => {
  it("returns the last assistant message's string content", () => {
    expect(
      extractLastAssistantText([
        { role: "user", content: "q" },
        { role: "assistant", content: "first" },
        { role: "assistant", content: "the answer" },
      ]),
    ).toBe("the answer");
  });
  it("joins array-of-blocks content", () => {
    expect(
      extractLastAssistantText([
        { role: "assistant", content: [{ text: "hel" }, { text: "lo" }, { type: "tool" }] },
      ]),
    ).toBe("hello");
  });
  it("returns empty when there is no assistant text", () => {
    expect(extractLastAssistantText([{ role: "user", content: "q" }])).toBe("");
    expect(extractLastAssistantText(undefined)).toBe("");
  });
});

function mockGateway(
  history: unknown,
  opts?: { spawnOk?: boolean; waitStatus?: string; waitStopReason?: string },
): {
  call: CallGateway;
  methods: string[];
} {
  const methods: string[] = [];
  const call = (async (args: { method: string }) => {
    methods.push(args.method);
    if (args.method === "fork.subagents.spawn")
      return opts?.spawnOk === false
        ? { ok: false, note: "boom" }
        : { ok: true, childSessionKey: "cs", runId: "r1" };
    if (args.method === "agent.wait")
      return { status: opts?.waitStatus ?? "ok", stopReason: opts?.waitStopReason };
    if (args.method === "chat.history") return { messages: history };
    return {};
  }) as unknown as CallGateway;
  return { call, methods };
}

describe("createProductionOrchestrationRuntime", () => {
  it("agent() spawns via the gateway and returns the final assistant text", async () => {
    const { call, methods } = mockGateway([
      { role: "user", content: "question" },
      { role: "assistant", content: "the answer" },
    ]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    const out = await rt.agent("question");
    expect(out).toBe("the answer");
    expect(methods).toEqual(["fork.subagents.spawn", "agent.wait", "chat.history"]);
  });

  it("throws when the spawn fails", async () => {
    const { call } = mockGateway([], { spawnOk: false });
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    await expect(rt.agent("q")).rejects.toThrow(/spawn failed/i);
  });

  it("throws on a wait timeout and never reads history", async () => {
    // Since 2c96563f464 (2026-06-05) a timeout throws: an empty string chained into the next agent(prev) would
    // spawn a taskless subagent. This test still expected "" and failed from then on.
    const { call, methods } = mockGateway([{ role: "assistant", content: "x" }], {
      waitStatus: "timeout",
    });
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    await expect(rt.agent("q")).rejects.toThrow(/timed out/);
    expect(methods).toEqual(["fork.subagents.spawn", "agent.wait"]); // never reached chat.history
  });

  it("drives parallel() over the real spawn path", async () => {
    const { call } = mockGateway([{ role: "assistant", content: "ok" }]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    const res = await rt.parallel([() => rt.agent("a"), () => rt.agent("b")]);
    // SS5b: parallel() now returns Settled<T> partials, not raw values.
    expect(res).toEqual([
      { ok: true, value: "ok" },
      { ok: true, value: "ok" },
    ]);
  });

  it("throws a classified 'budget-exceeded' error when the wait reports status:'exhausted'", async () => {
    const { call, methods } = mockGateway([{ role: "assistant", content: "x" }], {
      waitStatus: "exhausted",
    });
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    let caught: unknown;
    try {
      await rt.agent("q");
    } catch (e) {
      caught = e;
    }
    expect((caught as { kind?: string } | undefined)?.kind).toBe("budget-exceeded");
    expect((caught as { recoverable?: boolean } | undefined)?.recoverable).toBe(false);
    expect(methods).toEqual(["fork.subagents.spawn", "agent.wait"]); // never reached chat.history
  });

  it("throws a classified 'budget-exceeded' error when the wait carries stopReason:'budget-exhausted'", async () => {
    const { call } = mockGateway([{ role: "assistant", content: "x" }], {
      waitStatus: "ok",
      waitStopReason: "budget-exhausted",
    });
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    let caught: unknown;
    try {
      await rt.agent("q");
    } catch (e) {
      caught = e;
    }
    expect((caught as { kind?: string } | undefined)?.kind).toBe("budget-exceeded");
  });

  it("leaves the normal 'ok' status path unchanged", async () => {
    const { call, methods } = mockGateway([
      { role: "user", content: "question" },
      { role: "assistant", content: "the answer" },
    ]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    expect(await rt.agent("question")).toBe("the answer");
    expect(methods).toEqual(["fork.subagents.spawn", "agent.wait", "chat.history"]);
  });
});

// 2026-10-09: a requester at maxChildrenPerAgent active children gets its next spawn REFUSED
// (src/agents/subagent-spawn.ts), not queued; a sibling unit or another fan-out frees a slot soon.
describe("spawn refused for max active children", () => {
  function refusingGateway(refusals: number, message: string) {
    const methods: string[] = [];
    let spawns = 0;
    const call = (async (args: { method: string }) => {
      methods.push(args.method);
      if (args.method === "fork.subagents.spawn") {
        spawns++;
        if (spawns <= refusals) throw new Error(message);
        return { ok: true, childSessionKey: "cs", runId: `r${spawns}` };
      }
      if (args.method === "agent.wait") return { status: "ok" };
      if (args.method === "chat.history")
        return { messages: [{ role: "assistant", content: "the answer" }] };
      return {};
    }) as unknown as CallGateway;
    return { call, methods, spawns: () => spawns };
  }

  it("waits for a slot and then runs the unit", async () => {
    const g = refusingGateway(
      2,
      "sessions_spawn has reached max active children for this session (10/10)",
    );
    const rt = createProductionOrchestrationRuntime({ callGateway: g.call, spawnRetryDelayMs: 1 });
    expect(await rt.agent("q")).toBe("the answer");
    expect(g.methods).toEqual([
      "fork.subagents.spawn",
      "fork.subagents.spawn",
      "fork.subagents.spawn",
      "agent.wait",
      "chat.history",
    ]);
  });

  it("does not retry any other spawn error", async () => {
    const g = refusingGateway(
      5,
      "sessions_spawn is not allowed at this depth (current depth: 1, max: 1)",
    );
    const rt = createProductionOrchestrationRuntime({ callGateway: g.call, spawnRetryDelayMs: 1 });
    await expect(rt.agent("q")).rejects.toThrow(/depth/);
    expect(g.spawns()).toBe(1);
  });

  it("passes maxInFlight to the runtime", async () => {
    let now = 0;
    let peak = 0;
    const call = (async (args: { method: string }) => {
      if (args.method === "fork.subagents.spawn") {
        now++;
        peak = Math.max(peak, now);
        return { ok: true, childSessionKey: "cs", runId: "r" };
      }
      if (args.method === "agent.wait") {
        await new Promise((r) => setTimeout(r, 5));
        now--;
        return { status: "ok" };
      }
      if (args.method === "chat.history")
        return { messages: [{ role: "assistant", content: "x" }] };
      return {};
    }) as unknown as CallGateway;
    const rt = createProductionOrchestrationRuntime({ callGateway: call, maxInFlight: 2 });
    await rt.parallel(["a", "b", "c", "d", "e"].map((x) => () => rt.agent(x)));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// 2026-10-09: when a Claude seat hits its usage limit, the child's only "reply" is a synthetic error
// message (model "<synthetic>", stopReason "error"). agent.wait still says ok, so the unit returned the
// error text as its answer and 11 J-series analysts were read as finished.
describe("a child that ended in a provider error", () => {
  it("fails the unit instead of returning the error text as the answer", async () => {
    const { call } = mockGateway([
      { role: "user", content: "task" },
      {
        role: "assistant",
        model: "<synthetic>",
        stopReason: "error",
        content: [
          { type: "text", text: "You've hit your weekly limit · resets 8am (Europe/Madrid)" },
        ],
      },
    ]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    await expect(rt.agent("task")).rejects.toThrow(/weekly limit/);
  });

  it("still returns a normal answer", async () => {
    const { call } = mockGateway([
      { role: "assistant", model: "claude-opus-5-5", stopReason: "stop", content: "the answer" },
    ]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    expect(await rt.agent("task")).toBe("the answer");
  });
});
