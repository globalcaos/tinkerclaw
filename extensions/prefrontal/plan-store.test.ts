import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PlanStore } from "./plan-store.js";

describe("PlanStore", () => {
  let dir: string;
  let store: PlanStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-"));
    store = new PlanStore({ rootDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads back a plan", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "Add foo RPC",
      runId: "run-1",
      steps: [{ title: "Explore" }, { title: "Implement" }],
    });
    const plan = await store.get("agent:main:main");
    expect(plan).not.toBeNull();
    expect(plan!.intent).toBe("Add foo RPC");
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[0].status).toBe("pending");
    expect(plan!.status).toBe("in_progress");
    expect(plan!.currentStep).toBe(0);
  });

  it("setting step 2 to in_progress demotes the previous current step to pending", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "x",
      runId: "r1",
      steps: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });
    await store.step({ sessionKey: "agent:main:main", stepIndex: 0, status: "in_progress" });
    await store.step({ sessionKey: "agent:main:main", stepIndex: 2, status: "in_progress" });
    const plan = await store.get("agent:main:main");
    expect(plan!.currentStep).toBe(2);
    expect(plan!.steps[0].status).toBe("pending");
    expect(plan!.steps[2].status).toBe("in_progress");
  });

  it("status:done sets completedAt and advances currentStep to next pending", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "x",
      runId: "r1",
      steps: [{ title: "A" }, { title: "B" }],
    });
    await store.step({ sessionKey: "agent:main:main", stepIndex: 0, status: "in_progress" });
    await store.step({
      sessionKey: "agent:main:main",
      stepIndex: 0,
      status: "done",
      note: "did A",
    });
    const plan = await store.get("agent:main:main");
    expect(plan!.steps[0].status).toBe("done");
    expect(plan!.steps[0].note).toBe("did A");
    expect(plan!.currentStep).toBe(1);
  });

  it("close archives the file under archive/<YYYY-MM-DD>/ and removes the live plan", async () => {
    await store.set({
      sessionKey: "agent:main:main",
      intent: "x",
      runId: "r1",
      steps: [{ title: "A" }],
    });
    const result = await store.close({ sessionKey: "agent:main:main", status: "done" });
    expect(result.archivedTo).toMatch(/archive\/\d{4}-\d{2}-\d{2}\/agent__main__main-r1\.md$/);
    expect(await store.get("agent:main:main")).toBeNull();
    expect(fs.existsSync(result.archivedTo)).toBe(true);
  });
});
