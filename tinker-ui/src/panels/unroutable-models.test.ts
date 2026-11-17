import { describe, expect, it } from "vitest";
import {
  hoverNameAttrs,
  interleaveByScore,
  renderUnroutableChip,
  unroutableChipLabel,
  unroutableTraceId,
  renderUnroutableRow,
  type UnroutableModel,
} from "./unroutable-models.ts";

const entry = (name: string, score: number): UnroutableModel => ({
  id: `aa:${name}`,
  name,
  score,
  reason: "no-host",
  url: `https://example.test/${name}`,
  note: "Nobody serves it yet.",
});

describe("interleaveByScore", () => {
  const scores: Record<string, number> = { a: 58, b: 50, c: 46 };
  const scoreOf = (id: string) => scores[id];

  it("places each greyed entry at its rank among routed ids", () => {
    const out = interleaveByScore(["a", "b", "c"], scoreOf, [entry("x", 59), entry("y", 49)], 0);
    expect(out.map((o) => ("id" in o ? o.id : o.entry.name))).toEqual(["x", "a", "b", "y", "c"]);
  });

  it("drops entries below the floor and appends the rest after the last routed id", () => {
    const out = interleaveByScore(["a"], scoreOf, [entry("low", 10), entry("mid", 30)], 20);
    expect(out.map((o) => ("id" in o ? o.id : o.entry.name))).toEqual(["a", "mid"]);
  });

  it("keeps an unscored routed id after every entry", () => {
    const out = interleaveByScore(["auto"], () => undefined, [entry("x", 59)], 0);
    expect(out.map((o) => ("id" in o ? o.id : o.entry.name))).toEqual(["auto", "x"]);
  });
});

describe("greyed markup", () => {
  it("a model nobody serves says so and offers no link", () => {
    const chip = renderUnroutableChip(entry("x", 59));
    expect(chip).toContain('data-unroutable-note="No way to route it: Nobody serves it yet."');
    expect(chip).toContain('data-unroutable-url=""');
  });

  it("carries the note and the supplier link, and a chip has no pick index", () => {
    const chip = renderUnroutableChip({ ...entry("Gem <4>", 59), reason: "vendor" });
    expect(chip).toContain(
      'data-unroutable-url="https://example.test/Gem <4>"'
        .replace("<", "&lt;")
        .replace(">", "&gt;"),
    );
    expect(chip).not.toContain("data-model-idx");
    expect(chip).toContain('aria-disabled="true"');
    expect(renderUnroutableRow(entry("x", 49.73))).toContain(">49.7<");
  });
});

describe("hover names and labels", () => {
  it("every greyed chip names its model on the card", () => {
    expect(renderUnroutableChip(entry("Gemini 4 Hydrogen", 54))).toContain(
      'data-hover-name="Gemini 4 Hydrogen"',
    );
  });
  it("a Gemini codename is the label, a variant word is not", () => {
    expect(unroutableChipLabel("Gemini 4 Hydrogen")).toBe("Hydrogen");
    expect(unroutableChipLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash");
    expect(renderUnroutableChip(entry("Gemini 4 Hydrogen", 54))).toContain(">Hydrogen<");
  });
  it("draws the trace it is given and paints by the supplier path", () => {
    expect(renderUnroutableChip(entry("x", 50), "<svg></svg>")).toContain("<svg></svg>");
    expect(
      unroutableTraceId({
        ...entry("g", 54),
        reason: "openrouter",
        url: "https://openrouter.ai/google/gemini-4-hydrogen",
      }),
    ).toBe("google/gemini-4-hydrogen");
    expect(unroutableTraceId(entry("muse-x", 50))).toBe("aa/muse-x");
  });
  it("a pickable chip gets a name and an optional note, never aria-disabled", () => {
    expect(hoverNameAttrs("Opus 5.5")).toBe(' data-hover-name="Opus 5.5"');
    expect(hoverNameAttrs("Sol 6.1", "Out of tokens")).toContain('data-hover-note="Out of tokens"');
  });
});
