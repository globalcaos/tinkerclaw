import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanStore } from "../plan-store.js";

describe("PlanStore typed error round-trip (SS5a)", () => {
  let dir: string;
  let store: PlanStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "planstore-ss5a-"));
    store = new PlanStore({ rootDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists and reloads a step's structured error", async () => {
    await store.set({
      sessionKey: "s1",
      intent: "demo",
      runId: "r1",
      kitRef: "globalcaos/demo",
      steps: [{ title: "Run" }],
    });
    const err = {
      kind: "timeout",
      message: "step exceeded its budget (with spaces & symbols: <>)",
      recoverable: true,
      details: { attempt: 2, lastSeen: "x y z" },
    };
    await store.step({
      sessionKey: "s1",
      stepIndex: 0,
      status: "error",
      note: "failed",
      artifact: "ran but failed",
      error: err,
    });
    // get() always re-reads from disk; a fresh instance over the same dir also works.
    const reloaded = new PlanStore({ rootDir: dir });
    const plan = await reloaded.get("s1");
    expect(plan).not.toBeNull();
    expect(plan!.steps[0].error).toEqual(err);
    expect(plan!.steps[0].status).toBe("error");
    expect(plan!.steps[0].artifact).toBe("ran but failed"); // digest still present
  });

  it("leaves error undefined for legacy steps with no error (no regression)", async () => {
    await store.set({
      sessionKey: "s2",
      intent: "d",
      runId: "r2",
      kitRef: "k",
      steps: [{ title: "Plain" }],
    });
    await store.step({ sessionKey: "s2", stepIndex: 0, status: "done", note: "n", artifact: "a" });
    const reloaded = new PlanStore({ rootDir: dir });
    const plan = await reloaded.get("s2");
    expect(plan!.steps[0].error).toBeUndefined();
    expect(plan!.steps[0].artifact).toBe("a"); // existing fields still round-trip
  });
});
