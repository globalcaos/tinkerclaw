import { describe, expect, it } from "vitest";
import {
  appendTurnPhase,
  pendingPillLabel,
  readTurnPhaseEvent,
  TURN_PHASE_STREAM,
  turnPhaseLabelFor,
  turnPhaseSteps,
  type TurnPhase,
} from "./turn-phase.js";

// app.ts `sessionKeyMatches`, transcribed: tolerant of short vs canonical forms.
const matches = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) {
    return false;
  }
  return a === b || a.endsWith(":" + b) || b.endsWith(":" + a);
};

const evt = (sessionKey: string, phase: string, label?: string) => ({
  runId: "run-1",
  sessionKey,
  stream: TURN_PHASE_STREAM,
  data: label === undefined ? { phase } : { phase, label },
});

describe("readTurnPhaseEvent", () => {
  it("keeps the gateway's label and the session it belongs to", () => {
    const got = readTurnPhaseEvent(
      evt("agent:main:tinker:A", "recall", "recalling memories"),
      1234,
    );
    expect(got).toEqual({
      phase: "recall",
      label: "recalling memories",
      at: 1234,
      sessionKey: "agent:main:tinker:A",
    });
  });

  it("accepts every phase in the contract", () => {
    for (const phase of ["accepted", "compaction", "recall", "prompt", "model", "spawn"]) {
      expect(readTurnPhaseEvent(evt("s", phase, `doing ${phase}`), 1)?.phase).toBe(phase);
    }
  });

  it("accepts a phase name the UI has never heard of (forward compatibility)", () => {
    expect(readTurnPhaseEvent(evt("s", "warming-cache", "warming the cache"), 1)?.label).toBe(
      "warming the cache",
    );
  });

  it("falls back to the phase name when the envelope carries no label", () => {
    expect(readTurnPhaseEvent(evt("s", "spawn"), 1)?.label).toBe("spawn");
    expect(readTurnPhaseEvent(evt("s", "spawn", "   "), 1)?.label).toBe("spawn");
  });

  it("drops envelopes that cannot be attributed or have no phase", () => {
    expect(readTurnPhaseEvent(evt("", "recall", "x"), 1)).toBeNull();
    expect(readTurnPhaseEvent(evt("s", "", "x"), 1)).toBeNull();
    expect(readTurnPhaseEvent({ sessionKey: "s" }, 1)).toBeNull();
    expect(readTurnPhaseEvent(null, 1)).toBeNull();
    expect(readTurnPhaseEvent({ sessionKey: 7, data: { phase: "recall" } }, 1)).toBeNull();
    expect(readTurnPhaseEvent({ sessionKey: "s", data: { phase: 7 } }, 1)).toBeNull();
  });

  it("trims trailing dots (the pill appends its own) and clamps a runaway label", () => {
    expect(readTurnPhaseEvent(evt("s", "recall", "recalling memories..."), 1)?.label).toBe(
      "recalling memories",
    );
    const long = readTurnPhaseEvent(evt("s", "recall", "x".repeat(200)), 1)?.label ?? "";
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("turnPhaseLabelFor", () => {
  const state: TurnPhase = {
    phase: "recall",
    label: "recalling memories",
    at: 1,
    sessionKey: "agent:main:tinker:A",
  };

  it("paints the viewed tab, in short or canonical form", () => {
    expect(turnPhaseLabelFor(state, "agent:main:tinker:A", matches)).toBe("recalling memories");
    expect(turnPhaseLabelFor(state, "tinker:A", matches)).toBe("recalling memories");
  });

  it("never paints a different tab's phase", () => {
    expect(turnPhaseLabelFor(state, "agent:main:tinker:B", matches)).toBeNull();
  });

  it("is null before any event has arrived", () => {
    expect(turnPhaseLabelFor(null, "agent:main:tinker:A", matches)).toBeNull();
    expect(turnPhaseLabelFor(state, undefined, matches)).toBeNull();
  });
});

describe("pendingPillLabel", () => {
  it("prefers the gateway's phase over the static text", () => {
    expect(pendingPillLabel({ preparing: true, phaseLabel: "building the prompt" })).toBe(
      "building the prompt",
    );
  });

  it("keeps today's behaviour when the gateway emits no phases", () => {
    expect(pendingPillLabel({ preparing: true, phaseLabel: null })).toBe("preparing context");
    expect(pendingPillLabel({ preparing: false, phaseLabel: null })).toBe("sending");
    expect(pendingPillLabel({ preparing: false })).toBe("sending");
  });

  it("still shows a phase that landed before chat.send resolved", () => {
    expect(pendingPillLabel({ preparing: false, phaseLabel: "accepted" })).toBe("accepted");
  });

  it("treats a blank label as no phase at all — never a blank pill", () => {
    expect(pendingPillLabel({ preparing: true, phaseLabel: "   " })).toBe("preparing context");
  });
});

// FORK 2026-08-15 (the architect: "itemized as much as possible") — the trail is what answers
// "where did the 30 seconds go", so its ordering, collapsing and duration arithmetic are
// the parts worth pinning. Durations come from real arrival times only.
const P = (phase: string, at: number, sessionKey = "agent:main:tinker:A"): TurnPhase => ({
  phase,
  label: phase,
  at,
  sessionKey,
});

describe("appendTurnPhase", () => {
  it("keeps phases in arrival order", () => {
    let t: TurnPhase[] = [];
    t = appendTurnPhase(t, P("recall", 1000));
    t = appendTurnPhase(t, P("prompt", 2000));
    t = appendTurnPhase(t, P("model", 3000));
    expect(t.map((x) => x.phase)).toEqual(["recall", "prompt", "model"]);
  });

  it("collapses a re-announced phase instead of stuttering", () => {
    let t = appendTurnPhase([], P("prompt", 1000));
    t = appendTurnPhase(t, P("prompt", 2000));
    expect(t).toHaveLength(1);
    expect(t[0].at).toBe(1000);
  });

  it("starts a fresh trail when the session changes — that is a new turn", () => {
    let t = appendTurnPhase([], P("recall", 1000, "agent:main:tinker:A"));
    t = appendTurnPhase(t, P("prompt", 2000, "agent:main:tinker:B"));
    expect(t).toHaveLength(1);
    expect(t[0].sessionKey).toBe("agent:main:tinker:B");
  });

  it("caps the trail rather than growing unbounded", () => {
    let t: TurnPhase[] = [];
    for (let i = 0; i < 20; i++) {
      t = appendTurnPhase(t, P(`p${i}`, i * 1000));
    }
    expect(t.length).toBeLessThanOrEqual(8);
    expect(t[t.length - 1].phase).toBe("p19");
  });

  // FORK 2026-08-15 — the gateway now reports each stage TWICE (start, then completion with a
  // server-measured `ms`) under the same phase name. The collapse rule above was written when a
  // repeated name could only be a stutter, so it swallowed every completion and the trail held
  // nothing but open-ended stages — which is why the breadcrumb never rendered a single chip.
  it("lets a completion REPLACE its own start rather than collapsing it", () => {
    let t = appendTurnPhase([], P("recall", 1_000));
    t = appendTurnPhase(t, { ...P("recall", 9_000), ms: 8_000 });
    expect(t).toHaveLength(1);
    expect(t[0].ms).toBe(8_000);
    // the START's arrival time is kept: it is when the stage actually began
    expect(t[0].at).toBe(1_000);
  });

  it("still collapses two starts of the same phase (a genuine re-announcement)", () => {
    let t = appendTurnPhase([], P("prompt", 1_000));
    t = appendTurnPhase(t, P("prompt", 2_000));
    expect(t).toHaveLength(1);
    expect(t[0].ms).toBeUndefined();
  });

  it("does not let a completion overwrite an already-completed stage", () => {
    let t = appendTurnPhase([], { ...P("recall", 1_000), ms: 5_000 });
    t = appendTurnPhase(t, { ...P("recall", 9_000), ms: 99_000 });
    expect(t).toHaveLength(1);
    expect(t[0].ms).toBe(5_000);
  });
});

describe("turnPhaseSteps", () => {
  it("derives each step's duration from the NEXT step's arrival, and leaves the last one live", () => {
    const t = [P("recall", 1_000), P("prompt", 5_000), P("model", 21_000)];
    const steps = turnPhaseSteps(t, "agent:main:tinker:A", matches, 26_000);
    expect(steps).toEqual([
      { label: "recall", seconds: 4, ms: 4_000, done: true },
      { label: "prompt", seconds: 16, ms: 16_000, done: true },
      { label: "model", seconds: 5, ms: 5_000, done: false },
    ]);
  });

  it("renders nothing for a tab the trail does not belong to", () => {
    const t = [P("recall", 1_000, "agent:main:tinker:A")];
    expect(turnPhaseSteps(t, "agent:main:tinker:B", matches, 2_000)).toEqual([]);
  });

  // FORK 2026-08-15 — a self-timed stage reports the wall time it actually held. That must beat
  // arrival-gap arithmetic, which silently folds websocket and event-loop latency into whichever
  // stage happens to be open — and those are precisely the numbers being used to decide what to
  // optimise, so an inflated one would send the work to the wrong stage.
  it("prefers the gateway's measured ms over the gap to the next arrival", () => {
    const t: TurnPhase[] = [
      { ...P("recall", 1_000), ms: 8_000 },
      { ...P("prompt", 30_000), ms: 500 },
    ];
    const steps = turnPhaseSteps(t, "agent:main:tinker:A", matches, 60_000);
    expect(steps).toEqual([
      { label: "recall", seconds: 8, ms: 8_000, done: true },
      { label: "prompt", seconds: 1, ms: 500, done: true },
    ]);
  });

  it("still uses arrival gaps for a gateway that only sends starts", () => {
    const t = [P("recall", 1_000), P("prompt", 5_000)];
    const steps = turnPhaseSteps(t, "agent:main:tinker:A", matches, 9_000);
    expect(steps).toEqual([
      { label: "recall", seconds: 4, ms: 4_000, done: true },
      { label: "prompt", seconds: 4, ms: 4_000, done: false },
    ]);
  });

  // FORK 2026-08-16 (the architect: "All the phase elapsed times should always show even though the time
  // is small or zero"). `seconds` rounds a sub-second stage to 0, and the chip used to print
  // "0s" — which reads as "did not happen" for exactly the stages a warm cache makes fast. The
  // unrounded `ms` is what the renderer formats from, so it must survive here.
  it("keeps the unrounded ms for a sub-second stage instead of collapsing it to zero", () => {
    const t: TurnPhase[] = [
      { ...P("recall", 1_000), ms: 11 },
      { ...P("prompt", 1_100), ms: 0 },
    ];
    const steps = turnPhaseSteps(t, "agent:main:tinker:A", matches, 2_000);
    expect(steps[0]).toEqual({ label: "recall", seconds: 0, ms: 11, done: true });
    expect(steps[1]).toEqual({ label: "prompt", seconds: 0, ms: 0, done: true });
  });

  it("never reports a negative duration", () => {
    // A completion whose ms is junk, and a trail whose clock ran backwards, both floor at 0.
    const t: TurnPhase[] = [{ ...P("recall", 5_000), ms: -20 }];
    expect(turnPhaseSteps(t, "agent:main:tinker:A", matches, 1_000)[0].ms).toBe(0);
    const t2 = [P("recall", 5_000)];
    expect(turnPhaseSteps(t2, "agent:main:tinker:A", matches, 1_000)[0].ms).toBe(0);
  });

  it("renders nothing when the gateway has sent no phases (un-rebuilt gateway)", () => {
    expect(turnPhaseSteps([], "agent:main:tinker:A", matches, 1_000)).toEqual([]);
    expect(turnPhaseSteps(null, "agent:main:tinker:A", matches, 1_000)).toEqual([]);
  });
});
