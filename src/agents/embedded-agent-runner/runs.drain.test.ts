import { afterEach, describe, expect, it } from "vitest";
import { createBoundaryPauseGate } from "./boundary-pause.js";
import {
  __testing,
  clearActiveEmbeddedRun,
  drainEmbeddedRunsToBoundary,
  releaseEmbeddedRunsFromBoundary,
  setActiveEmbeddedRun,
} from "./runs.js";

afterEach(() => __testing.resetActiveEmbeddedRuns());

function fakeRun(provider = "xai") {
  const gate = createBoundaryPauseGate();
  const handle = {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
    boundaryPause: gate,
    provider,
  };
  return { gate, handle };
}

/** Simulate pi reaching its next model call: the gate holds it. */
function reachBoundary(gate: ReturnType<typeof createBoundaryPauseGate>) {
  void gate.wrap((() => {
    throw new Error("the provider must not be called while held");
  }) as never)({ id: "m" } as never, {} as never, {});
}

describe("drainEmbeddedRunsToBoundary", () => {
  it("reports held, ended and unfinished runs, and leaves cc-bridge runs alone", async () => {
    const heldRun = fakeRun();
    const endingRun = fakeRun();
    const stuckRun = fakeRun();
    const bridgeRun = fakeRun("claude-code");
    setActiveEmbeddedRun("held", heldRun.handle);
    setActiveEmbeddedRun("ending", endingRun.handle);
    setActiveEmbeddedRun("stuck", stuckRun.handle);
    setActiveEmbeddedRun("bridge", bridgeRun.handle);

    setTimeout(() => reachBoundary(heldRun.gate), 30);
    setTimeout(() => clearActiveEmbeddedRun("ending", endingRun.handle), 30);

    const report = await drainEmbeddedRunsToBoundary(300, { pollMs: 10 });
    expect(report.held).toEqual(["held"]);
    expect(report.ended).toEqual(["ending"]);
    expect(report.unfinished).toEqual(["stuck"]);
    // the bridge run is left alone: holding its one call would keep its prompt from the CLI
    // session; the bridge drains its worker at the API calls inside it
    expect(bridgeRun.gate.state).toBe("running");
  });

  it("returns at once when nothing is running", async () => {
    const started = Date.now();
    expect(await drainEmbeddedRunsToBoundary(5_000, { pollMs: 10 })).toEqual({
      held: [],
      ended: [],
      unfinished: [],
    });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("release lets every held run go on", async () => {
    const run = fakeRun();
    setActiveEmbeddedRun("r", run.handle);
    setTimeout(() => reachBoundary(run.gate), 10);
    await drainEmbeddedRunsToBoundary(500, { pollMs: 5 });
    expect(run.gate.state).toBe("paused");
    releaseEmbeddedRunsFromBoundary();
    expect(run.gate.state).toBe("running");
  });
});
