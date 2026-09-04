import { describe, expect, it } from "vitest";
import { AA_EFFORT_INDEX, aaFamilyOf, aaNamedEfforts, aaScoreAt } from "./aa-effort-index.js";

// FORK 2026-09-02 (the architect: "there are still models that look like a horizontal line").
// A flat constellation means the model has a vendor effort ladder but ≤1 AA-measured
// rung. The audit that turn found most of those are genuinely unmeasured — AA runs a
// full effort ladder only for selected flagship models — but TWO were flat because our
// own family lookup missed data already on disk. That is the failure this locks down:
// a join miss is indistinguishable from missing data on the chart, and silently throws
// away the only real number we have for a model.
describe("aa-effort-index — family joins that were silently missing", () => {
  it("resolves Anthropic's 4.6 pair through AA's `-adaptive` slug", () => {
    // AA names these "Claude Sonnet 4.6 (Adaptive Reasoning, Max Effort)" and files
    // them under a slug our config never uses. Before the alias both resolved to a
    // family that does not exist, so aaScoreAt returned undefined for every effort.
    expect(aaFamilyOf("claude-code/claude-sonnet-4-6")).toBe("claude-sonnet-4-6-adaptive");
    expect(aaFamilyOf("claude-code/claude-opus-4-6")).toBe("claude-opus-4-6-adaptive");
    expect(aaScoreAt("claude-code/claude-sonnet-4-6", "max")).toBeCloseTo(48.3663, 4);
    expect(aaScoreAt("claude-code/claude-opus-4-6", "max")).toBeCloseTo(44.9314, 4);
  });

  it("carries gemini-3.5-flash-lite, which the name-regex extractor had dropped", () => {
    expect(aaScoreAt("google/gemini-3.5-flash-lite", "high")).toBeCloseTo(37.4387, 4);
  });

  it("carries today's arrivals — Gemini 3.8 Flash and Muse Spark 1.3", () => {
    expect(aaScoreAt("google/gemini-3.8-flash", "high")).toBeCloseTo(58.6792, 4);
    expect(aaScoreAt("google/gemini-3.8-flash", "medium")).toBeCloseTo(56.6391, 4);
    expect(aaScoreAt("google/gemini-3.8-flash", "low")).toBeCloseTo(51.7492, 4);
    expect(aaScoreAt("openrouter/meta/muse-spark-1.3", "max")).toBeCloseTo(62.0885, 4);
    expect(aaScoreAt("openrouter/meta/muse-spark-1.3", "xhigh")).toBeCloseTo(60.778, 3);
  });

  // The honesty invariant the whole table exists for. A missing pair must come back
  // undefined so the caller draws it on the cost rail, NEVER as an approximated y.
  it("returns undefined for an effort AA did not publish — never a fallback", () => {
    expect(aaScoreAt("claude-code/claude-sonnet-4-6", "low")).toBeUndefined();
    expect(aaScoreAt("claude-code/claude-haiku-4-5", "high")).toBeUndefined();
    expect(aaScoreAt("openai/gpt-4o", "medium")).toBeUndefined();
  });

  // Sonnet 5's low/medium/high/xhigh rows exist on AA but are `intelligenceIndex: null`,
  // and its `-non-reasoning` sibling IS scored at high (42.57). Folding that in would
  // file a different MODE as an effort stop and put a bogus 42.57 below its own 55.26.
  it("never absorbs a non-reasoning row as an effort stop", () => {
    expect(aaNamedEfforts("claude-code/claude-sonnet-5")).toEqual(["max"]);
    expect(aaScoreAt("claude-code/claude-sonnet-5", "high")).toBeUndefined();
  });

  it("every shipped score is a finite number — no nulls, no placeholders", () => {
    for (const [family, row] of Object.entries(AA_EFFORT_INDEX)) {
      for (const [effort, v] of Object.entries(row)) {
        expect(Number.isFinite(v), `${family}.${effort}`).toBe(true);
      }
    }
  });
});
