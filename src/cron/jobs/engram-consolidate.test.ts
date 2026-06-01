/**
 * Tests — Upgrade 4 runtime wiring: ENGRAM sleep-consolidation cron job.
 *
 * Test target: src/cron/jobs/engram-consolidate.ts
 * Runs against a temp ENGRAM dir; seeds an event store with a 3x-failing
 * strategy and asserts the job persists the failure-state map + proposes a
 * switch + writes the manifest.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStore } from "../../memory/engram/event-store.js";
import { loadFailureStateMap } from "../../memory/engram/failure-tracking-store.js";
import type { SleepConsolidationConfig } from "../../memory/engram/sleep-consolidation.js";
import {
  __setRunSleepConsolidationForTest,
  engramConsolidateJob,
  runEngramConsolidate,
} from "./engram-consolidate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-consolidate-job-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("engramConsolidateJob descriptor", () => {
  it("exposes a stable id, a schedule, and a run fn", () => {
    expect(engramConsolidateJob.id).toBe("engram-consolidate");
    expect(engramConsolidateJob.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    expect(typeof engramConsolidateJob.run).toBe("function");
    expect(engramConsolidateJob.run).toBe(runEngramConsolidate);
  });
});

describe("runEngramConsolidate", () => {
  it("returns zeros when there is no events dir", async () => {
    const res = await runEngramConsolidate({ baseDir: dir });
    expect(res.sessionsProcessed).toBe(0);
    expect(res.strategySwitchesProposed).toBe(0);
  });

  it("wires the strategy-switch loop: 3 failing episodes → switch proposed + state persisted", async () => {
    const store = createEventStore({ baseDir: dir, sessionKey: "default" });
    for (let i = 0; i < 3; i++) {
      store.append({
        kind: "user_message",
        content: `merge run ${i}`,
        tokens: 10,
        turnId: i,
        sessionKey: "default",
        metadata: { tags: ["strategy:fork-sync:always-merge", "failure"], taskId: `t${i}` },
      });
    }

    const res = await runEngramConsolidate({ baseDir: dir });

    expect(res.sessionsProcessed).toBe(1);
    expect(res.strategySwitchesProposed).toBe(1);

    // Failure-state map persisted with the global consecutive count.
    const persisted = loadFailureStateMap(dir)["fork-sync:always-merge"];
    expect(persisted).toBeDefined();
    expect(persisted.consecutiveErrors).toBe(3);

    // Manifest written.
    const manifestDir = join(dir, "recipe-mutations");
    expect(existsSync(manifestDir)).toBe(true);
    expect(readdirSync(manifestDir).length).toBe(1);
  });

  it("is idempotent: a second run over the same events proposes nothing new", async () => {
    const store = createEventStore({ baseDir: dir, sessionKey: "default" });
    for (let i = 0; i < 3; i++) {
      store.append({
        kind: "user_message",
        content: `merge run ${i}`,
        tokens: 10,
        turnId: i,
        sessionKey: "default",
        metadata: { tags: ["strategy:fork-sync:always-merge", "failure"], taskId: `t${i}` },
      });
    }

    await runEngramConsolidate({ baseDir: dir });
    const second = await runEngramConsolidate({ baseDir: dir });
    // No new events → no new episodes → counter unchanged (still 3, not 6).
    expect(loadFailureStateMap(dir)["fork-sync:always-merge"].consecutiveErrors).toBe(3);
    expect(second.eventsProcessed).toBe(0);
  });
});

// --- PRODUCER-WIRING tests: the cron MUST inject every procedural-evolution lane
// into the real runSleepConsolidation call, not just strategySwitch. These assert
// the injection at the actual call site (via a spy on runSleepConsolidation) — they
// FAIL against the pre-wiring job, which only ever passed { strategySwitch }.
describe("runEngramConsolidate — producer injection into runSleepConsolidation", () => {
  afterEach(() => {
    __setRunSleepConsolidationForTest(undefined); // restore the real impl
  });

  function seedOneSession(): void {
    const store = createEventStore({ baseDir: dir, sessionKey: "default" });
    store.append({
      kind: "user_message",
      content: "do the thing",
      tokens: 10,
      turnId: 0,
      sessionKey: "default",
      metadata: { taskId: "t0" },
    });
  }

  it("injects skillExtraction (library + extractor) AND recipeEvolution (archive), not just strategySwitch", async () => {
    seedOneSession();

    let captured: SleepConsolidationConfig | undefined;
    const spy = vi.fn(async (_store, _artifact, _state, config?: SleepConsolidationConfig) => {
      captured = config;
      return {
        newEpisodes: [],
        summariesGenerated: 0,
        eventsProcessed: 0,
        durationMs: 0,
      };
    });
    __setRunSleepConsolidationForTest(spy as never);

    await runEngramConsolidate({ baseDir: dir });

    expect(spy).toHaveBeenCalled();
    expect(captured).toBeDefined();
    // U4 (was the only one wired before).
    expect(captured?.strategySwitch).toBeDefined();
    // U6 — the producer that was previously inert.
    expect(captured?.skillExtraction).toBeDefined();
    expect(captured?.skillExtraction?.library).toBeDefined();
    expect(typeof captured?.skillExtraction?.extractor).toBe("function");
    // U1 — recipe-evolution archive must be supplied.
    expect(captured?.recipeEvolution).toBeDefined();
    expect(captured?.recipeEvolution?.archive).toBeDefined();
  });

  it("does NOT inject reconciliation unless ENGRAM_RECONCILE=true (safe default = today's behavior)", async () => {
    seedOneSession();
    const prev = process.env.ENGRAM_RECONCILE;
    delete process.env.ENGRAM_RECONCILE;

    let captured: SleepConsolidationConfig | undefined;
    const spy = vi.fn(async (_store, _artifact, _state, config?: SleepConsolidationConfig) => {
      captured = config;
      return { newEpisodes: [], summariesGenerated: 0, eventsProcessed: 0, durationMs: 0 };
    });
    __setRunSleepConsolidationForTest(spy as never);

    try {
      await runEngramConsolidate({ baseDir: dir });
      expect(captured?.reconciliation).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.ENGRAM_RECONCILE;
      } else {
        process.env.ENGRAM_RECONCILE = prev;
      }
    }
  });

  it("injects reconciliation (default always-ADD reconciler + ledger) when ENGRAM_RECONCILE=true", async () => {
    seedOneSession();
    const prev = process.env.ENGRAM_RECONCILE;
    process.env.ENGRAM_RECONCILE = "true";

    let captured: SleepConsolidationConfig | undefined;
    const spy = vi.fn(async (_store, _artifact, _state, config?: SleepConsolidationConfig) => {
      captured = config;
      return { newEpisodes: [], summariesGenerated: 0, eventsProcessed: 0, durationMs: 0 };
    });
    __setRunSleepConsolidationForTest(spy as never);

    try {
      await runEngramConsolidate({ baseDir: dir });
      expect(captured?.reconciliation).toBeDefined();
      expect(captured?.reconciliation?.reconciler).toBeDefined();
      expect(captured?.reconciliation?.ledger).toBeDefined();
    } finally {
      if (prev === undefined) {
        delete process.env.ENGRAM_RECONCILE;
      } else {
        process.env.ENGRAM_RECONCILE = prev;
      }
    }
  });
});
