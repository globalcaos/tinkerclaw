import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderRoutingRationale } from "./routing-rationale";
import { GOLDEN_FIXTURES } from "./routing-rationale.golden.fixtures";
import { renderThalamusV4, type ThalamusV4View } from "./thalamus-v4-card";

// "Off means absent", proven against develop itself. `routing-rationale.develop-golden.json` is what develop's routing card
// drew for each fixture before THALAMUS v4's block existed (see the fixtures file for how it was made). With no v4 data this
// branch must draw exactly that; with v4 data it must draw exactly that plus the block, in the one place the block goes.

const golden = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "routing-rationale.develop-golden.json"),
    "utf8",
  ),
) as Record<string, string>;
const NOW = 1_700_000_000_000;

const view: ThalamusV4View = {
  state: "ok",
  panel: {
    mode: "shadow",
    ts: NOW,
    today: { calls: 14, wouldChange: 3 },
    decisions: [],
    uses: [],
    cardNames: {},
    plans: [],
  },
};

describe("the card with no v4 data is develop's card, byte for byte", () => {
  it("has a golden for every fixture, and none of them knows about v4", () => {
    expect(Object.keys(golden).toSorted()).toEqual(Object.keys(GOLDEN_FIXTURES).toSorted());
    for (const html of Object.values(golden)) expect(html).not.toContain("thalamus-v4");
  });

  for (const [name, signals] of Object.entries(GOLDEN_FIXTURES)) {
    it(`${name}: identical, with the field absent and with it undefined`, () => {
      expect(renderRoutingRationale(signals)).toBe(golden[name]);
      expect(
        renderRoutingRationale({ ...signals, thalamusV4: undefined, thalamusV4Open: new Set() }),
      ).toBe(golden[name]);
    });

    it(`${name}: with v4 data it is develop's card plus the block and nothing else`, () => {
      const out = renderRoutingRationale({ ...signals, thalamusV4: view });
      const block = renderThalamusV4(view, { nowMs: signals.nowMs });
      expect(block).not.toBe("");
      expect(out.split(block)).toHaveLength(2);
      expect(out.replace(block, "")).toBe(golden[name]);
    });

    it(`${name}: a gateway error draws one quiet line and still changes nothing else`, () => {
      const err: ThalamusV4View = { state: "error", message: "timed out" };
      const out = renderRoutingRationale({ ...signals, thalamusV4: err });
      expect(out.replace(renderThalamusV4(err, { nowMs: signals.nowMs }), "")).toBe(golden[name]);
    });
  }
});
