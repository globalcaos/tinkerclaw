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

    expect(chatSendCalls).toHaveLength(1);
    const call = chatSendCalls[0];
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
    expect(chatSendCalls).toHaveLength(0);
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
    expect(chatSendCalls).toHaveLength(1);
  });
});
