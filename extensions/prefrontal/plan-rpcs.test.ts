import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createPlanRpcs } from "./plan-rpcs.js";
import { PlanStore } from "./plan-store.js";

describe("plan-rpcs", () => {
  let dir: string;
  let store: PlanStore;
  let emitted: Array<{ event: string; payload: unknown }>;
  let rpcs: ReturnType<typeof createPlanRpcs>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-rpc-"));
    emitted = [];
    store = new PlanStore({
      rootDir: dir,
      onMutation: (sessionKey, plan) => {
        emitted.push({ event: "prefrontal-plan-state", payload: { sessionKey, plan } });
      },
    });
    rpcs = createPlanRpcs({ store });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prefrontal.plan.set creates the plan and emits a WS event", async () => {
    const res = await rpcs["prefrontal.plan.set"]({
      sessionKey: "agent:main:main",
      intent: "Add foo",
      runId: "r1",
      steps: [{ title: "A" }, { title: "B" }],
    });
    expect(res.path).toContain("agent__main__main.md");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("prefrontal-plan-state");
  });

  it("prefrontal.plan.set rejects invalid params via schema", async () => {
    await expect(
      rpcs["prefrontal.plan.set"]({ sessionKey: "", intent: "x", runId: "r", steps: [] } as never),
    ).rejects.toThrow(/sessionKey|steps/);
  });
});
