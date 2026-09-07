// tinker-ui/src/panels/aa-panel-floor.test.ts
//
// THE SMART-MODELS FLOOR MUST SURVIVE A RESCALE OF THE METRIC IT READS.
// That is the single property this file exists to hold.
//
// Bought on 2026-09-05: Artificial Analysis rebased its Intelligence Index overnight and
// every scored model fell ~15-25% in one scrape. The gate was the literal number 53, so
// SMART MODELS went from 23 entries to 2 and the model selector went with it. The user
// found it as "in the model picker panel I only have 2 models available now".
//
// Each assertion carries its CONTROL: a fixture where the OLD absolute rule really gives
// a different answer, so none of these can pass against a reverted implementation.
import { describe, expect, test } from "vitest";
import { AA_PANEL_TOP_N, aaPanelFloor } from "./aa-panel-floor.js";

/** A plausible board: 40 models spread down from `top`, smartest first. */
const board = (top: number, step = 0.5): number[] =>
  Array.from({ length: 40 }, (_, i) => top - i * step);

const admitted = (scores: number[]): number =>
  scores.filter((s) => s >= aaPanelFloor(scores)).length;

describe("aa panel floor", () => {
  test("admits exactly the top N", () => {
    const scores = board(65);
    expect(admitted(scores)).toBe(AA_PANEL_TOP_N);
    expect(aaPanelFloor(scores)).toBeCloseTo(65 - (AA_PANEL_TOP_N - 1) * 0.5, 6);
  });

  test("a uniform rescale of the whole board changes nothing", () => {
    const before = board(65);
    // The real 2026-09-05 event: AA multiplied the board down by ~0.86.
    const after = before.map((s) => s * 0.864);
    // CONTROL — the old absolute rule really does move under this fixture.
    expect(after.filter((s) => s >= 53).length).toBeLessThan(before.filter((s) => s >= 53).length);
    // THE FIX — the same models are admitted on either scale.
    expect(admitted(after)).toBe(admitted(before));
  });

  test("the actual 2026-09-05 rescale, on the real scores it broke", () => {
    // The genuine head of agents.defaults.models, before and after the AA rebase.
    // Not a ramp: the real board has a wide gap under the two Anthropic flagships,
    // which is why an absolute 53 left exactly TWO models standing.
    const real: [number, number][] = [
      [65.6529, 56.7581], // claude-code/claude-fable-5-1
      [63.0532, 54.0539], // claude-code/claude-opus-5
      [62.0885, 52.9463], // openrouter/meta/muse-spark-1.3
      [60.9299, 51.2552], // openai-codex/gpt-5.6-sol
      [60.923, 50.5768], // xai/grok-4.6
      [59.6995, 50.2337], // openrouter/moonshotai/kimi-k3
      [59.5134, 48.584], // openrouter/z-ai/glm-5.3
      [58.6792, 47.0703], // google/gemini-3.8-flash
      [58.0774, 46.9057], // openrouter/qwen/qwen3.8-max
      [56.7616, 46.8372], // openrouter/meta/muse-spark-1.2
    ];
    const oldScores = real.map(([o]) => o);
    const newScores = real.map(([, n]) => n);
    // CONTROL — the reported outage, reproduced from the real numbers.
    expect(oldScores.filter((s) => s >= 53).length).toBe(10);
    expect(newScores.filter((s) => s >= 53).length).toBe(2);
    // THE FIX — a 10-model board is shorter than N, so all 10 stay on both scales.
    expect(admitted(oldScores)).toBe(10);
    expect(admitted(newScores)).toBe(10);
  });

  test("input order does not matter", () => {
    const scores = board(65);
    expect(aaPanelFloor([...scores].reverse())).toBeCloseTo(aaPanelFloor(scores), 6);
  });

  test("a catalog shorter than N is admitted whole, never emptied", () => {
    expect(aaPanelFloor([40, 10])).toBe(10);
    expect(admitted([40, 10])).toBe(2);
  });

  test("an unscored catalog fails OPEN rather than hiding every model", () => {
    expect(aaPanelFloor([])).toBe(Number.NEGATIVE_INFINITY);
    expect(admitted([])).toBe(0);
    expect([1, 2].filter((s) => s >= aaPanelFloor([]))).toHaveLength(2);
  });

  test("non-finite scores are ignored rather than poisoning the sort", () => {
    expect(aaPanelFloor([50, Number.NaN, 40])).toBe(40);
  });

  test("does not mutate its input", () => {
    const scores = [10, 50, 30];
    aaPanelFloor(scores);
    expect(scores).toEqual([10, 50, 30]);
  });
});
