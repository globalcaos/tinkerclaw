/**
 * Resume of a parallel group that was only partly done (burn review 2026-11-13, F4).
 *
 * The finished sibling must stay `done`: it is not re-run, its row is not flipped
 * back to in_progress/pending, and it still shows up in the run's results.
 * Uses the real PlanStore (the mock in recipe-runner-resume.test.ts turns every
 * in_progress write into done, which hides the downgrade).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { PlanStore } from "../plan-store.js";
import { runRecipe } from "../recipe-runner.js";

const KIT = `---
schema: "kit/1.0"
slug: "resume-fanout-probe"
title: "Resume fan-out"
summary: "two parallel steps then a join"
tags: ["demo"]
parallelism:
  groups:
    - [0, 1]
    - [2]
---

## Steps

### 1. Left
Do the left half.

### 2. Right
Do the right half.

### 3. Join
Join both halves.
`;

describe("resume of a partly-done parallel group", () => {
  it("keeps the already-done sibling done and reports it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-fanout-"));
    const prevHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = path.join(root, "home"); // empty overlay dir
    try {
      const recipes = path.join(root, "recipes");
      await fs.mkdir(path.join(recipes, "resume-fanout-probe"), { recursive: true });
      await fs.writeFile(path.join(recipes, "resume-fanout-probe", "kit.md"), KIT, "utf-8");
      const store = new PlanStore({ rootDir: path.join(root, "plans") });
      // The interrupted run: step 1 ("Right") finished, step 0 was still running.
      await store.set({
        sessionKey: "s1",
        intent: "t",
        runId: "r1",
        kitRef: "globalcaos/resume-fanout-probe",
        steps: [{ title: "Left" }, { title: "Right" }, { title: "Join" }],
      });
      await store.step({ sessionKey: "s1", stepIndex: 0, status: "in_progress" });
      await store.step({ sessionKey: "s1", stepIndex: 1, status: "done", note: "right done" });

      const spawned: number[] = [];
      const res = await runRecipe({
        kitRef: "globalcaos/resume-fanout-probe",
        sessionKey: "s1",
        intent: "t",
        planStore: store,
        ownRecipesDir: recipes,
        recipeInstallSandbox: path.join(root, "sandbox"),
        resume: true,
        _spawnStep: async (_task, label) => {
          const idx = Number(label.split(":step-")[1]);
          spawned.push(idx);
          await store.step({
            sessionKey: "s1",
            stepIndex: idx,
            status: "done",
            note: `step ${idx} ok`,
          });
          return { ok: true, runId: "mock" };
        },
      });
      expect(res.ok).toBe(true);
      expect(spawned).not.toContain(1);
      expect(res.results?.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
    } finally {
      if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
