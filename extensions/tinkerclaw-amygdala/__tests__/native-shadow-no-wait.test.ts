import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNativeHandlers, SLOW_SHADOW_DECIDE_MS } from "../src/native.js";

// 2026-10-22 (JarvisPi): a shadow pre-tool decision that never came back held the tool call, twice in one chat,
// until the run timeout and then until the host's 10-minute hook bound. In shadow mode the call no longer waits.
function setup(mode: "shadow" | "enforce", decide: () => Promise<unknown>) {
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const api = {
    on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => handlers.set(name, fn),
  };
  const runtime = {
    mode,
    decide: vi.fn(decide),
    waitFor: async () => ({ answer: "timeout" }),
    noteNotesDropped: () => {},
  };
  registerNativeHandlers(api as never, runtime as never);
  const preTool = () =>
    handlers.get("before_tool_call")!(
      { toolName: "exec", params: { command: "jarvis hello" }, toolCallId: "call-1" },
      { sessionKey: "agent:main:tinker:x" },
    );
  return { runtime, preTool };
}

describe("native before_tool_call in shadow mode", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets the call go on at once while the decision never comes back", async () => {
    const { runtime, preTool } = setup("shadow", () => new Promise(() => {}));
    const raced = await Promise.race([
      preTool(),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);
    expect(raced).toBeUndefined();
    expect(runtime.decide).toHaveBeenCalledWith(
      "pre-tool",
      expect.objectContaining({ session_id: "agent:main:tinker:x", tool_name: "exec" }),
    );
  });

  it("logs a shadow decision still running after the slow mark", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { preTool } = setup("shadow", () => new Promise(() => {}));
    await preTool();
    await vi.advanceTimersByTimeAsync(SLOW_SHADOW_DECIDE_MS);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "shadow pre-tool decision still running after 60 s (session=agent:main:tinker:x tool=exec)",
    );
  });

  it("logs a failed shadow decision instead of leaving it unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { preTool } = setup("shadow", async () => {
      throw new Error("store gone");
    });
    await expect(preTool()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toHaveBeenCalledWith("[amygdala] native handler failed", expect.any(Error));
  });

  it("still waits for the decision in enforce mode, where it can block", async () => {
    const { preTool } = setup("enforce", async () => ({
      decisionId: "d",
      hook: { kind: "deny", reason: "not here" },
    }));
    await expect(preTool()).resolves.toEqual({ block: true, blockReason: "not here" });
  });
});
