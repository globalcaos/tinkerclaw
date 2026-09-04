import { describe, it, expect } from "vitest";
import { EEG_EFFORT_MULT, eegRelCost } from "./eeg-trace";
import {
  renderSmartCostChart,
  scClampView,
  SC_VIEW_FULL,
  SC_VIEW_MIN_W,
  scComputeScales,
  scX,
  scY,
  scRadius,
  scPointsFor,
  scEffortsFor,
  scFmtCtx,
  scFmtTokens,
  scBaseTokens,
  scTokensPerTask,
  scTaskShiftDecades,
  scDefaultCtx,
  scCostX,
  scLinearTicks,
  scTokenRatio,
  scAssignTwins,
  scSyncTwinContext,
  scModelKey,
  scApiPrice,
  scApiPointsFor,
  scApiMultiple,
  scCostFromX,
  scCostAtUtil,
  scUtilAtCost,
  scIsUtilDrag,
  SC_PLAN_UTIL,
  SC_COPILOT_PINK,
  type ScModel,
} from "./smart-cost-chart";

const model = (over: Partial<ScModel> & { id: string }): ScModel => ({
  name: over.id.split("/").pop() ?? over.id,
  provider: "claude-code",
  index: 55,
  relCost: 5,
  ctx: 1_000_000,
  color: "#E8702A",
  ...over,
});

describe("smart-cost chart — scales", () => {
  it("cost maps logarithmically: 10× the cost moves the same distance as 10× again", () => {
    const s = scComputeScales([model({ id: "a", relCost: 1 }), model({ id: "b", relCost: 10 })]);
    const d1 = scX(1, s) - scX(0.1, s);
    const d2 = scX(10, s) - scX(1, s);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.001);
  });

  it("higher intelligence index renders higher on the page (smaller y)", () => {
    const s = scComputeScales([model({ id: "a", index: 30 }), model({ id: "b", index: 60 })]);
    expect(scY(60, s)).toBeLessThan(scY(30, s));
  });

  it("circle AREA is proportional to context window (radius ∝ √ctx, through the origin)", () => {
    const s = scComputeScales([
      model({ id: "a", ctx: 200_000 }),
      model({ id: "b", ctx: 1_000_000 }),
    ]);
    const rSmall = scRadius(200_000, s);
    const rBig = scRadius(1_000_000, s);
    expect(rBig).toBeGreaterThan(rSmall);
    // radius ∝ √ctx exactly → area ratio == ctx ratio (5×), no offset term
    const ratio = (rBig * rBig) / (rSmall * rSmall);
    expect(ratio).toBeCloseTo(5, 5);
  });
});

describe("smart-cost chart — vendor ladder ∩ AA score, nothing invented", () => {
  // the architect 2026-08-27: find how many thinking efforts each model has, find a
  // public source for how smart each effort is, then attribute. Do not invent.

  it("plots Opus 5 at AA's five named efforts, not a flattened headline", () => {
    const pts = scPointsFor(model({ id: "claude-opus-5", relCost: 2, index: 63.05 }));
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(pts.map((p) => p.smart)).toEqual([52.4569, 58.6355, 61.4751, 62.5205, 63.0532]);
    expect(pts.every((p) => p.measured)).toBe(true);
  });

  it("omits a vendor stop AA did not score — Opus 5 has no AA 'minimal'", () => {
    const pts = scPointsFor(model({ id: "claude-opus-5", relCost: 2, index: 63 }));
    expect(pts.map((p) => p.lvl)).not.toContain("minimal");
  });

  // REVISED 2026-08-30, then again 2026-09-02. A rung AA had not scored was first
  // DROPPED, then drawn on the dashed cost rail at the headline index. Since 2026-09-02
  // (the architect: "find other benchmarks … approximate") such a rung carries an ESTIMATE from
  // other public per-effort benchmark runs fitted to AA's scale, flagged as such. The
  // guard that matters is unchanged: `measured` is true ONLY for AA's own number, the
  // measured rung's value never moves, and an estimate is never a measurement.
  it("plots Sonnet 5's whole ladder, with only max carrying an AA score", () => {
    const pts = scPointsFor(model({ id: "claude-sonnet-5", relCost: 1, index: 55.26 }));
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(pts.filter((p) => p.measured).map((p) => p.lvl)).toEqual(["max"]);
    expect(pts.find((p) => p.lvl === "max")!.smart).toBe(55.2612);
    for (const p of pts.filter((x) => !x.measured)) {
      expect(p.estimate, p.lvl).toBeDefined(); // flagged, with a σ and a basis
      expect(p.estimate!.sd).toBeGreaterThan(0);
      expect(p.smart).toBeLessThan(55.2612); // clamped below the measured max
    }
  });

  it("plots Grok 4.6 at AA's four named efforts, not a single flattened dot", () => {
    const pts = scPointsFor(
      model({ id: "grok-4.6", provider: "xai", relCost: 0.0536, index: 60.92 }),
    );
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(pts.map((p) => p.smart)).toEqual([51.6796, 59.0064, 60.923, 60.0136]);
  });

  it("scores GLM-5.3 only at max — low and high ride the rail", () => {
    const pts = scPointsFor(model({ id: "glm-5.3", provider: "zai", relCost: 4.4, index: 59.51 }));
    expect(pts.map((p) => p.lvl)).toEqual(["low", "high", "max"]);
    expect(pts.filter((p) => p.measured).map((p) => p.lvl)).toEqual(["max"]);
    expect(pts.find((p) => p.lvl === "max")!.smart).toBe(59.5134);
  });

  it("scores Kimi K3 at low and max, and rails the unscored high", () => {
    const pts = scPointsFor(
      model({
        id: "openrouter/moonshotai/kimi-k3",
        provider: "openrouter",
        relCost: 15,
        index: 59.7,
      }),
    );
    expect(pts.map((p) => p.lvl)).toEqual(["low", "high", "max"]);
    expect(pts.filter((p) => p.measured).map((p) => p.lvl)).toEqual(["low", "max"]);
    expect(pts.filter((p) => p.measured).map((p) => p.smart)).toEqual([48.2515, 59.6995]);
    // the unscored middle rung is an ESTIMATE (flagged), clamped between the two
    // measured neighbours — never a bare copy of the headline
    const high = pts.find((p) => p.lvl === "high")!;
    expect(high.estimate).toBeDefined();
    expect(high.smart).toBeGreaterThanOrEqual(48.2515);
    expect(high.smart).toBeLessThanOrEqual(59.6995);
    expect(high.smart).not.toBe(59.7);
  });

  it("says UNKNOWN for a catalog-tail model with no vendor page", () => {
    const pts = scPointsFor(
      model({ id: "qwen/qwen3.8-max", provider: "openrouter", relCost: 4, index: 58 }),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].label).toBe("Effort ladder unknown");
    expect(pts[0].smart).toBe(58); // headline, not invented per-effort
    expect(pts[0].measured).toBe(false);
  });

  it("never copies the headline index onto a stop AA did not score", () => {
    const pts = scPointsFor(model({ id: "claude-opus-5", relCost: 2, index: 99 }));
    expect(pts.some((p) => p.smart === 99)).toBe(false);
  });

  it("spreads COST across the plotted stops on the EEG burn mults", () => {
    const pts = scPointsFor(model({ id: "claude-opus-5", relCost: 2, index: 63 }));
    const high = pts.find((p) => p.lvl === "high")!;
    const max = pts.find((p) => p.lvl === "max")!;
    expect(high.cost).toBeCloseTo(2 * 1.5);
    expect(max.cost).toBeCloseTo(2 * 3);
  });

  it("marks the published-price stop as the anchor, found not assumed", () => {
    const pts = scPointsFor(model({ id: "claude-opus-5", relCost: 2, index: 63 }));
    const anchors = pts.filter((p) => p.anchor);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].lvl).toBe("medium"); // costMult 1
    const gem = scPointsFor(model({ id: "gemini-3-pro", provider: "google", relCost: 2 }));
    expect(gem.filter((p) => p.anchor)).toHaveLength(1);
  });

  it("renders one outline dot + one ghost per PLOTTED stop", () => {
    const svg = renderSmartCostChart([
      model({ id: "claude-opus-5", name: "Opus", color: "#C382FB", relCost: 6, index: 63 }),
      model({ id: "grok-4.6", provider: "xai", name: "Grok", color: "#07B2FE", relCost: 15 }),
    ]);
    // 5 Opus (low..max) + 4 Grok (low/medium/high/xhigh)
    expect(svg.split('class="sc-dotg"').length - 1).toBe(9);
    expect(svg.split('class="sc-ghost"').length - 1).toBe(9);
    expect(svg).toContain("#C382FB");
    expect(svg).toContain("#07B2FE");
    expect(svg).toContain("Opus");
    expect(svg).toContain("Grok");
  });

  it("tooltip names the AA score AT that effort", () => {
    const svg = renderSmartCostChart([
      model({ id: "claude-opus-5", name: "TestModel", relCost: 4, index: 63 }),
    ]);
    expect(svg).toContain("TestModel · High");
    expect(svg).toContain("€6.0/Mtok"); // 4 × high(1.5)
    expect(svg).toContain("idx 61.5 at High (AA)");
    expect(svg).not.toContain("measured once, not per effort");
    expect(svg).toContain("/task");
    expect(svg).toContain("1M ctx");
  });
});

describe("smart-cost chart — tokens per task (the architect 2026-08-06 #2)", () => {
  it("opus-5 base is the OckBench anchor: high=6,745 tokens", () => {
    expect(scTokensPerTask("claude-code/claude-opus-5", "high")).toBeCloseTo(6745, -1);
  });

  it("kimi-k3 base is the OckBench anchor: high=12,250 tokens", () => {
    expect(scTokensPerTask("openrouter/moonshotai/kimi-k3", "high")).toBeCloseTo(12250, -1);
  });

  it("per-effort tokens scale by the documented EEG burn mults", () => {
    const base = scBaseTokens("claude-code/claude-opus-5");
    for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(scTokensPerTask("claude-code/claude-opus-5", lvl)).toBeCloseTo(
        base * EEG_EFFORT_MULT[lvl],
        6,
      );
    }
  });

  it("the REFERENCE (Opus 5 @ high — its top REAL effort) has ZERO shift", () => {
    // Was "max" until 2026-08-25; Anthropic's ladder for this class stops at
    // high, so max was a setting the reference model cannot be run at.
    expect(scTaskShiftDecades("claude-code/claude-opus-5", "high")).toBeCloseTo(0, 10);
  });

  it("a more token-hungry model shifts RIGHT (positive decades)", () => {
    // Kimi K3 at max burns ~24.5k tokens vs the Opus@max reference ~13.5k
    expect(scTaskShiftDecades("openrouter/moonshotai/kimi-k3", "max")).toBeGreaterThan(0);
  });

  it("a leaner model/effort shifts LEFT (negative decades)", () => {
    // Opus 5 at medium burns fewer tokens than the max reference
    expect(scTaskShiftDecades("claude-code/claude-opus-5", "medium")).toBeLessThan(0);
  });

  it("unknown models fall back to the default base, never NaN", () => {
    expect(Number.isFinite(scTaskShiftDecades("mystery/model-x", "high"))).toBe(true);
  });

  it("token formatting: 13,491 → 13.5k tok, 800 → 800 tok", () => {
    expect(scFmtTokens(13491)).toBe("13.5k tok");
    expect(scFmtTokens(800)).toBe("800 tok");
  });
});

describe("smart-cost chart — honesty + edges", () => {
  it("empty input renders an empty frame, not a crash", () => {
    expect(() => renderSmartCostChart([])).not.toThrow();
    const svg = renderSmartCostChart([]);
    expect(svg).toContain("<svg");
  });

  it("context formatting: 1048576 → 1M, 256000 → 256k", () => {
    expect(scFmtCtx(1_000_000)).toBe("1M");
    expect(scFmtCtx(1_048_576)).toBe("1M");
    expect(scFmtCtx(256_000)).toBe("256k");
    expect(scFmtCtx(200_000)).toBe("200k");
  });
});

describe("smart-cost chart — full-catalog labels (the architect 2026-08-06 #3)", () => {
  it("labelled models get a text label; unlabelled live only in their tooltip", () => {
    const svg = renderSmartCostChart([
      model({ id: "p/a", name: "Alpha", labeled: true }),
      model({ id: "p/b", name: "Beta", labeled: false, relCost: 8, index: 48 }),
    ]);
    expect(svg).toContain("Alpha");
    expect(svg).not.toContain(">Beta</text>");
  });

  it("family context defaults: gpt-5 → 272k, gemini → 1M, claude → 200k", () => {
    expect(scDefaultCtx("codex/gpt-5.6-sol")).toBe(272_000);
    expect(scDefaultCtx("google/gemini-3.5-flash")).toBe(1_000_000);
    expect(scDefaultCtx("claude-code/claude-sonnet-5")).toBe(200_000);
    expect(scDefaultCtx("openai/gpt-4o")).toBe(128_000);
    expect(scDefaultCtx("mystery/model-x")).toBe(200_000); // fallback
  });

  it("ChatGPT bubbles use the models-panel blossom, tinted the circle colour, not a white AI disc", () => {
    const svg = renderSmartCostChart([
      model({
        id: "openai/gpt-5.6-sol",
        provider: "openai",
        name: "GPT-5.6 Sol",
        relCost: 0.2679,
        index: 60.93,
      }),
    ]);
    expect(svg).toContain('fill="#10A37F"');
    expect(svg).not.toContain(">AI</text>");
  });
});

describe("prepaid utilisation slider (the architect 2026-08-28)", () => {
  it("home cost is the 75% quota convention; 100% is cheaper, list is dearer", () => {
    expect(SC_PLAN_UTIL).toBe(0.75);
    expect(scCostAtUtil(0.2232, 0.75)).toBeCloseTo(0.2232, 6);
    expect(scCostAtUtil(0.2232, 1)).toBeCloseTo(0.2232 * 0.75, 6);
    expect(scUtilAtCost(0.2232, 0.2232)).toBeCloseTo(0.75, 6);
  });

  it("scCostFromX inverts scCostX on both axes", () => {
    const s = scComputeScales(
      [model({ id: "claude-code/claude-opus-5", relCost: 0.2232, index: 63 })],
      "log",
    );
    const x = scCostX(0.2232, s);
    expect(scCostFromX(x, s)).toBeCloseTo(0.2232, 5);
    const lin = scComputeScales(
      [model({ id: "claude-code/claude-opus-5", relCost: 0.2232, index: 63 })],
      "linear",
    );
    const xl = scCostX(0.2232, lin);
    expect(scCostFromX(xl, lin)).toBeCloseTo(0.2232, 5);
  });

  it("Claude and Grok prepaid circles are util-draggable; Copilot and metered are not", () => {
    expect(scIsUtilDrag({ id: "claude-code/claude-opus-5", provider: "claude-code" })).toBe(true);
    expect(scIsUtilDrag({ id: "xai/grok-4.6", provider: "xai" })).toBe(true);
    expect(scIsUtilDrag({ id: "github-copilot/claude-opus-5", provider: "github-copilot" })).toBe(
      false,
    );
    expect(scIsUtilDrag({ id: "openrouter/moonshotai/kimi-k3", provider: "openrouter" })).toBe(
      false,
    );
  });

  it("renders the size legend and the 75% tooltip on a Claude plan circle", () => {
    const svg = renderSmartCostChart([
      model({
        id: "claude-code/claude-opus-5",
        name: "Opus 5",
        relCost: 0.2232,
        index: 63,
        ctx: 1_000_000,
      }),
    ]);
    expect(svg).toContain("SIZE ∝ CONTEXT");
    expect(svg).toContain('class="sc-ctxleg"');
    expect(svg).toContain("75% of the quota ceiling");
    expect(svg).toContain('data-util-drag="1"');
    expect(svg).toContain('class="sc-util-pct"');
  });
});

describe("smart-cost chart — linear ↔ log axis (the architect 2026-08-06 #4)", () => {
  it("linear ticks start at 0, use nice 1/2/5 steps, cover the domain", () => {
    const ticks = scLinearTicks(48);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(48);
    const step = ticks[1] - ticks[0];
    expect([1, 2, 5, 10, 20]).toContain(step);
  });

  it("linear mode maps cost linearly from €0", () => {
    const s = scComputeScales([model({ id: "a", relCost: 4 })], "linear");
    expect(s.xScale).toBe("linear");
    // €0 sits at the left edge; halfway in cost = halfway in pixels (defining property)
    expect(scCostX(0, s)).toBeCloseTo(64, 0);
    const mid = s.c1 / 2;
    expect(scCostX(mid, s) - scCostX(0, s)).toBeCloseTo(scCostX(s.c1, s) - scCostX(mid, s), 1);
  });

  it("log remains the default and keeps its logarithmic spacing", () => {
    const s = scComputeScales([model({ id: "a", relCost: 1 })]);
    expect(s.xScale).toBe("log");
    const d1 = scCostX(1, s) - scCostX(0.1, s);
    const d2 = scCostX(10, s) - scCostX(1, s);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.001);
  });

  it("token ratio is 1 for the reference, >1 for a verboser model", () => {
    expect(scTokenRatio("claude-code/claude-opus-5", "high")).toBeCloseTo(1, 10);
    expect(scTokenRatio("openrouter/moonshotai/kimi-k3", "max")).toBeGreaterThan(1);
  });

  it("render marks the axis with the active scale word", () => {
    const models = [model({ id: "p/a", name: "Alpha" })];
    expect(renderSmartCostChart(models, { xScale: "linear" })).toContain("· linear");
    expect(renderSmartCostChart(models, { xScale: "log" })).toContain("· log");
  });

  it("task-mode dots stay inside the plot in linear scale too", () => {
    const models = [model({ id: "openrouter/moonshotai/kimi-k3", name: "Kimi", relCost: 15 })];
    const svg = renderSmartCostChart(models, { xScale: "linear" });
    const xs = [...svg.matchAll(/--sc-x:([-\d.]+)px/g)].map((m) => parseFloat(m[1]));
    const dxs = [...svg.matchAll(/--sc-dx:([-\d.]+)px/g)].map((m) => parseFloat(m[1]));
    xs.forEach((x, i) => {
      expect(x).toBeGreaterThan(60);
      expect(x).toBeLessThan(868);
      expect(x + dxs[i]).toBeGreaterThan(60);
      expect(x + dxs[i]).toBeLessThan(868);
    });
  });
});

describe("smart-cost chart — full-catalog bounds (the architect 2026-08-06 #5)", () => {
  // The real reachable catalog: ~40 families across the whole index range.
  // However many models are plotted, every dot and every task-mode landing
  // must stay inside the plot — that is what lets the card fit the window.
  const families: [string, number, number][] = [
    ["claude-code/claude-opus-5", 60.7, 8.8],
    ["claude-code/claude-fable-5", 59.9, 17.6],
    ["codex/gpt-5.6-sol", 58.9, 6.45],
    ["openrouter/moonshotai/kimi-k3", 57.1, 15.0],
    ["claude-code/claude-opus-4-8", 55.7, 8.8],
    ["codex/gpt-5.6-terra", 55.0, 3.23],
    ["openai-codex/gpt-5.5", 54.8, 6.45],
    ["github-copilot/gpt-5.5", 54.8, 2.15],
    ["xai/grok-4.5", 53.8, 1.29],
    ["claude-code/claude-opus-4-7", 53.5, 8.8],
    ["github-copilot/claude-opus-4.7", 53.5, 5.38],
    ["claude-code/claude-sonnet-5", 53.4, 1.76],
    ["github-copilot/gpt-5.4", 51.4, 3.23],
    ["codex/gpt-5.6-luna", 51.2, 1.29],
    ["openrouter/z-ai/glm-5.2", 51.1, 2.42],
    ["google/gemini-3.6-flash", 50.1, 1.94],
    ["google/gemini-3.5-flash", 50.2, 1.94],
    ["openrouter/deepseek/deepseek-v4-flash-0731", 49.9, 0.18],
    ["claude-code/claude-sonnet-4-6", 47.2, 1.76],
    ["openrouter/qwen/qwen3.8-max", 56.5, 6.0],
    ["openrouter/qwen/qwen3.7-max", 46.0, 4.42],
    ["google/gemini-3.1-pro-preview", 46.5, 2.58],
    ["openai/gpt-5.3-codex", 44.3, 3.01],
    ["openai/gpt-5.2", 42.2, 2.58],
    ["github-copilot/gpt-5.2-codex", 40.1, 3.01],
    ["openai/gpt-5.4-mini", 40.0, 0.97],
    ["google/gemini-3-pro-preview", 39.6, 2.58],
    ["openai/gpt-5.4-nano", 38.2, 0.97],
    ["github-copilot/claude-opus-4.6", 37.8, 5.38],
    ["openai/gpt-5.1", 36.9, 2.15],
    ["google/gemini-3.5-flash-lite", 36.5, 1.94],
    ["claude-code/claude-haiku-4-5", 29.6, 0.53],
    ["openai/o3", 30.4, 2.58],
    ["google/gemini-3-flash-preview", 27.4, 1.94],
    ["google/gemini-2.5-pro", 25.8, 2.58],
    ["openai/gpt-4.1", 19.4, 2.15],
    ["google/gemini-2.5-flash", 14.1, 1.94],
    ["google/gemini-2.0-flash", 12.3, 1.94],
    ["openai/gpt-4o", 11.2, 2.15],
  ];
  const catalog = families.map(([id, index, relCost], i) => ({
    id,
    name: id.split("/").pop() || "",
    provider: id.split("/")[0],
    index,
    relCost,
    ctx: 200000 + i * 20000,
    color: "#E8702A",
    labeled: i < 22,
  }));

  for (const xScale of ["log", "linear"] as const) {
    it(`every dot + task landing stays inside the plot (${xScale}, ${catalog.length} models)`, () => {
      const svg = renderSmartCostChart(catalog, { xScale });
      // Parse each DOT's own (x, y, dx) triple from its single style attribute.
      // These used to be three independent global scrapes paired by index, which
      // silently broke the day a second mark type (the API-price triangles, 2026-08-27)
      // also started emitting --sc-dx: the dx array grew, the pairing slid, and the
      // assertion started comparing one model's x against another's glide. Reading the
      // triple from one element is the only form that cannot drift.
      const dotStyles = [
        ...svg.matchAll(
          /class="sc-dotg" style="--sc-x:([-\d.]+)px;--sc-y:([-\d.]+)px;--sc-dx:([-\d.]+)px/g,
        ),
      ];
      const xs = dotStyles.map((m) => parseFloat(m[1]));
      const ys = dotStyles.map((m) => parseFloat(m[2]));
      const dxs = dotStyles.map((m) => parseFloat(m[3]));
      // One dot per REAL provider stop, so the expected count is now summed
      // rather than assumed to be six per model.
      const expectedDots = catalog.reduce((n, m) => n + scPointsFor(m).length, 0);
      expect(xs.length).toBe(expectedDots);
      for (const y of ys) {
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(28);
        expect(y).toBeLessThanOrEqual(540);
      }
      for (const x of xs) {
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(60);
        expect(x).toBeLessThanOrEqual(870);
      }
      xs.forEach((x, i) => {
        expect(x + (dxs[i] || 0)).toBeGreaterThan(50);
        expect(x + (dxs[i] || 0)).toBeLessThan(880);
      });
      // The API triangles are real marks on the same axes and must respect the same
      // frame. Opus 5's list price is 112x its plan price, so if the scale did not
      // grow to include them they would all pile onto the right boundary and read as
      // one price — the failure this assertion exists to catch.
      const triPos = [
        ...svg.matchAll(/<g class="sc-apipos" transform="translate\(([-\d.]+), ([-\d.]+)\)"/g),
      ];
      expect(triPos.length).toBeGreaterThan(0);
      for (const t of triPos) {
        const tx = parseFloat(t[1]);
        const ty = parseFloat(t[2]);
        expect(tx).toBeGreaterThanOrEqual(60);
        expect(tx).toBeLessThanOrEqual(870);
        expect(ty).toBeGreaterThanOrEqual(28);
        expect(ty).toBeLessThanOrEqual(540);
      }
    });
  }
});

// FORK 2026-08-06 #7: the chart is injected with `body.innerHTML = "<svg>…"`.
// HTML's foreign-content parser CLOSES the <svg> at any of a fixed list of HTML
// tags — `img` among them — so a single <img> logo silently truncates the chart:
// every dot after it becomes an unknown HTML element that renders nothing, and
// the imgs flow below the chart, left-aligned. It shipped three times because a
// FILE render does not reproduce it; only innerHTML does. Assert the whole class,
// not just <img>.
describe("the chart markup can never break its own <svg>", () => {
  // The HTML spec's foreign-content breakout list (the ones plausible in a logo).
  const BREAKOUT =
    /<(b|big|blockquote|body|br|center|code|dd|div|dl|dt|em|embed|h[1-6]|head|hr|i|img|li|listing|menu|meta|nobr|ol|p|pre|ruby|s|small|span|strong|strike|sub|sup|table|tt|u|ul|var)[\s/>]/i;

  it("emits no HTML tag that would terminate the enclosing svg", () => {
    const svg = renderSmartCostChart([
      // github-copilot is the one whose mark is an <img> — the breakout trigger.
      model({
        id: "github-copilot/gpt-5.5",
        provider: "github-copilot",
        name: "GPT5.5",
        color: "#BF09A3",
        relCost: 6,
        index: 54.8,
      }),
      model({ id: "p/k", name: "Kimi", color: "#07B2FE", relCost: 15, index: 57.1 }),
    ]);
    const hit = BREAKOUT.exec(svg);
    expect(hit ? hit[0] : null).toBeNull();
  });

  it("keeps every dot inside the svg — count survives a real innerHTML parse", () => {
    const svg = renderSmartCostChart([
      // github-copilot is the one whose mark is an <img> — the breakout trigger.
      model({
        id: "github-copilot/gpt-5.5",
        provider: "github-copilot",
        name: "GPT5.5",
        color: "#BF09A3",
        relCost: 6,
        index: 54.8,
      }),
      model({ id: "p/k", name: "Kimi", color: "#07B2FE", relCost: 15, index: 57.1 }),
    ]);
    const host = document.createElement("div");
    host.innerHTML = svg;
    const inSource = (svg.match(/class="sc-ring"/g) ?? []).length;
    const inDom = host.querySelectorAll("svg .sc-ring").length;
    expect(inSource).toBeGreaterThan(0);
    expect(inDom).toBe(inSource);
  });
});

// FORK 2026-08-06 #8: the zoom-out floor the architect asked for — "don't let the graph
// zoom out more when all the models are already visible" — plus the pan pin that
// keeps the constellations reachable.
describe("pan/zoom view clamp", () => {
  it("never shows more than the whole drawing, however hard you zoom out", () => {
    const v = scClampView({ x: -500, y: -500, w: SC_VIEW_FULL.w * 4, h: SC_VIEW_FULL.h * 4 });
    expect(v.w).toBe(SC_VIEW_FULL.w);
    expect(v.h).toBe(SC_VIEW_FULL.h);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it("stops zooming IN at the floor", () => {
    expect(scClampView({ x: 0, y: 0, w: 1, h: 1 }).w).toBe(SC_VIEW_MIN_W);
  });

  it("keeps the aspect locked so the chart never skews", () => {
    const v = scClampView({ x: 0, y: 0, w: 300, h: 999 });
    expect(v.h / v.w).toBeCloseTo(SC_VIEW_FULL.h / SC_VIEW_FULL.w, 6);
  });

  it("pins a pan inside the drawing — you cannot drag the models out of sight", () => {
    const zoomed = scClampView({ x: 0, y: 0, w: 300, h: 200 });
    const far = scClampView({ ...zoomed, x: 99_999, y: 99_999 });
    expect(far.x).toBe(SC_VIEW_FULL.w - zoomed.w);
    expect(far.y).toBe(SC_VIEW_FULL.h - zoomed.h);
    const neg = scClampView({ ...zoomed, x: -99_999, y: -99_999 });
    expect(neg.x).toBe(0);
    expect(neg.y).toBe(0);
  });
});

// FORK 2026-08-24 (the architect): REVERSES the 2026-08-06 #10 fold. Copilot charges its
// own published rate, so folding its dot into the vendor's showed the cheaper of
// two routes and answered "what does this cost?" with a price you cannot pay on
// the route you are looking at. Every route now keeps its own dot; a dashed
// connector ties the routes to one brain together.
describe("one brain, several vendors: every route keeps its own dot", () => {
  // Same model, two sellers, GENUINELY different prices — the real shape:
  // openai/gpt-5.5 is prepaid inside a plan, Copilot bills $30/Mtok sticker.
  const pair = (): ScModel[] => [
    model({
      id: "openai/gpt-5.5",
      provider: "openai",
      name: "GPT-5.5",
      index: 54.8,
      relCost: 0.2679,
    }),
    model({
      id: "github-copilot/gpt-5.5",
      provider: "github-copilot",
      name: "gpt-5.5",
      index: 54.8,
      relCost: 16.71,
    }),
  ];

  it("normalises the route punctuation: opus-4-7 and opus-4.7 are one model", () => {
    expect(scModelKey("claude-code/claude-opus-4-7")).toBe(
      scModelKey("github-copilot/claude-opus-4.7"),
    );
    expect(scModelKey("openrouter/moonshotai/kimi-k3")).not.toBe(scModelKey("openai/gpt-5.5"));
  });

  it("keeps BOTH routes, each at its own price, tagged as one twin group", () => {
    const out = scAssignTwins(pair());
    expect(out.map((m) => m.id)).toEqual(["openai/gpt-5.5", "github-copilot/gpt-5.5"]);
    // nothing re-priced
    expect(out.map((m) => m.relCost)).toEqual([0.2679, 16.71]);
    // one shared identity, two members, prices genuinely apart
    expect(new Set(out.map((m) => m.twinKey)).size).toBe(1);
    expect(out.every((m) => m.twinN === 2 && m.twinSpread === true)).toBe(true);
  });

  it("leaves a single-route model untagged — an exclusive is not a twin", () => {
    const out = scAssignTwins([
      ...pair(),
      model({
        id: "github-copilot/grok-code-fast-1",
        provider: "github-copilot",
        name: "grok-code-fast-1",
        index: 21.6,
      }),
    ]);
    expect(out).toHaveLength(3);
    const exclusive = out.find((m) => m.id === "github-copilot/grok-code-fast-1")!;
    expect(exclusive.twinKey).toBeUndefined();
    expect(exclusive.twinN).toBeUndefined();
  });

  it("marks same-priced routes as NO-spread so no zero-length dash is drawn", () => {
    // gpt-5.6-sol really is 0.2679 on all three of openai / openai-codex / codex.
    const same = scAssignTwins([
      model({ id: "openai/gpt-5.6-sol", provider: "openai", index: 60, relCost: 0.2679 }),
      model({
        id: "openai-codex/gpt-5.6-sol",
        provider: "openai-codex",
        index: 60,
        relCost: 0.2679,
      }),
      model({ id: "codex/gpt-5.6-sol", provider: "codex", index: 60, relCost: 0.2679 }),
    ]);
    expect(same.every((m) => m.twinN === 3)).toBe(true);
    expect(same.every((m) => m.twinSpread === false)).toBe(true);
    // …and the renderer draws no connector for them
    expect(renderSmartCostChart(same)).not.toContain("sc-twin-cost");
  });

  it("inherits the native twin's context onto Copilot so bubble size matches the brain", () => {
    const native = model({
      id: "claude-code/claude-opus-5",
      provider: "claude-code",
      name: "Opus 5",
      ctx: 1_000_000,
      relCost: 0.2232,
    });
    const copilot = model({
      id: "github-copilot/claude-opus-5",
      provider: "github-copilot",
      name: "claude-opus-5",
      ctx: 200_000,
      relCost: 13.93,
    });
    const out = scSyncTwinContext([native, copilot]);
    expect(out.find((m) => m.provider === "claude-code")!.ctx).toBe(1_000_000);
    expect(out.find((m) => m.provider === "github-copilot")!.ctx).toBe(1_000_000);
    expect(out.find((m) => m.provider === "github-copilot")!.relCost).toBe(13.93);
  });

  it("does not invent a window for a Copilot-only model with no native twin", () => {
    const exclusive = model({
      id: "github-copilot/grok-code-fast-1",
      provider: "github-copilot",
      ctx: 200_000,
    });
    expect(scSyncTwinContext([exclusive])[0].ctx).toBe(200_000);
  });

  it("draws ONE dashed connector between the two priced-apart routes", () => {
    const svg = renderSmartCostChart(scAssignTwins(pair()));
    expect((svg.match(/class="sc-twin-cost"/g) ?? []).length).toBe(1);
    expect((svg.match(/class="sc-twin-task"/g) ?? []).length).toBe(1);
    // horizontal: twins share an AA index, so both ends sit at the same y
    const m = /class="sc-twin-cost"[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/.exec(svg)!;
    expect(m[1]).toBe(m[2]);
    // and it spans a real distance — the price gap is the point
    const xs = /class="sc-twin-cost"[^>]*x1="([\d.]+)"[^>]*x2="([\d.]+)"/.exec(svg)!;
    expect(Number(xs[2]) - Number(xs[1])).toBeGreaterThan(1);
  });

  it("labels each route with its own seller, Copilot's in pink", () => {
    const svg = renderSmartCostChart(scAssignTwins(pair()));
    expect(svg).toContain(SC_COPILOT_PINK);
    // the copilot dot now tags ITSELF — it is no longer a note on openai's label
    expect((svg.match(/\(copilot\)/g) ?? []).length).toBe(1);
    expect((svg.match(/\(openai\)/g) ?? []).length).toBe(1);
  });

  it("exposes the highlight hooks app.ts drives hover and the legend with", () => {
    const svg = renderSmartCostChart(
      scAssignTwins(pair()).map((m) => ({ ...m, vendorKey: m.provider })),
    );
    expect(svg).toContain('data-vendor="github-copilot"');
    expect(svg).toContain('data-vendor="openai"');
    expect(svg).toContain(`data-twin="${scModelKey("openai/gpt-5.5")}"`);
  });
});

describe("chart dots hold still (the architect: 'why is gemini flash pulsating?')", () => {
  it("inlines no SMIL animation, even for the animated google mark", () => {
    const svg = renderSmartCostChart([
      model({ id: "google/gemini-3.6-flash", provider: "google", name: "Gemini Flash", index: 50 }),
    ]);
    expect(svg).not.toMatch(/<animate/);
    expect(svg).toContain("sc-ring"); // the mark survived the strip
  });
});

describe("labels ride the zoom (the architect: 'should approach the circle as I zoom in')", () => {
  const svg = () =>
    renderSmartCostChart([
      model({ id: "a/one", name: "One", index: 50, relCost: 2 }),
      model({ id: "b/two", name: "Two", index: 51, relCost: 30 }),
    ]);

  it("anchors each name ON its max-effort dot, offset only by scaled vars", () => {
    const m =
      /<g class="sc-labelpos"[^>]*? transform="translate\(([-\d.]+), ([-\d.]+)\)"[^>]*>/.exec(
        svg(),
      );
    expect(m).not.toBeNull();
    // the anchor is the max-effort point of the cheapest model, inside the plot
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![2])).toBeGreaterThan(0);
  });

  it("carries a gap for CSS to scale by --sc-k, and NO vertical nudge", () => {
    const out = svg();
    expect(out).toMatch(/--sc-gap:[\d.]+px/);
    expect(out).not.toMatch(/--sc-dy/);
  });

  // the architect 2026-08-06 #11: "the model names need to be exactly at the same height
  // than its highest effort bubble" — a name a few px off its dot points at the
  // wrong model. The anchor y MUST equal the max-effort point's y, and the text
  // must be centred on it rather than sitting on a nudged baseline.
  it("puts each name at EXACTLY its max-effort bubble's height", () => {
    const m = model({ id: "a/one", name: "One", index: 50, relCost: 2 });
    const s = scComputeScales([m]);
    const pts = scPointsFor(m);
    const maxPoint = pts[pts.length - 1];
    const out = renderSmartCostChart([m]);
    const anchor =
      /<g class="sc-labelpos"[^>]*? transform="translate\([-\d.]+, ([-\d.]+)\)"[^>]*>/.exec(out);
    expect(Number(anchor![1])).toBeCloseTo(scY(maxPoint.smart, s), 1);
    expect(out).toContain('dominant-baseline="central"');
  });

  it("never staggers two crowded names apart — same index, same height", () => {
    const out = renderSmartCostChart([
      model({ id: "a/one", name: "One", index: 50, relCost: 2 }),
      model({ id: "b/two", name: "Two", index: 50, relCost: 2.1 }),
    ]);
    const ys = [
      ...out.matchAll(
        /<g class="sc-labelpos"[^>]*? transform="translate\([-\d.]+, ([-\d.]+)\)"[^>]*>/g,
      ),
    ].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(ys[0]).toBeCloseTo(ys[1], 5);
  });

  it("never flips a name to the left of its bubble", () => {
    expect(svg()).not.toMatch(/text-anchor="end"[^>]*class="sc-label"/);
    expect(svg()).not.toMatch(/class="sc-label"[^>]*text-anchor="end"/);
  });
});

// ─── API-price triangles (the architect 2026-08-27) ───
// The overlay exists because the x axis mixes two BASES: an amortized subscription
// price for the models we hold a plan for, and a metered list price for everything
// else. These tests pin the three things that make the overlay honest rather than
// decorative — a triangle only where a real gap exists, never where there is none,
// and both marks reachable by one hover.
describe("smart-cost chart — API list-price layer", () => {
  it("prices a subscription model at its published sticker, not its plan rate", () => {
    // Opus 5 on Max 20x: €0.2232 effective against a $25 published output price.
    const opus = model({ id: "claude-code/claude-opus-5", relCost: 0.2232 });
    expect(scApiPrice(opus.id)).toBe(25);
    const mult = scApiMultiple(opus);
    expect(mult).toBeDefined();
    expect(mult!).toBeCloseTo(25 / 0.2232, 3);
    // ~112x — the single number that reconciles "Claude is cheapest" with
    // "Claude is the dearest frontier model".
    expect(mult!).toBeGreaterThan(100);
  });

  it("draws NO triangle for a metered route — its circle already IS the list price", () => {
    // Kimi K3 is billed in cash at $15/Mtok, which is exactly what the dot plots.
    const kimi = model({
      id: "openrouter/moonshotai/kimi-k3",
      relCost: 15,
      provider: "openrouter",
    });
    expect(scApiPointsFor(kimi)).toEqual([]);
    expect(scApiMultiple(kimi)).toBeUndefined();
    const out = renderSmartCostChart([kimi]);
    expect(out).not.toContain("sc-tri");
  });

  it("draws no triangle for a model with no verified list price rather than inventing one", () => {
    const unknown = model({ id: "openrouter/acme/never-heard-of-it", relCost: 3 });
    expect(scApiPrice(unknown.id)).toBeUndefined();
    expect(scApiPointsFor(unknown)).toEqual([]);
  });

  it("puts every triangle at the SAME height as its matching-effort circle", () => {
    const opus = model({ id: "claude-code/claude-opus-5", relCost: 0.2232, index: 63.05 });
    const circles = scPointsFor(opus);
    const tris = scApiPointsFor(opus);
    expect(tris.length).toBe(circles.length);
    for (let i = 0; i < tris.length; i++) {
      expect(tris[i].lvl).toBe(circles[i].lvl);
      expect(tris[i].smart).toBe(circles[i].smart);
    }
    // Across efforts the constellation now CLIMBS — AA scored them separately.
    expect(new Set(circles.map((p) => p.smart)).size).toBeGreaterThan(1);
  });

  it("keeps every triangle INSIDE the plot — the 112× gap must not clip at the edge", () => {
    const opus = model({ id: "claude-code/claude-opus-5", relCost: 0.2232 });
    const s = scComputeScales([opus]);
    for (const p of scApiPointsFor(opus)) {
      const x = scCostX(p.cost, s);
      // strictly inside the drawing, not clamped onto the right boundary
      expect(x).toBeLessThan(scCostX(Math.pow(10, s.x1), s));
      expect(Math.log10(p.cost)).toBeLessThanOrEqual(s.x1);
      expect(Math.log10(p.cost)).toBeGreaterThanOrEqual(s.x0);
    }
  });

  it("spans the LINEAR axis to the dearest list price too", () => {
    const opus = model({ id: "claude-code/claude-opus-5", relCost: 0.2232 });
    const s = scComputeScales([opus], "linear");
    const dearest = Math.max(...scApiPointsFor(opus).map((p) => p.cost));
    expect(s.c1).toBeGreaterThanOrEqual(dearest);
  });

  it("ties circles and triangles to ONE model key so a hover lights both", () => {
    const out = renderSmartCostChart([
      model({ id: "claude-code/claude-opus-5", name: "Opus 5", relCost: 0.2232 }),
    ]);
    expect(out).toContain('class="sc-dotpos"');
    expect(out).toContain('class="sc-apipos"');
    // the tag the focus machinery keys on must be present on BOTH mark types
    const dot = /<g class="sc-dotpos"[^>]*data-model="([^"]+)"/.exec(out);
    const tri = /<g class="sc-apipos"[^>]*data-model="([^"]+)"/.exec(out);
    expect(dot).toBeTruthy();
    expect(tri).toBeTruthy();
    expect(tri![1]).toBe(dot![1]);
    expect(dot![1]).toBe("claude-code/claude-opus-5");
  });

  it("bridges each triangle to its circle with a dashed connector", () => {
    const out = renderSmartCostChart([model({ id: "claude-code/claude-opus-5", relCost: 0.2232 })]);
    const stops = scApiPointsFor(
      model({ id: "claude-code/claude-opus-5", relCost: 0.2232 }),
    ).length;
    const bridges = [...out.matchAll(/class="sc-bridge-cost"/g)];
    expect(stops).toBeGreaterThan(0);
    expect(bridges).toHaveLength(stops);
    // horizontal by DATA (same index at both ends), not forced flat by the drawing
    const seg = /<line class="sc-bridge-cost"[^>]*y1="([-\d.]+)"[^>]*y2="([-\d.]+)"/.exec(out);
    expect(Number(seg![1])).toBeCloseTo(Number(seg![2]), 6);
  });

  it("never lets a specific price row be stolen by a generic one", () => {
    // Sonnet 5 is $10; the older Sonnet 4.6 is $15. One regex order bug prices
    // both the same and the chart silently overstates the newer, cheaper model.
    expect(scApiPrice("claude-code/claude-sonnet-5")).toBe(10);
    expect(scApiPrice("claude-code/claude-sonnet-4-6")).toBe(15);
    expect(scApiPrice("openai/gpt-5.4-mini")).toBe(4.5);
    expect(scApiPrice("openai/gpt-5.4")).toBe(15);
    expect(scApiPrice("google/gemini-3.7-flash")).toBe(3.75);
    expect(scApiPrice("google/gemini-3.5-flash")).toBe(9);
    expect(scApiPrice("google/gemini-3.1-pro-preview")).toBe(12);
  });

  it("prices a Copilot re-sell at the SAME sticker as its vendor — GitHub adds no markup", () => {
    expect(scApiPrice("github-copilot/claude-opus-4.7")).toBe(
      scApiPrice("claude-code/claude-opus-5"),
    );
    // Pro+ returns $70 of credit for $39, so its gap is ~1.79x, not ~112x.
    const cop = model({ id: "github-copilot/claude-opus-4.7", relCost: 13.93 });
    expect(scApiMultiple(cop)!).toBeCloseTo(25 / 13.93, 3);
  });
});

// ─── 2026-08-30 catalog refresh ───
// Every assertion here is a REGEX-ORDER guard. This table is first-match-wins and
// the file's history is a list of generic rows silently claiming specific models
// (glm-5-turbo, nex-n2-mini, gemini-3.6-flash). A new model added below its
// family's generic row is mispriced in a way nothing else detects.
describe("smart-cost chart — 2026-08-30 arrivals", () => {
  // FORK 2026-09-02 — two cases lived here and both existed ONLY to pin the
  // `claude-opus-5-fast` overrides in SC_API_PRICE and SC_CTX_RULES. The architect
  // banned OpenRouter routes that duplicate a vendor we hold a direct subscription
  // with; the route left the catalog and the overrides went with it, so the cases are
  // DELETED rather than re-pointed at a live model. Neither thing they asserted is
  // now unguarded: Opus 5's $25 sticker is pinned by "prices a subscription model at
  // its published sticker" and "a metered route draws NO triangle" by the Kimi K3
  // case, both in the API list-price describe above — and again by Fable 5.1 below.
  it("keeps no override for a route the architect banned", () => {
    // The gate that replaces those two cases. Prose saying "we removed the rows"
    // decays into being ignored; this fails the moment either row comes back, because
    // a re-added special case would beat the generic row each assertion names.
    const banned = "openrouter/anthropic/claude-opus-5-fast";
    expect(scApiPrice(banned)).toBe(25); // generic /opus/i, not a $50 special case
    expect(scDefaultCtx(banned)).toBe(200_000); // generic /claude/i, not a 1M one
  });

  it("puts the whole gpt-5.6 family on ONE pricing basis (short context)", () => {
    // Sol read 30 (long-context) while Terra/Luna read short — one family, two
    // bases, which is the defect class this chart exists to make visible.
    expect(scApiPrice("openai/gpt-5.6-sol")).toBe(20);
    expect(scApiPrice("openai/gpt-5.6-terra")).toBe(12);
    expect(scApiPrice("openai/gpt-5.6-luna")).toBe(1.2);
  });

  it("uses each arrival's REAL context window — circle area depends on it", () => {
    // FORK 2026-09-02: the `claude-opus-5-fast` line that led this list went with its
    // route and its SC_CTX_RULES override. The ordering it guarded — a specific 1M row
    // must beat the generic /claude/i 200k — is still guarded, by Fable 5.1 in the
    // Claude Fable 5.1 describe further down this file.
    expect(scDefaultCtx("openrouter/meituan/longcat-2.0")).toBe(1_048_756);
    expect(scDefaultCtx("openrouter/nvidia/nemotron-3.5-lightning")).toBe(262_144);
    expect(scDefaultCtx("openrouter/inclusionai/ling-3.0-flash")).toBe(262_144);
    // the generic /claude/i rule must still answer for everything else
    expect(scDefaultCtx("claude-code/claude-sonnet-5")).toBe(200_000);
  });

  it("plots the new arrivals without inventing a list price for them", () => {
    for (const id of [
      "openrouter/meituan/longcat-2.0",
      "openrouter/nvidia/nemotron-3.5-lightning",
      "openrouter/inclusionai/ling-3.0-flash",
    ]) {
      expect(scApiPrice(id)).toBeUndefined();
    }
  });
});

// ─── logo identity (the architect 2026-08-30: "openrouter bubbles have the wrong icon") ───
// The old fallback returned Anthropic's registered mark for ANY unknown provider, so
// 15 of 99 plotted models — NVIDIA, Meta, Tencent, MiniMax, Xiaomi, Meituan … —
// rendered as Claude. These tests exist because the defect was invisible in every
// string assertion: the SVG was well-formed, correctly placed, and wrong.
describe("smart-cost chart — no bubble wears the wrong vendor's mark", () => {
  const ANTHROPIC_MARK = "#D97757"; // the sparkle's fill, unique to that logo
  const dot = (id: string, provider: string) =>
    renderSmartCostChart([model({ id, provider, relCost: 1, index: 50, ctx: 262_144 })]);

  it("never paints the Claude sparkle on a non-Anthropic routed model", () => {
    for (const id of [
      "openrouter/nvidia/nemotron-3.5-lightning",
      "openrouter/meta/muse-spark-1.2",
      "openrouter/tencent/hy3",
      "openrouter/minimax/minimax-m3",
      "openrouter/xiaomi/mimo-v2.5-pro",
      "openrouter/meituan/longcat-2.0",
      "openrouter/inclusionai/ling-3.0-flash",
      "openrouter/upstage/solar-pro4",
      "openrouter/thinkingmachines/inkling",
      "openrouter/nex-agi/nex-n2-pro",
    ]) {
      expect(dot(id, "openrouter")).not.toContain(ANTHROPIC_MARK);
    }
  });

  it("reads the vendor out of the id's middle segment for routed models", () => {
    // the vendor is stated verbatim in the id and was simply never parsed
    expect(dot("openrouter/google/gemini-3.7-flash", "openrouter")).toContain("#4285f4");
    // FORK 2026-09-02: was `openrouter/openai/gpt-5.3-codex`, removed from the catalog
    // by the architect's ban on OpenRouter routes that duplicate a vendor we hold a
    // direct subscription with. The `openai` alias is keyed on the id's MIDDLE SEGMENT,
    // not on a model, so it is still live code that needs a guard — the id below is a
    // deliberate SYNTHETIC probe of the parser, not a catalog entry.
    expect(dot("openrouter/openai/some-future-route", "openrouter")).toContain("#10A37F");
    // …and a genuinely Anthropic model routed via OpenRouter still gets the sparkle
    // (Fable 5.1 — a live route — replaces the banned opus-5-fast twin here)
    expect(dot("openrouter/anthropic/claude-fable-5.1", "openrouter")).toContain(ANTHROPIC_MARK);
  });

  it("keeps the four vendor marks that resolve from the model id", () => {
    expect(dot("openrouter/moonshotai/kimi-k3", "openrouter")).toContain("#07B2FE");
    expect(dot("openrouter/z-ai/glm-5.3", "openrouter")).toContain("#80EE24");
    expect(dot("openrouter/deepseek/deepseek-v4-flash", "openrouter")).toContain("#4D6BFE");
    expect(dot("openrouter/qwen/qwen3.8-max", "openrouter")).toContain("#C382FB");
  });

  it("still gives first-party providers their own mark", () => {
    expect(dot("claude-code/claude-opus-5", "claude-code")).toContain(ANTHROPIC_MARK);
    expect(dot("openai/gpt-5.6-sol", "openai")).toContain("#10A37F");
    expect(dot("google/gemini-3.7-flash", "google")).toContain("#4285f4");
  });

  it("falls back to a NEUTRAL glyph, never to a brand, for an unknown vendor", () => {
    const out = dot("openrouter/acme/never-heard-of-it", "openrouter");
    expect(out).toContain("#b9ab97"); // the neutral routed mark
    expect(out).not.toContain(ANTHROPIC_MARK);
  });
});

// ─── cost rail (the architect 2026-08-30: "Fable appears only as one bubble, break it
//     down into different thinking efforts") ───
// AA scores Fable 5 at exactly ONE effort (max) against Anthropic's five-rung
// ladder — verified live 2026-08-30 15:09 UTC. So the rungs are real, the SCORES
// are not, and these tests pin that the chart shows the first without claiming
// the second. The census found 60 of 99 models in this state; Fable was a sample.
describe("smart-cost chart — vendor rungs AA never scored", () => {
  const fable = () => model({ id: "claude-fable-5", relCost: 0.4464, index: 62.0727 });

  it("plots ALL five Anthropic rungs for Fable, not just the one AA scored", () => {
    const pts = scPointsFor(fable());
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("marks exactly the AA-scored rung as measured, the rest as rail", () => {
    const pts = scPointsFor(fable());
    expect(pts.filter((p) => p.measured).map((p) => p.lvl)).toEqual(["max"]);
    expect(pts.find((p) => p.lvl === "max")!.smart).toBe(62.0727);
  });

  it("carries a flagged ESTIMATE on every unmeasured rung — never a bare headline copy", () => {
    const pts = scPointsFor(fable());
    for (const p of pts.filter((x) => !x.measured)) {
      expect(p.estimate, p.lvl).toBeDefined();
      expect(p.estimate!.basis.length).toBeGreaterThan(0);
      expect(p.smart).not.toBe(62.0727);
      expect(p.smart).toBeLessThanOrEqual(62.0727);
    }
    // the measured rung is untouched, and the ladder reads in effort order
    expect(pts.find((p) => p.lvl === "max")!.smart).toBe(62.0727);
    const ys = pts.map((p) => p.smart);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
  });

  it("spreads the rungs across COST on the documented burn multipliers", () => {
    const pts = scPointsFor(fable());
    expect(pts.find((p) => p.lvl === "low")!.cost).toBeCloseTo(0.4464 * 0.75);
    expect(pts.find((p) => p.lvl === "max")!.cost).toBeCloseTo(0.4464 * 3);
  });

  it("says in the note how many efforts AA actually scored", () => {
    const note = scEffortsFor(fable()).note;
    expect(note).toContain("AA scored 1 of 5 efforts");
    expect(note).toContain("ESTIMATED from other public benchmarks");
  });

  it("draws estimated rungs DOTTED with a dotted line, so they cannot pass as data", () => {
    const svg = renderSmartCostChart([fable()]);
    // 4 estimated rungs → 4 dotted rings (the ESTIMATE pattern, not the rail's dashes)
    const dotted = svg.match(/class="sc-ring"[^>]*stroke-dasharray="1\.2 1\.7"/g) ?? [];
    expect(dotted).toHaveLength(4);
    expect(svg).toContain("sc-line-est-cost");
    // every rung has a number we stand behind, so there is no cost rail left to draw
    expect(svg).not.toContain("sc-rail-cost");
  });

  it("keeps the dashed cost rail for a rung with neither a measurement nor an estimate", () => {
    // Copilot's Anthropic ladder exposes `minimal`, which no benchmark ran and no AA
    // ladder pair can shape — it must stay on the rail at the headline index.
    const m = model({
      id: "github-copilot/claude-opus-4.7",
      provider: "github-copilot",
      relCost: 1,
      index: 54.96,
    });
    const pts = scPointsFor(m);
    const minimal = pts.find((p) => p.lvl === "minimal")!;
    expect(minimal.measured).toBe(false);
    expect(minimal.estimate).toBeUndefined();
    expect(minimal.smart).toBe(54.96);
    const svg = renderSmartCostChart([m]);
    expect(svg).toContain("sc-rail-cost");
    expect(svg).toContain("headline — AA published no per-effort split");
  });

  it("leaves a FULLY scored model untouched — no rail, solid curve, real spread", () => {
    const opus = model({ id: "claude-opus-5", relCost: 0.2232, index: 63.0532 });
    const pts = scPointsFor(opus);
    expect(pts.every((p) => p.measured)).toBe(true);
    expect(new Set(pts.map((p) => p.smart)).size).toBe(5); // a real curve, not flat
    expect(renderSmartCostChart([opus])).not.toContain("sc-rail-cost");
  });

  it("keeps the tooltip honest about which rungs are measured", () => {
    const svg = renderSmartCostChart([fable()]);
    expect(svg).toContain("at Max (AA)");
    expect(svg).toContain("ESTIMATE");
    expect(svg).toContain("not an AA measurement");
  });
});

// ─── real vendor marks for the OpenRouter tail (2026-09-02) ───
// Finishes the item left open on 2026-08-30, when 12 models fell through to the
// neutral routed glyph because we shipped no art for their vendor. Each tint below
// is the fill of that vendor's official mark, so asserting it proves the right
// ARTWORK resolved, not merely that something non-Anthropic did.
describe("smart-cost chart — OpenRouter vendors get their own logo", () => {
  const ANTHROPIC_MARK = "#D97757";
  const NEUTRAL = "#b9ab97";
  const dot = (id: string) =>
    renderSmartCostChart([
      model({ id, provider: "openrouter", relCost: 1, index: 50, ctx: 262_144 }),
    ]);

  it("resolves each vendor to its real brand mark", () => {
    const want: [string, string][] = [
      ["openrouter/nvidia/nemotron-3.5-lightning", "#74B71B"],
      ["openrouter/meta/muse-spark-1.2", "#0082FB"],
      ["openrouter/meta/muse-spark-1.1", "#0082FB"],
      ["openrouter/minimax/minimax-m3", "#FF6B5A"],
      ["openrouter/upstage/solar-pro4", "#A88BFF"],
    ];
    for (const [id, tint] of want) {
      const out = dot(id);
      expect(out).toContain(tint);
      expect(out).not.toContain(NEUTRAL);
      expect(out).not.toContain(ANTHROPIC_MARK);
    }
  });

  it("uses the MODEL-FAMILY mark where the parent company is not the identity", () => {
    // Tencent the company also makes WeChat; the model family is Hunyuan.
    expect(dot("openrouter/tencent/hy3")).toContain("#00BCFF");
    // Xiaomi's model family is MiMo, and the package ships that mark specifically.
    expect(dot("openrouter/xiaomi/mimo-v2.5-pro")).toContain("#FF7A33");
    // Meituan's model is LongCat, which is the mark that exists.
    expect(dot("openrouter/meituan/longcat-2.0")).toContain("#29E154");
  });

  it("keeps the neutral glyph for vendors that genuinely ship no mark", () => {
    for (const id of [
      "openrouter/thinkingmachines/inkling",
      "openrouter/thinkingmachines/inkling-small",
      "openrouter/inclusionai/ling-3.0-flash",
      "openrouter/nex-agi/nex-n2-pro",
    ]) {
      const out = dot(id);
      expect(out).toContain(NEUTRAL);
      expect(out).not.toContain(ANTHROPIC_MARK);
    }
  });

  it("does not disturb the marks that already resolved", () => {
    expect(dot("openrouter/moonshotai/kimi-k3")).toContain("#07B2FE");
    expect(dot("openrouter/z-ai/glm-5.3")).toContain("#80EE24");
    expect(dot("openrouter/google/gemini-3.7-flash")).toContain("#4285f4");
    // FORK 2026-09-02: was `openrouter/anthropic/claude-opus-5-fast`; Fable 5.1 is the
    // live Anthropic OpenRouter route that now carries this assertion.
    expect(dot("openrouter/anthropic/claude-fable-5.1")).toContain(ANTHROPIC_MARK);
  });
});

// ─── Claude Fable 5.1, the new AA #1 (2026-09-02) ───
// The nightly job added the model, its price and its five AA effort scores, but two
// channels it does not own were wrong: the effort LADDER (a lookahead meant for
// `opus-4-70` also blocked every point release, so 5.1 fell to the minimal→high base
// and lost xhigh and max — its two best rungs) and the CONTEXT WINDOW (200k default
// against a real 1M, and circle area is proportional to it).
describe("smart-cost chart — Claude Fable 5.1", () => {
  const fable51 = () =>
    model({
      id: "openrouter/anthropic/claude-fable-5.1",
      provider: "openrouter",
      relCost: 50,
      index: 65.6529,
      ctx: scDefaultCtx("openrouter/anthropic/claude-fable-5.1"),
    });

  it("takes the 5-class ladder, so xhigh and max are not lost", () => {
    const pts = scPointsFor(fable51());
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(pts.map((p) => p.lvl)).not.toContain("minimal"); // not exposed for this class
  });

  it("carries AA's measurement at every rung — the only fully scored model besides Opus 5", () => {
    const pts = scPointsFor(fable51());
    expect(pts.every((p) => p.measured)).toBe(true);
    expect(pts.map((p) => p.smart)).toEqual([58.1487, 60.4752, 62.4807, 64.8016, 65.6529]);
  });

  it("tops the board: its max beats Opus 5's max", () => {
    const f = scPointsFor(fable51()).find((p) => p.lvl === "max")!.smart;
    const o = scPointsFor(model({ id: "claude-opus-5", relCost: 0.2232, index: 63.0532 })).find(
      (p) => p.lvl === "max",
    )!.smart;
    expect(f).toBeGreaterThan(o);
  });

  it("uses its real 1M context window, not the 200k Claude default", () => {
    expect(scDefaultCtx("openrouter/anthropic/claude-fable-5.1")).toBe(1_000_000);
    expect(scDefaultCtx("claude-code/claude-sonnet-5")).toBe(200_000); // default still stands
  });

  // The OpenRouter route was REMOVED from the panel and the chart catalog on
  // 2026-09-02 (the architect: "remove the erroneous openrouter Fable 5.1 model") — we hold
  // the model on the subscription. The PRICING RULE it exercised is still live and
  // still worth guarding, because it is what stops a metered route drawing a fake
  // discount: when a model's plotted cost already IS its list price, there is no
  // second mark and no dashed bridge.
  it("a metered route's circle IS list price, so it gets no triangle", () => {
    expect(scApiPrice("openrouter/anthropic/claude-fable-5.1")).toBe(50);
    expect(scApiPointsFor(fable51())).toEqual([]);
  });

  it("does not disturb Fable 5, which keeps its own ladder and single AA score", () => {
    const pts = scPointsFor(
      model({ id: "claude-code/claude-fable-5", relCost: 0.4464, index: 62.0727 }),
    );
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(pts.filter((p) => p.measured).map((p) => p.lvl)).toEqual(["max"]);
  });
});

// FORK 2026-09-02 (the architect: "the triangles need to go at its official price and the
// circles at the 20x price. The model points for different thinking efforts need
// different intelligence index and different cost, without hallucinating any value").
// Fable 5.1 shipped as an OpenRouter-only dot because the id was probed with AA's
// DOTTED display name; the real subscription id is hyphenated, and Claude Code serves
// it. This block locks the shape of the subscription route: five rungs, five DISTINCT
// AA-measured heights, five DISTINCT plan costs, and a triangle ladder at sticker.
describe("smart-cost chart — Claude Fable 5.1 on the Max 20x subscription", () => {
  const ID = "claude-code/claude-fable-5-1";
  // relCost comes from the SHIPPED table, never a literal — otherwise this fixture
  // keeps asserting a price the chart no longer draws, which is exactly what happened
  // when the Anthropic block was re-derived on 2026-09-02 and this file did not move.
  const PLAN = eegRelCost(ID);
  const sub = () =>
    model({
      id: ID,
      provider: "claude-code",
      relCost: PLAN,
      index: 65.6529,
      ctx: scDefaultCtx(ID),
    });

  it("plots the circles at the amortised plan price, far under sticker", () => {
    const pts = scPointsFor(sub());
    expect(pts.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Every rung a DIFFERENT cost — the effort multiplier applied to the plan price.
    const costs = pts.map((p) => Number(p.cost.toFixed(4)));
    expect(costs).toEqual([0.75, 1, 1.5, 2, 3].map((k) => Number((PLAN * k).toFixed(4))));
    expect(new Set(costs).size).toBe(5);
    expect(PLAN).toBeLessThan(1); // the plan price, not the $50 sticker
  });

  it("plots the triangles at the OFFICIAL API price, same effort ladder", () => {
    const tri = scApiPointsFor(sub());
    expect(scApiPrice(ID)).toBe(50);
    expect(tri.map((p) => p.lvl)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(tri.map((p) => Number(p.cost.toFixed(2)))).toEqual([37.5, 50, 75, 100, 150]);
  });

  it("every rung's Y is AA-measured — no rung hangs on the headline index", () => {
    const pts = scPointsFor(sub());
    expect(pts.every((p) => p.measured)).toBe(true);
    expect(pts.map((p) => p.smart)).toEqual([58.1487, 60.4752, 62.4807, 64.8016, 65.6529]);
    expect(new Set(pts.map((p) => p.smart)).size).toBe(5);
  });

  it("each triangle sits at the same Y as the circle of the same effort", () => {
    const pts = scPointsFor(sub());
    const tri = scApiPointsFor(sub());
    for (let i = 0; i < pts.length; i++) expect(tri[i].smart).toBe(pts[i].smart);
  });

  it("the circle↔triangle gap IS the subscription discount", () => {
    expect(scApiMultiple(sub())).toBeCloseTo(50 / PLAN, 6);
    expect(scApiMultiple(sub())!).toBeGreaterThan(100); // two orders of magnitude
  });

  it("keeps its real 1M window under the hyphenated id too", () => {
    expect(scDefaultCtx(ID)).toBe(1_000_000);
  });
});
