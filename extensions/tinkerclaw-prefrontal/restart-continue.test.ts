import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PlanStore } from "./plan-store.js";
import { runRestartContinue, _resetDebounceForTests } from "./restart-continue.js";

describe("restart-continue", () => {
  let dir: string;
  let store: PlanStore;
  let chatSendCalls: Array<{
    method: string;
    params: {
      sessionKey: string;
      message: string;
      deliver: boolean;
      dispatchAgent?: boolean;
      idempotencyKey?: string;
      systemInputProvenance?: unknown;
    };
  }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-rc-"));
    store = new PlanStore({ rootDir: dir });
    chatSendCalls = [];
    _resetDebounceForTests?.();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // restart-continue makes TWO gatewayCalls per resume: the chat.send
  // [System] continue, plus a chat.inject visible chip (FORK 2026-05-13
  // Task 3.3). The dispatch-count assertions care only about chat.send.
  const sends = () => chatSendCalls.filter((c) => c.method === "chat.send");

  it("dispatches a [System] continue for an in-progress plan", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "Test",
      runId: "r1",
      steps: [{ title: "A" }, { title: "B" }],
    });
    await store.step({
      sessionKey: "agent:main:main",
      stepIndex: 1,
      status: "in_progress",
      note: "halfway",
    });

    await runRestartContinue({
      store,
      gatewayCall: async (method, params) => {
        chatSendCalls.push({ method, params: params as any });
        return { runId: "ack" };
      },
      systemKind: "plan-resume",
    });

    expect(sends()).toHaveLength(1);
    const call = sends()[0];
    expect(call.method).toBe("chat.send");
    expect(call.params.sessionKey).toBe("agent:main:main");
    expect(call.params.message).toContain("[System] Gateway restarted");
    expect(call.params.message).toContain("Step 1: B");
    expect(call.params.message).toContain("halfway");
    expect(call.params.deliver).toBe(false);
    expect(call.params.dispatchAgent).toBe(true);
  });

  it("skips done plans", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "Test",
      runId: "r1",
      steps: [{ title: "A" }],
    });
    await store.step({ sessionKey: "agent:main:main", stepIndex: 0, status: "done" });
    await runRestartContinue({
      store,
      gatewayCall: async (m, p) => {
        chatSendCalls.push({ method: m, params: p as any });
        return { runId: "x" };
      },
    });
    expect(sends()).toHaveLength(0);
  });

  // FORK 2026-05-16: kit-matcher seeds a plan with ALL steps `pending`
  // (status:"in_progress", currentStep:0) at turn start. The old guard
  // required a step to be literally `in_progress`, so a restart in the
  // seed→first-action window lost the turn — exactly the recovery gap the
  // user flagged. Regression guard: a freshly-seeded all-pending plan must
  // still be resumed.
  it("resumes a freshly-seeded plan with all steps pending (kit-matcher recovery)", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "Debug & Fix",
      runId: "kitmatch-1",
      kitRef: "debug",
      steps: [{ title: "Reproduce" }, { title: "Diagnose" }, { title: "Fix" }, { title: "Verify" }],
    });
    // No store.step() call — every step is still `pending`, exactly as the
    // kit-matcher leaves it before Jarvis's first action.
    await runRestartContinue({
      store,
      gatewayCall: async (m, p) => {
        chatSendCalls.push({ method: m, params: p as any });
        return { runId: "ack" };
      },
      systemKind: "plan-resume",
    });
    expect(sends()).toHaveLength(1);
    const call = sends()[0];
    expect(call.params.message).toContain("[System] Gateway restarted");
    expect(call.params.message).toContain("Debug & Fix");
    expect(call.params.message).toContain("Step 0: Reproduce");
  });

  // FORK 2026-05-16: hand smoke tests of prefrontal.plan.set leave plan
  // files with sessionKey `test:plan:<ts>` (intent "verify", steps a/b) in
  // the live plans dir. They were never closed, so restart-continue resumed
  // one on EVERY gateway restart, dispatching a [System] continue for
  // nonexistent work. Only `agent:` session keys are resumable.
  it("skips non-agent sessionKeys (leftover test/smoke fixtures)", async () => {
    await store.set({
      sessionKey: "test:plan:1778755051690",
      intent: "verify",
      runId: "v1",
      steps: [{ title: "a" }, { title: "b" }],
    });
    await runRestartContinue({
      store,
      gatewayCall: async (m, p) => {
        chatSendCalls.push({ method: m, params: p as any });
        return { runId: "ack" };
      },
    });
    expect(sends()).toHaveLength(0);
  });

  it("debounces same sessionKey within 30s window", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "x",
      runId: "r1",
      steps: [{ title: "A" }],
    });
    await store.step({ sessionKey: "agent:main:main", stepIndex: 0, status: "in_progress" });

    const call = async () =>
      runRestartContinue({
        store,
        gatewayCall: async (m, p) => {
          chatSendCalls.push({ method: m, params: p as any });
          return { runId: "ack" };
        },
      });
    await call();
    await call(); // second call within debounce
    expect(sends()).toHaveLength(1);
  });
});
