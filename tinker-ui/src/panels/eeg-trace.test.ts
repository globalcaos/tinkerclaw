import { describe, it, expect } from "vitest";
import {
  EEG_STOPS,
  EEG_PROVIDER_COLORS,
  EEG_COST_TABLE,
  EEG_EFFORT_MULT,
  eegProviderPaint,
  eegStrandShade,
  eegCostWidthPx,
  eegCostWidthLogPx,
  EEG_COST_LADDER_DOC,
  EEG_COST_LOG_LADDER_DOC,
  EEG_COST_LOG_BASE_PX,
  EEG_COST_LOG_PX_PER_DECADE,
  EEG_COST_LOG_PX_FLOOR,
  EEG_COST_LOG_REF_REL,
  eegStopX,
  eegToolIdentity,
  eegAssignLanes,
  eegMergeIntervals,
  EegTraceStore,
  type EegSample,
  type EegTurnEnd,
  EEG_COST_PX_FLOOR,
  EEG_COST_PX_PER_REL,
  eegRelCost,
  resolveEegPaint,
  resolveEegGlowColor,
  EEG_GOOGLE_GLOW,
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
// FORK 2026-06-26: x of the first eeg-main trunk segment = the effort COLUMN.
const mainX = (svg: string): number => {
  const m = /<path class="eeg-main"[^>]*\bd="M ([\d.]+)/.exec(svg);
  return m ? Number(m[1]) : -1;
};
const svgHeight = (svg: string): number => Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);

describe("segment length = euro cost (the architect 2026-06-20: §1 grid)", () => {
  // FORK 2026-08-11: these used claude-fable-5 vs claude-haiku-4-5. After the measured
  // recalibration a subscription turn is worth fractions of a cent, so BOTH clamp to
  // EEG_MIN_LEN (€0.178) and every length assertion compared 56 with 56. The renderer
  // property is unchanged and is now exercised on METERED models, where euros are real
  // cash. The subscription collapse is pinned by its own test at the end of this block.
  it("a costlier turn renders a longer (taller) segment", () => {
    // length = €; use a pricey model + many tokens to clear the ~€0.2 click floor.
    const big = new EegTraceStore();
    big.record(sample({ runId: "r1", model: "moonshotai/kimi-k3", outputTokens: 120000 }));
    const small = new EegTraceStore();
    small.record(sample({ runId: "r1", model: "z-ai/glm-5", outputTokens: 50 }));
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
    store.record(sample({ runId: "r1", model: "moonshotai/kimi-k3", outputTokens: 120000 }));
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('class="eeg-eurogrid"');
    expect(svg).toContain("€1");
  });

  it("euro length scales with the model's €/Mtok at equal tokens (kimi taller than glm)", () => {
    const kimi = new EegTraceStore();
    kimi.record(sample({ runId: "r1", model: "moonshotai/kimi-k3", outputTokens: 200000 }));
    const glm = new EegTraceStore();
    glm.record(sample({ runId: "r1", model: "z-ai/glm-5", outputTokens: 200000 }));
    expect(svgHeight(kimi.renderSvg({ width: WIDTH }))).toBeGreaterThan(
      svgHeight(glm.renderSvg({ width: WIDTH })),
    );
  });

  // FORK 2026-08-11: PINS the consequence of pricing the subscription honestly, so a
  // future reader meets it as a documented property instead of as a mystery. €264.08/mo
  // over the MEASURED trailing-30d burn makes one prepaid turn worth ~€0.05 — far under
  // the €0.178 minimum drawn length. The euro axis (EEG_PX_PER_EURO = 90px per €1) was
  // calibrated when the constants were 43× high; at true rates its natural pitch is
  // nearer €0.01. Until that is decided, subscription work draws as a flat mat and only
  // metered calls carry length. Do NOT "fix" this by re-inflating relCost.
  it("a prepaid turn clamps to the minimum length however many tokens it burns", () => {
    const small = new EegTraceStore();
    small.record(sample({ runId: "r1", model: "claude-opus-4-8", outputTokens: 1000 }));
    const huge = new EegTraceStore();
    huge.record(sample({ runId: "r1", model: "claude-opus-4-8", outputTokens: 200000 }));
    expect(svgHeight(huge.renderSvg({ width: WIDTH }))).toBe(
      svgHeight(small.renderSvg({ width: WIDTH })),
    );
    // …while the same token count on a metered model is visibly taller.
    const metered = new EegTraceStore();
    metered.record(sample({ runId: "r1", model: "moonshotai/kimi-k3", outputTokens: 200000 }));
    expect(svgHeight(metered.renderSvg({ width: WIDTH }))).toBeGreaterThan(
      svgHeight(huge.renderSvg({ width: WIDTH })),
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
  it("is floored (never capped) for every model x stop combination", () => {
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
        expect(w).toBeGreaterThanOrEqual(EEG_COST_PX_FLOOR);
        // FORK 2026-08-15: no upper bound to assert — the cap is gone on purpose.
      }
    }
  });

  // FORK 2026-08-12 (the architect: "I would like to keep the linear axis") — reverted from
  // the log axis shipped the same morning. Assert the LAW against the constants,
  // never magic pixels: this exact test rotted twice by hardcoding a scale.
  // FORK 2026-08-13: Luna stopped being the unit when the ÷4.65 blanket was removed —
  // its relCost re-based 0.258 → 0.0107 and it now floors, so asserting "Luna = 1.5px"
  // asserted a coincidence of the old basis. The LAW is what survives a reprice.
  it("is LINEAR in cost: width = relCost * pxPerRel", () => {
    // Models strictly between the floor and the cap, where the law is observable.
    for (const m of ["qwen/qwen3.8-max", "z-ai/glm-5", "claude-opus-4-8", "claude-fable-5"]) {
      expect(eegCostWidthPx(m, "medium")).toBeCloseTo(eegRelCost(m) * EEG_COST_PX_PER_REL, 2);
    }
    // Doubling the cost doubles the stroke — the property the linear axis exists for.
    const a = eegRelCost("claude-opus-4-8");
    const b = eegRelCost("claude-fable-5");
    expect(b / a).toBeCloseTo(2, 2); // fable $50 is exactly 2x opus $25 on sticker
    expect(eegCostWidthPx("claude-fable-5", "medium")).toBeCloseTo(
      2 * eegCostWidthPx("claude-opus-4-8", "medium"),
      2,
    );
  });

  // FORK 2026-08-13: the defect the architect caught — Fable ($50/Mtok, the dearest model we
  // can reach) was drawing 14.4x THINNER than Sol ($30), because Fable was on the
  // measured Anthropic basis and Sol on the invented ÷4.65 blanket. Every prepaid seat
  // now shares one basis, so sticker order must hold across vendors.
  // FORK 2026-08-30: the ORDER changed because a PRICE was corrected, not because
  // the invariant weakened. Sol was carrying OpenAI's LONG-context rate ($30) while
  // Terra and Luna carried the short one; on the standard short-context list Sol is
  // $20, which puts it BELOW Opus 5's $25 rather than above it. The property under
  // test is unchanged — prepaid seats rank by public sticker — and it is exactly
  // this test that caught the reordering, which is the whole reason it exists.
  it("ranks prepaid models across VENDORS by their public sticker price", () => {
    const fable = eegCostWidthPx("claude-fable-5", "medium"); // $50
    const opus = eegCostWidthPx("claude-opus-4-8", "medium"); // $25
    const sol = eegCostWidthPx("codex/gpt-5.6-sol", "medium"); // $20 short-ctx
    const terra = eegCostWidthPx("codex/gpt-5.6-terra", "medium"); // $12
    const sonnet = eegCostWidthPx("claude-sonnet-4-5", "medium"); // $10
    expect(fable).toBeGreaterThan(opus);
    expect(opus).toBeGreaterThan(sol);
    expect(sol).toBeGreaterThan(terra);
    expect(terra).toBeGreaterThan(sonnet);
    // …and the ratio is the sticker ratio, not merely the order.
    expect(fable / sol).toBeCloseTo(50 / 20, 1);
  });

  // FORK 2026-08-12: the PROPERTY linear buys, and the reason the architect kept it — the
  // drawn ratio equals the cost ratio. Under the log axis this was ~2.5×; here it is
  // the true ~30×. Guard it, because it is the only thing that makes the stroke
  // width quantitative rather than merely ordinal.
  it("draws cost RATIOS faithfully while both models are inside the clamps", () => {
    const opusPx = eegCostWidthPx("claude-opus-4-8", "medium");
    const qwenPx = eegCostWidthPx("qwen/qwen3.8-max", "medium");
    const costRatio = eegRelCost("qwen/qwen3.8-max") / eegRelCost("claude-opus-4-8");
    expect(qwenPx / opusPx).toBeCloseTo(costRatio, 1);
  });

  it("is monotonic in cost across the METERED ladder: kimi > qwen3.8 > glm", () => {
    expect(typeof EEG_EFFORT_MULT).toBe("object");
    const kimi = eegCostWidthPx("moonshotai/kimi-k3", "max");
    const qwen = eegCostWidthPx("qwen/qwen3.8-max", "medium");
    const glm = eegCostWidthPx("z-ai/glm-5", "minimal");
    expect(kimi).toBeGreaterThan(qwen);
    expect(qwen).toBeGreaterThan(glm);
  });

  // FORK 2026-08-16 (the architect: "double check that the EEG thickness of the models are
  // correct"). The ladder used to be a prose comment saying "do not hand-edit these,
  // print them" — and was itself a stale hand-edit, wrong on six of sixteen entries,
  // luna by 4.3× and gemini-3.5 by 4.6×. Documentation that restates a computed value
  // is a second source of truth; this test makes the first one enforce it.
  it("matches the documented stroke ladder exactly (no silent reprice drift)", () => {
    expect(EEG_COST_LADDER_DOC.length).toBeGreaterThan(15);
    const drift: string[] = [];
    for (const [model, expected] of EEG_COST_LADDER_DOC) {
      const actual = eegCostWidthPx(model, "medium");
      if (Math.abs(actual - expected) > 0.01) {
        drift.push(`${model}: documented ${expected}px, computed ${actual.toFixed(2)}px`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps the documented ladder sorted, so the doc reads as a ladder", () => {
    for (let i = 1; i < EEG_COST_LADDER_DOC.length; i++) {
      expect(EEG_COST_LADDER_DOC[i]![1]).toBeGreaterThanOrEqual(EEG_COST_LADDER_DOC[i - 1]![1]);
    }
  });

  // FORK 2026-08-11: the whole point of the recalibration. Before it, opus drew at
  // 10.2px against qwen3.8's 7.0 — the panel said the metered model was the CHEAPER
  // one, and a $146 bill followed. Prepaid tokens must never out-draw cash ones.
  // This is the load-bearing invariant of the entire column; keep it even if the
  // scale changes again.
  it("draws every prepaid Anthropic model thinner than any metered model", () => {
    const metered = eegCostWidthPx("qwen/qwen3.8-max", "medium");
    for (const m of [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(eegCostWidthPx(m, "max")).toBeLessThan(metered);
    }
  });

  // FORK 2026-08-12: PINS what the linear axis costs, so it is met as a documented
  // property and not re-filed as a bug. Fable→sonnet stay ordered; haiku falls off
  // the bottom and is indistinguishable from a local grep, and everything dearer
  // than gpt-5.6-sol saturates into one 40px slab. No linear map of a 1247:1 spread
  // into a 114:1 drawable range can avoid this — do NOT "fix" it by inflating the
  // constants, which is the defect that made the panel recommend a $146 model.
  // FORK 2026-08-13: this assertion has now been rewritten THREE times, each because a
  // reprice moved which model sits on the floor — €264.08→€200 pushed sonnet onto it,
  // the 75%-usage basis pulled sonnet back off (0.35 → 0.52px). Naming the clipped
  // model is naming a scale, which is exactly the rot this file keeps suffering. So
  // assert the LAW instead: width is non-increasing in cost, and two models may only
  // TIE if both are pinned to a clamp. That survives any future reprice.
  it("is monotonic in cost, with ties only where the clamps bite", () => {
    const ladder = [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ].map((m) => ({ m, rel: eegRelCost(m), px: eegCostWidthPx(m, "medium") }));
    // sanity: the fixture really is in descending cost order
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i - 1]!.rel).toBeGreaterThan(ladder[i]!.rel);
    }
    for (let i = 1; i < ladder.length; i++) {
      const hi = ladder[i - 1]!;
      const lo = ladder[i]!;
      expect(hi.px).toBeGreaterThanOrEqual(lo.px);
      if (hi.px === lo.px) {
        // FORK 2026-08-15: with the cap gone, the FLOOR is the only clamp that can
        // legitimately produce a tie. A tie anywhere else is a real defect.
        expect(hi.px).toBe(EEG_COST_PX_FLOOR);
      }
    }
    // Local housekeeping is never thicker than the cheapest real model.
    expect(eegCostWidthPx("tool:local", "", "tool")).toBe(EEG_COST_PX_FLOOR);
    expect(eegCostWidthPx("tool:local", "", "tool")).toBeLessThanOrEqual(ladder.at(-1)!.px);
  });

  // FORK 2026-08-15 (the architect: "do not cap pixel width — the thickness comparison is the
  // main objective"). The cap had turned six rows into one indistinguishable slab, so
  // a 3.3× price gap rendered as 0×. This guards the top of the range the way the
  // ratio test guards the middle: the dearest models must stay SEPARABLE and their
  // widths must stay PROPORTIONAL, however wide that gets.
  it("never clips the expensive end — ratios survive at any magnitude", () => {
    const kimi = eegCostWidthPx("moonshotai/kimi-k3", "medium"); // $15/Mtok, cash
    const qwen = eegCostWidthPx("qwen/qwen3.8-max", "medium"); // $6/Mtok, cash
    const fable = eegCostWidthPx("claude-fable-5", "medium"); // prepaid reference
    expect(kimi).toBeGreaterThan(qwen);
    // proportional, not merely ordered — the whole reason the axis is linear
    expect(kimi / qwen).toBeCloseTo(
      eegRelCost("moonshotai/kimi-k3") / eegRelCost("qwen/qwen3.8-max"),
      2,
    );
    expect(kimi / fable).toBeCloseTo(
      eegRelCost("moonshotai/kimi-k3") / eegRelCost("claude-fable-5"),
      2,
    );
    // and it is genuinely wide: kimi is ~33x fable and must draw that way.
    expect(kimi).toBeGreaterThan(80);
  });

  it("falls back to a default cost for unknown models (never NaN)", () => {
    const w = eegCostWidthPx("totally-unknown-model-xyz", "medium");
    expect(Number.isNaN(w)).toBe(false);
    // Bound by the CODE's clamps, not by literals — [0.5, 11] was a hardcoded range
    // from a scale two rescales old and went red again on the 2026-08-12 reprice.
    expect(w).toBeGreaterThanOrEqual(EEG_COST_PX_FLOOR);
    // An unknown model must read as "assume it costs real money", never as free.
    expect(w).toBeGreaterThan(eegCostWidthPx("claude-opus-4-8", "medium"));
  });
});

// FORK 2026-08-28 (the architect: "in the model selector, the big spenders are capped and the
// cheap ones are very thin. Turn those last ones only into log-scale thickness, which
// will be also used in turn by the EEG"). The linear scale above stays — it owns the
// MODELS panel, whose row height grows to the stroke. These tests own the LOG scale,
// which the model-selector chip and the EEG paper draw because both live in a fixed
// box: the chip is a 26px-tall SVG, and 26px was a SILENT cap under linear.
//
// FORK 2026-08-28 #2 — the chip box is NO LONGER a constant. the architect: "are the trace
// thickness in the model selector truncated in height? they should not be", and when
// told they were not, "it was truncated before and, if you did not change anything in
// this context, it still is". He was right: moving to log stopped the strokes
// EXCEEDING 26 but left the top of the range saturating it (six models filling the box
// as near-identical squares, each drawn 20px long and up to 21px thick). app.ts now
// derives the height from the widest stroke it will draw
// (`modelChipBoxHeight` = ceil(widest) + CHIP_PAD_PX, floored at 26), so the box can
// never cap the channel again. These constants MIRROR app.ts and are asserted below;
// they are a test-side copy on purpose, because app.ts is a browser entry that cannot
// be imported here — the assertion is that the derived box always clears the ladder.
const CHIP_PAD_PX = 10; // app.ts renderModelChip — background above+below the widest
const CHIP_MIN_BOX_PX = 26; // app.ts floor: a minimum, never a maximum
const CHIP_SANE_MAX_PX = 44; // the row is two chips tall; a runaway box would eat the panel
const chipBoxFor = (widest: number) => Math.max(Math.ceil(widest) + CHIP_PAD_PX, CHIP_MIN_BOX_PX);

describe("eegCostWidthLogPx — the bounded surfaces (the architect 2026-08-28)", () => {
  // THE reason the scale exists. Under linear, six models drew as the identical 26px
  // slab (clipped by the SVG box, not by any constant anyone could grep for) while the
  // whole prepaid block sat on the 0.35px floor. Flat at BOTH ends of the range.
  it("the derived chip box always clears the widest stroke — no stroke is ever cut", () => {
    expect(EEG_COST_TABLE.length).toBeGreaterThan(0);
    // EVERY row of the cost table, not a sample — the rows are matched by regex, so
    // apply the closed form to each row's relCost directly.
    const widths: number[] = [];
    for (const row of EEG_COST_TABLE) {
      const w =
        EEG_COST_LOG_BASE_PX +
        EEG_COST_LOG_PX_PER_DECADE * Math.log10(row.relCost / EEG_COST_LOG_REF_REL);
      expect(Number.isFinite(w)).toBe(true);
      widths.push(Math.max(EEG_COST_LOG_PX_FLOOR, w));
    }
    // The box is derived from the widest, so EVERY stroke clears it with real
    // background left over. This is the assertion the old "≤ 26" one should always
    // have been: a fixed number can be outgrown, a derived one cannot.
    const box = chipBoxFor(Math.max(...widths));
    for (const w of widths) {
      expect(w).toBeLessThan(box);
      expect(box - w).toBeGreaterThanOrEqual(CHIP_PAD_PX / 2);
    }
    // …and it stays a sane size: two rows of chips must not take over the panel.
    expect(box).toBeGreaterThanOrEqual(CHIP_MIN_BOX_PX);
    expect(box).toBeLessThanOrEqual(CHIP_SANE_MAX_PX);
    // …and through the real entry point for the documented ladder.
    for (const [model] of EEG_COST_LOG_LADDER_DOC) {
      const w = eegCostWidthLogPx(model, "medium");
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(EEG_COST_LOG_PX_FLOOR);
      expect(w).toBeLessThan(chipBoxFor(Math.max(...widths)));
    }
  });

  // The defining LAW, asserted against the constants rather than magic pixels — the
  // linear ladder rotted three times by hardcoding a scale.
  it("is LOG in cost: a 10x price step adds exactly one decade of pixels", () => {
    const a = eegCostWidthLogPx("claude-sonnet-5", "medium");
    const relA = eegRelCost("claude-sonnet-5");
    // synthesise a 10x model off the same table by comparing two REAL rows whose
    // ratio is known: fable is exactly 2x opus on sticker → log2 of a decade.
    const opus = eegCostWidthLogPx("claude-opus-4-8", "medium");
    const fable = eegCostWidthLogPx("claude-fable-5", "medium");
    expect(fable - opus).toBeCloseTo(EEG_COST_LOG_PX_PER_DECADE * Math.log10(2), 2);
    // and the closed form holds exactly for anything above the reference
    expect(a).toBeCloseTo(
      EEG_COST_LOG_BASE_PX + EEG_COST_LOG_PX_PER_DECADE * Math.log10(relA / EEG_COST_LOG_REF_REL),
      6,
    );
  });

  it("draws the reference model (luna) at the documented base width", () => {
    expect(eegRelCost("codex/gpt-5.6-luna")).toBeCloseTo(EEG_COST_LOG_REF_REL, 6);
    expect(eegCostWidthLogPx("codex/gpt-5.6-luna", "medium")).toBeCloseTo(EEG_COST_LOG_BASE_PX, 6);
  });

  // What log BUYS at the bottom, and the half of the architect's report the top-end fix
  // doesn't cover: under linear, fable/opus/sonnet/haiku were 2.6/1.3/0.52/0.35px —
  // haiku pinned to the floor and indistinguishable from a local grep. Under log they
  // are STRICTLY separated, no ties, no clamp doing the work.
  it("separates the cheap prepaid block that the linear floor collapsed", () => {
    const ladder = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"].map(
      (m) => ({ m, rel: eegRelCost(m), px: eegCostWidthLogPx(m, "medium") }),
    );
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i - 1]!.rel).toBeGreaterThan(ladder[i]!.rel);
      expect(ladder[i - 1]!.px).toBeGreaterThan(ladder[i]!.px); // STRICT — no floor ties
    }
    // every one of them is comfortably drawable, not a sub-pixel hairline
    for (const row of ladder) {
      expect(row.px).toBeGreaterThan(2);
    }
    // local housekeeping stays the thinnest thing on the paper, by construction
    expect(eegCostWidthLogPx("tool:local", "", "tool")).toBe(EEG_COST_LOG_PX_FLOOR);
    expect(eegCostWidthLogPx("tool:local", "", "tool")).toBeLessThan(ladder.at(-1)!.px);
  });

  // What log COSTS, pinned as a documented property so it is never re-filed as a bug:
  // the drawn ratio is no longer the cost ratio on these two surfaces. It is ORDER
  // that survives — and order must survive EXACTLY, or the two scales disagree about
  // which model is dearer and one of the surfaces is lying.
  it("preserves the LINEAR scale's ordering everywhere, magnitude nowhere", () => {
    const models = [
      "tool:local",
      "codex/gpt-5.6-luna",
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-fable-5",
      "qwen/qwen3.8-27b",
      "moonshotai/kimi-k3",
    ];
    const rows = models.map((m) => ({
      m,
      lin: eegCostWidthPx(m, "medium", m === "tool:local" ? "tool" : undefined),
      log: eegCostWidthLogPx(m, "medium", m === "tool:local" ? "tool" : undefined),
    }));
    for (let i = 1; i < rows.length; i++) {
      // linear may TIE at its floor where log separates; log must never invert linear
      expect(rows[i]!.lin).toBeGreaterThanOrEqual(rows[i - 1]!.lin);
      expect(rows[i]!.log).toBeGreaterThan(rows[i - 1]!.log);
    }
    // magnitude is explicitly NOT preserved — this is the trade, stated in code.
    // Restated 2026-08-29: the old `< 20` was a magic literal from the BASE=2.0 era.
    // Luna IS the reference, so the drawn ratio is 1 + (P/BASE)·log10(costRatio) by
    // CONSTRUCTION — 25.00 at the current constants — while the true cost ratio is
    // ~1402×. The pinned property: the drawn ratio stays far below the cost ratio.
    const kimi = "moonshotai/kimi-k3";
    const luna = "codex/gpt-5.6-luna";
    const costRatio = eegRelCost(kimi) / eegRelCost(luna);
    expect(costRatio).toBeGreaterThan(1000);
    const drawnRatio = eegCostWidthLogPx(kimi, "medium") / eegCostWidthLogPx(luna, "medium");
    expect(drawnRatio).toBeCloseTo(
      1 + (EEG_COST_LOG_PX_PER_DECADE / EEG_COST_LOG_BASE_PX) * Math.log10(costRatio),
      6,
    );
    expect(drawnRatio).toBeLessThan(costRatio / 10);
  });

  // The load-bearing invariant of the whole column, carried over from the linear
  // scale (2026-08-11: opus out-drew qwen3.8 and a $146 bill followed). A change of
  // AXIS must not change WHO IS DEARER — prepaid tokens never out-draw cash ones.
  it("still draws every prepaid Anthropic model thinner than any metered model", () => {
    const metered = eegCostWidthLogPx("qwen/qwen3.8-max", "medium");
    for (const m of [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(eegCostWidthLogPx(m, "max")).toBeLessThan(metered);
    }
  });

  it("effort does not scale the log width either (it is the X column)", () => {
    for (const m of ["claude-fable-5", "qwen/qwen3.8-max"]) {
      const widths = EEG_STOPS.map((s) => eegCostWidthLogPx(m, s.lvl));
      for (const w of widths) {
        expect(w).toBeCloseTo(widths[0]!, 6);
      }
    }
  });

  it("falls back to a default cost for unknown models (never NaN)", () => {
    const w = eegCostWidthLogPx("totally-unknown-model-xyz", "medium");
    expect(Number.isNaN(w)).toBe(false);
    expect(w).toBeGreaterThan(eegCostWidthLogPx("claude-opus-4-8", "medium"));
    expect(w).toBeLessThan(chipBoxFor(w));
  });

  // Same ritual as the linear ladder: the doc is a second source of truth, so the
  // first one enforces it. A reprice breaks the build instead of leaving a lying doc.
  it("matches the documented LOG ladder exactly (no silent reprice drift)", () => {
    expect(EEG_COST_LOG_LADDER_DOC.length).toBeGreaterThan(10);
    const drift: string[] = [];
    for (const [model, expected] of EEG_COST_LOG_LADDER_DOC) {
      const actual = eegCostWidthLogPx(
        model,
        "medium",
        model === "tool:local" ? "tool" : undefined,
      );
      if (Math.abs(actual - expected) > 0.01) {
        drift.push(`${model}: documented ${expected}px, computed ${actual.toFixed(2)}px`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps the documented LOG ladder sorted, so the doc reads as a ladder", () => {
    for (let i = 1; i < EEG_COST_LOG_LADDER_DOC.length; i++) {
      expect(EEG_COST_LOG_LADDER_DOC[i]![1]).toBeGreaterThanOrEqual(
        EEG_COST_LOG_LADDER_DOC[i - 1]![1],
      );
    }
  });
});

// The central point now carries BOTH scales, so a surface can never accidentally
// invent its own: renderCostCol reads .width, renderModelChip + the paper read
// .logWidth, and nothing computes a third.
describe("resolveEegPaint carries both scales (the architect 2026-08-28)", () => {
  it("exposes width (linear) and logWidth (log) from the same run descriptor", () => {
    const run = { model: "moonshotai/kimi-k3", provider: "openrouter" };
    const paint = resolveEegPaint(run);
    expect(paint.width).toBeCloseTo(eegCostWidthPx(run.model, "", run.provider), 6);
    expect(paint.logWidth).toBeCloseTo(eegCostWidthLogPx(run.model, "", run.provider), 6);
    // the expensive end is exactly where the two scales must diverge: linear blows
    // straight past any chip box (it is drawn on the panel, whose row grows), log
    // stays inside the box the selector derives for it.
    expect(paint.width).toBeGreaterThan(CHIP_SANE_MAX_PX);
    expect(paint.logWidth).toBeLessThan(chipBoxFor(paint.logWidth));
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

describe("branch never paints into the label row (the architect 2026-06-23: weird max↔high loop on the labels)", () => {
  const TOP_PAD = 26;
  const allBranchYs = (svg: string): number[] => {
    const ys: number[] = [];
    for (const m of svg.matchAll(/class="eeg-branch"[^>]*\bd="([^"]+)"/g)) {
      const nums = m[1].replace(/[MCL]/g, " ").trim().split(/\s+/).map(Number);
      nums.forEach((v, i) => {
        if (i % 2 === 1) ys.push(v); // odd index = y in the x,y stream
      });
    }
    return ys;
  };

  it("a near-top ENDED subagent (split close to the top) keeps every branch y >= TOP_PAD", () => {
    const store = new EegTraceStore();
    // a max main, a high subagent that ends, then nothing newer → the subagent's split sits
    // right under the top, the case that used to arc onto the labels.
    store.record(sample({ runId: "M1", chosenLevel: "max", startedAt: T0, endedAt: T0 + 1000 }));
    store.record(
      sample({
        runId: "SUB",
        subagent: true,
        parentRunId: "M1",
        chosenLevel: "high",
        startedAt: T0 + 1100,
        endedAt: T0 + 1300,
      }),
    );
    const svg = store.renderSvg({ width: 300 });
    const ys = allBranchYs(svg);
    expect(ys.length).toBeGreaterThan(0); // a branch IS drawn (not skipped into invisibility)
    for (const y of ys) expect(y).toBeGreaterThanOrEqual(TOP_PAD); // ...but never on the labels
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

describe("EEG concurrency = depth-shaded stack (bible §5.8h / §5.84, the architect 2026-06-14)", () => {
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

  it("draws one strand per concurrent subagent with the BOTTOM whitened, front pure brand (the architect 2026-07-20)", () => {
    const strokes = branchStrokes(concurrent(3));
    expect(strokes).toHaveLength(3);
    expect(strokes[2]).toBe(ANTHROPIC_STROKE); // front/top of the pile = full brand color
    expect(strokes[0]).not.toBe(ANTHROPIC_STROKE); // bottom = whitened
    expect(new Set(strokes).size).toBe(3); // each buried strand a distinct, whiter tint
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
    expect(ops[2]).toBeGreaterThan(ops[0]); // front solid, bottom of the pile faded (the architect 2026-07-20)
  });
});

describe("tool calls branch off the trunk (the architect 2026-06-25: scope C — see EVERY tool call, color+thickness over precise cost)", () => {
  it("eegToolIdentity maps a gemini-backed skill (nano-banana) to the google/rainbow identity", () => {
    const id = eegToolIdentity("Bash", "python3 scripts/generate_image.py --prompt 'a cat'");
    expect(id.provider).toBe("google");
    expect(eegProviderPaint(id.provider).isRainbow).toBe(true);
  });

  it("eegToolIdentity maps a codex/openai-backed call to the openai identity", () => {
    const id = eegToolIdentity("Bash", "codex exec --model gpt-5");
    expect(id.provider).toBe("openai");
    expect(eegProviderPaint(id.provider).stroke).toBe(EEG_PROVIDER_COLORS.openai);
  });

  it("eegToolIdentity maps plain housekeeping (grep/read/edit) to a neutral thin local identity", () => {
    const grep = eegToolIdentity("Bash", "grep -rn foo src/");
    const read = eegToolIdentity("Read", undefined);
    expect(grep.provider).toBe("tool");
    expect(read.provider).toBe("tool");
    // gray, non-rainbow, AND thin (≤1px) so housekeeping never out-shouts a provider call
    expect(eegProviderPaint(grep.provider).stroke).toBe(FALLBACK_GRAY);
    expect(eegProviderPaint(grep.provider).isRainbow).toBe(false);
    // Thinner than ONE Luna, and never below the floor. Passing the provider is
    // deliberate: it reproduces the real call (eegCostKey prefixes it) and would
    // have caught the "tool/tool:local" miss that made housekeeping default-thick.
    // On the linear axis haiku ALSO floors, so the claim is "never thicker than the
    // cheapest real model", not "strictly thinner" — the two are the same hairline.
    expect(eegCostWidthPx(grep.model, "", grep.provider)).toBeLessThanOrEqual(
      eegCostWidthPx("claude-haiku-4-5", "medium"),
    );
    expect(eegCostWidthPx(grep.model, "", grep.provider)).toBe(EEG_COST_PX_FLOOR);
  });

  it("a tool sample renders as a BRANCH (not the trunk) tagged data-eeg-tool", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "M1", chosenLevel: "high", startedAt: T0, endedAt: T0 + 4000 }));
    const id = eegToolIdentity("Bash", "generate_image.py");
    store.record(
      sample({
        runId: "TOOL1",
        subagent: false,
        tool: true,
        parentRunId: "M1",
        provider: id.provider,
        model: id.model,
        chosenLevel: "",
        label: "Bash: generate_image.py",
        startedAt: T0 + 500,
        endedAt: T0 + 1500,
      }),
    );
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('data-eeg-tool="1"'); // drawn as a tool branch
    expect(svg).toContain("url(#eeg-google)"); // …in the gemini rainbow
    // the tool must NOT be drawn as a trunk segment (eeg-main) — only the real LLM call is
    const mainCount = (svg.match(/class="eeg-main"/g) || []).length;
    expect(mainCount).toBe(1);
  });

  it("a housekeeping tool branch is thin + gray; a provider tool branch is thick + colored", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "M1", startedAt: T0, endedAt: T0 + 6000 }));
    const grepId = eegToolIdentity("Bash", "grep -rn x");
    const gemId = eegToolIdentity("Bash", "generate_image.py");
    store.record(
      sample({
        runId: "G",
        tool: true,
        subagent: false,
        parentRunId: "M1",
        provider: grepId.provider,
        model: grepId.model,
        chosenLevel: "",
        startedAt: T0 + 500,
        endedAt: T0 + 800,
      }),
    );
    store.record(
      sample({
        runId: "I",
        tool: true,
        subagent: false,
        parentRunId: "M1",
        provider: gemId.provider,
        model: gemId.model,
        chosenLevel: "",
        startedAt: T0 + 1000,
        endedAt: T0 + 3000,
      }),
    );
    const svg = store.renderSvg({ width: WIDTH });
    // each branch <path> emits stroke-width BEFORE data-eeg-tool, so match in that order
    const ws = [
      ...svg.matchAll(/class="eeg-branch"[^>]*stroke-width="([\d.]+)"[^>]*data-eeg-tool="1"/g),
    ].map((m) => Number(m[1]));
    expect(ws.length).toBe(2);
    expect(Math.max(...ws)).toBeGreaterThan(Math.min(...ws)); // gemini thicker than grep
    expect(svg).toContain("url(#eeg-google)"); // gemini colored
  });

  it("tool branches do NOT inflate the subagent ×N multiplicity gauge", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "M1", startedAt: T0, endedAt: T0 + 5000 }));
    // one real subagent + two overlapping tool calls at the same instant
    store.record(
      sample({
        runId: "SUB",
        subagent: true,
        parentRunId: "M1",
        startedAt: T0 + 100,
        endedAt: T0 + 4000,
      }),
    );
    store.record(
      sample({
        runId: "T1",
        tool: true,
        parentRunId: "M1",
        model: "tool:local",
        provider: "tool",
        chosenLevel: "",
        startedAt: T0 + 100,
        endedAt: T0 + 4000,
      }),
    );
    store.record(
      sample({
        runId: "T2",
        tool: true,
        parentRunId: "M1",
        model: "tool:local",
        provider: "tool",
        chosenLevel: "",
        startedAt: T0 + 100,
        endedAt: T0 + 4000,
      }),
    );
    const svg = store.renderSvg({ width: WIDTH });
    // 3 branches drawn (1 subagent + 2 tools), but the ×N gauge counts only the subagent → never ×2/×3
    expect((svg.match(/class="eeg-branch"/g) || []).length).toBe(3);
    expect(svg).not.toContain("×2");
    expect(svg).not.toContain("×3");
  });
});

describe("close-stale + prompt anchors + prompt-break (the architect 2026-06-19)", () => {
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

  it("draws the turn boundary as a YELLOW rule carrying data-eeg-prompt-text (the architect 2026-06-22)", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1" }));
    store.turnEnd({
      turn: 1,
      runId: "r1",
      endedAt: T0 + 2_000,
      promptIndex: 0,
      promptText: "make the lines yellow <ok>",
    });
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('class="eeg-marker"');
    expect(svg).toContain('stroke="#FFD23F"'); // yellow, not blue/gray
    expect(svg).toContain('data-eeg-prompt-text="make the lines yellow &lt;ok&gt;"');
  });

  it("draws the boundary even with NO samples (fresh-session first prompt — the no-line bug)", () => {
    const store = new EegTraceStore();
    // a turnEnd recorded at send time, before any model sample lands → n===0
    store.turnEnd({
      turn: 1,
      runId: "send-1",
      endedAt: T0 + 100,
      promptIndex: 0,
      promptText: "first prompt",
    });
    const svg = store.renderSvg({ width: WIDTH });
    expect(svg).toContain('class="eeg-marker"'); // marker drawn despite empty paper
    expect(svg).toContain('stroke="#FFD23F"');
    expect(svg).toContain('data-eeg-prompt-index="0"');
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

  it("a subagent branch never draws above the label row (no max↔high loop on the labels)", () => {
    // the architect 2026-06-23: a high subagent splitting off a max trunk near the TOP used to arc
    // above TOP_PAD into the column labels and loop max→high→max. Every branch y must clamp.
    const store = new EegTraceStore();
    store.record(
      sample({
        runId: "M1",
        model: "claude-opus-4-8",
        chosenLevel: "max",
        startedAt: T0,
        endedAt: T0 + 1000,
      }),
    );
    store.record(
      sample({
        runId: "SUB",
        subagent: true,
        parentRunId: "M1",
        model: "claude-sonnet-4-6",
        chosenLevel: "high",
        startedAt: T0 + 1100,
        endedAt: T0 + 1300,
      }),
    );
    store.record(
      sample({ runId: "M2", model: "claude-opus-4-8", chosenLevel: "max", startedAt: T0 + 1500 }),
    );
    const svg = store.renderSvg({ width: 300 });
    const TOP_PAD = 26;
    let minBranchY = Infinity;
    for (const m of svg.matchAll(/class="eeg-branch"[^>]*\bd="([^"]+)"/g)) {
      const nums = [...m[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => Number(x[0]));
      for (let i = 1; i < nums.length; i += 2) minBranchY = Math.min(minBranchY, nums[i]);
    }
    // either no branch drawn (skipped for lack of room) or every y stays at/below the labels
    if (minBranchY !== Infinity) expect(minBranchY).toBeGreaterThanOrEqual(TOP_PAD);
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

describe("whitening only on REAL overlap + per-model lanes (the architect 2026-06-25)", () => {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  // {stroke, col} per branch — col is the strand's vertical-run x (1st cubic ctrl x)
  const branches = (svg: string): { stroke: string; col: number; run: string }[] =>
    [
      ...svg.matchAll(
        /<path class="eeg-branch" d="M [\d.]+ [\d.]+ C [\d.]+ [\d.]+ ([\d.]+) [\d.]+[^"]*" fill="none" stroke="([^"]+)"[^>]*data-eeg-run="([^"]+)"/g,
      ),
    ].map((m) => ({ col: Number(m[1]), stroke: m[2], run: m[3] }));

  it("SEQUENTIAL same-group strands never whiten (they don't run in parallel)", () => {
    const store = new EegTraceStore();
    for (let i = 0; i < 3; i++)
      store.record(
        sample({
          runId: `seq${i}`,
          tool: true,
          model: "tool:local",
          provider: "",
          chosenLevel: "",
          startedAt: T0 + i * 100,
          endedAt: T0 + i * 100 + 50, // each ends before the next starts → no overlap
        }),
      );
    const b = branches(store.renderSvg({ width: WIDTH }));
    expect(b.length).toBe(3);
    expect(b.every((x) => x.stroke === FALLBACK_GRAY)).toBe(true); // all base, zero whitening
  });

  it("OVERLAPPING same-group strands still grade toward white", () => {
    const store = new EegTraceStore();
    for (let i = 0; i < 3; i++)
      store.record(
        sample({
          runId: `ov${i}`,
          tool: true,
          model: "tool:local",
          provider: "",
          chosenLevel: "",
          startedAt: T0 + i,
          endedAt: T0 + 500, // all overlap → one cluster
        }),
      );
    const b = branches(store.renderSvg({ width: WIDTH }));
    expect(b.some((x) => lum(x.stroke) >= 195)).toBe(true); // front strand near-white
    expect(b.some((x) => x.stroke === FALLBACK_GRAY)).toBe(true); // back strand base
  });

  it("different models at the SAME effort stand side by side (distinct lanes), no cross-whitening", () => {
    const store = new EegTraceStore();
    store.record(
      sample({
        runId: "opus",
        subagent: true,
        model: "claude-opus-4-8",
        provider: "claude-code",
        chosenLevel: "low",
        startedAt: T0,
        endedAt: T0 + 500,
      }),
    );
    store.record(
      sample({
        runId: "sonnet",
        subagent: true,
        model: "claude-sonnet-4-6",
        provider: "claude-code",
        chosenLevel: "low",
        startedAt: T0 + 1,
        endedAt: T0 + 500,
      }),
    );
    const b = branches(store.renderSvg({ width: WIDTH }));
    const opus = b.find((x) => x.run === "opus")!;
    const sonnet = b.find((x) => x.run === "sonnet")!;
    expect(opus.col).not.toBe(sonnet.col); // side by side, not stacked
    // each keeps its brand color (no overlap WITHIN a single-model group → no lift)
    expect(opus.stroke).toBe(ANTHROPIC_STROKE);
    expect(sonnet.stroke).toBe(ANTHROPIC_STROKE);
  });
});

// FORK 2026-07-28 (the architect "lines dancing laterally within Min"): a lane index must be
// EARNED by real temporal overlap. The old allocator gave every distinct group a
// permanent lane numbered per RAW chosenLevel, so it spread strands that were merely
// sequential and collided strands that were genuinely parallel — inverted on both axes.
describe("lane offsets encode REAL concurrency (the architect 2026-07-28)", () => {
  const branchCols = (svg: string): { run: string; col: number }[] =>
    [
      ...svg.matchAll(
        /<path class="eeg-branch" d="M [\d.]+ [\d.]+ C [\d.]+ [\d.]+ ([\d.]+) [\d.]+[^"]*"[^>]*data-eeg-run="([^"]+)"/g,
      ),
    ].map((m) => ({ run: m[2], col: Number(m[1]) }));

  it("SEQUENTIAL groups in one column share lane 0 — no lateral dance at concurrency 1", () => {
    const store = new EegTraceStore();
    // every tool call is recorded chosenLevel:"" → all land in the Min column
    const ids = [
      { runId: "grep", model: "tool:local", provider: "tool:local" },
      { runId: "nano", model: "gemini-image", provider: "google" },
      { runId: "read", model: "tool:local", provider: "tool:local" },
      { runId: "codex", model: "gpt-codex", provider: "openai" },
    ];
    ids.forEach((s, i) =>
      store.record(
        sample({
          ...s,
          tool: true,
          chosenLevel: "",
          startedAt: T0 + i * 1000,
          endedAt: T0 + i * 1000 + 500,
        }),
      ),
    );
    const cols = branchCols(store.renderSvg({ width: WIDTH }));
    expect(cols.length).toBe(4);
    // all four sit on the SAME x — the Min column, unshifted
    expect(new Set(cols.map((c) => c.col)).size).toBe(1);
    // the SVG rounds coords to 2dp (fx), so compare at that resolution
    expect(cols[0].col).toBeCloseTo(eegStopX("minimal", WIDTH), 1);
  });

  it("CONCURRENT groups that all fold into Min get distinct side-by-side lanes", () => {
    const store = new EegTraceStore();
    // ""/"off"/"auto" all fold to the Min column via eegEffectiveLevel — the old
    // allocator numbered them in separate RAW buckets, so all three drew at lane 0.
    store.record(
      sample({
        runId: "tool",
        tool: true,
        model: "tool:local",
        provider: "tool:local",
        chosenLevel: "",
        startedAt: T0,
        endedAt: T0 + 500,
      }),
    );
    store.record(
      sample({
        runId: "haiku",
        subagent: true,
        model: "claude-haiku-4-5",
        provider: "claude-code",
        chosenLevel: "minimal",
        startedAt: T0 + 1,
        endedAt: T0 + 500,
      }),
    );
    store.record(
      sample({
        runId: "off",
        subagent: true,
        model: "claude-sonnet-4-6",
        provider: "claude-code",
        chosenLevel: "off",
        startedAt: T0 + 2,
        endedAt: T0 + 500,
      }),
    );
    const cols = branchCols(store.renderSvg({ width: WIDTH }));
    expect(new Set(cols.map((c) => c.col)).size).toBe(3); // three lanes, no collision
  });

  it("a lane is REUSED once its occupant finished (lane index means 'parallel here')", () => {
    const store = new EegTraceStore();
    store.record(
      sample({
        runId: "a",
        subagent: true,
        model: "m-a",
        provider: "claude-code",
        chosenLevel: "medium",
        startedAt: T0,
        endedAt: T0 + 100,
      }),
    );
    store.record(
      sample({
        runId: "b",
        subagent: true,
        model: "m-b",
        provider: "claude-code",
        chosenLevel: "medium",
        startedAt: T0 + 200,
        endedAt: T0 + 300,
      }),
    );
    const cols = branchCols(store.renderSvg({ width: WIDTH }));
    expect(new Set(cols.map((c) => c.col)).size).toBe(1); // b reuses a's lane
  });

  it("eegAssignLanes: overlap → distinct lanes; disjoint → shared lane 0", () => {
    const overlapping = eegAssignLanes([
      { key: "x", level: "minimal", intervals: [[0, 10]] },
      { key: "y", level: "minimal", intervals: [[5, 15]] },
    ]);
    expect(new Set(overlapping.values()).size).toBe(2);

    const disjoint = eegAssignLanes([
      { key: "x", level: "minimal", intervals: [[0, 10]] },
      { key: "y", level: "minimal", intervals: [[20, 30]] },
    ]);
    expect([...disjoint.values()]).toEqual([0, 0]);

    // a STILL-RUNNING group (end = Infinity) genuinely overlaps everything after it
    const live = eegAssignLanes([
      { key: "live", level: "minimal", intervals: [[0, Infinity]] },
      { key: "later", level: "minimal", intervals: [[50, 60]] },
    ]);
    expect(live.get("later")).toBe(1);

    // different effort columns never share a lane namespace
    const crossColumn = eegAssignLanes([
      { key: "x", level: "minimal", intervals: [[0, 10]] },
      { key: "y", level: "max", intervals: [[0, 10]] },
    ]);
    expect([...crossColumn.values()]).toEqual([0, 0]);
  });

  it("eegMergeIntervals folds overlapping and touching runs", () => {
    expect(
      eegMergeIntervals([
        [10, 20],
        [0, 5],
        [4, 12],
      ]),
    ).toEqual([[0, 20]]);
    expect(
      eegMergeIntervals([
        [0, 5],
        [10, 20],
      ]),
    ).toEqual([
      [0, 5],
      [10, 20],
    ]);
  });
});

describe("eegEffectiveLevel — graphs the REQUESTED level, never char-bucketed (2026-06-26)", () => {
  it("chosenLevel='medium' lands at the medium column regardless of thinkingChars", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1", chosenLevel: "medium", thinkingChars: 0 }));
    expect(mainX(store.renderSvg({ width: WIDTH }))).toBeCloseTo(eegStopX("medium", WIDTH), 0);
  });

  it("chosenLevel='high' wins even when thinkingChars would have bucketed to 'low'", () => {
    const store = new EegTraceStore();
    store.record(sample({ runId: "r1", chosenLevel: "high", thinkingChars: 500 }));
    const x = mainX(store.renderSvg({ width: WIDTH }));
    expect(x).toBeCloseTo(eegStopX("high", WIDTH), 0);
    expect(x).not.toBeCloseTo(eegStopX("low", WIDTH), 0);
  });

  it("empty/off level floors to 'minimal', NOT the Auto gutter, ignoring thinkingChars", () => {
    const off = new EegTraceStore();
    off.record(sample({ runId: "r1", chosenLevel: "", thinkingChars: 8000 }));
    const x = mainX(off.renderSvg({ width: WIDTH }));
    expect(x).toBeCloseTo(eegStopX("minimal", WIDTH), 0);
    expect(x).not.toBeCloseTo(eegStopX("", WIDTH), 0); // not the Auto column (idx 0)
    expect(x).not.toBeCloseTo(eegStopX("high", WIDTH), 0); // not char-bucketed
  });
});

describe("eegStrandShade — overlap pile whitens the BOTTOM (the architect 2026-07-20)", () => {
  const brand = { stroke: "#E8702A", isRainbow: false };

  it("bottom of a 3-stack (idx 0) is the whitest, front (idx 2) keeps pure brand color", () => {
    const bottom = eegStrandShade(brand, 0, 3);
    const front = eegStrandShade(brand, 2, 3);
    expect(front.stroke).toBe("#E8702A");
    expect(bottom.stroke).not.toBe("#E8702A");
    // whiter = higher RGB channel values than the pure brand color
    const chan = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(chan(bottom.stroke)).toBeGreaterThan(chan(front.stroke));
  });

  it("a solo strand (n=1) gets the pure brand color — no whitening of lone tracks", () => {
    expect(eegStrandShade(brand, 0, 1).stroke).toBe("#E8702A");
  });

  it("rainbow (untintable) fades the bottom by opacity instead: bottom faintest, front solid", () => {
    const rainbow = { stroke: "url(#g)", isRainbow: true };
    expect(eegStrandShade(rainbow, 0, 3).opacity).toBeLessThan(
      eegStrandShade(rainbow, 2, 3).opacity,
    );
    expect(eegStrandShade(rainbow, 2, 3).opacity).toBe(1);
  });
});

// FORK 2026-08-06 (the architect: central paint resolution). resolveEegPaint is THE
// entry point every surface uses; these tests lock the OpenRouter vendor paints
// to the VALUES MEASURED IN OSCAR'S LIVE EEG SNAPSHOT that day (qwen #C382FB
// w=6.98, kimi #07B2FE w=17.44) — i.e. they assert the design, not the code.
// Before 2026-08-04 these runs painted gray + default width, because the vendor
// branch was unreachable (callers passed only the provider string "openrouter").
describe("resolveEegPaint — the central point (the architect 2026-08-06)", () => {
  it("openrouter vendor runs resolve by MODEL id: color + cost width", () => {
    const qwen = resolveEegPaint({ model: "qwen/qwen3.8-max", provider: "openrouter" });
    expect(qwen.stroke).toBe("#C382FB");
    expect(qwen.width).toBeCloseTo(eegCostWidthPx("qwen/qwen3.8-max", "medium"), 6);

    const kimi = resolveEegPaint({ model: "moonshotai/kimi-k3", provider: "openrouter" });
    expect(kimi.stroke).toBe("#07B2FE");
    expect(kimi.width).toBeCloseTo(eegCostWidthPx("moonshotai/kimi-k3", "medium"), 6);

    const glm = resolveEegPaint({ model: "z-ai/glm-5.2", provider: "openrouter" });
    expect(glm.stroke).toBe("#80EE24");

    // FORK 2026-08-12: deepseek no longer floors. On the log axis $0.144/Mtok is a
    // real, drawable price — it is the CHEAPEST metered model, not a free one, and
    // the panel now says so instead of hiding it in the hairline with local greps.
    const dseek = resolveEegPaint({ model: "deepseek/deepseek-v4-flash", provider: "openrouter" });
    expect(dseek.stroke).toBe("#4D6BFE");
    expect(dseek.width).toBeGreaterThan(EEG_COST_PX_FLOOR);
    expect(dseek.width).toBeLessThan(eegCostWidthPx("qwen/qwen3.8-max", "medium"));
  });

  it("full config refs and aliases resolve the same as bare segments", () => {
    const bare = resolveEegPaint({ model: "qwen/qwen3.8-max", provider: "openrouter" });
    const full = resolveEegPaint({ model: "openrouter/qwen/qwen3.8-max", provider: "openrouter" });
    expect(full).toEqual(bare);
  });

  it("an unrecognized openrouter model falls back to gray + default, never throws", () => {
    const unk = resolveEegPaint({ model: "acme/mystery-9b", provider: "openrouter" });
    expect(unk.stroke).toBe("#8A8F98");
    expect(unk.width).toBeGreaterThan(EEG_COST_PX_FLOOR);
  });

  it("effort travels with the run but does not scale width (it is the X column)", () => {
    const lo = resolveEegPaint({
      model: "qwen/qwen3.8-max",
      provider: "openrouter",
      effort: "low",
    });
    const mx = resolveEegPaint({
      model: "qwen/qwen3.8-max",
      provider: "openrouter",
      effort: "max",
    });
    expect(lo.width).toBe(mx.width);
  });

  it("the PAPER renders an openrouter qwen trunk in its vendor paint end-to-end", () => {
    const store = new EegTraceStore();
    store.record(
      sample({
        runId: "qwen-run",
        model: "qwen/qwen3.8-max",
        provider: "openrouter",
        chosenLevel: "",
        outputTokens: 4000,
      }),
    );
    const svg = store.renderSvg({ width: WIDTH });
    const trunk = /<path class="eeg-main"[^>]*>/.exec(svg)?.[0] ?? "";
    expect(trunk).toContain('stroke="#C382FB"');
    // Derived, never a magic pixel — this exact assertion has rotted twice before.
    // FORK 2026-08-28: the PAPER draws the LOG scale now (the MODELS panel keeps
    // linear), so this asserts eegCostWidthLogPx. Asserting the linear width here
    // would silently re-couple the paper to the panel's scale.
    const qwenPx = String(Number(eegCostWidthLogPx("qwen/qwen3.8-max", "medium").toFixed(2)));
    expect(trunk).toContain(`stroke-width="${qwenPx}"`);
    // and it now FITS: linear put this trunk at 34.9px on a paper it shares with
    // effort columns, lanes and strand stacks.
    expect(eegCostWidthLogPx("qwen/qwen3.8-max", "medium")).toBeLessThan(
      eegCostWidthPx("qwen/qwen3.8-max", "medium"),
    );
    expect(trunk).toContain('stroke-linecap="butt"');
  });
});

// FORK 2026-08-06 #2 (the architect: unify the thinking-indicator glows on the EEG
// trace color). resolveEegGlowColor is the ONE source for chat indicator, tab
// glow, model-row glow, session-row glow and RECIPES node glow.
describe("resolveEegGlowColor — glows wear the EEG trace color", () => {
  it("openrouter vendors glow in their trace color", () => {
    expect(resolveEegGlowColor({ model: "qwen/qwen3.8-max", provider: "openrouter" })).toBe(
      "#C382FB",
    );
    expect(resolveEegGlowColor({ model: "moonshotai/kimi-k3", provider: "openrouter" })).toBe(
      "#07B2FE",
    );
    expect(resolveEegGlowColor({ model: "z-ai/glm-5.2", provider: "openrouter" })).toBe("#80EE24");
  });

  it("native providers glow in the EEG palette, not a second provider map", () => {
    expect(resolveEegGlowColor({ model: "claude-opus-5", provider: "claude-code" })).toBe(
      "#E8702A",
    );
    expect(resolveEegGlowColor({ model: "gpt-5.6-sol", provider: "codex" })).toBe("#10A37F");
  });

  it("rainbow (google) has no CSS gradient — falls back to a solid brand blue", () => {
    const glow = resolveEegGlowColor({ model: "gemini-3-pro", provider: "google" });
    expect(glow).toBe(EEG_GOOGLE_GLOW);
    expect(glow).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("an unknown run still returns a usable hex (never a gradient ref)", () => {
    const glow = resolveEegGlowColor({ model: "", provider: "" });
    expect(glow).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

// FORK 2026-08-17 (the architect: "nor the parallelism done, which should show a few EEG traces side
// by side"). The ×N gauge is the only non-hover affordance that reports how many strands ran
// at once. It used to emit a label at every change in concurrency, coalescing only events at
// the SAME INSTANT — so a real fan-out (ten legs spawned inside two minutes, on a paper that
// spans days) stacked ten 9px labels inside ~3px of gutter and read as a smudge.
describe("×N concurrency gauge — legible rows, peak preserved (2026-08-17)", () => {
  const xnLabels = (svg: string): Array<{ y: number; n: number }> =>
    [...svg.matchAll(/<text class="eeg-xn" x="3" y="([\d.]+)"[^>]*>×(\d+)<\/text>/g)].map((m) => ({
      y: Number(m[1]),
      n: Number(m[2]),
    }));

  /** ten subagents spawning 12s apart, each running 20 min, inside a multi-day paper */
  const fanOut = (): EegTraceStore => {
    const store = new EegTraceStore();
    const samples: EegSample[] = [
      sample({ runId: "old", startedAt: T0, endedAt: T0 + 60_000 }),
      sample({
        runId: "recent",
        startedAt: T0 + 3 * 86_400_000,
        endedAt: T0 + 3 * 86_400_000 + 1000,
      }),
    ];
    const spawn = T0 + 2 * 86_400_000;
    for (let i = 0; i < 10; i++) {
      samples.push(
        sample({
          runId: `leg-${i}`,
          subagent: true,
          startedAt: spawn + i * 12_000,
          endedAt: spawn + 20 * 60_000 + i * 12_000,
        }),
      );
    }
    store.backfill(samples, []);
    return store;
  };

  it("never draws two ×N labels on top of each other", () => {
    const labels = xnLabels(fanOut().renderSvg({ width: WIDTH }));
    expect(labels.length).toBeGreaterThan(0);
    const ys = labels.map((l) => l.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(Math.abs(ys[i] - ys[i - 1])).toBeGreaterThanOrEqual(10);
    }
  });

  it("still reports the PEAK concurrency — collapsing rows must never understate the fan-out", () => {
    const labels = xnLabels(fanOut().renderSvg({ width: WIDTH }));
    expect(Math.max(...labels.map((l) => l.n))).toBe(10);
  });

  it("a genuinely sequential pair still gets its own gauge rows, not one merged label", () => {
    const store = new EegTraceStore();
    const day = 86_400_000;
    const samples: EegSample[] = [sample({ runId: "trunk", startedAt: T0, endedAt: T0 + 1000 })];
    // two separate 2-deep fan-outs, a day apart — far enough to deserve two labels
    for (const [k, base] of [
      [0, T0 + day],
      [1, T0 + 2 * day],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        samples.push(
          sample({
            runId: `p${k}-${i}`,
            subagent: true,
            startedAt: base + i * 1000,
            endedAt: base + 300_000,
          }),
        );
      }
    }
    store.backfill(samples, []);
    expect(xnLabels(store.renderSvg({ width: WIDTH })).length).toBeGreaterThanOrEqual(2);
  });
});
