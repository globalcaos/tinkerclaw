import { describe, it, expect } from "vitest";
import { renderSmartCostChart, type ScModel } from "./smart-cost-chart";

/**
 * ONE MODEL, ONE MARK SIZE.
 *
 * the architect 2026-08-30: "Revise the circle sizes, opus 5 seems to have different
 * sizes in the same model, impossible, must be a bug." It was. Both emission
 * sites multiplied scRadius by `(anchor ? 1 : 0.82)`, so a model is plotted once
 * per EFFORT STOP — Opus 5 has five — and only the anchor drew full size. One
 * model with ONE context window therefore rendered at TWO radii, and size
 * encoded context window AND anchor-ness at once.
 *
 * These specs live apart from smart-cost-chart.test.ts (the same split as
 * routing-rationale / routing-rationale-bias-lock) because they guard ONE
 * invariant and they guard it at the EMISSION SITE. That distinction is the
 * whole point: scRadius was never wrong, and a unit test on scRadius passes
 * happily while the renderer scales its result on the way out. Every assertion
 * below therefore reads the rendered SVG.
 *
 * CONTROL — measured, not asserted. Reverting ONLY smart-cost-chart.ts to
 * b3de8b7564b and re-running this file: 4 failed | 2 passed.
 *   · same radius   → "expected 2 to be 1" (the radius Set was { 12, 9.84 })
 *   · same triangle → "expected 2 to be 1"
 *   · anchor channel (both) → "expected [ …(5) ] to have a length of 1 but got 5"
 *     — at HEAD all five rings shared one stroke-opacity, because the anchor was
 *     saying itself in the size instead.
 * The label-clearance spec passes at HEAD: there the ring and the gap were BOTH
 * shrunk by 0.82, so the air came out right by cancellation. Its own control is
 * the fix with only that line left at `* 0.82 + 5`, which fails with
 * "expected 2.84 to be greater than 4.9" — 2.84px of air at R_MAX.
 */

const model = (over: Partial<ScModel> & { id: string }): ScModel => ({
  name: over.id.split("/").pop() ?? over.id,
  provider: "claude-code",
  index: 55,
  relCost: 5,
  ctx: 1_000_000,
  color: "#E8702A",
  ...over,
});

/** Opus 5: five AA-scored effort stops, and a list price ($25) far enough from
 *  this plan's €2 that it also gets the API triangle row. One fixture, both
 *  emission sites. */
const opus5 = model({ id: "claude-opus-5", name: "Opus 5", relCost: 2, index: 63.05 });

type Mark = { model: string; r: number; strokeOpacity: number };

/** Circles, keyed by the model whose <g class="sc-dotpos"> wraps them. */
function rings(svg: string): Mark[] {
  const re =
    /<g class="sc-dotpos"[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?<circle class="sc-ring" r="([\d.]+)"[^>]*stroke-opacity="([\d.]+)"/g;
  const out: Mark[] = [];
  for (const m of svg.matchAll(re)) {
    out.push({ model: m[1], r: Number(m[2]), strokeOpacity: Number(m[3]) });
  }
  return out;
}

/** API triangles. `points` is emitted in the group's own coordinates, so two
 *  stops of one model are the same triangle iff the string is identical. */
function triangles(svg: string): { model: string; points: string; strokeOpacity: number }[] {
  const re =
    /<g class="sc-apipos"[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?<polygon class="sc-tri" points="([^"]+)"[^>]*stroke-opacity="([\d.]+)"/g;
  const out: { model: string; points: string; strokeOpacity: number }[] = [];
  for (const m of svg.matchAll(re)) {
    out.push({ model: m[1], points: m[2], strokeOpacity: Number(m[3]) });
  }
  return out;
}

/** The --sc-gap CSS var the label rides out on, per model. */
function labelGaps(svg: string): Map<string, number> {
  const re = /<g class="sc-labelpos"[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?--sc-gap:([\d.]+)px/g;
  const out = new Map<string, number>();
  for (const m of svg.matchAll(re)) out.set(m[1], Number(m[2]));
  return out;
}

describe("smart-cost chart — one model, one mark size", () => {
  it("draws every effort stop of a model at the SAME radius", () => {
    const marks = rings(renderSmartCostChart([opus5]));
    // five effort rungs, one context window
    expect(marks).toHaveLength(5);
    expect(marks.every((m) => m.model === "claude-opus-5")).toBe(true);
    expect(new Set(marks.map((m) => m.r)).size).toBe(1);
  });

  it("draws every API triangle of a model at the same size too", () => {
    const tris = triangles(renderSmartCostChart([opus5]));
    expect(tris).toHaveLength(5);
    expect(new Set(tris.map((t) => t.points)).size).toBe(1);
  });

  it("still says which stop is the published price — in the STROKE, not the size", () => {
    const marks = rings(renderSmartCostChart([opus5]));
    const strongest = Math.max(...marks.map((m) => m.strokeOpacity));
    // exactly one anchor, and it is louder than the stops derived from it
    expect(marks.filter((m) => m.strokeOpacity === strongest)).toHaveLength(1);
    expect(marks.filter((m) => m.strokeOpacity < strongest)).toHaveLength(4);
    // …while sharing their radius: the anchor channel must not touch size
    const anchor = marks.find((m) => m.strokeOpacity === strongest)!;
    for (const m of marks) expect(m.r).toBe(anchor.r);
  });

  it("carries the same anchor signal on the triangles", () => {
    const tris = triangles(renderSmartCostChart([opus5]));
    const strongest = Math.max(...tris.map((t) => t.strokeOpacity));
    expect(tris.filter((t) => t.strokeOpacity === strongest)).toHaveLength(1);
  });

  it("keeps size meaning context window: bigger ctx, bigger circle, area ∝ ctx", () => {
    const svg = renderSmartCostChart([
      model({ id: "a/small", name: "Small", ctx: 200_000, relCost: 3, index: 50 }),
      model({ id: "b/big", name: "Big", ctx: 1_000_000, relCost: 4, index: 51 }),
    ]);
    const byModel = new Map<string, number[]>();
    for (const m of rings(svg)) byModel.set(m.model, [...(byModel.get(m.model) ?? []), m.r]);
    // each model is internally uniform…
    for (const rs of byModel.values()) expect(new Set(rs).size).toBe(1);
    // …and the law across models survives: r ∝ √ctx through the origin, so a 5×
    // context window is a 5× AREA, i.e. √5 the radius. No offset term.
    const small = byModel.get("a/small")![0];
    const big = byModel.get("b/big")![0];
    expect(big).toBeGreaterThan(small);
    expect(big / small).toBeCloseTo(Math.sqrt(5), 2);
  });

  it("leaves the model name clear of the full-size ring it hangs off", () => {
    const svg = renderSmartCostChart([opus5]);
    const r = rings(svg)[0].r;
    const gap = labelGaps(svg).get("claude-opus-5")!;
    // the gap is measured from the mark's centre, so the air is gap − r
    expect(gap - r).toBeGreaterThan(4.9);
    expect(gap - r).toBeLessThan(5.1);
  });
});
