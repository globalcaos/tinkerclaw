import { describe, expect, it } from "vitest";
import { AA_EFFORT_INDEX, aaFamilyOf, aaNamedEfforts, aaScoreAt } from "./aa-effort-index.js";

// FORK 2026-09-02 (the user: "there are still models that look like a horizontal line").
// A flat constellation means the model has a vendor effort ladder but ≤1 AA-measured
// rung. The audit that turn found most of those are genuinely unmeasured — AA runs a
// full effort ladder only for selected flagship models — but TWO were flat because our
// own family lookup missed data already on disk. That is the failure this locks down:
// a join miss is indistinguishable from missing data on the chart, and silently throws
// away the only real number we have for a model.
//
// RESHAPED 2026-09-05, the morning AA REBASED the Intelligence Index — every scored
// model fell ~15-25% overnight (Fable 5.1 65.6529→56.7581, Opus 5 63.0532→54.0539).
// The nightly refresh regenerated src/shared/aa-effort-index.ts correctly and this
// suite went red on three blocks of hand-copied literals. Same anti-pattern that took
// the model picker from 23 entries to 2 that same morning — a value denominated in a
// VENDOR's units, pinned somewhere it goes stale silently (there `AA_PANEL_MIN = 53`,
// here a transcribed `48.3663`) — one layer down, and with a worse failure mode: the
// gate goes red, so the nightly refresh FAILS CLOSED and nobody gets the new numbers.
//
// So the assertions below state the claim this file actually exists for — the FAMILY
// JOIN and extractor COVERAGE: this slug resolves to THIS family, exposes exactly
// THESE rungs, and returns the value the generated table holds. A rescale now moves
// the table and the expectation in the same commit. Two shapes deliberately avoided:
//   · a bare copied number — that is the thing that broke;
//   · a monotone ladder assertion (low < medium < high < max). AA does not guarantee
//     it and this table already contradicts it — grok-4-6 measures xhigh 49.3394 BELOW
//     its own high 50.5768, gpt-5-mini high 18.4192 below its medium 24.2225. Asserting
//     it would rebuild the same fail-closed trap on a different axis.
describe("aa-effort-index — family joins that were silently missing", () => {
  /** Assert AA published a real number here, and hand it back narrowed. The join claim
   *  is "reachable at all"; WHICH number is AA's business and changes under a rescale. */
  const measured = (modelId: string, effort: string): number => {
    const v = aaScoreAt(modelId, effort);
    expect(v, `${modelId} @ ${effort}`).toBeDefined();
    expect(Number.isFinite(v), `${modelId} @ ${effort}`).toBe(true);
    return v as number;
  };

  it("resolves Anthropic's 4.6 pair through AA's `-adaptive` slug", () => {
    // AA names these "Claude Sonnet 4.6 (Adaptive Reasoning, Max Effort)" and files
    // them under a slug our config never uses. Before the alias both resolved to a
    // family that does not exist, so aaScoreAt returned undefined for every effort.
    expect(aaFamilyOf("claude-code/claude-sonnet-4-6")).toBe("claude-sonnet-4-6-adaptive");
    expect(aaFamilyOf("claude-code/claude-opus-4-6")).toBe("claude-opus-4-6-adaptive");
    // The recovered measurement: `max` must be REACHABLE (it was on disk and unreachable
    // for both models), and must come from the `-adaptive` row — aaScoreAt has its own
    // lookup path, so it is checked against that row's cell rather than assumed to agree
    // with aaFamilyOf above. Tying it to the generated cell, not to a transcript of it,
    // is what makes this survive the next rescale.
    expect(measured("claude-code/claude-sonnet-4-6", "max")).toBe(
      AA_EFFORT_INDEX["claude-sonnet-4-6-adaptive"].max,
    );
    expect(measured("claude-code/claude-opus-4-6", "max")).toBe(
      AA_EFFORT_INDEX["claude-opus-4-6-adaptive"].max,
    );
    // One rung each, and it is `max`. A second key appearing here would mean the
    // extractor folded a non-reasoning row in as an effort stop (see the test below).
    expect(aaNamedEfforts("claude-code/claude-sonnet-4-6")).toEqual(["max"]);
    expect(aaNamedEfforts("claude-code/claude-opus-4-6")).toEqual(["max"]);
  });

  it("carries gemini-3.5-flash-lite, which the name-regex extractor had dropped", () => {
    // Coverage AND discrimination: `-lite` is its own AA family, and the neighbour it
    // would collapse into (`gemini-3-5-flash`) is scored at `high` too — so a join miss
    // here does not read as absence, it reads as a plausible wrong number on the chart.
    // The family identity is the anchor for that, not a value comparison against the
    // neighbour: the 09-05 rebase moved every model by a different amount, so a
    // cross-family inequality is not an invariant either.
    expect(aaFamilyOf("google/gemini-3.5-flash-lite")).toBe("gemini-3-5-flash-lite");
    expect(measured("google/gemini-3.5-flash-lite", "high")).toBe(
      AA_EFFORT_INDEX["gemini-3-5-flash-lite"].high,
    );
    expect(aaNamedEfforts("google/gemini-3.5-flash-lite")).toEqual(["high"]);
  });

  it("carries today's arrivals — Gemini 3.8 Flash and Muse Spark 1.3", () => {
    // A new arrival is where the extractor is likeliest to drop a rung, so assert the
    // EXACT published rung set: complete, in AA's own order, nothing invented. That is
    // the shape a join miss destroys and a rescale leaves alone.
    expect(aaNamedEfforts("google/gemini-3.8-flash")).toEqual(["low", "medium", "high"]);
    expect(measured("google/gemini-3.8-flash", "low")).toBe(
      AA_EFFORT_INDEX["gemini-3-8-flash"].low,
    );
    expect(measured("google/gemini-3.8-flash", "medium")).toBe(
      AA_EFFORT_INDEX["gemini-3-8-flash"].medium,
    );
    expect(measured("google/gemini-3.8-flash", "high")).toBe(
      AA_EFFORT_INDEX["gemini-3-8-flash"].high,
    );
    // Muse Spark ships three versions and 1.1/1.2/1.3 are all scored at `xhigh`, so the
    // real claim is that the dotted OpenRouter id lands on 1-3 and not on a neighbour.
    // The family key carries that; a literal only carried it until AA moved the y-axis.
    expect(aaFamilyOf("openrouter/meta/muse-spark-1.3")).toBe("muse-spark-1-3");
    expect(aaNamedEfforts("openrouter/meta/muse-spark-1.3")).toEqual(["xhigh", "max"]);
    expect(measured("openrouter/meta/muse-spark-1.3", "xhigh")).toBe(
      AA_EFFORT_INDEX["muse-spark-1-3"].xhigh,
    );
    expect(measured("openrouter/meta/muse-spark-1.3", "max")).toBe(
      AA_EFFORT_INDEX["muse-spark-1-3"].max,
    );
  });

  // The honesty invariant the whole table exists for. A missing pair must come back
  // undefined so the caller draws it on the cost rail, NEVER as an approximated y.
  it("returns undefined for an effort AA did not publish — never a fallback", () => {
    expect(aaScoreAt("claude-code/claude-sonnet-4-6", "low")).toBeUndefined();
    expect(aaScoreAt("claude-code/claude-haiku-4-5", "high")).toBeUndefined();
    expect(aaScoreAt("openai/gpt-4o", "medium")).toBeUndefined();
  });

  // Sonnet 5's low/medium/high/xhigh rows exist on AA but are `intelligenceIndex: null`,
  // and its `-non-reasoning` sibling IS scored at high. Folding that in would file a
  // different MODE as an effort stop and put a bogus high rung below its own max.
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
