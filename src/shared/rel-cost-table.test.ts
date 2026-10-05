import { describe, expect, it } from "vitest";
import {
  DEFAULT_REL_COST,
  PLAN_UTIL,
  REL_COST_TABLE,
  SEAT_MEASURED,
  SEAT_TIERS,
  relCostFor,
  relCostKey,
  seatRelCost,
  seatValueMultiple,
} from "./rel-cost-table.js";

/**
 * The ONLY property of this table that cannot be read off a single row: it is a
 * SEQUENCE. Every case below pins first-match-wins, because reordering the rows
 * re-prices models silently — no type error, no crash, just a wrong number.
 */
const indexOfRowMatching = (id: string): number =>
  REL_COST_TABLE.findIndex((row) => row.modelMatch.test(id));

/** Every row whose regex claims this id, in table order. */
const allRowsMatching = (id: string) => REL_COST_TABLE.filter((row) => row.modelMatch.test(id));

/** Prepaid rows are COMPUTED from the measured seats since 2026-09-23, so pins compare at
 *  4 decimals — the precision the table used to be typed at. */
const r4 = (n: number): number => Number(n.toFixed(4));

describe("shared/rel-cost-table", () => {
  describe("order preservation — first match wins", () => {
    // Real pair, and the row comment records the bug it already caused once:
    // `/nex-n2/i` also claims `nex-n2-mini`, drawing it 10x too thick.
    it("prices nex-n2-mini from the SPECIFIC row, not the generic /nex-n2/ row", () => {
      const claimants = allRowsMatching("nex-n2-mini");
      // THREE rows genuinely claim this id (its own, /nex-n2/, and the \bmini\b
      // catch-all) — order, not exclusivity, is what decides the price.
      expect(claimants.map((r) => r4(r.relCost))).toEqual([0.1, 1.0, 0.3079]);
      expect(relCostFor("nex-n2-mini")).toBe(0.1);
      expect(indexOfRowMatching("nex-n2-mini")).toBeLessThan(indexOfRowMatching("nex-n2-pro"));
    });

    // The most expensive inversion available: a METERED cash route ($50/Mtok)
    // sitting above the amortized subscription /opus/ row (0.5692 since the 2026-09-23
    // measured re-base; 0.2232 before) — 88x.
    it("prices claude-opus-5-fast as metered cash, not as amortized opus", () => {
      const claimants = allRowsMatching("openrouter/anthropic/claude-opus-5-fast");
      expect(claimants.map((r) => r4(r.relCost))).toEqual([50.0, 0.5692]);
      expect(relCostFor("openrouter/anthropic/claude-opus-5-fast")).toBe(50.0);
    });

    // FORK 2026-09-09: the ChatGPT seat now serves Astra, so openai-codex/ takes the
    // MEASURED ChatGPT Plus seat (3.4212 since 2026-09-23) and the generic /gpt-6-astra/ row stays at the $50 list
    // for any metered twin. Two rows is the point — a seat pin must not inherit cash.
    it("prices openai-codex Astra as the ChatGPT seat, metered twin as cash", () => {
      expect(r4(relCostFor("openai-codex/gpt-6-astra"))).toBe(3.4212);
      expect(relCostFor("openai/gpt-6-astra")).toBe(50.0);
    });

    // Third real pair: /glm-5(?![.\d])/ does not block a LETTER, so it also
    // claims glm-5v-turbo, as does the bare /glm/ fallback.
    it("prices glm-5v-turbo from its own row, ahead of both generic glm rows", () => {
      expect(allRowsMatching("glm-5v-turbo").map((r) => r.relCost)).toEqual([4.0, 1.92, 3.036]);
      expect(relCostFor("glm-5v-turbo")).toBe(4.0);
    });
  });

  describe("gemini 4 argon (2026-10-02)", () => {
    it("prices Gemini 4 Argon from its own row at the $10 introductory output price", () => {
      // Only its own row may claim it: a generic gemini row would price a frontier
      // model at Flash or 3.1-Pro rates, and the default would put it nowhere.
      expect(allRowsMatching("google/gemini-4-argon").map((r) => r4(r.relCost))).toEqual([10.0]);
      expect(relCostFor("google/gemini-4-argon")).toBe(10.0);
    });
  });

  describe("fallback", () => {
    it("returns DEFAULT_REL_COST for an id no row claims", () => {
      expect(allRowsMatching("acme/frobnicator-9")).toHaveLength(0);
      expect(relCostFor("acme/frobnicator-9")).toBe(DEFAULT_REL_COST);
      expect(DEFAULT_REL_COST).toBe(2.58);
    });
  });

  describe("known ids", () => {
    // Typed as a mutable tuple array on purpose: it.each infers (string, number)
    // from this, where a bare literal array infers (string | number) and makes
    // relCostFor(id) a type error under tsgo (vitest does not typecheck, so a
    // green run here would not have told us).
    const FIXTURE: [string, number][] = [
      // 2026-09-23 measured re-base: Claude seat ×2.55, ChatGPT seat ×7.66 vs the
      // borrowed 0.0893 unit. Grok still BORROWS the Anthropic multiple (unmeasured).
      ["xai/grok-4.6", 0.1366],
      ["claude-code/claude-opus-5", 0.5692],
      ["claude-code/claude-opus-5-5", 0.4553],
      ["openai-codex/gpt-5.6-sol", 1.3685],
      ["openai/gpt-5.6-luna", 0.0821],
    ];

    it.each(FIXTURE)("prices %s at %f", (id, expected) => {
      expect(r4(relCostFor(id))).toBe(expected);
    });

    // The winning value alone is NOT enough. Two of the four fixture ids are
    // themselves order-dependent: the generic /gpt-5/i row (0.0893) also claims
    // Sol and Luna, so hoisting it would reprice Sol 2x cheap and Luna 8.3x dear
    // while grok and opus stayed green. Pin the ORDERED claimant list instead.
    it("pins the ordered claimant list behind each fixture price", () => {
      const claims = (id: string) => allRowsMatching(id).map((row) => r4(row.relCost));
      expect(claims("xai/grok-4.6")).toEqual([0.1366]);
      expect(claims("claude-code/claude-opus-5")).toEqual([0.5692]);
      expect(claims("claude-code/claude-opus-5-5")).toEqual([0.4553, 0.5692]);
      expect(claims("openai-codex/gpt-5.6-sol")).toEqual([1.3685, 0.6842]);
      expect(claims("openai/gpt-5.6-luna")).toEqual([0.0821, 0.6842]);
    });

    // The deepest stack in the table and its best single canary for a reorder:
    // four claimants spanning 187x — the Copilot-specific row, the Copilot
    // catch-all, the native gpt-5.5 row and the native gpt-5 row.
    it("prices M365 Copilot Think Deeper on its own seat row, never a github-copilot row", () => {
      expect(allRowsMatching("copilot/copilot-think-deeper").map((row) => r4(row.relCost))).toEqual(
        [1.3685],
      );
      expect(r4(relCostFor("copilot/copilot-think-deeper"))).toBe(1.3685);
    });

    it("resolves the four-deep github-copilot/gpt-5.5 stack to the Copilot row", () => {
      expect(allRowsMatching("github-copilot/gpt-5.5").map((row) => r4(row.relCost))).toEqual([
        16.71, 6.69, 2.0527, 0.6842,
      ]);
      expect(relCostFor("github-copilot/gpt-5.5")).toBe(16.71);
    });
  });

  // 2026-09-23 (the architect: "the cost of the tokens of the different openai models are not
  // calculated properly"). Both seats are now MEASURED with one method; these pins are
  // the published-ladder arithmetic on top of the two measurements.
  describe("measured subscription seats", () => {
    const at100 = (tag: string) => {
      const t = SEAT_TIERS.find((x) => x.tag === tag)!;
      return Number(seatValueMultiple(t.vendor, t, 1).toFixed(1));
    };

    it("prices each tier's full week as a multiple of its fee", () => {
      expect([
        at100("Pro €20"),
        at100("Max 5× €100"),
        at100("Team €125"),
        at100("Max 20× €200"),
      ]).toEqual([29.3, 29.3, 23.4, 58.6]);
      expect([
        at100("Plus €20"),
        at100("Business €25"),
        at100("Pro 5× €100"),
        at100("Pro 10× €200"),
        at100("Pro 25× €500"),
      ]).toEqual([19.5, 15.6, 19.5, 19.5, 19.5]);
    });

    it("draws our own seat's circle at PLAN_UTIL of its 100% waypoint", () => {
      for (const vendor of ["anthropic", "openai"] as const) {
        const held = SEAT_MEASURED[vendor];
        const full = 10 / seatValueMultiple(vendor, held, 1);
        expect(seatRelCost(vendor, 10) * PLAN_UTIL).toBeCloseTo(full, 12);
      }
    });

    it("keeps every prepaid row on a measured seat, never the retired 0.0893 unit", () => {
      expect(REL_COST_TABLE.some((row) => row.relCost === 0.0893)).toBe(false);
      expect(relCostFor("claude-code/claude-sonnet-5")).toBeCloseTo(
        seatRelCost("anthropic", 10),
        12,
      );
      expect(relCostFor("openai-codex/gpt-6-sol")).toBeCloseTo(seatRelCost("openai", 10), 12);
    });

    // Lived only in eeg-trace.ts's duplicate until the 2026-09-23 collapse.
    it("prices a metered openrouter Fable route as cash, the claude-code route as the seat", () => {
      expect(relCostFor("openrouter/anthropic/claude-fable-5.1")).toBe(50.0);
      expect(relCostFor("claude-code/claude-fable-5-1")).toBeCloseTo(
        seatRelCost("anthropic", 50),
        12,
      );
    });
  });

  describe("relCostKey", () => {
    it("prefixes a bare model with its provider so provider-scoped rows can fire", () => {
      expect(relCostKey("gpt-5.5", "github-copilot")).toBe("github-copilot/gpt-5.5");
      // A full ref is passed through untouched.
      expect(relCostKey("openrouter/z-ai/glm-5.2", "openrouter")).toBe("openrouter/z-ai/glm-5.2");
      expect(relCostKey("", "xai")).toBe("");
    });

    it("routes a copilot ref to the Copilot row and the bare name to the native row", () => {
      expect(relCostFor("gpt-5.5", "github-copilot")).toBe(16.71);
      expect(r4(relCostFor("gpt-5.5"))).toBe(2.0527);
    });

    // The gateway's own failure shape: a config entry carrying no model string at
    // all. It must price at the default — never 0 (which reads as free) and never
    // NaN, which would make every comparison in the 1.5x cost veto silently false.
    it("prices an empty key at the default, never 0 and never NaN", () => {
      expect(relCostKey("", "xai")).toBe("");
      expect(relCostFor("")).toBe(DEFAULT_REL_COST);
      expect(relCostFor("", "xai")).toBe(DEFAULT_REL_COST);
    });
  });

  describe("table invariants", () => {
    // A truncated move is the one way this file can be wrong without any single
    // assertion above failing. 77 rows came across from EEG_COST_TABLE; the floor
    // catches a loss without blocking the near-weekly additions.
    it("kept every row that came across from EEG_COST_TABLE", () => {
      expect(REL_COST_TABLE.length).toBeGreaterThanOrEqual(77);
    });

    // A stray /g or /y makes RegExp.test() STATEFUL through lastIndex: the same
    // model would price differently on alternate calls, intermittently, with no
    // error anywhere. Nothing carries one today — keep it that way.
    it("has no stateful matcher and no case-sensitive row", () => {
      const bad = REL_COST_TABLE.filter(
        (row) => row.modelMatch.global || row.modelMatch.sticky || !row.modelMatch.ignoreCase,
      ).map((row) => row.modelMatch.source);
      expect(bad).toEqual([]);
    });

    it("prices the same id identically on a repeat call", () => {
      for (const id of ["xai/grok-4.6", "nex-n2-mini", "tool/tool:local"]) {
        expect(relCostFor(id)).toBe(relCostFor(id));
      }
    });

    // A duplicated pattern is an unreachable row, and the usual fingerprint of a
    // bad merge putting a row back after it was deliberately re-scoped.
    it("has no duplicate pattern, which would be an unreachable row", () => {
      const sources = REL_COST_TABLE.map((row) => row.modelMatch.source);
      expect(sources.length - new Set(sources).size).toBe(0);
    });

    it("gives every row a positive, finite price", () => {
      const bad = REL_COST_TABLE.filter(
        (row) => !Number.isFinite(row.relCost) || row.relCost <= 0,
      ).map((row) => row.modelMatch.source);
      expect(bad).toEqual([]);
    });
  });
});
