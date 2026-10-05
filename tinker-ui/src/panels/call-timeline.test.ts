/**
 * context-window-panel.md §6.2 B5 — the CALL TIMELINE's pure half.
 *
 * The geometry is the part a screenshot cannot defend: "the scale always fits the width" and "an
 * idle night folds, a tool loop never does" are properties, so they are held here over random
 * inputs as well as by example. The canvas module only draws what these functions decide.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BREAK_CSS_PX,
  CallTimelineStore,
  GAP_FLOOR_MS,
  LOD_CALLS_PER_DEVICE_PX,
  MAX_BREAK_FRACTION,
  MIN_SPAN_MS,
  OUTPUT_KINDS,
  TOP_LANE_KEYS,
  UNITEMISED_KEY,
  apportion,
  columnHeight,
  columnSlots,
  compositionFromContextSent,
  describeCall,
  estimateTokens,
  gapThresholdMs,
  lastDataAt,
  layoutAxis,
  lodKeep,
  mergeActivity,
  observedSpan,
  outputPieces,
  outputTotal,
  parseCallFrame,
  promptStack,
  promptWindow,
  rampOf,
  rescaleFactor,
  rescaleSamples,
  stackHeights,
  sweepX,
  tAt,
  thinSamples,
  xAt,
  type Interval,
  type OutSample,
  type TimelineCall,
} from "./call-timeline";
import { mountCallTimeline } from "./call-timeline-canvas";
import { SEGMENT_COLORS } from "./context-timeline";

const S = 1000;
const MIN = 60 * S;

/** Deterministic PRNG (mulberry32) so a failing case can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("palette discipline (P3, P4)", () => {
  it("stacks the top lane in the palette's own order, moral code touching the axis", () => {
    expect(TOP_LANE_KEYS[0]).toBe("moralCode");
    expect(TOP_LANE_KEYS).not.toContain("responseText");
    for (const key of TOP_LANE_KEYS) {
      expect(SEGMENT_COLORS[key], key).toBeTruthy();
    }
  });

  it("reads a composition through the BAR's reader: every lane key itemised, in the bar's order", () => {
    // The A9 field names, pinned here as the expected contract — a test may state them; the module
    // must not copy them (cacheSegments owns the map). A palette key the bar cannot read would draw
    // nothing, forever, without an error: this is the check that it cannot.
    const full = {
      moralCodeTokens: 1,
      systemPromptTokens: 2,
      injectedFilesTotalTokens: 3,
      skillsTokens: 4,
      toolSchemasTokens: 5,
      conversationHistoryTokens: 6,
      toolResultsTokens: 7,
      userMessageTokens: 8,
    };
    expect(Object.keys(compositionFromContextSent(full) ?? {})).toEqual([...TOP_LANE_KEYS]);
    // P10: a measured 0 is an ABSENT pack; a missing field is an unmeasured one.
    expect(compositionFromContextSent({ moralCodeTokens: 0, systemPromptTokens: 5 })).toEqual({
      systemPrompt: 5,
      moralCode: 0,
    });
    expect(compositionFromContextSent({ systemPromptTokens: 5 })).toEqual({ systemPrompt: 5 });
    expect(compositionFromContextSent({})).toBeUndefined();
  });

  it("holds no local hex in either call-timeline module (colours come from SEGMENT_COLORS)", () => {
    // Resolved from the run root, NOT from import.meta.url: under the jsdom project that is an
    // http:// URL and fileURLToPath throws (retry-lifecycle.test.ts, styles-svg-transform-invariant).
    const panels = ["tinker-ui/src/panels", "src/panels", "panels"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "call-timeline.ts")));
    expect(panels, `call-timeline.ts not found from ${process.cwd()}`).toBeTruthy();
    for (const f of ["call-timeline.ts", "call-timeline-canvas.ts"]) {
      const src = readFileSync(join(panels as string, f), "utf8");
      expect(src.match(/#[0-9a-fA-F]{6}\b/g) ?? [], f).toEqual([]);
      expect(src, f).toMatch(/SEGMENT_COLORS/);
    }
  });
});

describe("G — derived, not frozen (§5.3, design-principles #19)", () => {
  it("never drops below 60 s", () => {
    expect(gapThresholdMs([])).toBe(GAP_FLOOR_MS);
    expect(gapThresholdMs([1 * S, 2 * S, 5 * S])).toBe(GAP_FLOOR_MS);
  });

  it("is 3 × the p90 of intra-turn gaps once those are long", () => {
    const gaps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((g) => g * S);
    expect(gapThresholdMs(gaps)).toBe(3 * 90 * S);
  });
});

describe("mergeActivity", () => {
  it("joins gaps ≤ G, keeps longer ones apart, tolerates unsorted and reversed input", () => {
    const out = mergeActivity(
      [
        { start: 100, end: 50 },
        { start: 0, end: 10 },
        { start: 70, end: 80 },
        { start: 500, end: 600 },
      ],
      60,
    );
    expect(out).toEqual([
      { start: 0, end: 100 },
      { start: 500, end: 600 },
    ]);
  });
});

describe("layoutAxis — the whole observed span, always fitting", () => {
  it("folds an idle gap longer than G into one 6 px break and lays the rest out linearly", () => {
    const G = GAP_FLOOR_MS;
    const act: Interval[] = [
      { start: 0, end: 10 * S },
      { start: 3 * 60 * MIN, end: 3 * 60 * MIN + 30 * S },
    ];
    const lay = layoutAxis(act, {
      t0: 0,
      t1: 3 * 60 * MIN + 30 * S,
      width: 400,
      breakPx: 6,
      gapMs: G,
    });
    const breaks = lay.pieces.filter((p) => p.kind === "break");
    expect(breaks).toHaveLength(1);
    expect(breaks[0].x1 - breaks[0].x0).toBe(6);
    // 40 s of activity share 394 px at one scale: the 10 s stretch gets a quarter of it.
    const first = lay.pieces[0];
    expect(first.x1 - first.x0).toBeCloseTo(394 / 4, 6);
    expect(lay.pieces[lay.pieces.length - 1].x1).toBe(400);
  });

  it("never folds a gap ≤ G (a tool-loop pause stays to scale)", () => {
    const lay = layoutAxis(
      [
        { start: 0, end: 10 * S },
        { start: 50 * S, end: 60 * S },
      ],
      { t0: 0, t1: 60 * S, width: 300, breakPx: 6, gapMs: GAP_FLOOR_MS },
    );
    expect(lay.pieces.filter((p) => p.kind === "break")).toHaveLength(0);
    expect(xAt(lay, 30 * S)).toBeCloseTo(150, 6);
  });

  it("property: pieces tile [0, width] exactly, x is monotone, the ends pin, breaks stay ≤ ⅓", () => {
    const rand = rng(20260924);
    for (let n = 0; n < 200; n++) {
      const width = 20 + Math.floor(rand() * 1600);
      const G = GAP_FLOOR_MS * (1 + Math.floor(rand() * 3));
      const iv: Interval[] = [];
      let t = Math.floor(rand() * 1e6);
      const t0 = t;
      const count = 1 + Math.floor(rand() * 120);
      for (let i = 0; i < count; i++) {
        t += rand() < 0.25 ? G + rand() * 8 * 3600 * S : rand() * 90 * S;
        const len = rand() * 120 * S;
        iv.push({ start: t, end: t + len });
        t += len;
      }
      const t1 = t + rand() * 10 * S;
      const breakPx = BREAK_CSS_PX * (1 + Math.floor(rand() * 3));
      const lay = layoutAxis(iv, { t0, t1, width, breakPx, gapMs: G });
      const p = lay.pieces;
      expect(p[0].x0).toBeGreaterThanOrEqual(0);
      expect(p[p.length - 1].x1).toBe(width);
      for (let i = 1; i < p.length; i++) {
        expect(Math.abs(p[i].x0 - p[i - 1].x1)).toBeLessThan(1e-6);
        expect(p[i].x1).toBeGreaterThanOrEqual(p[i].x0 - 1e-9);
      }
      const breakWidth = p.filter((q) => q.kind === "break").reduce((a, q) => a + (q.x1 - q.x0), 0);
      expect(breakWidth).toBeLessThanOrEqual(width * MAX_BREAK_FRACTION + 1e-6);
      expect(xAt(lay, t0)).toBeCloseTo(p[0].x0, 9);
      expect(xAt(lay, t1)).toBe(width);
      let prev = -Infinity;
      const sweep = sweepX(lay);
      for (let k = 0; k <= 50; k++) {
        const at = t0 + ((t1 - t0) * k) / 50;
        const x = xAt(lay, at);
        expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(x).toBeLessThanOrEqual(width + 1e-9);
        // The renderer's forward sweep must agree with the binary search, mark for mark.
        expect(sweep(at)).toBe(x);
        prev = x;
      }
      expect(sweep(t0)).toBe(xAt(lay, t0)); // out of order: falls back, still right
    }
  });

  it("merges the OLDEST breaks into one glyph when they would take more than a third", () => {
    const iv: Interval[] = [];
    for (let i = 0; i < 40; i++) {
      iv.push({ start: i * 10 * MIN, end: i * 10 * MIN + 5 * S });
    }
    const width = 120; // room for floor(120 / 3 / 6) = 6 breaks
    const lay = layoutAxis(iv, {
      t0: 0,
      t1: 39 * 10 * MIN + 5 * S,
      width,
      breakPx: 6,
      gapMs: GAP_FLOOR_MS,
    });
    const breaks = lay.pieces.filter((p) => p.kind === "break");
    expect(breaks).toHaveLength(39);
    const glyphs = breaks.filter((b) => b.glyph);
    expect(glyphs).toHaveLength(6);
    // The first glyph carries every merged gap; the recent five are single breaks.
    expect(glyphs[0].folded).toBe(39 - 6 + 1);
    expect(glyphs.slice(1).every((b) => b.folded === 1)).toBe(true);
    expect(breaks.filter((b) => !b.glyph).every((b) => b.x1 === b.x0)).toBe(true);
    expect(lay.pieces[lay.pieces.length - 1].x1).toBe(width);
  });

  it("tAt inverts xAt inside active stretches", () => {
    const lay = layoutAxis(
      [
        { start: 0, end: 30 * S },
        { start: 2 * 3600 * S, end: 2 * 3600 * S + 30 * S },
      ],
      { t0: 0, t1: 2 * 3600 * S + 30 * S, width: 500, breakPx: 6, gapMs: GAP_FLOOR_MS },
    );
    for (const t of [0, 7 * S, 29 * S, 2 * 3600 * S + 12 * S]) {
      expect(tAt(lay, xAt(lay, t)).t).toBeCloseTo(t, 3);
    }
    const brk = lay.pieces.find((p) => p.kind === "break")!;
    expect(tAt(lay, (brk.x0 + brk.x1) / 2).piece?.kind).toBe("break");
  });
});

describe("observedSpan", () => {
  it("runs to now while live or within G of now, else stops at the last event", () => {
    expect(observedSpan(0, 100 * S, 130 * S, false, GAP_FLOOR_MS)?.t1).toBe(130 * S);
    expect(observedSpan(0, 100 * S, 100 * S + 2 * GAP_FLOOR_MS, false, GAP_FLOOR_MS)?.t1).toBe(
      100 * S,
    );
    expect(observedSpan(0, 100 * S, 100 * S + 2 * GAP_FLOOR_MS, true, GAP_FLOOR_MS)?.nearNow).toBe(
      true,
    );
  });

  it("never zooms in below MIN_SPAN_MS, so the first call grows from the left", () => {
    const span = observedSpan(1000, 1500, 2000, true, GAP_FLOOR_MS)!;
    expect(span.t1 - span.t0).toBe(MIN_SPAN_MS);
    expect(observedSpan(Number.POSITIVE_INFINITY, 0, 0, false, GAP_FLOOR_MS)).toBeNull();
  });
});

describe("estimate → exact (§5.4)", () => {
  const samples: OutSample[] = [
    { t: 0, cum: 0, kind: "responseThinking" },
    { t: 400, cum: 40, kind: "responseThinking" },
    { t: 900, cum: 100, kind: "responseText" },
  ];

  it("keeps the measured TIMING and ends at the exact TOTAL", () => {
    const out = rescaleSamples(samples, 150);
    expect(out.map((s) => s.t)).toEqual([0, 400, 900]);
    expect(out.map((s) => s.kind)).toEqual(samples.map((s) => s.kind));
    expect(out[out.length - 1].cum).toBe(150);
    expect(out[1].cum).toBeCloseTo(60, 9);
  });

  it("apportions a turn total into integers that sum to it, by estimated share", () => {
    const parts = apportion(1001, [100, 300, 600]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(parts[2]).toBeGreaterThan(parts[1]);
    expect(apportion(10, [0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(10);
    expect(apportion(5, [])).toEqual([]);
  });
});

/** A turn in the shape today's streams produce (no `call` contract): the §5.4 fallback column. */
function fallbackTurn(): { store: CallTimelineStore; t: (s: number) => number } {
  const base = 1_700_000_000_000;
  const t = (sec: number): number => base + sec * S;
  const st = new CallTimelineStore();
  st.prepTick(t(0));
  st.prepTick(t(20));
  st.turnStart("run-1", t(24), "claude-opus-5");
  st.outputCumulative("run-1", "responseThinking", 350, t(26)); // first token at 26 s
  st.outputCumulative("run-1", "responseText", 700, t(28));
  st.toolStart("run-1", "tool-a", "bash", t(29), 70); // call 1 ends, asks for a tool
  st.toolEnd("tool-a", t(35), false); // call 2 will be sent at the result
  st.outputCumulative("run-1", "responseText", 1400, t(38));
  st.turnOutput("run-1", 900, t(40));
  st.turnEnd("run-1", t(40));
  return { store: st, t };
}

describe("CallTimelineStore — the fallback column of §5.4", () => {
  it("infers two calls from one tool loop, with sends at lifecycle start and at the tool result", () => {
    const { store, t } = fallbackTurn();
    expect(store.calls).toHaveLength(2);
    const [c1, c2] = store.calls;
    expect(c1.sendAt).toBe(t(24));
    expect(c1.sendProvenance).toBe("inferred");
    expect(c1.firstTokenAt).toBe(t(26));
    expect(c1.endAt).toBe(t(29));
    expect(c2.sendAt).toBe(t(35));
    expect(c2.firstTokenAt).toBe(t(38));
    // The turn tick sits at the start of its preparation window, not at the model's name.
    expect(store.turns[0].tickAt).toBe(t(0));
    expect(store.turnsEnded).toBe(1);
    expect(store.lastTurnSummary()).toMatch(/^Turn 1 finished: 2 calls/);
  });

  it("estimates output with ceil(chars/3.5) and apportions the turn total, never calling it exact", () => {
    const { store } = fallbackTurn();
    const [c1, c2] = store.calls;
    expect(c1.outEstimate).toBe(estimateTokens(350) + estimateTokens(700) + estimateTokens(70));
    expect(c2.outEstimate).toBe(estimateTokens(700));
    expect(c1.outProvenance).toBe("apportioned");
    expect(c2.outProvenance).toBe("apportioned");
    expect(outputTotal(c1) + outputTotal(c2)).toBe(900);
    // The ramp's kinds are kept in order: thinking, then text, then the tool-call input.
    expect(c1.samples.map((s) => s.kind)).toEqual([
      "responseThinking",
      "responseThinking",
      "responseText",
      "responseToolCalls",
    ]);
  });

  it("consumes the `call` contract when present and upgrades an inferred call by index", () => {
    const base = 1_700_000_000_000;
    const st = new CallTimelineStore();
    st.turnStart("r", base, "m");
    st.outputCumulative("r", "responseText", 35, base + 3 * S); // a delta that beat its `send`
    expect(st.calls[0].sendProvenance).toBe("inferred");
    st.callEvent("r", { phase: "send", callIndex: 1, t: base + 1 * S }, base + 3 * S);
    st.callEvent(
      "r",
      { phase: "usage", callIndex: 1, input: 100, cacheRead: 9000, cacheWrite: 900 },
      base + 2 * S,
    );
    st.callEvent(
      "r",
      { phase: "end", callIndex: 1, output: 42, stopReason: "end_turn" },
      base + 5 * S,
    );
    expect(st.calls).toHaveLength(1);
    const c = st.calls[0];
    expect(c.sendAt).toBe(base + 1 * S);
    expect(c.sendProvenance).toBe("exact");
    expect(c.stack).toMatchObject({ total: 10_000, provenance: "exact" });
    expect(c.outProvenance).toBe("exact");
    expect(outputTotal(c)).toBe(42);
    // A later turn total does not relabel an exact call.
    st.turnOutput("r", 999, base + 6 * S);
    expect(c.outProvenance).toBe("exact");
    expect(outputTotal(c)).toBe(42);
  });

  it("eases the ramp from the estimate to the exact total over 120 ms (instantly when reduced)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.outputCumulative("r", "responseText", 350, 1000); // 100 tokens estimated
    st.callEvent("r", { phase: "end", callIndex: 1, output: 200, t: 2000 }, 2000);
    const c = st.calls[0];
    expect(rescaleFactor(c, 2000, false)).toBeCloseTo(1, 9);
    expect(rescaleFactor(c, 2060, false)).toBeGreaterThan(1);
    expect(rescaleFactor(c, 2120, false)).toBeCloseTo(2, 9);
    expect(rescaleFactor(c, 2000, true)).toBeCloseTo(2, 9);
  });

  it("never lets a turn-aggregate cache sample become one call's prompt (P5, F7)", () => {
    const { store } = fallbackTurn();
    const applied = store.cacheSample(
      "run-1",
      { provider: "claude-code", promptTokens: 6_448_106, input: 10, cacheRead: 6_000_000 },
      0,
    );
    expect(applied).toBe(false);
    expect(store.calls.every((c) => c.prompt.exact === undefined)).toBe(true);
    const perCall = store.cacheSample(
      "run-1",
      { provider: "openai", promptTokens: 50_000, cacheRead: 40_000, cacheWrite: 0, input: 10_000 },
      0,
    );
    expect(perCall).toBe(true);
    expect(store.calls[1].prompt.exact).toBe(50_000);
  });

  it("draws a pre-call composition under its call and the unitemised remainder of an exact total", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.composition(
      "r",
      {
        snapshot: "pre-call",
        roundNumber: 1,
        contextSent: { moralCodeTokens: 0, systemPromptTokens: 600, totalTokens: 1000 },
      },
      1,
    );
    st.outputCumulative("r", "responseText", 7, 2);
    st.callEvent("r", { phase: "usage", callIndex: 1, input: 3000 }, 3);
    const stack = st.calls[0].stack;
    expect(stack.moral).toBe("absent");
    expect(stack.pieces.map((p) => p.key)).toEqual(["systemPrompt", UNITEMISED_KEY]);
    expect(stack.total).toBe(3000);
    expect(promptStack({}).provenance).toBe("none");
  });

  it("re-opens a run a fallback model carries on after an error (same runId)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "primary");
    st.outputCumulative("r", "responseText", 35, 1 * S);
    st.turnEnd("r", 2 * S); // lifecycle error
    st.turnStart("r", 3 * S, "fallback");
    st.outputCumulative("r", "responseText", 70, 4 * S);
    expect(st.calls).toHaveLength(2);
    expect(st.calls[1].model).toBe("fallback");
    expect(st.isLive(4 * S)).toBe(true);
  });

  it("draws a straight ramp for a final figure it never saw stream", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.toolStart("r", "t1", "read", 5000, 0); // a reply that was nothing but a tool call
    st.callEvent("r", { phase: "end", callIndex: 1, output: 30, t: 5000 }, 5000);
    const ramp = rampOf(st.calls[0]);
    expect(ramp[ramp.length - 1].cum).toBe(30);
  });

  it("folds nothing inside a finished turn, even a tool that ran longer than G", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.outputCumulative("r", "responseText", 35, 1 * S);
    st.toolStart("r", "slow", "bash", 2 * S, 10);
    st.toolEnd("slow", 2 * S + 5 * MIN, false);
    st.outputCumulative("r", "responseText", 70, 2 * S + 5 * MIN + 1 * S);
    st.turnEnd("r", 2 * S + 5 * MIN + 2 * S);
    const G = st.gapThreshold();
    const merged = st.closedActivity(G);
    expect(merged).toHaveLength(1);
  });
});

// FORK 2026-09-30 (the architect: "a graph that restarts every prompt and it shows me on the top what is
// sent and in the bottom what is received").
describe("promptView — the timeline restarts at every prompt", () => {
  /** Turn 1: one call with a 90k prompt and 5k out. Turn 2: two calls, 10k and 12k in. */
  function twoPrompts(): { st: CallTimelineStore; t: (s: number) => number } {
    const base = 1_700_000_000_000;
    const t = (sec: number): number => base + sec * S;
    const st = new CallTimelineStore();
    st.prepTick(t(0));
    st.turnStart("p1", t(5), "m");
    st.callEvent("p1", { phase: "send", callIndex: 1, t: t(5) }, t(5));
    st.callEvent("p1", { phase: "usage", callIndex: 1, input: 90_000 }, t(6));
    st.callEvent("p1", { phase: "end", callIndex: 1, output: 5_000 }, t(9));
    st.turnEnd("p1", t(10));
    st.prepTick(t(100));
    st.turnStart("p2", t(104), "m");
    st.callEvent("p2", { phase: "send", callIndex: 1, t: t(104) }, t(104));
    st.callEvent("p2", { phase: "usage", callIndex: 1, input: 10_000 }, t(105));
    st.callEvent("p2", { phase: "end", callIndex: 1, output: 300 }, t(107));
    st.callEvent("p2", { phase: "send", callIndex: 2, t: t(110) }, t(110));
    st.callEvent("p2", { phase: "usage", callIndex: 2, input: 12_000 }, t(111));
    return { st, t };
  }

  it("starts at the latest prompt's submission and keeps the earlier one out of the view", () => {
    const { st, t } = twoPrompts();
    const v = st.promptView()!;
    expect(v.start).toBe(t(100)); // the preparation window's start, i.e. the send
    expect(v.end).toBeUndefined(); // still being answered
    expect(v.runId).toBe("p2");
    expect(v.ordinal).toBe(2);
    expect(st.calls[v.firstCall].runId).toBe("p2");
    expect(v.calls).toBe(2);
  });

  it("scales both lanes to this prompt's calls, not to an older, larger prompt", () => {
    const { st } = twoPrompts();
    const v = st.promptView()!;
    expect(v.prompt).toBe(12_000);
    expect(v.out).toBe(300);
    // CONTROL: the session-wide denominators still see turn 1.
    expect(st.scales()).toMatchObject({ prompt: 90_000, out: 5_000 });
  });

  // FORK 2026-10-02 (the owner: "The CALL TIMELINE panel sometimes stays empty, it should always show
  // the last run instead"). Until 10-02 the preparation tick restarted the view with no call in it.
  it("keeps the last run on screen until the next prompt makes its first call", () => {
    const { st, t } = twoPrompts();
    st.turnEnd("p2", t(115));
    expect(st.promptView()).toMatchObject({ start: t(100), end: t(115), calls: 2 });
    expect(st.promptView()!.newer).toBeUndefined();
    // The next prompt is sent: nothing of it to draw yet, so p2 stays, and the view names prompt 3.
    st.prepTick(t(200));
    expect(st.promptView()).toMatchObject({
      start: t(100),
      end: t(115),
      runId: "p2",
      ordinal: 2,
      calls: 2,
      newer: { ordinal: 3, state: "preparing" },
    });
    // Its run names a model: still no call.
    st.turnStart("p3", t(203), "m");
    expect(st.promptView()).toMatchObject({
      runId: "p2",
      newer: { ordinal: 3, state: "preparing" },
    });
    // Its first call is sent: the view restarts on prompt 3.
    st.callEvent("p3", { phase: "send", callIndex: 1, t: t(204) }, t(204));
    const v = st.promptView()!;
    expect(v).toMatchObject({ start: t(200), runId: "p3", ordinal: 3, calls: 1 });
    expect(v.newer).toBeUndefined();
  });

  it("holds the last run past a prompt that made no model call", () => {
    const { st, t } = twoPrompts();
    st.turnEnd("p2", t(115));
    st.prepTick(t(200));
    st.turnStart("p3", t(203), "m");
    st.turnEnd("p3", t(205)); // aborted before any call
    expect(st.promptView()).toMatchObject({
      runId: "p2",
      calls: 2,
      newer: { ordinal: 3, state: "no-calls" },
    });
  });

  it("draws only the held run's calls, never a later history row's", () => {
    const { st, t } = twoPrompts();
    st.turnEnd("p2", t(115));
    st.loadHistory([{ runId: "h3", timestampMs: t(300), durationMs: 20 * S, responseTokens: 50 }]);
    const v = st.promptView()!;
    expect(v).toMatchObject({ runId: "p2", calls: 2, newer: { ordinal: 3, state: "history" } });
    const drawn = st.calls.slice(v.firstCall, v.firstCall + v.calls);
    expect(drawn.map((c) => c.runId)).toEqual(["p2", "p2"]);
  });

  it("never restarts on a preparation tick while a run is still answering", () => {
    const { st, t } = twoPrompts();
    st.prepTick(t(112));
    expect(st.promptView()!.start).toBe(t(100));
  });

  it("counts the session as before: the view does not drop anything from the store", () => {
    const { st } = twoPrompts();
    st.promptView();
    expect(st.totals()).toEqual({ turns: 2, calls: 3 });
  });

  it("shows the latest history turn when nothing live has happened yet", () => {
    const st = new CallTimelineStore();
    st.loadHistory([
      { runId: "h1", timestampMs: 1000 * S, durationMs: 20 * S, responseTokens: 400 },
      { runId: "h2", timestampMs: 2000 * S, durationMs: 30 * S, responseTokens: 900 },
    ]);
    const v = st.promptView()!;
    expect(v).toMatchObject({ start: 2000 * S, end: 2030 * S, runId: "h2", calls: 1, out: 900 });
    expect(v.newer).toBeUndefined(); // nothing live to hold: the stage note stands
  });
});

// FORK 2026-10-02 (the owner: "it should always show the last run instead"). The store lives in the page,
// so a reload (every rebuild pushes one) used to leave only history rows, which are not drawn. The
// last finished run is now snapshotted and restored into the fresh store.
describe("the last run survives a reload — snapshot and restore", () => {
  const base = 1_700_000_000_000;
  const t = (sec: number): number => base + sec * S;

  /** p1 (one call), then p2: two calls, streamed output, a tool between them, both ended exactly. */
  function finishedRuns(): CallTimelineStore {
    const st = new CallTimelineStore();
    st.prepTick(t(0));
    st.turnStart("p1", t(1), "m");
    st.outputCumulative("p1", "responseText", 700, t(3));
    st.turnEnd("p1", t(4));
    st.prepTick(t(100));
    st.turnStart("p2", t(102), "m");
    st.callEvent("p2", { phase: "send", callIndex: 1, t: t(102) }, t(102));
    st.callEvent("p2", { phase: "usage", callIndex: 1, input: 9_000, cacheRead: 1_000 }, t(103));
    for (let i = 1; i <= 40; i++) {
      st.outputCumulative("p2", "responseThinking", i * 35, t(104) + i * 100);
    }
    st.toolStart("p2", "tool-1", "read", t(110), 70);
    st.callEvent("p2", { phase: "end", callIndex: 1, output: 450 }, t(110));
    st.toolEnd("tool-1", t(112), false);
    st.callEvent("p2", { phase: "send", callIndex: 2, t: t(112) }, t(112));
    st.callEvent("p2", { phase: "usage", callIndex: 2, input: 9_500 }, t(113));
    st.outputCumulative("p2", "responseText", 350, t(115));
    st.callEvent("p2", { phase: "end", callIndex: 2, output: 120, stopReason: "end_turn" }, t(116));
    st.turnEnd("p2", t(117));
    return st;
  }

  const roundTrip = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

  it("snapshots the newest finished run that made calls, and restores it drawn the same way", () => {
    const st = finishedRuns();
    const snap = st.lastRunSnapshot();
    expect(snap).toMatchObject({ runId: "p2" });
    const fresh = new CallTimelineStore();
    expect(fresh.restoreRun(roundTrip(snap))).toBe(true);
    const v = fresh.promptView()!;
    expect(v).toMatchObject({ runId: "p2", start: t(100), end: t(117), calls: 2 });
    const was = st.calls.filter((c) => c.runId === "p2");
    const now = fresh.calls.slice(v.firstCall, v.firstCall + v.calls);
    for (const [i, c] of now.entries()) {
      expect(c).toMatchObject({
        sendAt: was[i].sendAt,
        firstTokenAt: was[i].firstTokenAt,
        endAt: was[i].endAt,
        outFinal: was[i].outFinal,
        outProvenance: was[i].outProvenance,
      });
      expect(c.stack).toEqual(was[i].stack);
      expect(c.historic).toBeUndefined();
    }
    expect(now[1].stopReason).toBe("end_turn");
    expect(fresh.tools.map((x) => [x.name, x.start, x.end])).toEqual([["read", t(110), t(112)]]);
    // Same columns: what each restored call sent back, by kind, is what the original drew.
    for (const [i, c] of now.entries()) {
      expect(outputPieces(c, rescaleFactor(c, Number.POSITIVE_INFINITY, true))).toEqual(
        outputPieces(was[i], rescaleFactor(was[i], Number.POSITIVE_INFINITY, true)),
      );
    }
  });

  it("does not snapshot a run that is still answering", () => {
    const st = finishedRuns();
    st.prepTick(t(200));
    st.turnStart("p3", t(201), "m");
    st.outputCumulative("p3", "responseText", 35, t(202));
    expect(st.lastRunSnapshot()).toMatchObject({ runId: "p2" });
  });

  it("is null for a store with nothing live recorded", () => {
    const st = new CallTimelineStore();
    st.loadHistory([{ runId: "h1", timestampMs: t(0), durationMs: 5 * S, responseTokens: 10 }]);
    expect(st.lastRunSnapshot()).toBeNull();
  });

  it("keeps the restored run when history loads afterwards, without a second copy of its turn", () => {
    const snap = roundTrip(finishedRuns().lastRunSnapshot());
    const fresh = new CallTimelineStore();
    fresh.restoreRun(snap);
    fresh.loadHistory([
      { runId: "p1", timestampMs: t(1), durationMs: 3 * S, responseTokens: 200 },
      { runId: "p2", timestampMs: t(102), durationMs: 15 * S, responseTokens: 570 },
    ]);
    expect(fresh.turns.filter((tr) => tr.runId === "p2")).toHaveLength(1);
    expect(fresh.promptView()).toMatchObject({ runId: "p2", ordinal: 2, calls: 2 });
    expect(fresh.totals()).toEqual({ turns: 2, calls: 3 });
  });

  it("never overwrites a live record of the same run", () => {
    const snap = roundTrip(finishedRuns().lastRunSnapshot());
    const live = new CallTimelineStore();
    live.turnStart("p2", t(102), "m");
    expect(live.restoreRun(snap)).toBe(false);
    expect(live.calls).toHaveLength(0);
  });

  it("rejects what is not a snapshot", () => {
    const st = new CallTimelineStore();
    for (const bad of [
      null,
      7,
      "x",
      {},
      { v: 99, runId: "r", calls: [] },
      { v: 1, runId: "r", calls: [] },
    ]) {
      expect(st.restoreRun(bad)).toBe(false);
    }
    expect(st.version).toBe(0);
  });

  it("caps the samples it keeps, without losing a token or a change of kind", () => {
    const samples: OutSample[] = [];
    let cum = 0;
    for (let i = 0; i < 1_000; i++) {
      cum += 3;
      const kind = i < 400 ? "responseThinking" : i < 410 ? "responseToolCalls" : "responseText";
      samples.push({ t: i * 50, cum, kind });
    }
    const thin = thinSamples(samples, 60);
    expect(thin.length).toBeLessThanOrEqual(60);
    expect(thin[0]).toEqual(samples[0]);
    expect(thin[thin.length - 1]).toEqual(samples[samples.length - 1]);
    // The last sample of every run of one kind is kept, so each kept segment holds one kind only.
    for (const i of [399, 409]) {
      expect(thin).toContainEqual(samples[i]);
    }
    for (let i = 1; i < thin.length; i++) {
      expect(thin[i].t).toBeGreaterThan(thin[i - 1].t);
    }
    // Under the cap it is the same array, copied.
    expect(thinSamples(samples.slice(0, 10), 60)).toEqual(samples.slice(0, 10));
  });
});

// FORK 2026-10-02 (the owner: "the graph has horizontal gaps where nothing is sent nor received, they
// should be cut out ... let's not be so rigorous with the time factor, and present a simplified graph
// where more area is painted"). Supersedes the 2026-10-01 rate chart and its tests.
describe("columns — one per call, side by side, nothing drawn for the time between", () => {
  /** One prompt, two calls: 20k in, a 4 s wait, 400 out over 8 s; an 8 s tool gap; 30k in, 100 out. */
  function twoCalls(): CallTimelineStore {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.callEvent("r", { phase: "send", callIndex: 1, t: 0 }, 0);
    st.callEvent("r", { phase: "usage", callIndex: 1, input: 20_000 }, 4 * S);
    st.outputCumulative("r", "responseText", 7, 4 * S); // first token at 4 s
    st.outputCumulative("r", "responseText", 1400, 12 * S);
    st.callEvent("r", { phase: "end", callIndex: 1, output: 400, t: 12 * S }, 12 * S);
    st.callEvent("r", { phase: "send", callIndex: 2, t: 20 * S }, 20 * S);
    st.callEvent("r", { phase: "usage", callIndex: 2, input: 30_000 }, 22 * S);
    st.outputCumulative("r", "responseText", 7, 22 * S); // first token at 22 s
    st.outputCumulative("r", "responseText", 350, 26 * S);
    st.callEvent("r", { phase: "end", callIndex: 2, output: 100, t: 26 * S }, 26 * S);
    st.turnEnd("r", 26 * S);
    return st;
  }

  it("keeps each call's timing for the title and the tooltip", () => {
    const [c1, c2] = twoCalls().calls;
    expect(promptWindow(c1)).toEqual({ start: 0, end: 4 * S });
    expect(promptWindow(c2)).toEqual({ start: 20 * S, end: 22 * S });
    expect(lastDataAt(c2)).toBe(26 * S);
    const fresh = new CallTimelineStore();
    fresh.turnStart("w", 0, "m");
    fresh.callEvent("w", { phase: "send", callIndex: 1, t: 0 }, 0);
    expect(promptWindow(fresh.calls[0])).toBeNull(); // sent, nothing back yet
  });

  it("gives every call an equal, contiguous slot of the width, however long the gap between them", () => {
    // The two calls are 20 s apart with an 8 s tool run between: equal halves, no gap drawn.
    expect(columnSlots(2, 300)).toEqual([
      { x0: 0, x1: 150 },
      { x0: 150, x1: 300 },
    ]);
    const r = rng(11);
    for (let trial = 0; trial < 300; trial++) {
      const w = 1 + Math.floor(r() * 900);
      const n = 1 + Math.floor(r() * 400);
      const slots = columnSlots(n, w);
      expect(slots).toHaveLength(n);
      for (const s of slots) {
        expect(s.x1 - s.x0).toBeGreaterThanOrEqual(1);
        expect(s.x0).toBeGreaterThanOrEqual(0);
        expect(s.x1).toBeLessThanOrEqual(w);
      }
      if (n <= w) {
        // Tiled: first at 0, last at the edge, each column starting where the previous ended, and
        // no column wider than another by more than a pixel.
        expect(slots[0].x0).toBe(0);
        expect(slots[n - 1].x1).toBe(w);
        const widths = slots.map((s) => s.x1 - s.x0);
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
        for (let i = 1; i < n; i++) {
          expect(slots[i].x0).toBe(slots[i - 1].x1);
        }
      }
    }
    expect(columnSlots(0, 300)).toEqual([]);
    expect(columnSlots(3, 0)).toEqual([]);
  });

  it("sizes a column by its tokens against the lane's largest, floored so a small one stays visible", () => {
    expect(columnHeight(500, 1000, 32, 2)).toBe(16);
    expect(columnHeight(1000, 1000, 32, 2)).toBe(32);
    expect(columnHeight(1, 100_000, 32, 2)).toBe(2);
    expect(columnHeight(5000, 1000, 32, 2)).toBe(32);
    expect(columnHeight(0, 1000, 32, 2)).toBe(0);
    expect(columnHeight(5, 0, 32, 2)).toBe(0);
  });

  it("stacks a column's pieces in their order, filling its height, every present piece visible", () => {
    const r = rng(5);
    const keys = [...TOP_LANE_KEYS, UNITEMISED_KEY];
    for (let trial = 0; trial < 500; trial++) {
      const pieces = keys.map((key) => ({
        key,
        tokens: r() < 0.25 ? 0 : r() < 0.3 ? Math.ceil(r() * 50) : Math.ceil(r() * 300_000),
      }));
      const H = 1 + Math.floor(r() * 64);
      const hs = stackHeights(pieces, H, 2);
      expect(hs).toHaveLength(pieces.length);
      const present = pieces.filter((p) => p.tokens > 0).length;
      const sum = hs.reduce((a, h) => a + h, 0);
      if (present > 0) {
        expect(sum).toBe(H);
      }
      pieces.forEach((p, i) => {
        expect(hs[i]).toBeGreaterThanOrEqual(0);
        if (p.tokens === 0) {
          expect(hs[i]).toBe(0);
        } else if (present * 2 <= H) {
          expect(hs[i]).toBeGreaterThanOrEqual(2);
        }
      });
      const moral = pieces.findIndex((p) => p.key === "moralCode");
      if (pieces[moral].tokens > 0 && present * 2 <= H) {
        expect(hs[moral]).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("never shortens the moral code to pay for another piece's floor (P2, P3)", () => {
    const pieces = [
      { key: "moralCode", tokens: 12_000 },
      { key: "systemPrompt", tokens: 40_000 },
      { key: "skills", tokens: 50 },
      { key: "toolResults", tokens: 300_000 },
    ];
    const H = 32;
    const hs = stackHeights(pieces, H, 2);
    expect(hs[0]).toBeGreaterThanOrEqual(Math.floor((12_000 / 352_050) * H));
    expect(hs[0]).toBeGreaterThanOrEqual(1);
    expect(hs[2]).toBeGreaterThanOrEqual(2); // 50 tokens would be 0 px; the floor shows it
    expect(hs.reduce((a, h) => a + h, 0)).toBe(H);
  });

  it("never cuts a big piece to nothing to pay for the floors of small ones (a short column)", () => {
    // 8 px, floors of 2: the bar's allocator, which may only cut the non-moral, non-floored
    // pieces, cut the 30 % piece to 0 px here.
    const hs = stackHeights(
      [
        { key: "moralCode", tokens: 60_000 },
        { key: "systemPrompt", tokens: 30_000 },
        { key: "skills", tokens: 5_000 },
        { key: "toolResults", tokens: 5_000 },
      ],
      8,
      2,
    );
    expect(hs).toEqual([2, 2, 2, 2]);
  });

  it("splits what came back by kind, eased to the exact total, and a tool-only reply as one kind", () => {
    const [c1] = twoCalls().calls;
    const done = (c: TimelineCall) =>
      outputPieces(c, rescaleFactor(c, Number.POSITIVE_INFINITY, true));
    const sum = (p: Array<{ tokens: number }>) => p.reduce((a, x) => a + x.tokens, 0);
    expect(sum(done(c1))).toBeCloseTo(400, 6);
    expect(done(c1).find((p) => p.key === "responseText")?.tokens).toBeCloseTo(400, 6);

    const mixed = new CallTimelineStore();
    mixed.turnStart("m", 0, "m");
    mixed.outputCumulative("m", "responseThinking", 700, 1 * S); // 200 estimated
    mixed.outputCumulative("m", "responseText", 350, 2 * S); // 100 estimated
    mixed.callEvent("m", { phase: "end", output: 600 }, 3 * S); // exact: twice the estimate
    const kinds = done(mixed.calls[0]);
    expect(kinds.find((p) => p.key === "responseThinking")?.tokens).toBeCloseTo(400, 6);
    expect(kinds.find((p) => p.key === "responseText")?.tokens).toBeCloseTo(200, 6);

    const toolOnly = new CallTimelineStore();
    toolOnly.turnStart("t", 0, "m");
    toolOnly.toolStart("t", "t1", "read", 5 * S, 0);
    toolOnly.callEvent(
      "t",
      { phase: "end", callIndex: 1, output: 30, stopReason: "tool_use", t: 5 * S },
      5 * S,
    );
    expect(done(toolOnly.calls[0])).toEqual([
      { key: "responseThinking", tokens: 0 },
      { key: "responseText", tokens: 0 },
      { key: "responseToolCalls", tokens: 30 },
    ]);
  });
});

// FORK 2026-10-02 (the owner: "I see some sent information is unitemised, why is that? Can you fix it
// and assign it a bucket?"). On the cc-bridge lane the anatomy row describes the gateway's mirror,
// not what the CLI sends; the bridge now itemises each call from the CLI's own transcript and sends
// it on the call's `usage` frame (the contract's CallComposition).
describe("a call's own itemised prompt (the `usage` frame's composition)", () => {
  const MIRROR = {
    snapshot: "pre-call",
    contextSent: {
      systemPromptTokens: 8_000,
      conversationHistoryTokens: 80_000,
      totalTokens: 88_000,
    },
  };
  const COMP = {
    moralCode: 12_000,
    systemPrompt: 40_000,
    injectedFiles: 12_000,
    skills: 8_000,
    toolSchemas: 22_000,
    conversation: 20_000,
    toolResults: 54_000,
    userMessage: 4_000,
  };

  it("reads it from usage frames only: top-lane keys, measured values", () => {
    const f = parseCallFrame(
      {
        phase: "usage",
        callIndex: 0,
        lane: "cc-bridge",
        cacheRead: 100,
        composition: {
          moralCode: 0,
          systemPrompt: 40,
          unitemised: 9,
          toolResults: -1,
          skills: "x",
        },
      },
      1000,
    );
    expect(f?.composition).toEqual({ moralCode: 0, systemPrompt: 40 });
    expect(
      parseCallFrame({ phase: "end", callIndex: 0, composition: { systemPrompt: 40 } }, 1000)
        ?.composition,
    ).toBeUndefined();
    expect(
      parseCallFrame({ phase: "usage", callIndex: 0, composition: { nope: 1 } }, 1000)?.composition,
    ).toBeUndefined();
  });

  function itemisedRun(): CallTimelineStore {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    // The gateway's own row lands first, as it does on this lane.
    st.composition("r", MIRROR, 0);
    st.callEvent("r", { phase: "send", callIndex: 0, lane: "cc-bridge", t: 1000 }, 1000);
    st.callEvent(
      "r",
      {
        phase: "usage",
        callIndex: 0,
        lane: "cc-bridge",
        input: 2,
        cacheRead: 160_000,
        cacheWrite: 11_998,
        composition: COMP,
      },
      1500,
    );
    return st;
  }

  it("stacks the call by its own buckets, with nothing unitemised, ever", () => {
    const st = itemisedRun();
    const c = st.calls[0];
    expect(c.stack.total).toBe(172_000);
    expect(c.stack.provenance).toBe("exact");
    expect(c.stack.pieces.map((p) => p.key)).toEqual([...TOP_LANE_KEYS]);
    expect(c.stack.moral).toBe("present");
    // The parts and the composition land in ONE write, so the legend never learns "unitemised".
    expect(st.seenKeys.has(UNITEMISED_KEY)).toBe(false);
    expect(describeCall(c, { turnOrdinal: 1, now: 2000 }).join("\n")).toMatch(
      /split estimated from what was sent, total exact/,
    );
    // CONTROL: the same usage frame without a composition leaves the remainder unitemised.
    const bare = new CallTimelineStore();
    bare.turnStart("r", 0, "m");
    bare.composition("r", MIRROR, 0);
    bare.callEvent("r", { phase: "send", callIndex: 0, lane: "cc-bridge", t: 1000 }, 1000);
    bare.callEvent(
      "r",
      {
        phase: "usage",
        callIndex: 0,
        lane: "cc-bridge",
        input: 2,
        cacheRead: 160_000,
        cacheWrite: 11_998,
      },
      1500,
    );
    expect(bare.calls[0].stack.pieces.find((p) => p.key === UNITEMISED_KEY)?.tokens).toBe(84_000);
  });

  it("keeps its own buckets when the gateway's anatomy rows arrive later", () => {
    const st = itemisedRun();
    st.composition("r", { ...MIRROR, snapshot: "post-turn" }, 3000);
    st.composition("r", { ...MIRROR, roundNumber: 1 }, 3000);
    expect(st.calls[0].prompt.composition).toEqual(COMP);
    expect(st.calls[0].prompt.source).toBe("call");
  });

  it("reads a moral code of 0 as a measured absence (P3's red rule)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    st.callEvent(
      "r",
      {
        phase: "usage",
        callIndex: 0,
        lane: "cc-bridge",
        cacheRead: 100,
        composition: { moralCode: 0, conversation: 100 },
      },
      10,
    );
    expect(st.calls[0].stack.moral).toBe("absent");
  });

  it("survives a reload as the call's own split", () => {
    const st = itemisedRun();
    st.callEvent("r", { phase: "end", callIndex: 0, lane: "cc-bridge", output: 50 }, 2000);
    st.turnEnd("r", 2100);
    const fresh = new CallTimelineStore();
    expect(fresh.restoreRun(JSON.parse(JSON.stringify(st.lastRunSnapshot())))).toBe(true);
    expect(fresh.calls[0].prompt).toMatchObject({ source: "call", composition: COMP });
    fresh.composition("r", { ...MIRROR, snapshot: "post-turn" }, 3000);
    expect(fresh.calls[0].prompt.composition).toEqual(COMP);
  });
});

describe("LOD — retention bounded in space (§5.3)", () => {
  it("keeps K = 4 × width calls in full and bins the rest per pixel column, preserving the sums", () => {
    expect(lodKeep(394)).toBe(LOD_CALLS_PER_DEVICE_PX * 394);
    const st = new CallTimelineStore();
    const n = 600;
    for (let i = 0; i < n; i++) {
      const run = `r${i}`;
      st.turnStart(run, i * 10 * S, "m");
      st.outputCumulative(run, "responseText", 350, i * 10 * S + 1 * S);
      st.callEvent(run, { phase: "usage", callIndex: 1, input: 1000 + i }, i * 10 * S + 1 * S);
      st.turnEnd(run, i * 10 * S + 2 * S);
    }
    const width = 50;
    const keep = lodKeep(width); // 200
    const G = st.gapThreshold();
    const lay = layoutAxis(st.closedActivity(G), {
      t0: st.earliestAt,
      t1: st.latestAt,
      width,
      breakPx: 6,
      gapMs: G,
    });
    const promptSumBefore = st.calls.reduce((a, c) => a + c.stack.total, 0);
    expect(st.compact(keep, lay)).toBe(true);
    expect(st.calls).toHaveLength(keep);
    expect(st.bins.length).toBeLessThanOrEqual(width + 1);
    const binnedCount = st.bins.reduce((a, b) => a + b.count, 0);
    expect(binnedCount).toBe(n - keep);
    const promptSumAfter =
      st.calls.reduce((a, c) => a + c.stack.total, 0) +
      st.bins.reduce((a, b) => a + b.promptSum, 0);
    expect(promptSumAfter).toBe(promptSumBefore);
    expect(st.totals()).toEqual({ turns: n, calls: n });
    // Bins keep min start / max end: the earliest bin still starts at the first call.
    expect(st.bins[0].start).toBe(st.earliestAt);
    // A second pass with nothing to do is a no-op.
    expect(st.compact(keep, lay)).toBe(false);
  });
});

describe("mountCallTimeline — filled once into its static host (P9), accessible (§5.7)", () => {
  it("builds the canvas, the lane scales, the legend and the live region, even with no 2D context", () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const host = document.createElement("div");
    host.id = "cache-timeline";
    document.body.append(host);
    try {
      const view = mountCallTimeline(host, { isLive: () => false });
      const canvas = host.querySelector("canvas");
      expect(canvas?.getAttribute("role")).toBe("img");
      expect(canvas?.tabIndex).toBe(0);
      expect(canvas?.getAttribute("aria-label")).toMatch(/^Call timeline/);
      expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
      expect(host.querySelector(".ctl-scale--out")).not.toBeNull();
      expect(host.querySelector(".ctl-scale--in")).not.toBeNull();
      expect(document.getElementById("call-timeline-style")).not.toBeNull();
      view.setStore(new CallTimelineStore());
      expect(view.debugSnapshot()).toMatchObject({ budgetMs: 2, calls: 0 });
      view.destroy();
      expect(host.childElementCount).toBe(0);
    } finally {
      spy.mockRestore();
      host.remove();
    }
  });
});
