import { describe, expect, it, vi } from "vitest";
import { createSdkModelCaller, withTimeout } from "../src/model-caller.js";

describe("withTimeout", () => {
  it("gives the value when it comes in time", async () => {
    expect(await withTimeout(Promise.resolve(7), 100)).toBe(7);
  });
  it("gives undefined on timeout and calls the hook", async () => {
    const hook = vi.fn();
    expect(await withTimeout(new Promise(() => {}), 5, hook)).toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it("gives undefined, never a throw, when the promise rejects", async () => {
    expect(await withTimeout(Promise.reject(new Error("no")), 100)).toBeUndefined();
  });
});

const rt = (over: Record<string, unknown> = {}) => ({
  prepareSimpleCompletionModelForAgent: vi.fn(async () => ({
    model: { id: "m" },
    auth: { apiKey: "k" },
  })),
  completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
    content: [
      { type: "thinking", text: "hmm" },
      { type: "text", text: " digest " },
      { type: "text", text: "text" },
    ],
    usage: { input: 900, output: 40 },
  })),
  ...over,
});
const req = {
  modelKey: "claude-code/claude-haiku-4-5",
  prompt: "P",
  system: "S",
  maxTokens: 300,
  timeoutMs: 200,
};

describe("the SDK model caller", () => {
  it("asks for the route key, sends the prompt and system text, and returns the text blocks and usage", async () => {
    const r = rt();
    const call = createSdkModelCaller({ cfg: () => ({ c: 1 }), load: async () => r as never });
    const out = await call(req);
    expect(out).toEqual({ text: "digest text", input: 900, output: 40 });
    expect(r.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg: { c: 1 },
      agentId: "main",
      modelRef: "claude-code/claude-haiku-4-5",
    });
    const arg = (
      r.completeWithPreparedSimpleCompletionModel.mock.calls[0] as unknown as [
        {
          context: { systemPrompt: string; messages: Array<{ content: string }> };
          options: { maxTokens: number };
        },
      ]
    )[0];
    expect(arg.context.systemPrompt).toBe("S");
    expect(arg.context.messages[0].content).toBe("P");
    expect(arg.options.maxTokens).toBe(300);
  });
  it("undefined when the model cannot be prepared", async () => {
    const call = createSdkModelCaller({
      cfg: () => ({}),
      load: async () =>
        rt({ prepareSimpleCompletionModelForAgent: async () => ({ error: "no auth" }) }) as never,
    });
    expect(await call(req)).toBeUndefined();
  });
  it("undefined when the reply has no text, or the call throws, or the SDK will not load", async () => {
    const empty = createSdkModelCaller({
      cfg: () => ({}),
      load: async () =>
        rt({ completeWithPreparedSimpleCompletionModel: async () => ({ content: [] }) }) as never,
    });
    expect(await empty(req)).toBeUndefined();
    const boom = createSdkModelCaller({
      cfg: () => ({}),
      load: async () =>
        rt({
          completeWithPreparedSimpleCompletionModel: async () => {
            throw new Error("x");
          },
        }) as never,
    });
    expect(await boom(req)).toBeUndefined();
    const noSdk = createSdkModelCaller({
      cfg: () => ({}),
      load: async () => {
        throw new Error("cannot load");
      },
    });
    expect(await noSdk(req)).toBeUndefined();
  });
  it("undefined on timeout, and the request is aborted", async () => {
    let signal: AbortSignal | undefined;
    const slow = rt({
      completeWithPreparedSimpleCompletionModel: (p: { options: { signal: AbortSignal } }) => {
        signal = p.options.signal;
        return new Promise(() => {});
      },
    });
    const call = createSdkModelCaller({ cfg: () => ({}), load: async () => slow as never });
    expect(await call({ ...req, timeoutMs: 20 })).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});
