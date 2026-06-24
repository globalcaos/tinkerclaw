import { describe, it, expect } from "vitest";
import {
  EEG_STOPS,
  EEG_PROVIDER_COLORS,
  EEG_COST_TABLE,
  EEG_EFFORT_MULT,
  eegProviderPaint,
  eegCostWidthPx,
  eegStopX,
  EegTraceStore,
  type EegSample,
  type EegTurnEnd,
} from "./eeg-trace";

const T0 = 1_750_000_000_000;
const ANTHROPIC_STROKE = "#E8702A";
const FALLBACK_GRAY = "#8A8F98";
const WIDTH = 300;

const sample = (over: Partial<EegSample> & { runId: string }): EegSample => ({
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  chosenLevel: "medium",
  subagent: false,
  startedAt: T0,
  endedAt: T0 + 1_000,
  ...over,
});

const pathCount = (svg: string): number => (svg.match(/<path/g) || []).length;
const countOf = (svg: string, needle: string): number => svg.split(needle).length - 1;
const svgHeight = (svg: string): number => Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);

describe("segment length = euro cost (the user 2026-06-20: §1 grid)", () => {
  it("a costlier turn renders a longer (taller) segment", () => {
    // length = €; use a pricey model + many tokens to clear the ~€0.2 click floor.
    const big = new EegTraceStore();
    big.record(sample({ runId: "r1", model: "claude-fable-5", outputTokens: 120000 }));
    const small = new EegTraceStore();
    small.record(sample({ runId: "r1", model: "claude-haiku-4-5", outputTokens: 50 }));
    expect(svgHeight(big.renderSvg({ width: WIDTH }))).toBeGreaterThan(
      svgHeight(small.renderSvg({ width: WIDTH })),
    );
  });

  it("a zero-token (live) turn still draws at the minimum length", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1" })); // no tokens yet
    expect(svgHeight(store.renderSvg({ width: WIDTH }))).toBeGreaterThan(0);
  });

  it("draws a €1 horizontal grid: ruler lines + a €N gutter label", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1", model: "claude-fable-5", outputTokens: 120000 }));
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('class="eeg-eurogrid"');
    expect(svg).toContain("€1");
  });

  it("euro length scales with the model's €/Mtok at equal tokens (fable taller than haiku)", () => {
    const fable = new EegTraceStore();
    fable.record(sample({ runId: "r1", model: "claude-fable-5", outputTokens: 200000 }));
    const haiku = new EegTraceStore();
    haiku.record(sample({ runId: "r1", model: "claude-haiku-4-5", outputTokens: 200000 }));
    expect(svgHeight(fable.renderSvg({ width: WIDTH }))).toBeGreaterThan(
      svgHeight(haiku.renderSvg({ width: WIDTH })),
    );
  });
});

describe("eegStopX", () => {
  it("maps the 7 EEG_STOPS to strictly ascending x values within the rail at width 300", () => {
    expect(EEG_STOPS).toHaveLength(7); // Auto + 6 levels (Drop 3 collapsed Auto/Adaptive)
    expect(EEG_STOPS[0].lvl).toBe(""); // Auto first
    const xs = EEG_STOPS.map((s) => eegStopX(s.lvl, WIDTH));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
    expect(xs[0]).toBeGreaterThanOrEqual(18);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(WIDTH - 14 + 1);
  });
});

describe("eegCostWidthPx", () => {
  it("is clamped to [0.5, 11] for every model x stop combination", () => {
    expect(Array.isArray(EEG_COST_TABLE)).toBe(true);
    expect(EEG_COST_TABLE.length).toBeGreaterThan(0);
    const models = [
      "claude-fable-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "totally-unknown-model-xyz",
    ];
    for (const model of models) {
      for (const stop of EEG_STOPS) {
        const w = eegCostWidthPx(model, stop.lvl);
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0.5);
        expect(w).toBeLessThanOrEqual(11);
      }
    }
  });

  it("is LINEAR in cost: sonnet = 1.0px, fable = 10px, opus = 5px", () => {
    expect(eegCostWidthPx("claude-sonnet-4-5", "medium")).toBeCloseTo(1.0, 1);
    expect(eegCostWidthPx("claude-fable-5", "medium")).toBeCloseTo(10, 1);
    expect(eegCostWidthPx("claude-opus-4-8", "medium")).toBeCloseTo(5, 1);
  });

  it("is monotonic in cost: fable > sonnet > haiku", () => {
    expect(typeof EEG_EFFORT_MULT).toBe("object");
    const fable = eegCostWidthPx("claude-fable-5", "max");
    const sonnet = eegCostWidthPx("claude-sonnet-4-5", "medium");
    const haiku = eegCostWidthPx("claude-haiku-4-5", "minimal");
    expect(fable).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it("falls back to a default cost for unknown models (never NaN)", () => {
    const w = eegCostWidthPx("totally-unknown-model-xyz", "medium");
    expect(Number.isNaN(w)).toBe(false);
    expect(w).toBeGreaterThanOrEqual(0.5);
    expect(w).toBeLessThanOrEqual(11);
  });
});

describe("eegProviderPaint", () => {
  it("google is the rainbow provider", () => {
    expect(eegProviderPaint("google").isRainbow).toBe(true);
  });

  it("anthropic gets its brand stroke", () => {
    const paint = eegProviderPaint("anthropic");
    expect(paint.stroke).toBe(ANTHROPIC_STROKE);
    expect(paint.isRainbow).toBe(false);
  });

  it("infers the brand from a BARE model name (cc-bridge trace)", () => {
    expect(eegProviderPaint("claude-fable-5").stroke).toBe(ANTHROPIC_STROKE);
    expect(eegProviderPaint("claude-opus-4-8").stroke).toBe(ANTHROPIC_STROKE);
    expect(eegProviderPaint("gemini-3.1-pro").isRainbow).toBe(true);
    expect(eegProviderPaint("gpt-5.5").stroke).toBe(EEG_PROVIDER_COLORS.openai);
  });

  it("unknown providers fall back to gray, non-rainbow", () => {
    const paint = eegProviderPaint("no-such-provider");
    expect(paint.stroke).toBe(FALLBACK_GRAY);
    expect(paint.isRainbow).toBe(false);
    expect(Object.keys(EEG_PROVIDER_COLORS).length).toBeGreaterThan(0);
  });
});

describe("EegTraceStore basics", () => {
  it("fresh store is empty and renders the labeled axis but no trace strokes", () => {
    const store = new EegTraceStore();
    expect(store.isEmpty).toBe(true);
    const svg = store.renderSvg({ width: WIDTH });
    // Empty paper still shows the instrument: axis labels + a waiting hint, but
    // NO trace/branch strokes (no-placeholders rule, §5.9).
    expect(svg).toContain("<svg");
    expect(svg).toContain("eeg-collabel");
    expect(svg).toContain("waiting for model");
    expect(svg).not.toContain("eeg-main");
    expect(svg).not.toContain("data-eeg-turn");
  });

  it("one main sample + turnEnd renders an svg with the provider stroke and a turn marker", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1", thinkingChars: 1200 }));
    store.turnEnd({ turn: 1, runId: "r1", endedAt: T0 + 1_000 });
    const svg = store.renderSvg({ width: WIDTH });
    expect(store.isEmpty).toBe(false);
    expect(svg).toContain("<svg");
    expect(svg).toContain(ANTHROPIC_STROKE);
    expect(svg).toContain("data-eeg-turn");
  });

  it("clear() empties the store again", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1" }));
    store.clear();
    expect(store.isEmpty).toBe(true);
    // back to the empty paper: no trace strokes, no markers
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).not.toContain("eeg-main");
    expect(svg).not.toContain("data-eeg-turn");
  });
});

describe("record() upserts by runId", () => {
  it("recording the same runId twice yields ONE strand, not two", () => {
    const twice = new EegTraceStore();
    twice.record(sample({ runId: "r1", thinkingChars: 100 }));
    twice.record(sample({ runId: "r1", thinkingChars: 2_400 }));
    const once = new EegTraceStore();
    once.record(sample({ runId: "r1", thinkingChars: 2_400 }));

    const svgTwice = twice.renderSvg({ width: WIDTH });
    const svgOnce = once.renderSvg({ width: WIDTH });
    expect(pathCount(svgTwice)).toBe(pathCount(svgOnce));
    expect(countOf(svgTwice, ANTHROPIC_STROKE)).toBe(countOf(svgOnce, ANTHROPIC_STROKE));
    expect(pathCount(svgTwice)).toBeGreaterThanOrEqual(1);
  });
});

describe("concurrency stacking", () => {
  const overlapping = (n: number): EegSample[] =>
    Array.from({ length: n }, (_, i) =>
      sample({
        runId: `sub-${i + 1}`,
        subagent: true,
        parentRunId: "main-1",
        startedAt: T0,
        endedAt: T0 + 1_000,
      }),
    );

  it("6 overlapping subagents render 6 branches (no cap) with a ×6 multiplicity label", () => {
    const store = new EegTraceStore();
    for (const s of overlapping(6)) store.record(s);
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain("×6"); // dynamic ×N gauge at peak concurrency
    expect(pathCount(svg)).toBe(6); // show ALL branches (bible §5.8h invariant 4, 2026-06-19)
  });

  it("3 overlapping subagents render 3 branches and a ×3 multiplicity label", () => {
    const store = new EegTraceStore();
    for (const s of overlapping(3)) store.record(s);
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toMatch(/×3/); // dynamic ×N fires at any concurrency ≥2
    expect(pathCount(svg)).toBe(3);
  });
});

describe("backfill", () => {
  it("renders all backfilled samples and a turn marker per end", () => {
    const store = new EegTraceStore();
    const samples: EegSample[] = [
      sample({ runId: "b1", startedAt: T0, endedAt: T0 + 1_000 }),
      sample({ runId: "b2", startedAt: T0 + 5_000, endedAt: T0 + 6_000 }),
    ];
    const ends: EegTurnEnd[] = [
      { turn: 1, runId: "b1", endedAt: T0 + 1_000 },
      { turn: 2, runId: "b2", endedAt: T0 + 6_000 },
    ];
    store.backfill(samples, ends);
    const svg = store.renderSvg({ width: WIDTH });
    expect(store.isEmpty).toBe(false);
    expect(svg).toContain("<svg");
    expect((svg.match(/data-eeg-turn/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("google gradient", () => {
  it("a google sample defines the eeg-google linearGradient and strokes with it", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "g1", provider: "google", model: "gemini-3-pro" }));
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain("linearGradient");
    expect(svg).toContain("eeg-google");
    expect(svg).toContain("url(#eeg-google)");
  });
});

describe("EEG concurrency = depth-shaded stack (bible §5.8h / §5.84, the user 2026-06-14)", () => {
  const concurrent = (n: number, over: Partial<EegSample> = {}): string => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "main", subagent: false }));
    for (let i = 0; i < n; i++) {
      store.record(
        sample({
          runId: `s${i}`,
          subagent: true,
          parentRunId: "main",
          model: "claude-opus-4-8",
          provider: "anthropic",
          chosenLevel: "high",
          startedAt: T0 + 10, // all overlap → one cluster
          endedAt: T0 + 2000,
          ...over,
        }),
      );
    }
    return store.renderSvg({ width: WIDTH });
  };
  const branchStrokes = (svg: string): string[] =>
    [...svg.matchAll(/class="eeg-branch"[^>]*?stroke="([^"]+)"/g)].map((m) => m[1]);

  it("draws one strand per concurrent subagent (≤5) with the bottom strand darkest, lightening upward", () => {
    const strokes = branchStrokes(concurrent(3));
    expect(strokes).toHaveLength(3);
    expect(strokes[0]).toBe(ANTHROPIC_STROKE); // bottom = full brand color (darkest)
    expect(new Set(strokes).size).toBe(3); // each higher strand a distinct, lighter tint
  });

  it("shows ALL strands (no cap) plus a ×N multiplicity label (bible §5.8h invariant 4, updated 2026-06-19)", () => {
    const svg = concurrent(7);
    expect((svg.match(/class="eeg-branch"/g) || []).length).toBe(7);
    expect(svg).toContain("×7");
  });

  it("a rainbow-provider stack stays the gradient but fades by depth (opacity, not tint)", () => {
    const svg = concurrent(3, { model: "gemini-2.5-pro", provider: "google" });
    const ops = [...svg.matchAll(/class="eeg-branch"[^>]*?stroke-opacity="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(ops).toHaveLength(3);
    expect(ops[0]).toBeGreaterThan(ops[2]); // bottom most opaque (darkest), top faded
  });
});

describe("close-stale + prompt anchors + prompt-break (the user 2026-06-19)", () => {
  it("closeStaleRunning closes ONLY dead-running subagent samples, returns their ids, idempotent", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "main", subagent: false, endedAt: undefined }));
    store.record(sample({ runId: "live", subagent: true, endedAt: undefined }));
    store.record(sample({ runId: "dead", subagent: true, endedAt: undefined }));
    store.record(sample({ runId: "done", subagent: true, endedAt: T0 + 500 }));
    const closed = store.closeStaleRunning((id) => id === "live", T0 + 99_000);
    expect(closed).toEqual(["dead"]); // not main (not subagent), not live, not done (already ended)
    expect(store.closeStaleRunning((id) => id === "live", T0 + 99_000)).toEqual([]); // idempotent
  });

  it("a turnEnd's promptIndex + promptText render as data-eeg-prompt-index + an escaped <title>", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1" }));
    store.turnEnd({
      turn: 1,
      runId: "r1",
      endedAt: T0 + 2_000,
      promptIndex: 0,
      promptText: "hello <world>",
    });
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('data-eeg-prompt-index="0"');
    expect(svg).toContain("<title>hello &lt;world&gt;</title>");
  });

  it("draws EVERY call as a separate segment (no spline) and a prompt gap > a call gap", () => {
    const hasMainCurve = (svg: string): boolean =>
      /<path class="eeg-main"[^>]*\sd="[^"]*C[^"]*"/.test(svg);
    const mainPaths = (svg: string): string[] =>
      [...svg.matchAll(/<path class="eeg-main"[^>]*\bd="([^"]*)"/g)].map((m) => m[1]);
    // each d = "M x yBottom L x yTop" (newest at top = smaller y). The gap between two
    // stacked segments = the OLDER (lower) segment's top edge − the NEWER (upper) one's
    // bottom edge.
    const gapBetween = (svg: string): number => {
      const segs = mainPaths(svg).map((d) => {
        const nums = d.match(/[\d.]+/g)!.map(Number); // [x, y1, x, y2]
        return { topY: Math.min(nums[1], nums[3]), botY: Math.max(nums[1], nums[3]) };
      });
      segs.sort((p, q) => p.topY - q.topY); // [0] = upper/newer, [1] = lower/older
      return segs[1].topY - segs[0].botY;
    };
    const m1 = sample({ runId: "m1", chosenLevel: "low", startedAt: T0, endedAt: T0 + 1_000 });
    const m2 = sample({
      runId: "m2",
      chosenLevel: "high",
      startedAt: T0 + 10_000,
      endedAt: T0 + 11_000,
    });
    // two same-turn calls: NO connector spline (no cubic), but TWO distinct segments.
    const sameTurn = new EegTraceStore();
    sameTurn.record(m1);
    sameTurn.record(m2);
    const svgSame = sameTurn.renderSvg({ width: WIDTH });
    expect(hasMainCurve(svgSame)).toBe(false); // the spline is gone — calls are separate
    expect(mainPaths(svgSame)).toHaveLength(2); // two distinct call segments
    const callGap = gapBetween(svgSame);
    expect(callGap).toBeGreaterThan(0); // calls visibly separated

    // a prompt boundary between them widens the gap (prompt break > call break).
    const acrossPrompt = new EegTraceStore();
    acrossPrompt.record(m1);
    acrossPrompt.record(m2);
    acrossPrompt.turnEnd({ turn: 1, runId: "m2", endedAt: T0 + 5_000 });
    const promptGap = gapBetween(acrossPrompt.renderSvg({ width: WIDTH }));
    expect(promptGap).toBeGreaterThan(callGap); // prompt separation is the stronger one
  });

  it("deeper zoom-out genuinely shrinks a long trace (rows scale below the old 14px floor)", () => {
    const store = new EegTraceStore();
    for (let i = 0; i < 20; i++) {
      store.record(
        sample({
          runId: `z${i}`,
          startedAt: T0 + i * 1000,
          endedAt: T0 + i * 1000 + 400,
          outputTokens: 50,
        }),
      );
    }
    const tall = svgHeight(store.renderSvg({ width: WIDTH, zoom: 1 }));
    const short = svgHeight(store.renderSvg({ width: WIDTH, zoom: 0.05 }));
    // before the zoom-scaled floor, both floored at n·14px and short === tall (the bug)
    expect(short).toBeLessThan(tall * 0.5);
  });

  it("emits a clickable per-prompt hit band carrying promptIndex + escaped promptText", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1", startedAt: T0, endedAt: T0 + 1000 }));
    store.turnEnd({
      turn: 1,
      runId: "r1",
      endedAt: T0 + 1100,
      promptIndex: 0,
      promptText: "ultracode this <thing>",
    });
    store.record(sample({ runId: "r2", startedAt: T0 + 2000, endedAt: T0 + 2500 }));
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('class="eeg-promptzone"');
    expect(svg).toContain('data-eeg-prompt-index="0"');
    expect(svg).toContain("<title>ultracode this &lt;thing&gt;</title>");
  });

  it("a subagent finishing AFTER a prompt boundary merges into its OWN turn column (no high→max hop)", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "M1", chosenLevel: "high", startedAt: T0, endedAt: T0 + 1000 }));
    store.record(
      sample({
        runId: "SUB",
        subagent: true,
        parentRunId: "M1",
        chosenLevel: "high",
        startedAt: T0 + 300,
        endedAt: T0 + 5000, // finishes well into turn 2
      }),
    );
    store.turnEnd({ turn: 1, runId: "M1", endedAt: T0 + 1100, promptIndex: 0 });
    store.record(
      sample({ runId: "M2", chosenLevel: "max", startedAt: T0 + 2000, endedAt: undefined }),
    );
    const svg = store.renderSvg({ width: 300 });
    const maxX = String(eegStopX("max", 300)); // the column the branch must NOT hop into
    const branchD = [...svg.matchAll(/class="eeg-branch"[^>]*\bd="([^"]*)"/g)]
      .map((m) => m[1])
      .join(" ");
    expect(branchD.length).toBeGreaterThan(0); // a branch WAS drawn
    expect(branchD).not.toContain(maxX); // ...but it did NOT merge into the next turn's max column
  });

  it("a fast helper (split≈join row) draws an out-and-back arch with a body, not a closed teardrop", () => {
    const store = new EegTraceStore();
    // a max main, a quick low sonnet helper whose start+end snap to one row (the
    // degenerate-loop trigger), and a NEWER max main above it (so the helper sits in
    // the scrollback with room for the arch — the case that actually persists).
    store.record(sample({ runId: "M1", chosenLevel: "max", startedAt: T0, endedAt: T0 + 1000 }));
    store.record(
      sample({
        runId: "H",
        subagent: true,
        parentRunId: "M1",
        chosenLevel: "low",
        startedAt: T0 + 100,
        endedAt: T0 + 200,
      }),
    );
    store.record(
      sample({ runId: "M2", chosenLevel: "max", startedAt: T0 + 3000, endedAt: undefined }),
    );
    const svg = store.renderSvg({ width: 300 });
    const d = /class="eeg-branch"[^>]*\bd="([^"]*)"/.exec(svg)?.[1] ?? "";
    expect(d).toContain("C"); // a branch was drawn
    // the path must NOT close on itself: its final point must differ from its start
    // (a closed teardrop = start === end, the "weird loop").
    const pts = d.replace(/[MCL]/g, " ").trim().split(/\s+/).map(Number);
    const startX = pts[0];
    const startY = pts[1];
    const endX = pts[pts.length - 2];
    const endY = pts[pts.length - 1];
    expect(Math.abs(startX - endX) + Math.abs(startY - endY)).toBeGreaterThan(1);
  });
});
