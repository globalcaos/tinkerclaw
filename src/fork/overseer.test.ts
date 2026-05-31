import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  activateOverseer,
  deactivateOverseer,
  getOverseerSession,
  shouldRunOverseer,
  parseOverseerVerdict,
  buildOverseerContext,
  maybeRunOverseer,
  MAX_OVERSEER_ITERATIONS,
  _resetOverseerState,
  type OverseerDeps,
} from "./overseer.js";

beforeEach(() => _resetOverseerState());

describe("parseOverseerVerdict — silence means done", () => {
  it("empty / whitespace → done", () => {
    expect(parseOverseerVerdict("")).toEqual({ done: true, nudge: null });
    expect(parseOverseerVerdict("   \n ")).toEqual({ done: true, nudge: null });
    expect(parseOverseerVerdict(null)).toEqual({ done: true, nudge: null });
    expect(parseOverseerVerdict(undefined)).toEqual({ done: true, nudge: null });
  });
  it("bare done-markers → done", () => {
    for (const m of ["✅", "DONE", "done.", "Complete", "task complete", "all done", "LGTM"]) {
      expect(parseOverseerVerdict(m).done).toBe(true);
    }
  });
  it("substantive text → nudge (trimmed, verbatim)", () => {
    const v = parseOverseerVerdict("  You still haven't run the tests. Run them and report.  ");
    expect(v.done).toBe(false);
    expect(v.nudge).toBe("You still haven't run the tests. Run them and report.");
  });
  it("a 'done' word inside a real nudge does NOT count as done", () => {
    const v = parseOverseerVerdict("Step 3 is done but step 4 (deploy) is still pending — do it.");
    expect(v.done).toBe(false);
  });
});

describe("activation + shouldRunOverseer (bounded)", () => {
  it("inactive session never runs", () => {
    expect(shouldRunOverseer("s")).toBe(false);
  });
  it("active + under cap runs; deactivated does not", () => {
    activateOverseer("s", "do the thing");
    expect(shouldRunOverseer("s")).toBe(true);
    deactivateOverseer("s");
    expect(shouldRunOverseer("s")).toBe(false);
  });
  it("at the iteration cap, does not run", () => {
    activateOverseer("s", "t");
    getOverseerSession("s")!.iteration = MAX_OVERSEER_ITERATIONS;
    expect(shouldRunOverseer("s")).toBe(false);
  });
});

describe("buildOverseerContext", () => {
  it("includes the task, role-labelled transcript, and the completion question", () => {
    const ctx = buildOverseerContext("ship the feature", [
      { role: "user", text: "build X" },
      { role: "assistant", text: "done-ish" },
    ]);
    expect(ctx).toContain("ship the feature");
    expect(ctx).toContain("USER: build X");
    expect(ctx).toContain("JARVIS: done-ish");
    expect(ctx).toContain("fully complete");
  });
  it("bounds the window to the last N turns", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `m${i}` }));
    const ctx = buildOverseerContext("t", msgs, 5);
    expect(ctx).toContain("m39");
    expect(ctx).not.toContain("m10");
  });
});

describe("maybeRunOverseer — the loop", () => {
  function mockDeps(output: string): {
    deps: OverseerDeps;
    injected: string[];
    spawn: ReturnType<typeof vi.fn>;
  } {
    const injected: string[] = [];
    const spawn = vi.fn().mockResolvedValue(output);
    return {
      injected,
      spawn,
      deps: {
        spawnOverseer: spawn,
        injectPrompt: async (_sk, nudge) => {
          injected.push(nudge);
        },
      },
    };
  }
  const msgs = [
    { role: "user", text: "build X" },
    { role: "assistant", text: "attempted" },
  ];

  it("inactive → does not run or inject", async () => {
    const { deps, injected, spawn } = mockDeps("nudge");
    const out = await maybeRunOverseer("s", "t", msgs, deps);
    expect(out.ran).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(injected).toEqual([]);
  });

  it("nudge → injects the nudge, increments iteration, stays active", async () => {
    activateOverseer("s", "build X fully");
    const { deps, injected } = mockDeps("You skipped the tests — run them.");
    const out = await maybeRunOverseer("s", "build X fully", msgs, deps);
    expect(out.nudged).toBe(true);
    expect(out.done).toBe(false);
    expect(injected).toEqual(["You skipped the tests — run them."]);
    expect(getOverseerSession("s")!.iteration).toBe(1);
    expect(getOverseerSession("s")!.active).toBe(true);
  });

  it("silence → done, deactivates, injects nothing (loop ends)", async () => {
    activateOverseer("s", "t");
    const { deps, injected } = mockDeps("");
    const out = await maybeRunOverseer("s", "t", msgs, deps);
    expect(out.done).toBe(true);
    expect(injected).toEqual([]);
    expect(getOverseerSession("s")!.active).toBe(false);
  });

  it("cannot exceed MAX_OVERSEER_ITERATIONS nudges", async () => {
    activateOverseer("s", "t");
    const { deps, injected } = mockDeps("keep going");
    for (let i = 0; i < MAX_OVERSEER_ITERATIONS + 3; i++) {
      await maybeRunOverseer("s", "t", msgs, deps);
    }
    expect(injected.length).toBe(MAX_OVERSEER_ITERATIONS);
    expect(getOverseerSession("s")!.active).toBe(false);
  });

  it("spawn error → reported, no injection, stays active for retry next turn", async () => {
    activateOverseer("s", "t");
    const deps: OverseerDeps = {
      spawnOverseer: vi.fn().mockRejectedValue(new Error("boom")),
      injectPrompt: vi.fn(),
    };
    const out = await maybeRunOverseer("s", "t", msgs, deps);
    expect(out.reason).toBe("spawn-error");
    expect(deps.injectPrompt).not.toHaveBeenCalled();
    expect(getOverseerSession("s")!.active).toBe(true);
  });
});
