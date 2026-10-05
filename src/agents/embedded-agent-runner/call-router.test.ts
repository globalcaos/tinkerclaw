import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCallRouter,
  registerCallRouter,
  type CallRouteCall,
  type CallRouteMeta,
} from "../../infra/thalamus-call-router.js";
import { wrapStreamFnWithCallRouter } from "./call-router.js";

const meta: CallRouteMeta = {
  runId: "run-1",
  sessionKey: "s",
  provider: "claude-code",
  model: "claude-opus-5",
};

/** Records what it is called with and answers with a fixed object, like a stream. */
function fakeStream() {
  const seen: unknown[][] = [];
  const result = { stream: true };
  const fn = ((...args: unknown[]) => {
    seen.push(args);
    return result;
  }) as unknown as StreamFn;
  return { fn, seen, result };
}

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("call router seam: inert when off", () => {
  it("returns the very function it was given when no router is registered", () => {
    const { fn } = fakeStream();
    expect(getCallRouter()).toBeUndefined();
    expect(wrapStreamFnWithCallRouter(fn, meta)).toBe(fn);
  });

  it("returns it again after the router that was registered is removed", () => {
    off = registerCallRouter({ observe: () => {} });
    off();
    off = undefined;
    const { fn } = fakeStream();
    expect(wrapStreamFnWithCallRouter(fn, meta)).toBe(fn);
  });
});

describe("call router seam: observing", () => {
  it("passes the SAME model, context and options objects to the original, and returns its result", () => {
    off = registerCallRouter({ observe: () => {} });
    const { fn, seen, result } = fakeStream();
    const wrapped = wrapStreamFnWithCallRouter(fn, meta);
    expect(wrapped).not.toBe(fn);
    const model = { id: "m" };
    const context = { messages: [{ role: "user", content: "hi" }] };
    const options = { temperature: 0 };
    const out = (wrapped as (...a: unknown[]) => unknown)(model, context, options);
    expect(out).toBe(result);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(model);
    expect(seen[0][1]).toBe(context);
    expect(seen[0][2]).toBe(options);
  });

  it("sends the same bytes with the router registered as without one", () => {
    const model = { id: "m", api: "anthropic-messages" };
    const context = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "t" }],
    };
    const options = { maxTokens: 100, headers: { a: "b" } };
    const bare = fakeStream();
    (wrapStreamFnWithCallRouter(bare.fn, meta) as (...a: unknown[]) => unknown)(
      model,
      context,
      options,
    );
    const bareBytes = JSON.stringify(bare.seen[0]);

    off = registerCallRouter({ observe: () => {} });
    const routed = fakeStream();
    (wrapStreamFnWithCallRouter(routed.fn, meta) as (...a: unknown[]) => unknown)(
      model,
      context,
      options,
    );
    expect(JSON.stringify(routed.seen[0])).toBe(bareBytes);
  });

  it("does not mutate what it was given: frozen arguments pass through", () => {
    off = registerCallRouter({ observe: () => {} });
    const { fn, seen } = fakeStream();
    const model = Object.freeze({ id: "m" });
    const context = Object.freeze({
      messages: Object.freeze([Object.freeze({ role: "user", content: "x" })]),
    });
    const options = Object.freeze({});
    expect(() =>
      (wrapStreamFnWithCallRouter(fn, meta) as (...a: unknown[]) => unknown)(
        model,
        context,
        options,
      ),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("tells the router about each call, with the run's meta and a growing call index", () => {
    const calls: CallRouteCall[] = [];
    off = registerCallRouter({ observe: (c) => void calls.push(c) });
    const { fn } = fakeStream();
    const wrapped = wrapStreamFnWithCallRouter(fn, meta) as (...a: unknown[]) => unknown;
    const model = { id: "m" };
    wrapped(model, { messages: [] }, {});
    wrapped(model, { messages: [] }, {});
    expect(calls.map((c) => c.callIndex)).toEqual([0, 1]);
    expect(calls[0].meta).toBe(meta);
    expect(calls[0].model).toBe(model);
  });

  it("numbers each run's calls from zero", () => {
    const idx: number[] = [];
    off = registerCallRouter({ observe: (c) => void idx.push(c.callIndex) });
    const a = wrapStreamFnWithCallRouter(fakeStream().fn, meta) as (...x: unknown[]) => unknown;
    const b = wrapStreamFnWithCallRouter(fakeStream().fn, { ...meta, runId: "run-2" }) as (
      ...x: unknown[]
    ) => unknown;
    a({}, {}, {});
    b({}, {}, {});
    a({}, {}, {});
    expect(idx).toEqual([0, 0, 1]);
  });
});

describe("call router seam: fails open", () => {
  it("still makes the call when the router throws", () => {
    off = registerCallRouter({
      observe: () => {
        throw new Error("router bug");
      },
    });
    const { fn, seen, result } = fakeStream();
    const out = (wrapStreamFnWithCallRouter(fn, meta) as (...a: unknown[]) => unknown)({}, {}, {});
    expect(out).toBe(result);
    expect(seen).toHaveLength(1);
  });

  it("calls the original without observing when the router is removed after the run was wired", () => {
    const observe = vi.fn();
    off = registerCallRouter({ observe });
    const { fn, seen } = fakeStream();
    const wrapped = wrapStreamFnWithCallRouter(fn, meta) as (...a: unknown[]) => unknown;
    off();
    off = undefined;
    wrapped({}, {}, {});
    expect(observe).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("does not wait for the router: a router that returns a promise is not awaited", () => {
    off = registerCallRouter({ observe: () => new Promise(() => {}) as unknown as void });
    const { fn, seen } = fakeStream();
    (wrapStreamFnWithCallRouter(fn, meta) as (...a: unknown[]) => unknown)({}, {}, {});
    expect(seen).toHaveLength(1);
  });
});

describe("call router registry", () => {
  it("removes only the router it registered", () => {
    const first = { observe: () => {} };
    const second = { observe: () => {} };
    const offFirst = registerCallRouter(first);
    const offSecond = registerCallRouter(second);
    offFirst();
    expect(getCallRouter()).toBe(second);
    offSecond();
    expect(getCallRouter()).toBeUndefined();
  });

  it("is shared by a second copy of the module, as the plugin bundle's copy would be", async () => {
    off = registerCallRouter({ observe: () => {} });
    vi.resetModules();
    const other = await import("../../infra/thalamus-call-router.js");
    expect(other.getCallRouter()).toBe(getCallRouter());
  });
});
