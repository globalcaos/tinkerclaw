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
});
