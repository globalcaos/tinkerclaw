import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  activateOverseer,
  deactivateOverseer,
  getOverseerSession,
  shouldRunOverseer,
  parseOverseerVerdict,
  buildOverseerContext,
  maybeRunOverseer,
  overseerWorkingBound,
  OVERSEER_LOOP_HARD_CEILING,
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
  it("at the derived budget, does not run (no frozen cap)", () => {
    activateOverseer("s", "t", 1.0); // a perfectly reliable recipe → smallest derived budget
    expect(shouldRunOverseer("s")).toBe(true); // iteration 0 < derived bound
    getOverseerSession("s")!.iteration = overseerWorkingBound(getOverseerSession("s")!);
    expect(shouldRunOverseer("s")).toBe(false); // reached the derived bound
  });
});

describe("buildOverseerContext", () => {
  it("includes the task, role-labelled transcript, and the completion-directive ask", () => {
    const ctx = buildOverseerContext("ship the feature", [
      { role: "user", text: "build X" },
      { role: "assistant", text: "done-ish" },
    ]);
    expect(ctx).toContain("ship the feature");
    expect(ctx).toContain("USER: build X");
    expect(ctx).toContain("JARVIS: done-ish");
    expect(ctx).toContain("completion directive");
    expect(ctx).toContain("every remaining gap");
  });
  it("by default includes the FULL transcript — all there is in the chat, no window", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `m${i}` }));
    const ctx = buildOverseerContext("t", msgs); // no windowTurns → entire conversation
    expect(ctx).toContain("m0");
    expect(ctx).toContain("m39");
  });
  it("bounds the window to the last N turns only when windowTurns is given", () => {
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

  it("nudge count is DERIVED from recipe fitness, never frozen, and is ceiling-bounded", async () => {
    // A perfectly reliable recipe earns the FEWEST supervision passes…
    activateOverseer("hi", "t", 1.0);
    const hi = mockDeps("keep going");
    for (let i = 0; i < OVERSEER_LOOP_HARD_CEILING + 3; i++) {
      await maybeRunOverseer("hi", "t", msgs, hi.deps);
    }
    // …a shaky one (low fitness) earns MORE — proving the bound responds to the situation.
    activateOverseer("lo", "t", 0.0);
    const lo = mockDeps("keep going");
    for (let i = 0; i < OVERSEER_LOOP_HARD_CEILING + 3; i++) {
      await maybeRunOverseer("lo", "t", msgs, lo.deps);
    }
    expect(hi.injected.length).toBeGreaterThanOrEqual(1); // always at least one pass
    expect(lo.injected.length).toBeGreaterThan(hi.injected.length); // derived, not a constant
    expect(lo.injected.length).toBeLessThanOrEqual(OVERSEER_LOOP_HARD_CEILING); // ceiling holds
    expect(getOverseerSession("hi")!.active).toBe(false); // loop self-terminated at its budget
    expect(getOverseerSession("lo")!.active).toBe(false);
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
