import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanStore } from "../plan-store.js";

describe("PlanStore typed output round-trip", () => {
  let dir: string;
  let store: PlanStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "planstore-ss1-"));
    store = new PlanStore({ rootDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists and reloads a step's structured output", async () => {
    await store.set({
      sessionKey: "s1",
      intent: "demo",
      runId: "r1",
      kitRef: "globalcaos/demo",
      steps: [{ title: "Produce" }],
    });
    await store.step({
      sessionKey: "s1",
      stepIndex: 0,
      status: "done",
      note: "done",
      artifact: "produced ok",
      output: { passed: true, failed: 0 },
      outputKind: "json",
    });
    // get() always re-reads from disk; a fresh instance over the same dir also works.
    const reloaded = new PlanStore({ rootDir: dir });
    const plan = await reloaded.get("s1");
    expect(plan).not.toBeNull();
    expect(plan!.steps[0].output).toEqual({ passed: true, failed: 0 });
    expect(plan!.steps[0].outputKind).toBe("json");
    expect(plan!.steps[0].artifact).toBe("produced ok"); // digest still present
  });

  it("leaves output undefined for untyped steps", async () => {
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
    expect(plan!.steps[0].output).toBeUndefined();
  });
});
