import { describe, it, expect } from "vitest";
import { parseThoughts } from "./reasoning-runtime.js";

describe("parseThoughts — generator self-score parsing", () => {
  it("parses '- thought :: score' lines into 0..1 scores", () => {
    const out = parseThoughts("- do X first :: 80\n- try Y :: 20");
    expect(out).toEqual([
      { text: "do X first", score: 0.8 },
      { text: "try Y", score: 0.2 },
    ]);
  });
  it("defaults to 0.5 when a line has no score", () => {
    expect(parseThoughts("- a bare thought")).toEqual([{ text: "a bare thought", score: 0.5 }]);
  });
  it("accepts '*' bullets and clamps scores to [0,1]", () => {
    expect(parseThoughts("* big :: 250")).toEqual([{ text: "big", score: 1 }]);
    expect(parseThoughts("- neg :: 0")).toEqual([{ text: "neg", score: 0 }]);
  });
  it("skips non-bullet / preamble / empty lines", () => {
    const out = parseThoughts(
      "Here are my ideas:\n\n- real one :: 70\nrandom prose\n- another :: 30",
    );
    expect(out.map((t) => t.text)).toEqual(["real one", "another"]);
  });
  it("returns [] for empty/garbage input", () => {
    expect(parseThoughts("")).toEqual([]);
    expect(parseThoughts("no bullets at all")).toEqual([]);
  });
});
