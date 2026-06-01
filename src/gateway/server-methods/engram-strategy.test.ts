/**
 * Tests — Upgrade 4 runtime wiring: gateway RPC surface for strategy-switch
 * review (engram-strategy.ts).
 *
 * Test target: src/gateway/server-methods/engram-strategy.ts
 * Handlers persist to a temp ENGRAM dir via the `baseDir` param so no real
 * ~/.openclaw is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as failureStore from "../../memory/engram/failure-tracking-store.js";
import {
  loadFailureStateMap,
  saveFailureStateMap,
} from "../../memory/engram/failure-tracking-store.js";
import {
  createInitialStrategyState,
  recordFailure,
  type FailureStateMap,
} from "../../memory/engram/failure-tracking.js";
import { forkStrategyHandlers } from "./engram-strategy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-strategy-rpc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Invoke a handler and capture the (ok, payload, error) it responds with. */
async function call(
  method: keyof typeof forkStrategyHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: any; error?: any }> {
  let captured: { ok: boolean; payload?: any; error?: any } = { ok: false };
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    captured = { ok, payload, error };
  };
  await forkStrategyHandlers[method]!({
    // Only `params` and `respond` are read by these fork handlers.
    params,
    respond,
  } as never);
  return captured;
}

/** Seed a strategy at N consecutive failures (enough to trip a switch). */
function seedFailing(strategyId: string, n: number): FailureStateMap {
  let s = createInitialStrategyState(strategyId);
  const base = Date.parse("2026-05-30T10:00:00.000Z");
  for (let i = 0; i < n; i++) {
    s = recordFailure(s, new Date(base + i * 60_000).toISOString(), `e${i}`);
  }
  return { [strategyId]: s };
}

describe("fork.strategy.switch.list", () => {
  it("returns an empty list when no state file exists", async () => {
    const res = await call("fork.strategy.switch.list", { baseDir: dir });
    expect(res.ok).toBe(true);
    expect(res.payload.decisions).toEqual([]);
  });

  it("returns a switch proposal for a 3x-failed strategy with a registered fallback", async () => {
    saveFailureStateMap(seedFailing("fork-sync:always-merge", 3), dir);
    const res = await call("fork.strategy.switch.list", {
      baseDir: dir,
      now: "2026-05-30T10:05:00.000Z",
    });
    expect(res.ok).toBe(true);
    expect(res.payload.decisions).toHaveLength(1);
    expect(res.payload.decisions[0].fromStrategy).toBe("fork-sync:always-merge");
    expect(res.payload.decisions[0].toStrategy).toBe("fork-sync:ask-before-merge");
  });

  it("omits strategies below threshold", async () => {
    saveFailureStateMap(seedFailing("fork-sync:always-merge", 2), dir);
    const res = await call("fork.strategy.switch.list", {
      baseDir: dir,
      now: "2026-05-30T10:05:00.000Z",
    });
    expect(res.payload.decisions).toEqual([]);
  });
});

describe("fork.strategy.switch.apply", () => {
  it("applies the switch, resets the counter, records history, and persists", async () => {
    saveFailureStateMap(seedFailing("fork-sync:always-merge", 3), dir);
    const res = await call("fork.strategy.switch.apply", {
      baseDir: dir,
      strategyId: "fork-sync:always-merge",
      toStrategy: "fork-sync:ask-before-merge",
    });
    expect(res.ok).toBe(true);

    const persisted = loadFailureStateMap(dir)["fork-sync:always-merge"];
    expect(persisted.currentStrategy).toBe("fork-sync:ask-before-merge");
    expect(persisted.consecutiveErrors).toBe(0);
    expect(persisted.switchHistory).toHaveLength(1);
    expect(persisted.switchHistory[0].to).toBe("fork-sync:ask-before-merge");
  });

  it("uses the registered fallback when toStrategy is omitted", async () => {
    saveFailureStateMap(seedFailing("fork-sync:always-merge", 3), dir);
    const res = await call("fork.strategy.switch.apply", {
      baseDir: dir,
      strategyId: "fork-sync:always-merge",
    });
    expect(res.ok).toBe(true);
    expect(loadFailureStateMap(dir)["fork-sync:always-merge"].currentStrategy).toBe(
      "fork-sync:ask-before-merge",
    );
  });

  it("errors when strategyId is missing", async () => {
    const res = await call("fork.strategy.switch.apply", { baseDir: dir });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("errors when the strategy is unknown", async () => {
    const res = await call("fork.strategy.switch.apply", {
      baseDir: dir,
      strategyId: "never-seen",
      toStrategy: "x",
    });
    expect(res.ok).toBe(false);
  });

  it("errors when no toStrategy is given and no fallback is registered", async () => {
    saveFailureStateMap(seedFailing("mystery", 3), dir);
    const res = await call("fork.strategy.switch.apply", {
      baseDir: dir,
      strategyId: "mystery",
    });
    expect(res.ok).toBe(false);
  });

  // Producer guard: the INITIAL loadFailureStateMap read in apply must be wrapped
  // in the same try/catch + errorShape(UNAVAILABLE) as switch.list/switch.review.
  // Before the wiring, a load throw escaped apply uncaught (the unwired-guard
  // regression). We force the read to throw via a spy and assert apply degrades to
  // a typed UNAVAILABLE response (not a rejected promise / uncaught throw).
  it("responds UNAVAILABLE (not an uncaught throw) when the initial load fails", async () => {
    const spy = vi.spyOn(failureStore, "loadFailureStateMap").mockImplementation(() => {
      throw new Error("engram store unreadable");
    });
    try {
      const res = await call("fork.strategy.switch.apply", {
        baseDir: dir,
        strategyId: "fork-sync:always-merge",
        toStrategy: "fork-sync:ask-before-merge",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe("UNAVAILABLE");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("fork.strategy.switch.review", () => {
  it("returns the full per-strategy state for human review", async () => {
    saveFailureStateMap(seedFailing("fork-sync:always-merge", 3), dir);
    // Pass `now` within the recency window of the seeded failures so the
    // decision's recency guard doesn't suppress the (otherwise live) switch.
    const res = await call("fork.strategy.switch.review", {
      baseDir: dir,
      now: "2026-05-30T10:05:00.000Z",
    });
    expect(res.ok).toBe(true);
    expect(res.payload.strategies).toHaveLength(1);
    const row = res.payload.strategies[0];
    expect(row.strategyId).toBe("fork-sync:always-merge");
    expect(row.consecutiveErrors).toBe(3);
    // each row carries its current switch decision (the proposal, if any)
    expect(row.decision.shouldSwitch).toBe(true);
  });

  it("can filter to a single strategyId", async () => {
    const map = { ...seedFailing("a", 3), ...seedFailing("b", 1) };
    saveFailureStateMap(map, dir);
    const res = await call("fork.strategy.switch.review", { baseDir: dir, strategyId: "a" });
    expect(res.payload.strategies).toHaveLength(1);
    expect(res.payload.strategies[0].strategyId).toBe("a");
  });
});
