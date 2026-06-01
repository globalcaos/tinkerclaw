import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
/**
 * FORK 2026-05-30 (Upgrade 5): durable per-step artifact persistence.
 *
 * The top-level `plan-store.test.ts` covers a single-step artifact round-trip.
 * This suite hardens the contract the resume path (kit-runner) depends on:
 * EVERY step's `artifact` digest must survive a full render → on-disk → parse
 * cycle, including ones with spaces, unicode, and at the 500-char schema bound.
 */
import { PlanStore, parsePlanMd } from "../plan-store.js";

describe("PlanStore — per-step artifact round-trip (Upgrade 5)", () => {
  let dir: string;
  let store: PlanStore;
  const KEY = "agent:main:main";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-artifact-"));
    store = new PlanStore({ rootDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a distinct artifact on every step across render → disk → parse", async () => {
    const artifacts = [
      "step0: surveyed 4 call sites in app.ts and gateway/router.ts",
      "step1: patched the filter at line 2046 — uses canonical sessionKey now",
      "step2: ✅ added vitest coverage (résumé, café, naïve unicode ok)",
    ];

    await store.set({
      sessionKey: KEY,
      intent: "Durable checkpointing per-step artifacts",
      runId: "run-artifacts",
      steps: [{ title: "Survey" }, { title: "Patch" }, { title: "Test" }],
    });

    // Mark each step in_progress → done with its own artifact digest.
    for (let i = 0; i < artifacts.length; i++) {
      await store.step({ sessionKey: KEY, stepIndex: i, status: "in_progress" });
      await store.step({
        sessionKey: KEY,
        stepIndex: i,
        status: "done",
        note: `note for step ${i}`,
        artifact: artifacts[i],
      });
    }

    // Re-read from disk → exercises renderPlanMd (writer) → parsePlanMd (reader).
    const plan = await store.get(KEY);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(3);
    for (let i = 0; i < artifacts.length; i++) {
      expect(plan!.steps[i].status).toBe("done");
      expect(plan!.steps[i].artifact).toBe(artifacts[i]);
      expect(plan!.steps[i].note).toBe(`note for step ${i}`);
    }
  });

  it("round-trips a digest at the 500-char schema bound (with embedded spaces)", async () => {
    // 500 chars of space-separated tokens → exercises the space-split parser guard.
    const digest = Array.from({ length: 100 }, (_, i) => `tok${i}`)
      .join(" ")
      .slice(0, 500);
    expect(digest.length).toBe(500);

    await store.set({
      sessionKey: KEY,
      intent: "bound",
      runId: "r-bound",
      steps: [{ title: "A" }],
    });
    await store.step({ sessionKey: KEY, stepIndex: 0, status: "in_progress" });
    await store.step({ sessionKey: KEY, stepIndex: 0, status: "done", artifact: digest });

    const plan = await store.get(KEY);
    expect(plan!.steps[0].artifact).toBe(digest);
  });

  it("renderPlanMd output is parsed back to identical artifacts by parsePlanMd directly", async () => {
    // Drive the writer through the store, read the raw markdown off disk, then
    // run the EXPORTED reader on it — proves writer/reader are symmetric without
    // relying on store.get() as the only path.
    await store.set({
      sessionKey: KEY,
      intent: "symmetry",
      runId: "r-sym",
      steps: [{ title: "One" }, { title: "Two" }],
    });
    await store.step({ sessionKey: KEY, stepIndex: 0, status: "in_progress" });
    await store.step({
      sessionKey: KEY,
      stepIndex: 0,
      status: "done",
      artifact: "alpha result with spaces",
    });
    await store.step({ sessionKey: KEY, stepIndex: 1, status: "in_progress" });
    await store.step({
      sessionKey: KEY,
      stepIndex: 1,
      status: "done",
      artifact: "beta result | pipes & specials",
    });

    const raw = fs.readFileSync(store.filePathPublic(KEY), "utf-8");
    const parsed = parsePlanMd(raw);
    expect(parsed.steps.map((s) => s.artifact)).toEqual([
      "alpha result with spaces",
      "beta result | pipes & specials",
    ]);
  });

  it("a step left without an artifact stays undefined (no phantom artifact injected)", async () => {
    await store.set({
      sessionKey: KEY,
      intent: "mixed",
      runId: "r-mixed",
      steps: [{ title: "Has" }, { title: "Missing" }],
    });
    await store.step({ sessionKey: KEY, stepIndex: 0, status: "in_progress" });
    await store.step({ sessionKey: KEY, stepIndex: 0, status: "done", artifact: "only on step 0" });
    await store.step({ sessionKey: KEY, stepIndex: 1, status: "in_progress" });
    await store.step({ sessionKey: KEY, stepIndex: 1, status: "done", note: "no artifact here" });

    const plan = await store.get(KEY);
    expect(plan!.steps[0].artifact).toBe("only on step 0");
    expect(plan!.steps[1].artifact).toBeUndefined();
    expect(plan!.steps[1].note).toBe("no artifact here");
  });
});
