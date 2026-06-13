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
  forced: false,
  subagent: false,
  startedAt: T0,
  endedAt: T0 + 1_000,
  ...over,
});

const pathCount = (svg: string): number => (svg.match(/<path/g) || []).length;
const countOf = (svg: string, needle: string): number => svg.split(needle).length - 1;
const svgHeight = (svg: string): number => Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);

describe("segment length ∝ token cost", () => {
  it("a higher-token turn renders a longer (taller) segment", () => {
    const big = new EegTraceStore();
    big.record(sample({ runId: "r1", outputTokens: 8000, inputTokens: 40000 }));
    const small = new EegTraceStore();
    small.record(sample({ runId: "r1", outputTokens: 50, inputTokens: 200 }));
    expect(svgHeight(big.renderSvg({ width: WIDTH }))).toBeGreaterThan(
      svgHeight(small.renderSvg({ width: WIDTH })),
    );
  });

  it("a zero-token (live) turn still draws at the minimum length", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1" })); // no tokens yet
    expect(svgHeight(store.renderSvg({ width: WIDTH }))).toBeGreaterThan(0);
  });
});

describe("eegStopX", () => {
  it("maps the 8 EEG_STOPS to strictly ascending x values within the rail at width 300", () => {
    expect(EEG_STOPS).toHaveLength(8);
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

describe("forced rendering", () => {
  it("forced:true draws a dashed strand", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "rf", forced: true }));
    expect(store.renderSvg({ width: WIDTH })).toContain("stroke-dasharray");
  });

  it("forced:false does not", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "rn", forced: false }));
    expect(store.renderSvg({ width: WIDTH })).not.toContain("stroke-dasharray");
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

  it("6 overlapping same model+level subagents collapse to <=5 strands with a x6 badge", () => {
    const store = new EegTraceStore();
    for (const s of overlapping(6)) store.record(s);
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain("×6"); // ×6 badge
    expect(pathCount(svg)).toBeLessThanOrEqual(5);
  });

  it("3 overlapping subagents render 3 strands and no xN badge", () => {
    const store = new EegTraceStore();
    for (const s of overlapping(3)) store.record(s);
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).not.toMatch(/×\d/);
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
