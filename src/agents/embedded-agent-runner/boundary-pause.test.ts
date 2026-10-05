import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createBoundaryPauseGate } from "./boundary-pause.js";

const model = { api: "openai-completions", provider: "xai", id: "grok-4.6" };

function fakeInner(text = "hello") {
  return vi.fn(() => {
    const s = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      stopReason: "stop" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    };
    queueMicrotask(() => {
      s.push({ type: "done", reason: "stop", message } as never);
      s.end();
    });
    return s;
  });
}

describe("boundary pause gate", () => {
  it("passes model calls straight through while running", async () => {
    const inner = fakeInner();
    const gate = createBoundaryPauseGate();
    const stream = await gate.wrap(inner as never)(model as never, {} as never, {});
    expect((await stream.result()).stopReason).toBe("stop");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe("running");
  });

  it("lets an in-flight call finish and holds the NEXT call at the boundary", async () => {
    const inner = fakeInner();
    const onPaused = vi.fn();
    const gate = createBoundaryPauseGate({ onPaused });
    const wrapped = gate.wrap(inner as never);
    const first = await wrapped(model as never, {} as never, {});
    gate.requestPause(); // the drain arrives while the first call is in flight
    expect((await first.result()).stopReason).toBe("stop");
    const held = await wrapped(model as never, {} as never, {});
    expect(gate.state).toBe("paused");
    expect(onPaused).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1); // the next call never reached the provider
    let settled = false;
    void held.result().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // held: no stub, nothing appended
  });

  it("released, the held call goes to the provider and streams through", async () => {
    const inner = fakeInner("after release");
    const gate = createBoundaryPauseGate();
    const wrapped = gate.wrap(inner as never);
    gate.requestPause();
    const held = await wrapped(model as never, {} as never, {});
    gate.release();
    const msg = await held.result();
    expect(msg.content).toEqual([{ type: "text", text: "after release" }]);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe("running");
  });

  it("aborted while held, it ends as an aborted call without calling the provider", async () => {
    const inner = fakeInner();
    const gate = createBoundaryPauseGate();
    const ac = new AbortController();
    gate.requestPause();
    const held = await gate.wrap(inner as never)(model as never, {} as never, {
      signal: ac.signal,
    });
    ac.abort("restart");
    const msg = await held.result();
    expect(msg.stopReason).toBe("aborted");
    expect(inner).not.toHaveBeenCalled();
  });

  it("a release before the boundary cancels the request", async () => {
    const inner = fakeInner();
    const gate = createBoundaryPauseGate();
    gate.requestPause();
    gate.release();
    const stream = await gate.wrap(inner as never)(model as never, {} as never, {});
    expect((await stream.result()).stopReason).toBe("stop");
    expect(gate.state).toBe("running");
  });
});
