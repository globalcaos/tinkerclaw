/**
 * FORK 2026-06-01 — tests for the nightly-consolidation SUPERVISOR shell (J8 §2c).
 *
 * Test target: src/fork/consolidation-shell.ts
 *
 * 2c LoRA TRAINING is EXTERNAL/OUT-OF-SCOPE: the real GPU/Python trainer + MMLU/HumanEval
 * benchmarks are a separate tracked deliverable. This shell only SIGNALS intent and
 * SUPERVISES a black-box trainer subprocess via a JSON contract. Every dependency
 * (trainer, capability matrix, emitter, gap reader) is injected so the suite runs with
 * NO GPU and NO model API — per the J8 plan test convention.
 */

import { describe, it, expect, vi } from "vitest";
import {
  notifyLoraTrainingNeeded,
  runNightlyConsolidation,
  type ConsolidationDeps,
} from "./consolidation-shell.js";
import { makeGap, type Gap } from "./curiosity-store.js";

const NOW = 1_700_000_000_000;

// A validated, high-priority knowledge gap (externally resolved → eligible for training).
function validatedGap(overrides: Partial<Parameters<typeof makeGap>[0]> = {}): Gap {
  const g = makeGap({
    topic: "use playwright",
    source: "no-match",
    importance: 0.9,
    learnability: 0.9,
    userRelevance: 0.9,
    resolutionType: "knowledge-gap",
    ts: NOW,
    ...overrides,
  });
  g.resolutionSource = "web-search"; // external channel → validated, NOT self-output
  g.resolvedAt = NOW;
  return g;
}

describe("notifyLoraTrainingNeeded — fire-and-forget intent signal", () => {
  it("returns void synchronously (never awaits the trainer) and emits a 'lora-training-needed' intent event off-stack", async () => {
    const emit = vi.fn();
    const ret = notifyLoraTrainingNeeded([validatedGap()], { emit, runId: "r1" });
    // The function MUST return void synchronously (not a Promise) — caller cannot await it.
    expect(ret).toBeUndefined();
    // The emit is fire-and-forget (scheduled off the caller's stack) → not yet called sync.
    expect(emit).not.toHaveBeenCalled();
    // Flush the microtask queue: the deferred signal lands.
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]![0];
    expect(ev.data.phase).toBe("lora-training-needed");
    expect(ev.runId).toBe("r1");
  });

  it("never throws even if the emitter throws (fire-and-forget is best-effort)", () => {
    const emit = vi.fn(() => {
      throw new Error("emit exploded");
    });
    expect(() => notifyLoraTrainingNeeded([validatedGap()], { emit })).not.toThrow();
  });

  it("signals zero gaps without throwing (no-op intent)", () => {
    const emit = vi.fn();
    expect(() => notifyLoraTrainingNeeded([], { emit })).not.toThrow();
  });
});

describe("runNightlyConsolidation — supervisor (mocked trainer + mocked gate)", () => {
  function baseDeps(overrides: Partial<ConsolidationDeps> = {}): ConsolidationDeps {
    return {
      readValidatedGaps: () => [validatedGap()],
      trainAdapter: vi.fn(async () => ({ ok: true, adapterPath: "/tmp/adapter-1" })),
      runCapabilityMatrix: vi.fn(async () => ({
        adapter: "/tmp/adapter-1",
        maxRegression: 0.01,
        alignmentFail: false,
        passed: true,
      })),
      updateConsolidationPointer: vi.fn(),
      emit: vi.fn(),
      runId: "consolidation-run",
      ...overrides,
    };
  }

  it("SKIPS when there are no high-priority validated gaps (cost guard) — no trainer spawned", async () => {
    const deps = baseDeps({ readValidatedGaps: () => [] });
    const result = await runNightlyConsolidation(deps);
    expect(result.status).toBe("skipped");
    expect(deps.trainAdapter).not.toHaveBeenCalled();
    expect(deps.runCapabilityMatrix).not.toHaveBeenCalled();
    expect(deps.updateConsolidationPointer).not.toHaveBeenCalled();
  });

  it("on a passing gate: merges — updates the pointer and emits 'consolidation-merged'", async () => {
    const deps = baseDeps();
    const result = await runNightlyConsolidation(deps);
    expect(deps.trainAdapter).toHaveBeenCalledTimes(1);
    expect(deps.runCapabilityMatrix).toHaveBeenCalledTimes(1);
    expect(deps.updateConsolidationPointer).toHaveBeenCalledTimes(1);
    expect(deps.updateConsolidationPointer).toHaveBeenCalledWith("/tmp/adapter-1");
    expect(result.status).toBe("merged");
    const phases = (deps.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data.phase);
    expect(phases).toContain("consolidation-merged");
  });

  it("on a regressing gate: REJECTS — does NOT touch the pointer and emits 'consolidation-fail'", async () => {
    const deps = baseDeps({
      runCapabilityMatrix: vi.fn(async () => ({
        adapter: "/tmp/adapter-1",
        maxRegression: 0.07, // > 2% → reject
        alignmentFail: false,
        passed: false,
      })),
    });
    const result = await runNightlyConsolidation(deps);
    expect(deps.trainAdapter).toHaveBeenCalledTimes(1);
    expect(deps.updateConsolidationPointer).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    const phases = (deps.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data.phase);
    expect(phases).toContain("consolidation-fail");
  });

  it("on an alignment failure: REJECTS regardless of benchmark deltas", async () => {
    const deps = baseDeps({
      runCapabilityMatrix: vi.fn(async () => ({
        adapter: "/tmp/adapter-1",
        maxRegression: 0.0,
        alignmentFail: true,
        passed: false,
      })),
    });
    const result = await runNightlyConsolidation(deps);
    expect(deps.updateConsolidationPointer).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
  });

  it("when the external trainer FAILS: aborts the gate and pointer, emits 'consolidation-fail', never throws", async () => {
    const deps = baseDeps({
      trainAdapter: vi.fn(async () => ({ ok: false, error: "GPU OOM" })),
    });
    const result = await runNightlyConsolidation(deps);
    expect(deps.runCapabilityMatrix).not.toHaveBeenCalled();
    expect(deps.updateConsolidationPointer).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    const phases = (deps.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data.phase);
    expect(phases).toContain("consolidation-fail");
  });

  it("never throws even if the gate itself throws (supervisor is defensive)", async () => {
    const deps = baseDeps({
      runCapabilityMatrix: vi.fn(async () => {
        throw new Error("benchmark harness exploded");
      }),
    });
    const result = await runNightlyConsolidation(deps);
    expect(result.status).toBe("rejected");
    expect(deps.updateConsolidationPointer).not.toHaveBeenCalled();
  });
});
