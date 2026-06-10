import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInflightSteerHook, tryInflightSteer } from "./inflight-steer-hook.js";

afterEach(() => registerInflightSteerHook(null));

describe("inflight-steer-hook", () => {
  it("returns false when no hook is registered (no live provider worker)", () => {
    expect(tryInflightSteer("sess-1", "hi")).toBe(false);
  });

  it("calls the registered hook with (sessionId, text) and returns its true result", () => {
    const calls: Array<[string, string]> = [];
    registerInflightSteerHook((sid, text) => {
      calls.push([sid, text]);
      return true;
    });
    expect(tryInflightSteer("sess-1", "fold me in")).toBe(true);
    expect(calls).toEqual([["sess-1", "fold me in"]]);
  });

  it("returns false when the hook reports no live worker (→ caller falls back to pi steer)", () => {
    registerInflightSteerHook(() => false);
    expect(tryInflightSteer("sess-1", "x")).toBe(false);
  });

  it("never propagates a throwing hook — returns false so the steer dispatch can't break", () => {
    registerInflightSteerHook(() => {
      throw new Error("worker exploded");
    });
    expect(tryInflightSteer("sess-1", "x")).toBe(false);
  });

  it("treats a non-true return as false (only an explicit true means handled)", () => {
    // @ts-expect-error intentionally wrong return for the guard
    registerInflightSteerHook(() => undefined);
    expect(tryInflightSteer("sess-1", "x")).toBe(false);
  });

  it("register(null) clears the hook", () => {
    registerInflightSteerHook(() => true);
    expect(tryInflightSteer("s", "t")).toBe(true);
    registerInflightSteerHook(null);
    expect(tryInflightSteer("s", "t")).toBe(false);
  });
});
