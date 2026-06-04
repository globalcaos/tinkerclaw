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
  opts?: { spawnOk?: boolean; waitStatus?: string },
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
    if (args.method === "agent.wait") return { status: opts?.waitStatus ?? "ok" };
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

  it("returns empty text on a wait timeout (no history read)", async () => {
    const { call, methods } = mockGateway([{ role: "assistant", content: "x" }], {
      waitStatus: "timeout",
    });
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    expect(await rt.agent("q")).toBe("");
    expect(methods).toEqual(["fork.subagents.spawn", "agent.wait"]); // never reached chat.history
  });

  it("drives parallel() over the real spawn path", async () => {
    const { call } = mockGateway([{ role: "assistant", content: "ok" }]);
    const rt = createProductionOrchestrationRuntime({ callGateway: call });
    const res = await rt.parallel([() => rt.agent("a"), () => rt.agent("b")]);
    expect(res).toEqual(["ok", "ok"]);
  });
});
