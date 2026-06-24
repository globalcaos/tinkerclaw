import { describe, expect, it } from "vitest";
import { tryInflightSteer } from "../../../src/agents/embedded-agent-runner/inflight-steer-hook.js";
// Importing the registry installs the steer hook (module side-effect).
import { registerInflightWorker, unregisterInflightWorker } from "./inflight-worker-registry.js";
import type { ClaudeCodeWorker } from "./worker.js";

function fakeWorker(steerReturns = true) {
  const calls: string[] = [];
  const w = {
    steer(text: string) {
      calls.push(text);
      return steerReturns;
    },
  };
  return { worker: w as unknown as ClaudeCodeWorker, calls };
}

describe("tinker-bridge inflight-worker-registry (P4 bridge)", () => {
  it("routes the core inflight-steer hook to the live worker's steer()", () => {
    const { worker, calls } = fakeWorker(true);
    registerInflightWorker("sess-x", worker);
    expect(tryInflightSteer("sess-x", "fold me")).toBe(true);
    expect(calls).toEqual(["fold me"]);
    unregisterInflightWorker("sess-x", worker);
    expect(tryInflightSteer("sess-x", "again")).toBe(false); // no live worker now
  });

  it("propagates worker.steer()'s false (EPIPE / dead subprocess) so the caller falls back", () => {
    const { worker } = fakeWorker(false);
    registerInflightWorker("sess-y", worker);
    expect(tryInflightSteer("sess-y", "hi")).toBe(false);
    unregisterInflightWorker("sess-y", worker);
  });

  it("returns false for a session with no live worker", () => {
    expect(tryInflightSteer("sess-none", "hi")).toBe(false);
  });

  it("a stale unregister does not clear a newer turn's worker", () => {
    const a = fakeWorker(true);
    const b = fakeWorker(true);
    registerInflightWorker("sess-z", a.worker);
    registerInflightWorker("sess-z", b.worker); // newer turn re-registers
    unregisterInflightWorker("sess-z", a.worker); // stale — must NOT clear b
    expect(tryInflightSteer("sess-z", "hi")).toBe(true);
    expect(b.calls).toEqual(["hi"]);
    expect(a.calls).toEqual([]);
    unregisterInflightWorker("sess-z", b.worker);
  });
});
