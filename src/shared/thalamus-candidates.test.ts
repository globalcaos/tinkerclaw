import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "../infra/usage-snapshot-store.js";
import {
  AA_TIE_BAND,
  COST_CEILING_MULTIPLIER,
  THALAMUS_COST_BASIS,
  THALAMUS_COST_BASIS_PER_TASK,
  thalamusCandidates,
  type CandidateExclusion,
  type ThalamusCandidatesParams,
  type ThalamusCandidatesResult,
  type ThalamusCatalog,
  type ThalamusCostConfidence,
} from "./thalamus-candidates.js";

// nowMs is always injected — never a clock read — so every case is deterministic.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
const FIVE_HOUR_RESET = Date.UTC(2026, 8, 1, 15, 0, 0);

const OPUS = "claude-code/claude-opus-5";
const FABLE = "claude-code/claude-fable-5";
const SOL = "openai-codex/gpt-5.6-sol";
const GROK = "xai/grok-4.6";
const KIMI = "openrouter/moonshotai/kimi-k3";
const GLM = "openrouter/z-ai/glm-5.3";
const GEMINI_FLASH = "google/gemini-3.7-flash";
const SONNET = "claude-code/claude-sonnet-5";
const DEEPSEEK = "openrouter/deepseek/deepseek-v4-flash-0731";

/**
 * NINE ROWS OF REAL DATA, copied character-for-character from the router's own
 * fixture (`src/agents/quota-aware-auto-model.test.ts:36-46`, itself the design
 * doc's §A.3 table). Sharing the numbers with the router's suite is the point:
 * two suites describing two different catalogs is how the chart and the router
 * start telling the architect two different stories.
 *
 * FROZEN literals, never the live ~/.openclaw/openclaw.json — a test that reads
 * the running config goes red on a nightly price refresh and tells you nothing
 * about the predicate.
 */
const REAL_INDEX: Record<string, number> = {
  [OPUS]: 63.0532452071291,
  [FABLE]: 62.0726622017462,
  [SOL]: 60.9298701329203,
  [GROK]: 60.92297113115,
  [KIMI]: 59.6994671342592,
  [GLM]: 59.5134408119521,
  [GEMINI_FLASH]: 56.0301180773699,
  [SONNET]: 55.261211717405,
  [DEEPSEEK]: 51.7665776089032,
};

const REAL_COST: Record<string, number> = {
  [OPUS]: 0.2232,
  [FABLE]: 0.4464,
  [SOL]: 0.2679,
  [GROK]: 0.0536,
  [KIMI]: 15,
  [GLM]: 3.96,
  [GEMINI_FLASH]: 3.75,
  [SONNET]: 0.0893,
  [DEEPSEEK]: 0.0899,
};

/**
 * THIRTY SYNTHETIC PADDING ROWS, named `fixture/pad-NN` so nobody can mistake
 * this block for a price list. They exist only to take the catalog to the 39
 * entries the live one carries, and they are shaped so the expected answer stays
 * hand-checkable: AA values exactly 1.0 apart, so each is its own tie band (the
 * band admits `head - member < 1.0`, and 1.0 is not < 1.0); far below every real
 * model; and priced well above any ceiling so each is cost-vetoed. Provider
 * "fixture" appears in no snapshot, so they are never exhausted either.
 */
const PAD_COUNT = 30;
const PAD_COST = 9.99;

function buildFixture(): { catalog: ThalamusCatalog; cost: Record<string, number> } {
  const catalog: Record<string, { intelligenceIndex: number }> = {};
  const cost: Record<string, number> = {};
  for (const [key, intelligenceIndex] of Object.entries(REAL_INDEX)) {
    catalog[key] = { intelligenceIndex };
    cost[key] = REAL_COST[key];
  }
  for (let n = 1; n <= PAD_COUNT; n += 1) {
    const key = `fixture/pad-${String(n).padStart(2, "0")}`;
    catalog[key] = { intelligenceIndex: 40 - n };
    cost[key] = PAD_COST;
  }
  return { catalog, cost };
}

const { catalog: CATALOG, cost: COST } = buildFixture();

const priced = (key: string): number | undefined => COST[key];
const unpriced = (): number | undefined => undefined;
const pricedExcept = (missing: string) => (key: string) =>
  key === missing ? undefined : COST[key];

/**
 * A STUB per-task table, deliberately NOT the chart's.
 *
 * The published one lives in `tinker-ui/src/panels/smart-cost-chart.ts`
 * (SC_TOKEN_RULES) and this module does not import it — the caller passes the
 * lookup in, which is the whole point of the argument. The base values below are
 * the ones those regex rows would produce for these nine keys, so the arithmetic
 * is checkable by hand against a real table rather than invented; but the test
 * owns them, so a nightly refresh of the panel's estimates cannot turn this suite
 * red for a reason that says nothing about the predicate.
 */
const TOKENS: Record<string, number> = {
  [OPUS]: 4497,
  [FABLE]: 5900,
  [SOL]: 8000,
  [GROK]: 4800,
  [KIMI]: 8167,
  [GLM]: 12000,
  [GEMINI_FLASH]: 8000,
  [SONNET]: 3500,
  [DEEPSEEK]: 11600,
};

/** Pads need a token count too, or they go uncosted and stop being cost-vetoed. */
const PAD_TOKENS = 8000;
const TASK_TOKENS: Record<string, number> = { ...TOKENS };
for (const key of Object.keys(CATALOG)) {
  TASK_TOKENS[key] ??= PAD_TOKENS;
}

/**
 * Provenance stub, shaped like the published table's split (one MEASURED anchor,
 * a couple of ANCHORED rows, everything else absent) with one of each value
 * landing on a model that actually survives, so all four are exercised.
 */
const CONFIDENCE: Record<string, ThalamusCostConfidence> = {
  [OPUS]: "measured",
  [KIMI]: "anchored",
  [DEEPSEEK]: "anchored",
  [GROK]: "estimated",
};

const tokened = (key: string): number | undefined => TASK_TOKENS[key];

/** The whole Anthropic OAuth pool spent, in the collapsed-scalar shape. */
const ANTHROPIC_SPENT: UsageSnapshot = {
  lastSuccessfulFetch: NOW - 60_000,
  providers: {
    anthropic: {
      fiveHourUtilization: 100,
      sevenDayUtilization: 100,
      fiveHourResetAt: FIVE_HOUR_RESET,
      sevenDayResetAt: NOW + 86_400_000,
    },
  },
};

/** One non-Anthropic provider spent, through the generic `windows` map. */
function spentProvider(provider: string, resetAtMs?: number): UsageSnapshot {
  const window =
    resetAtMs === undefined
      ? { label: "5-hour", usedPercent: 100 }
      : { label: "5-hour", usedPercent: 100, resetAtMs };
  return {
    lastSuccessfulFetch: NOW - 60_000,
    windows: { [provider]: [window] },
    providers: {},
  };
}

function run(over: Partial<ThalamusCandidatesParams> = {}): ThalamusCandidatesResult {
  return thalamusCandidates({
    catalog: CATALOG,
    snapshot: undefined,
    nowMs: NOW,
    relCostFor: priced,
    ...over,
  });
}

/** The same 39-row fixture on the PER-TASK basis. */
function runTask(over: Partial<ThalamusCandidatesParams> = {}): ThalamusCandidatesResult {
  return run({ tokensPerTask: tokened, ...over });
}

function reasonFor(result: ThalamusCandidatesResult, key: string): CandidateExclusion | undefined {
  return result.excluded.find((entry) => entry.key === key)?.reason;
}

describe("shared/thalamus-candidates", () => {
  describe("the envelope over a 39-entry catalog", () => {
    it("ranks, vetoes and partitions the whole catalog", () => {
      const result = run();

      expect(result.basis).toBe("cost/token");
      expect(result.catalogSize).toBe(39);
      expect(result.anchorKey).toBe(OPUS);
      // 0.2232 x 1.5. fable-5 at 0.4464 is exactly 2x the anchor and falls OUT —
      // a striking result, and precisely what the envelope exists to make visible.
      expect(result.ceiling).toBeCloseTo(0.3348, 10);
      expect(result.costVerified).toBe(true);

      expect(result.considered.map((c) => c.key)).toEqual([OPUS, GROK, SOL, SONNET, DEEPSEEK]);
      expect(result.considered.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
      expect(result.pick).toBe(OPUS);
      expect(result.considered[0].provider).toBe("claude-code");
      expect(result.considered[0].model).toBe("claude-opus-5");

      // Every catalog key lands in exactly one bucket, so the chart can never
      // draw an envelope that quietly forgot a model.
      expect(result.considered.length + result.excluded.length).toBe(39);
      const seen = new Set([
        ...result.considered.map((c) => c.key),
        ...result.excluded.map((e) => e.key),
      ]);
      expect(seen.size).toBe(39);
      expect(result.excluded.every((e) => e.reason === "cost-veto")).toBe(true);
      expect(reasonFor(result, FABLE)).toBe("cost-veto");
      expect(reasonFor(result, KIMI)).toBe("cost-veto");
    });

    it("splits a three-segment openrouter key at the FIRST slash, as the router does", () => {
      const deepseek = run().considered.find((c) => c.key === DEEPSEEK);
      expect(deepseek?.provider).toBe("openrouter");
      expect(deepseek?.model).toBe("deepseek/deepseek-v4-flash-0731");
    });

    it("reaches the ceiling multiplier through the router, not through a copy of 1.5", () => {
      expect(COST_CEILING_MULTIPLIER).toBe(1.5);
      expect(THALAMUS_COST_BASIS).toBe("cost/token");
    });
  });

  describe("rule 2 — a sub-1.0 AA gap is a tie, broken on cost", () => {
    it("puts grok-4.6 above gpt-5.6-sol on a 0.0069 gap", () => {
      const gap = REAL_INDEX[SOL] - REAL_INDEX[GROK];
      expect(gap).toBeLessThan(AA_TIE_BAND);
      expect(gap).toBeCloseTo(0.0069, 4);

      const order = run().considered.map((c) => c.key);
      // sol scores HIGHER and still ranks below: inside the band the AA numbers
      // carry no signal, and grok is 0.0536 against sol's 0.2679.
      expect(order.indexOf(GROK)).toBeLessThan(order.indexOf(SOL));
    });

    it("never lets cost promote a model across a band boundary", () => {
      // deepseek is a cheap survivor 11 AA points below opus-5. Cost is a VETO,
      // never a preference, so it stays at the bottom of the envelope.
      const order = run().considered.map((c) => c.key);
      expect(order.indexOf(OPUS)).toBeLessThan(order.indexOf(DEEPSEEK));
      expect(order.at(-1)).toBe(DEEPSEEK);
    });

    it("keeps AA order inside a band when any member of it is unpriced", () => {
      // A hole in the price table is not a cheap model. With sol's price missing
      // the band has no honest comparison to make, so it does not guess.
      const order = run({ relCostFor: pricedExcept(SOL) }).considered.map((c) => c.key);
      expect(order.indexOf(SOL)).toBeLessThan(order.indexOf(GROK));
    });
  });

  describe("rule 3 — the cost veto never fires on missing data", () => {
    it("reports costVerified false and vetoes nothing when relCost is absent everywhere", () => {
      const result = run({ relCostFor: unpriced });

      expect(result.costVerified).toBe(false);
      expect(result.ceiling).toBeUndefined();
      expect(result.excluded.filter((e) => e.reason === "cost-veto")).toEqual([]);
      // No ceiling could be formed, so nothing was dropped at all.
      expect(result.considered).toHaveLength(39);
      expect(result.considered.every((c) => c.relCost === undefined)).toBe(true);
      // And the tie-break is inert rather than guessing: pure AA order.
      expect(result.considered.slice(0, 4).map((c) => c.key)).toEqual([OPUS, FABLE, SOL, GROK]);
    });

    it("drops costVerified when a SURVIVOR is unpriced, and keeps it in the envelope", () => {
      const result = run({ relCostFor: pricedExcept(GROK) });

      expect(result.costVerified).toBe(false);
      expect(result.ceiling).toBeCloseTo(0.3348, 10);
      // Unpriced does NOT mean vetoed — it means unchecked, and it says so.
      expect(result.considered.map((c) => c.key)).toContain(GROK);
    });

    it("keeps costVerified true when the unpriced model was excluded for another reason", () => {
      // grok has no price, so the veto cannot touch it — but xai is spent, so it
      // never reaches the envelope and the cost axis over the envelope is intact.
      const result = run({ relCostFor: pricedExcept(GROK), snapshot: spentProvider("xai") });

      expect(reasonFor(result, GROK)).toBe("provider-exhausted");
      expect(result.considered.every((c) => c.relCost !== undefined)).toBe(true);
      expect(result.costVerified).toBe(true);
    });
  });

  describe("rule 4 — provider exhaustion, decided by the router's own predicate", () => {
    it("excludes every model on a spent provider and leaves the rest alone", () => {
      const result = run({ snapshot: spentProvider("xai") });

      expect(reasonFor(result, GROK)).toBe("provider-exhausted");
      expect(result.considered.some((c) => c.provider === "xai")).toBe(false);
      expect(result.considered.map((c) => c.key)).toEqual([OPUS, SOL, SONNET, DEEPSEEK]);
      expect(result.pick).toBe(OPUS);
    });

    it("holds the ceiling still when the ANCHOR's own provider goes dark", () => {
      const result = run({ snapshot: ANTHROPIC_SPENT });

      // The anchor and the ceiling do NOT move to the surviving pick: the router
      // measures against the original it is replacing, which is exhausted by
      // construction. Anchoring on the survivor would collapse and re-inflate the
      // envelope every time a 5-hour bucket rolls over.
      expect(result.anchorKey).toBe(OPUS);
      expect(result.ceiling).toBeCloseTo(0.3348, 10);
      expect(reasonFor(result, OPUS)).toBe("provider-exhausted");
      expect(reasonFor(result, SONNET)).toBe("provider-exhausted");
      expect(result.considered.map((c) => c.key)).toEqual([GROK, SOL, DEEPSEEK]);
      expect(result.pick).toBe(GROK);
    });

    it("lets a window that has already rolled over stop excluding, on nowMs alone", () => {
      const snapshot = spentProvider("xai", FIVE_HOUR_RESET);
      const during = run({ snapshot, nowMs: NOW });
      const after = run({ snapshot, nowMs: FIVE_HOUR_RESET + 1 });

      expect(during.considered.some((c) => c.provider === "xai")).toBe(false);
      expect(after.considered.some((c) => c.provider === "xai")).toBe(true);
    });

    it("treats a provider absent from the snapshot as UNKNOWN, never as spent", () => {
      const result = run({ snapshot: spentProvider("some-other-provider") });
      expect(result.considered.map((c) => c.key)).toEqual([OPUS, GROK, SOL, SONNET, DEEPSEEK]);
    });
  });

  describe("not-routable", () => {
    it("excludes a model config cannot rank, and never ranks it last instead", () => {
      const result = thalamusCandidates({
        catalog: {
          [OPUS]: { intelligenceIndex: REAL_INDEX[OPUS] },
          "xai/no-score": {},
          "google/not-a-number": { intelligenceIndex: Number.NaN },
          "no-slash": { intelligenceIndex: 50 },
          "trailing/": { intelligenceIndex: 50 },
          "/leading-slash": { intelligenceIndex: 50 },
        },
        snapshot: undefined,
        nowMs: NOW,
        relCostFor: priced,
      });

      expect(result.catalogSize).toBe(6);
      expect(result.considered.map((c) => c.key)).toEqual([OPUS]);
      expect(result.excluded).toEqual([
        { key: "xai/no-score", reason: "not-routable" },
        { key: "google/not-a-number", reason: "not-routable" },
        { key: "no-slash", reason: "not-routable" },
        { key: "trailing/", reason: "not-routable" },
        { key: "/leading-slash", reason: "not-routable" },
      ]);
    });

    it("honours allowedModelKeys and moves the anchor past a filtered-out leader", () => {
      const allowed = new Set(Object.keys(CATALOG).filter((key) => key !== OPUS));
      const result = run({ allowedModelKeys: allowed });

      expect(reasonFor(result, OPUS)).toBe("not-routable");
      // fable-5 is now the top routable model, so IT anchors: 0.4464 x 1.5 = 0.6696.
      expect(result.anchorKey).toBe(FABLE);
      expect(result.ceiling).toBeCloseTo(0.6696, 10);
      expect(result.pick).toBe(FABLE);
      expect(result.considered.map((c) => c.key)).toEqual([FABLE, GROK, SOL, SONNET, DEEPSEEK]);
    });
  });

  describe("purity", () => {
    it("is byte-identical on the same input twice", () => {
      const args: ThalamusCandidatesParams = {
        catalog: CATALOG,
        snapshot: spentProvider("openai-codex"),
        nowMs: NOW,
        relCostFor: priced,
      };
      expect(JSON.stringify(thalamusCandidates(args))).toBe(
        JSON.stringify(thalamusCandidates(args)),
      );
    });

    it("is byte-identical when the catalog is enumerated in the opposite order", () => {
      // The gateway walks cfg.agents.defaults.models; the browser walks whatever
      // the RPC serialised. Same models, different insertion order — and the two
      // sides must still draw the same envelope. This is what `byKey` buys.
      const reversed: Record<string, { intelligenceIndex?: number }> = {};
      for (const key of Object.keys(CATALOG).toReversed()) {
        reversed[key] = { intelligenceIndex: CATALOG[key]?.intelligenceIndex };
      }
      const forward = run();
      const backward = run({ catalog: reversed });

      expect(JSON.stringify(backward.considered)).toBe(JSON.stringify(forward.considered));
      expect(backward.pick).toBe(forward.pick);
      expect(backward.anchorKey).toBe(forward.anchorKey);
      expect(backward.ceiling).toBe(forward.ceiling);
      expect(backward.excluded.map((e) => e.key).toSorted()).toEqual(
        forward.excluded.map((e) => e.key).toSorted(),
      );
    });

    it("honours the nowMs argument instead of reading a clock", () => {
      // With a Date.now() inside, generatedAtMs would be the same wall-clock
      // instant in both results rather than following the argument.
      const early = run({ nowMs: NOW });
      const late = run({ nowMs: NOW + 86_400_000 });

      expect(early.generatedAtMs).toBe(NOW);
      expect(late.generatedAtMs).toBe(NOW + 86_400_000);
      expect(late.generatedAtMs - early.generatedAtMs).toBe(86_400_000);
    });

    it("invents nothing from an empty catalog", () => {
      const result = thalamusCandidates({
        catalog: {},
        snapshot: undefined,
        nowMs: NOW,
        relCostFor: priced,
      });
      expect(result.considered).toEqual([]);
      expect(result.excluded).toEqual([]);
      // ABSENT, not merely undefined — the conditional spread must not emit the
      // key at all, or a consumer doing "pick" in result reads a phantom answer.
      expect("pick" in result).toBe(false);
      expect("anchorKey" in result).toBe(false);
      expect("ceiling" in result).toBe(false);
      expect(result.costVerified).toBe(false);
      expect(result.catalogSize).toBe(0);
      expect(result.generatedAtMs).toBe(NOW);
    });
  });

  /**
   * THE PUBLISHED PER-TASK BASIS.
   *
   * What was refuted is a LOCALLY DERIVED cost/task (medians over our own
   * anatomy_events, which partly measure which tasks we sent where). A PUBLISHED
   * table anchored to third-party measurement is a different quantity, it already
   * exists in tinker-ui/src/panels/smart-cost-chart.ts, and it arrives here as an
   * ARGUMENT so `src/shared` never reaches into the browser tree.
   */
  describe("the optional cost/task basis", () => {
    const LEAN = "bench/lean";
    const VERBOSE = "bench/verbose";
    /**
     * Two models inside ONE AA tie band at an IDENTICAL price per token, so the
     * only thing that can separate them is how many tokens each needs to finish.
     */
    const BENCH: ThalamusCatalog = {
      [LEAN]: { intelligenceIndex: 60.5 },
      [VERBOSE]: { intelligenceIndex: 60.9 },
    };
    function runBench(tokens?: (key: string) => number | undefined): ThalamusCandidatesResult {
      return thalamusCandidates({
        catalog: BENCH,
        snapshot: undefined,
        nowMs: NOW,
        relCostFor: () => 1,
        ...(tokens === undefined ? {} : { tokensPerTask: tokens }),
      });
    }

    it("names both bases as constants, not literals scattered at call sites", () => {
      expect(THALAMUS_COST_BASIS).toBe("cost/token");
      expect(THALAMUS_COST_BASIS_PER_TASK).toBe("cost/task");
    });

    it("emits no per-task field at all without a supplier", () => {
      const result = run();

      expect(result.basis).toBe("cost/token");
      // EXACT key list, in order. `toEqual` cannot see present-vs-absent, so the
      // key list is the only thing that actually pins it: emitting these three
      // unconditionally would change every existing consumer's payload, and the
      // whole promise of an OPTIONAL basis is that it costs nothing when unused.
      expect(Object.keys(result.considered[0])).toEqual([
        "key",
        "provider",
        "model",
        "intelligenceIndex",
        "relCost",
        "rank",
      ]);
      const json = JSON.stringify(result);
      expect(json).not.toContain("cost/task");
      expect(json).not.toContain("tokensPerTask");
      expect(json).not.toContain("costPerTask");
      expect(json).not.toContain("costBasisConfidence");
    });

    it("switches the axis and drops a model cheap per token but verbose per task", () => {
      const result = runTask();

      expect(result.basis).toBe("cost/task");
      // 0.2232 EUR/Mtok x 4,497 tokens = 1003.7304 for the anchor, x1.5 = 1505.5956.
      expect(result.anchorKey).toBe(OPUS);
      expect(result.ceiling).toBeCloseTo(1505.5956, 6);
      expect(result.costVerified).toBe(true);
      expect(result.catalogSize).toBe(39);
      expect(result.considered.length + result.excluded.length).toBe(39);

      // gpt-5.6-sol PASSES the cost/token veto at 0.2679 against a 0.3348 ceiling
      // and FAILS the cost/task one: 0.2679 x 8,000 = 2,143.2 against 1,505.6,
      // because it needs ~1.8x Opus 5's tokens to finish the same job. That
      // difference is the entire reason the architect asked for this axis.
      expect(run().considered.map((c) => c.key)).toContain(SOL);
      expect(reasonFor(result, SOL)).toBe("cost-veto");

      expect(result.considered.map((c) => c.key)).toEqual([OPUS, GROK, SONNET, DEEPSEEK]);
      expect(result.considered.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
      expect(result.pick).toBe(OPUS);
      // The raw price is still reported unchanged; the per-task number is added.
      expect(result.considered[0].relCost).toBe(0.2232);
      expect(result.considered[0].tokensPerTask).toBe(4497);
      expect(result.considered[0].costPerTask).toBeCloseTo(1003.7304, 6);
      expect(Object.keys(result.considered[0])).toEqual([
        "key",
        "provider",
        "model",
        "intelligenceIndex",
        "relCost",
        "rank",
        "tokensPerTask",
        "costPerTask",
        "costBasisConfidence",
      ]);
    });

    it("ranks a 1.4x token burner below a lean peer at the SAME price per token", () => {
      // Per token the two are indistinguishable, so the band falls back to AA and
      // the higher-scoring verbose model leads.
      const perToken = runBench();
      expect(perToken.basis).toBe("cost/token");
      expect(perToken.considered.map((c) => c.key)).toEqual([VERBOSE, LEAN]);

      // Per task the lean model finishes for 1,000 against 1,400, so it leads —
      // inside the band, and only inside it. Both are under the 1,500 ceiling.
      const perTask = runBench((key) => (key === LEAN ? 1000 : 1400));
      expect(perTask.basis).toBe("cost/task");
      expect(perTask.considered.map((c) => c.key)).toEqual([LEAN, VERBOSE]);
      expect(perTask.considered.map((c) => c.rank)).toEqual([1, 2]);
      expect(perTask.considered[0].costPerTask).toBe(1000);
      expect(perTask.considered[1].costPerTask).toBe(1400);
    });

    it("cost-vetoes a 3x token burner that the cost/token axis waved through", () => {
      // Identical price per token, so cost/token keeps both: 1 against a ceiling
      // of 1.5. Three times the tokens is three times the cost of a FINISHED
      // task, 3,000 against a 1,500 ceiling, and a veto is a veto on either axis.
      expect(runBench().considered.map((c) => c.key)).toEqual([VERBOSE, LEAN]);

      const perTask = runBench((key) => (key === LEAN ? 1000 : 3000));
      expect(perTask.ceiling).toBe(1500);
      expect(perTask.considered.map((c) => c.key)).toEqual([LEAN]);
      expect(perTask.excluded).toEqual([{ key: VERBOSE, reason: "cost-veto" }]);
    });

    it("reproduces the cost/token answer exactly when every model burns the same tokens", () => {
      // THE DRIFT GATE. A CONSTANT token count scales every cost AND the ceiling
      // by one factor, so the two axes must agree model for model. If this ever
      // goes red, some rule has started reading a different quantity from the
      // others — which is exactly how a cost axis inverts a conclusion while
      // still looking sorted. It also proves the veto is scale-invariant, so it
      // does not matter whether a supplier returns absolute tokens or a figure
      // already normalised to SC_REFERENCE.
      const CONSTANT = 1000;
      const perToken = run();
      const perTask = runTask({ tokensPerTask: () => CONSTANT });

      expect(perTask.basis).toBe("cost/task");
      expect(perTask.considered.map((c) => c.key)).toEqual(perToken.considered.map((c) => c.key));
      expect(perTask.excluded).toEqual(perToken.excluded);
      expect(perTask.anchorKey).toBe(perToken.anchorKey);
      expect(perTask.pick).toBe(perToken.pick);
      expect(perTask.costVerified).toBe(perToken.costVerified);
      expect(perTask.ceiling).toBeCloseTo((perToken.ceiling ?? 0) * CONSTANT, 6);

      // Strip the three per-task keys and the payload IS the old one.
      const stripped = perTask.considered.map((c) => ({
        key: c.key,
        provider: c.provider,
        model: c.model,
        intelligenceIndex: c.intelligenceIndex,
        relCost: c.relCost,
        rank: c.rank,
      }));
      expect(JSON.stringify(stripped)).toBe(JSON.stringify(perToken.considered));
    });

    it("propagates costBasisConfidence and defaults it to unknown", () => {
      const result = runTask({ costBasisConfidenceFor: (key) => CONFIDENCE[key] });
      const seen = new Map(result.considered.map((c) => [c.key, c.costBasisConfidence]));

      expect(seen.get(OPUS)).toBe("measured");
      expect(seen.get(DEEPSEEK)).toBe("anchored");
      expect(seen.get(GROK)).toBe("estimated");
      // No row in the provenance table => "unknown", never a guessed "estimated".
      // Eleven of the thirteen published rows are estimates, so a consumer that
      // cannot tell an estimate from a measurement is the failure this prevents.
      expect(seen.get(SONNET)).toBe("unknown");

      // And with no supplier at all, every candidate says so honestly.
      expect(runTask().considered.every((c) => c.costBasisConfidence === "unknown")).toBe(true);
    });

    it("never emits costBasisConfidence on the token basis, even with a supplier", () => {
      const result = run({ costBasisConfidenceFor: () => "measured" });

      expect(result.basis).toBe("cost/token");
      // There is no per-task number for a provenance to describe, so the field
      // would be noise — and emitting it would break the byte-identity promise.
      expect(result.considered.every((c) => !("costBasisConfidence" in c))).toBe(true);
    });

    it("never falls back to cost/token when the token table has a hole", () => {
      // sol is PRICED but has no published tokens-per-task row. It must not be
      // ranked or vetoed on its cost/token figure — half a band on one axis and
      // half on the other is a sorted-looking answer to no question at all. On
      // the full table sol is cost-vetoed; here it must survive as UNCHECKED.
      const result = runTask({
        tokensPerTask: (key) => (key === SOL ? undefined : TASK_TOKENS[key]),
      });
      const sol = result.considered.find((c) => c.key === SOL);

      expect(sol?.relCost).toBe(0.2679);
      expect(sol?.tokensPerTask).toBeUndefined();
      expect(sol?.costPerTask).toBeUndefined();
      expect(sol?.costBasisConfidence).toBe("unknown");
      // Uncosted is never vetoed — it is unchecked, and costVerified says so.
      expect(reasonFor(result, SOL)).toBeUndefined();
      expect(result.costVerified).toBe(false);
      // And its band keeps AA order rather than ranking on a half-known cost.
      const order = result.considered.map((c) => c.key);
      expect(order.indexOf(SOL)).toBeLessThan(order.indexOf(GROK));
    });

    it("treats a zero or negative token count as MISSING, not as free", () => {
      // A 0 would drive the effective cost to zero and float the model to the top
      // of its band where no ceiling can reach it. That is not a cheap model, it
      // is a broken row — the mirror of "an invented price must never veto".
      const result = runTask({
        tokensPerTask: (key) => {
          if (key === KIMI) {
            return 0;
          }
          if (key === GLM) {
            return -1;
          }
          return TASK_TOKENS[key];
        },
      });
      const kimi = result.considered.find((c) => c.key === KIMI);

      expect(kimi?.tokensPerTask).toBeUndefined();
      expect(kimi?.costPerTask).toBeUndefined();
      expect(result.considered[0].key).toBe(OPUS);
      expect(result.costVerified).toBe(false);
    });

    it("keeps rule 2 and rule 4 intact on the per-task axis", () => {
      // Cost is still a VETO, never a promotion: grok is the cheapest survivor per
      // task (257.28 against opus-5's 1003.73) and stays at rank 2, because it is
      // more than a full AA point down and cost cannot cross a band boundary.
      expect(runTask().considered.find((c) => c.key === GROK)?.rank).toBe(2);

      // And exhaustion still outranks the whole cost axis.
      const spent = runTask({ snapshot: spentProvider("xai") });
      expect(reasonFor(spent, GROK)).toBe("provider-exhausted");
      expect(spent.considered.map((c) => c.key)).toEqual([OPUS, SONNET, DEEPSEEK]);
      expect(spent.anchorKey).toBe(OPUS);
    });
  });
});
