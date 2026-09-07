import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetHookLivenessForTests,
  hookInstrumentId,
  isForkPlugin,
  wrapHookForLiveness,
} from "./hook-liveness.js";

describe("hook liveness wrapper", () => {
  beforeEach(() => {
    __resetHookLivenessForTests();
  });

  it("is transparent: the handler's return value reaches the caller untouched", () => {
    // Hooks return payload mutations the emitter acts on. A wrapper that swallowed or reshaped
    // the return would change behaviour to buy observability, which is never the trade.
    const handler = ((payload: { n: number }) => ({ n: payload.n + 1 })) as never;
    const wrapped = wrapHookForLiveness("tinkerclaw-total-recall", "llm_output", handler);
    expect((wrapped as (p: { n: number }) => { n: number })({ n: 1 })).toEqual({ n: 2 });
  });

  it("passes every argument through in order", () => {
    const seen: unknown[] = [];
    const handler = ((...args: unknown[]) => {
      seen.push(...args);
    }) as never;
    const wrapped = wrapHookForLiveness("tinkerclaw-fractal-reflection", "agent_end", handler);
    (wrapped as (a: unknown, b: unknown) => void)({ runId: "r" }, { sessionKey: "s" });
    expect(seen).toEqual([{ runId: "r" }, { sessionKey: "s" }]);
  });

  it("records dispatch even when the handler throws", () => {
    // Fired BEFORE the handler on purpose. If it fired after, a handler that always throws would
    // read as "never dispatched" — pointing the investigation at the emitter instead of at the
    // handler, which is the single most expensive kind of wrong signal.
    const handler = (() => {
      throw new Error("handler exploded");
    }) as never;
    const wrapped = wrapHookForLiveness("tinkerclaw-people", "before_prompt_build", handler);
    expect(() => (wrapped as () => void)()).toThrow("handler exploded");
  });

  it("does not wrap upstream plugins — they are out of scope and would drown the report", () => {
    // Identity, not an equivalent function: no allocation, no indirection, nothing to debug.
    const handler = (() => "x") as never;
    expect(wrapHookForLiveness("whatsapp", "llm_output", handler)).toBe(handler);
    expect(wrapHookForLiveness("anthropic", "agent_end", handler)).toBe(handler);
  });

  it("scopes by the tinkerclaw- prefix", () => {
    expect(isForkPlugin("tinkerclaw-prefrontal")).toBe(true);
    expect(isForkPlugin("memory-core")).toBe(false);
    expect(isForkPlugin("")).toBe(false);
  });

  it("mints a stable, greppable id", () => {
    // Ids appear in reports and get grepped; they must not drift casually.
    expect(hookInstrumentId("tinkerclaw-total-recall", "llm_output")).toBe(
      "hook:tinkerclaw-total-recall:llm_output",
    );
  });

  it("re-registering the same hook does not re-declare it", () => {
    // Plugin reload / re-activation calls registerTypedHook again. Declaring twice would reset
    // the instrument's age and make a long-quiet hook look freshly pending.
    const handler = (() => undefined) as never;
    const a = wrapHookForLiveness("tinkerclaw-tinker", "agent_end", handler);
    const b = wrapHookForLiveness("tinkerclaw-tinker", "agent_end", handler);
    expect(typeof a).toBe("function");
    expect(typeof b).toBe("function");
  });
});
