// FORK 2026-10-08 — the Fractal turn in the call timeline (the owner: "Afegeix una línia vertical quan
// acaba el torn normal i segueix dibuixant els tokens d'anada i vinguda del torn fractal").
import { describe, expect, it } from "vitest";
import { fractalRunIdFor } from "../fractal-run-id.js";
import { CallTimelineStore, fractalSpans } from "./call-timeline.js";

const S = 1_000;
const base = 1_700_000_000_000;
const t = (sec: number): number => base + sec * S;

function call(
  st: CallTimelineStore,
  run: string,
  i: number,
  at: number,
  input: number,
  output: number,
) {
  st.callEvent(run, { phase: "send", callIndex: i, t: t(at) }, t(at));
  st.callEvent(run, { phase: "usage", callIndex: i, input }, t(at + 1));
  st.callEvent(run, { phase: "end", callIndex: i, output }, t(at + 2));
}

/** Prompt 1 (two calls), then its Fractal turn (one call so far). */
function promptThenFractal(): { st: CallTimelineStore; f: string } {
  const st = new CallTimelineStore();
  st.prepTick(t(0));
  st.turnStart("p1", t(1), "m");
  call(st, "p1", 1, 2, 50_000, 800);
  call(st, "p1", 2, 10, 60_000, 1_200);
  st.turnEnd("p1", t(20));
  const f = fractalRunIdFor("p1");
  st.turnStart(f, t(23), "m");
  call(st, f, 1, 24, 70_000, 400);
  return { st, f };
}

describe("call timeline — a Fractal turn drawn after the turn it reflects on", () => {
  it("puts both runs in one window, with the line at the first Fractal call", () => {
    const { st, f } = promptThenFractal();
    const v = st.promptView()!;
    expect(v.runId).toBe(f);
    expect(v.calls).toBe(3);
    expect(st.calls[v.firstCall].runId).toBe("p1");
    expect(v.fractal).toEqual({ firstCall: v.firstCall + 2, parentCalls: 2, calls: 1 });
    expect(st.calls[v.fractal!.firstCall].runId).toBe(f);
    // Both lanes scale over the two runs together.
    expect(v.prompt).toBe(70_000);
    expect(v.out).toBe(1_200);
  });

  it("counts prompts, not turns: the Fractal turn keeps its parent's number", () => {
    const { st, f } = promptThenFractal();
    expect(st.turnOrdinal("p1")).toBe(1);
    expect(st.turnOrdinal(f)).toBe(1);
    expect(st.promptView()!.ordinal).toBe(1);
    st.turnEnd(f, t(40));
    st.prepTick(t(100));
    st.turnStart("p2", t(101), "m");
    call(st, "p2", 1, 102, 10_000, 100);
    expect(st.promptView()).toMatchObject({ runId: "p2", ordinal: 2 });
    expect(st.promptView()!.fractal).toBeUndefined();
  });

  it("holds the parent, naming the Fractal turn, until the reflection makes its first call", () => {
    const st = new CallTimelineStore();
    st.turnStart("p1", t(1), "m");
    call(st, "p1", 1, 2, 50_000, 800);
    st.turnEnd("p1", t(20));
    st.turnStart(fractalRunIdFor("p1"), t(23), "m");
    const v = st.promptView()!;
    expect(v.runId).toBe("p1");
    expect(v.fractal).toBeUndefined();
    expect(v.newer).toMatchObject({ ordinal: 1, state: "preparing", fractal: true });
  });

  it("CONTROL: an ordinary second prompt draws alone, with no line", () => {
    const st = new CallTimelineStore();
    st.turnStart("p1", t(1), "m");
    call(st, "p1", 1, 2, 50_000, 800);
    st.turnEnd("p1", t(20));
    st.turnStart("p2", t(23), "m");
    call(st, "p2", 1, 24, 70_000, 400);
    const v = st.promptView()!;
    expect(v.calls).toBe(1);
    expect(v.fractal).toBeUndefined();
    expect(v.ordinal).toBe(2);
  });

  it("survives a reload: the snapshot carries the parent and both come back", () => {
    const { st, f } = promptThenFractal();
    st.turnEnd(f, t(40));
    const snap = JSON.parse(JSON.stringify(st.lastRunSnapshot()));
    expect(snap.runId).toBe(f);
    expect(snap.parent?.runId).toBe("p1");
    const fresh = new CallTimelineStore();
    expect(fresh.restoreRun(snap)).toBe(true);
    const v = fresh.promptView()!;
    expect(v.runId).toBe(f);
    expect(v.fractal).toMatchObject({ parentCalls: 2, calls: 1 });
  });

  it("CONTROL: a plain run's snapshot has no parent", () => {
    const st = new CallTimelineStore();
    st.turnStart("p1", t(1), "m");
    call(st, "p1", 1, 2, 50_000, 800);
    st.turnEnd("p1", t(20));
    expect(st.lastRunSnapshot()!.parent).toBeUndefined();
  });

  it("keeps a Fractal that is still running in the window of a prompt started over it", () => {
    const { st, f } = promptThenFractal();
    st.prepTick(t(30));
    st.turnStart("p2", t(31), "m");
    call(st, "p2", 1, 32, 80_000, 300);
    call(st, f, 2, 34, 75_000, 500);
    const v = st.promptView()!;
    expect(v.runId).toBe("p2");
    expect(v.ordinal).toBe(2);
    const drawn = st.calls.slice(v.firstCall, v.firstCall + v.calls).map((c) => c.runId);
    expect(drawn).toEqual([f, "p2", f]);
    expect(v.prompt).toBe(80_000);
    expect(fractalSpans(st.calls.slice(v.firstCall, v.firstCall + v.calls))).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ]);
  });

  it("CONTROL: a Fractal that ended before the new prompt stays out of its window", () => {
    const { st, f } = promptThenFractal();
    st.turnEnd(f, t(28));
    st.turnStart("p2", t(31), "m");
    call(st, "p2", 1, 32, 80_000, 300);
    const v = st.promptView()!;
    expect(v.calls).toBe(1);
    expect(st.calls[v.firstCall].runId).toBe("p2");
  });
});
