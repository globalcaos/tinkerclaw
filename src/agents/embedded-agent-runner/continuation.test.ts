import { describe, expect, it } from "vitest";
import { planContinuation } from "./continuation.js";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const assistantText = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 2,
});
const assistantTools = (...ids: string[]) => ({
  role: "assistant",
  content: ids.map((id) => ({
    type: "toolCall",
    id,
    name: "exec",
    arguments: { command: `run ${id}` },
  })),
  stopReason: "toolUse",
  timestamp: 3,
});
const toolResult = (id: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "exec",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 4,
});
const abortedStub = () => ({ role: "assistant", content: [], stopReason: "aborted", timestamp: 5 });

describe("planContinuation", () => {
  it("continues as-is from tool results (the drain's normal boundary)", () => {
    const messages = [user("go"), assistantTools("a"), toolResult("a")];
    const plan = planContinuation(messages as never, 99);
    expect(plan).toMatchObject({ ok: true, trimmed: 0, synthetic: [] });
    if (plan.ok) {
      expect(plan.messages).toBe(messages);
    }
  });

  it("continues from a user prompt the model never answered", () => {
    expect(planContinuation([assistantText("hi"), user("next")] as never, 99)).toMatchObject({
      ok: true,
    });
  });

  it("trims a trailing aborted stub left by an in-process restart", () => {
    const plan = planContinuation(
      [user("go"), assistantTools("a"), toolResult("a"), abortedStub()] as never,
      99,
    );
    expect(plan).toMatchObject({ ok: true, trimmed: 1, synthetic: [] });
    if (plan.ok) {
      expect(plan.messages.at(-1)).toMatchObject({ role: "toolResult" });
    }
  });

  it("closes tool calls the restart cut with an error result naming the restart", () => {
    const plan = planContinuation(
      [user("go"), assistantTools("a", "b"), toolResult("a")] as never,
      99,
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.synthetic).toHaveLength(1);
      expect(plan.synthetic[0]).toMatchObject({
        role: "toolResult",
        toolCallId: "b",
        toolName: "exec",
        isError: true,
        timestamp: 99,
      });
      expect(JSON.stringify(plan.synthetic[0].content)).toMatch(/gateway restart/);
      expect(plan.messages.at(-1)).toMatchObject({ toolCallId: "b" });
    }
  });

  it("refuses when the turn already ended in an answer", () => {
    expect(planContinuation([user("go"), assistantText("done")] as never, 99)).toEqual({
      ok: false,
      reason: "the transcript ends in an assistant answer",
    });
  });

  it("trims a failed turn whose only text is the repair placeholder", () => {
    const failed = {
      role: "assistant",
      stopReason: "error",
      content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
    };
    const plan = planContinuation([user("go"), failed] as never, 99);
    expect(plan).toMatchObject({ ok: true, trimmed: 1 });
  });

  it("refuses an empty transcript", () => {
    expect(planContinuation([] as never, 99)).toMatchObject({ ok: false });
  });

  // FORK 2026-10-05 (bug-log `failover-reprompt`): pi appends a turn's runtime-context custom
  // message right after its prompt, so a call that failed before any output leaves
  // [user][custom][stub]. Measured on two of the three Tinker retries (mucpt768 09-30, mtba8duf
  // 10-02): read as an answer, the retry prompted again and wrote the prompt twice.
  const runtimeContext = () => ({
    role: "custom",
    customType: "openclaw.runtime-context",
    content: "ctx",
    timestamp: 1,
  });
  const errorStub = () => ({ role: "assistant", content: [], stopReason: "error", timestamp: 5 });

  it("continues past the runtime-context message after an unanswered prompt", () => {
    const messages = [user("go"), runtimeContext(), errorStub()];
    const plan = planContinuation(messages as never, 99);
    expect(plan).toMatchObject({ ok: true, trimmed: 1, synthetic: [] });
    if (plan.ok) {
      expect(plan.messages).toEqual([user("go"), runtimeContext()]);
    }
  });

  it("a custom message after an answer still ends in that answer", () => {
    const messages = [user("go"), assistantText("done"), runtimeContext()];
    expect(planContinuation(messages as never, 99)).toMatchObject({ ok: false });
  });
});
