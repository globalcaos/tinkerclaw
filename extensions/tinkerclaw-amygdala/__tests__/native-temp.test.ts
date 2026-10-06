import { describe, expect, it } from "vitest";
import { registerNativeHandlers } from "../src/native.js";

// 2026-10-05: Jev sent the tab namer's titles back as unfinished, and would judge and re-explain the explainer's own
// answers. Internal one-shots run as temp:* sessions and are skipped.
describe("native handlers", () => {
  it("skip temp:* one-shots and still judge a real session", async () => {
    const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
    const api = {
      on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) =>
        handlers.set(name, fn),
    };
    const seen: string[] = [];
    const runtime = {
      mode: "shadow" as const,
      decide: async (seam: string, hook: Record<string, unknown>) => {
        seen.push(`${seam}:${String(hook.session_id)}`);
        return { decisionId: "d", hook: { kind: "none" } };
      },
      waitFor: async () => ({ answer: "timeout" }),
      noteNotesDropped: () => {},
    };
    registerNativeHandlers(api as never, runtime as never);
    for (const key of ["temp:jev-explain", "temp:title-suggest", "agent:main:x"]) {
      await handlers.get("before_tool_call")!(
        { toolName: "Bash", params: {} },
        { sessionKey: key },
      );
      await handlers.get("agent_end")!({ messages: [] }, { sessionKey: key });
    }
    expect(seen).toEqual(["pre-tool:agent:main:x", "stop:agent:main:x"]);
  });
});
