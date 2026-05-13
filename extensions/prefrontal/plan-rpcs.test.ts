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

  it("plan.set with kitRef seeds steps from the kit body", async () => {
    const ownKits = fs.mkdtempSync(path.join(os.tmpdir(), "kits-"));
    fs.mkdirSync(path.join(ownKits, "feature"), { recursive: true });
    fs.writeFileSync(
      path.join(ownKits, "feature", "kit.md"),
      "---\nschema: kit/1.0\nslug: feature\n---\n## Steps\n\n1. Explore\n2. Design\n3. Implement\n",
      "utf-8",
    );

    // Build fresh store + rpcs scoped to this test's temp dir
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-kr-"));
    const store2 = new PlanStore({ rootDir: dir2 });
    const rpcs2 = createPlanRpcs({ store: store2, ownKitsDir: ownKits });

    const res = await rpcs2["prefrontal.plan.set"]({
      sessionKey: "agent:main:main",
      intent: "Build foo",
      runId: "r1",
      kitRef: "globalcaos/feature",
      steps: [],
    });
    expect(res.path).toContain("agent__main__main.md");
    const plan = await store2.get("agent:main:main");
    expect(plan!.steps.map((s) => s.title)).toEqual(["Explore", "Design", "Implement"]);
    expect(plan!.kitRef).toBe("globalcaos/feature");

    fs.rmSync(ownKits, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
