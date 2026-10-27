import { describe, expect, it } from "vitest";
import { REFUSAL_TTL_MS } from "./thalamus-feasibility.js";
import {
  activeRefusalVetoes,
  aggregate,
  costFromCounts,
  estimates,
  EXPLORE_SHARE,
  exploreOption,
  LEARNING_KAPPA,
  learnedStrengthFor,
  percentile,
  posterior,
  refusalRecordsFrom,
  rungTimeFrom,
  rungTimeStats,
  type OutcomeFact,
} from "./thalamus-learning.js";
import { DEFAULT_RUNG_TIME } from "./thalamus-price.js";
import { routeCall } from "./thalamus-route-call.js";
import {
  answered,
  callParams,
  HAIKU,
  NOW,
  OPUS,
  R,
  SONNET,
  stepRead,
  taskRead,
} from "./thalamus-v4.test-support.js";

const fact = (over: Partial<OutcomeFact> = {}): OutcomeFact => ({
  ts: NOW,
  domain: "general",
  topic: "none",
  stepKind: "tool",
  rungKey: SONNET,
  outcome: "done",
  refused: false,
  input: 1000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 200,
  durationMs: 5000,
  ...over,
});

const many = (n: number, over: Partial<OutcomeFact> = {}) =>
  Array.from({ length: n }, () => fact(over));

describe("posterior", () => {
  it("is the map with no evidence, and half way at as many outcomes as kappa", () => {
    expect(LEARNING_KAPPA).toBe(10);
    expect(posterior(0.6, 0, 0)).toBe(0.6);
    // Ten outcomes, all wins: (10 x 0.6 + 10) / 20 = 0.8, half way from the map (0.6) to the record (1.0).
    expect(posterior(0.6, 10, 10)).toBeCloseTo(0.8, 12);
  });

  it("follows the record at a thousand outcomes", () => {
    expect(posterior(0.6, 1000, 1000)).toBeCloseTo((6 + 1000) / 1010, 12);
    expect(posterior(0.6, 500, 1000)).toBeCloseTo((6 + 500) / 1010, 12);
    expect(Math.abs(posterior(0.6, 500, 1000) - 0.5)).toBeLessThan(0.01);
  });

  it("stays within 0 and 1 whatever it is given, and never counts more wins than outcomes", () => {
    expect(posterior(2, 5, 3)).toBeLessThanOrEqual(1);
    expect(posterior(-1, -5, 3)).toBeGreaterThanOrEqual(0);
    expect(posterior(0.5, 99, 10)).toBe(posterior(0.5, 10, 10));
  });
});

describe("aggregate and estimates", () => {
  it("counts wins, retries and refusals per kind of work, kind of step and the model that answered", () => {
    const facts = [
      ...many(6),
      ...many(2, { outcome: "retry" }),
      fact({ outcome: "stuck" }),
      fact({ refused: true, outcome: "refused", topic: "medical" }),
      fact({ rungKey: HAIKU }),
      fact({ stepKind: "read" }),
    ];
    const c = aggregate(facts);
    expect(c.size).toBe(3);
    const sonnetTool = [...c.values()].find((x) => x.rung === SONNET && x.stepKind === "tool")!;
    expect(sonnetTool).toMatchObject({ n: 10, wins: 6, retries: 3, refusals: 1 });
    expect(sonnetTool.timeSum).toBeCloseTo(50, 9);
    expect(sonnetTool.costSum).toBeGreaterThan(0);
  });

  it("prices a call from its counts at list price, and says nothing for a model with no price row", () => {
    const cheap = costFromCounts(fact({ rungKey: HAIKU, input: 1_000_000, output: 0 }))!;
    const dear = costFromCounts(fact({ rungKey: OPUS, input: 1_000_000, output: 0 }))!;
    expect(dear).toBeGreaterThan(cheap);
    expect(costFromCounts(fact({ rungKey: "nobody/unknown" }))).toBeUndefined();
  });

  it("moves each estimate from its prior toward the record, sorted and stable", () => {
    const c = aggregate([...many(10), ...many(1000, { rungKey: HAIKU })]);
    const table = estimates(c, () => 0.6);
    expect(table.map((e) => e.rung)).toEqual([HAIKU, SONNET].sort());
    const haiku = table.find((e) => e.rung === HAIKU)!;
    const sonnet = table.find((e) => e.rung === SONNET)!;
    expect(sonnet.posterior).toBeCloseTo(0.8, 12);
    expect(haiku.posterior).toBeCloseTo(1006 / 1010, 12);
    expect(haiku.prior).toBe(0.6);
  });
});

describe("the ledger reaches the router's choice (not a stored flag)", () => {
  // Opus is the anchor with a public strength of 0.6; Sonnet has the same public strength but sits 6 points lower.
  // The bar is 70 at deep work: only Opus clears it on the public map. Quality = smart + 20 x (strength - anchor's).
  const base = (key: string): number | undefined =>
    key === OPUS || key === SONNET ? 0.6 : undefined;
  const pick = (strengthFor: (k: string, d: never) => number | undefined) =>
    routeCall(
      callParams({
        rungs: [R.opus, R.sonnet],
        anchorKey: OPUS,
        strengthFor: strengthFor as never,
        dialBar: 70,
        step: stepRead({ depth: answered("deep" as const), needs: answered("item" as const) }),
        task: taskRead(),
        freshPoint: true,
        feedTokens: { thread: 1000, brief: 1000 },
      }),
    )!;
  const sonnetRecord = (n: number) => estimates(aggregate(many(n, { rungKey: SONNET })), () => 0.6);

  it("picks the public map's choice with no record, and with ten outcomes stays near the map", () => {
    expect(pick(base).chosen.rung.key).toBe(OPUS);
    // Ten wins move Sonnet to 0.8: 64 + 20 x (0.8 - 0.6) = 68, still below the bar of 70.
    const ten = learnedStrengthFor(base, sonnetRecord(10));
    expect(ten(SONNET, "general")).toBeCloseTo(0.8, 12);
    expect(pick(ten as never).chosen.rung.key).toBe(OPUS);
  });

  it("follows the record at a thousand outcomes: Sonnet now clears the bar and, being cheaper, is the pick", () => {
    const thousand = learnedStrengthFor(base, sonnetRecord(1000));
    expect(thousand(SONNET, "general")).toBeGreaterThan(0.99);
    const d = pick(thousand as never);
    expect(d.chosen.rung.key).toBe(SONNET);
    expect(d.chosen.quality).toBeGreaterThanOrEqual(70);
  });

  it("moves the other way too: a record of failures drags a rung under the bar", () => {
    const failing = learnedStrengthFor(
      (k) => (k === OPUS ? 0.6 : k === SONNET ? 0.95 : undefined),
      estimates(aggregate(many(1000, { rungKey: SONNET, outcome: "retry" })), () => 0.95),
    );
    // On the public map Sonnet's 0.95 lifts it to 64 + 7 = 71 and it wins on price; after a thousand retries it is 0.01.
    const before = pick(((k: string) =>
      k === OPUS ? 0.6 : k === SONNET ? 0.95 : undefined) as never);
    expect(before.chosen.rung.key).toBe(SONNET);
    expect(pick(failing as never).chosen.rung.key).toBe(OPUS);
  });

  it("leaves a public number alone where the ledger has nothing, and needs real evidence where there is no public number", () => {
    const table = sonnetRecord(10);
    const learned = learnedStrengthFor(base, table);
    expect(learned(OPUS, "general")).toBe(0.6);
    expect(learned(SONNET, "coding" as never)).toBe(0.6);
    const none = learnedStrengthFor(() => undefined, table);
    expect(none(SONNET, "general")).toBeUndefined(); // 10 outcomes: below the 20 a ledger needs to speak alone
    const enough = learnedStrengthFor(() => undefined, sonnetRecord(40));
    expect(enough(SONNET, "general")).toBeGreaterThan(0.5);
  });

  it("pools the kinds of step for a route and a kind of work", () => {
    const c = aggregate([...many(5, { stepKind: "tool" }), ...many(5, { stepKind: "read" })]);
    const learned = learnedStrengthFor(
      () => 0.6,
      estimates(c, () => 0.6),
    );
    expect(learned(SONNET, "general")).toBeCloseTo(0.8, 12);
  });
});

describe("time per rung, and the slow end a hedge waits past", () => {
  const timed = (n: number, over: Partial<OutcomeFact> = {}) =>
    Array.from({ length: n }, (_, i) =>
      fact({ durationMs: (i + 1) * 1000, ttftMs: 500 + i * 10, output: 600, ...over }),
    );

  it("takes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it("measures p50 and p95 per rung from 100 calls, and skips a rung with too few", () => {
    const s = rungTimeStats([...timed(100), ...timed(5, { rungKey: HAIKU })]);
    expect(s.map((x) => x.rung)).toEqual([SONNET]);
    expect(s[0]).toMatchObject({ n: 100, durationP50Sec: 50, durationP95Sec: 95 });
    expect(s[0].ttftP95Sec).toBeCloseTo(0.5 + 94 * 0.01, 9);
    expect(s[0].tokensPerSecP5!).toBeLessThan(s[0].tokensPerSecP50!);
  });

  it("separates the first token of a warm cache from a cold one", () => {
    const warm = timed(30, { cacheRead: 900, input: 100, ttftMs: 400 });
    const cold = timed(30, { cacheRead: 0, input: 1000, ttftMs: 2400 });
    const s = rungTimeStats([...warm, ...cold])[0];
    expect(s.ttftWarmP50Sec).toBeCloseTo(0.4, 9);
    expect(s.ttftColdP50Sec).toBeCloseTo(2.4, 9);
  });

  it("builds a RungTime: typical from the medians, slow from the slow end, the class default for what is missing", () => {
    const stats = rungTimeStats(timed(100))[0];
    const typical = rungTimeFrom(stats, DEFAULT_RUNG_TIME, "typical");
    const slow = rungTimeFrom(stats, DEFAULT_RUNG_TIME, "slow");
    expect(slow.tokensPerSec).toBeLessThan(typical.tokensPerSec);
    expect(slow.ttftColdSec).toBeGreaterThanOrEqual(typical.ttftColdSec);
    expect(typical.thinkSec).toEqual(DEFAULT_RUNG_TIME.thinkSec);
    expect(rungTimeFrom(undefined, DEFAULT_RUNG_TIME, "slow")).toBe(DEFAULT_RUNG_TIME);
  });
});

describe("refusals from the ledger", () => {
  const refused = (over: Partial<OutcomeFact> = {}) =>
    fact({ refused: true, outcome: "refused", topic: "medical", rungKey: OPUS, ...over });

  it("turns refused calls in a class into the records the veto reads, inside their 30 days", () => {
    const facts = [
      refused(),
      refused({ ts: NOW - 29 * 86_400_000 }),
      refused({ ts: NOW - REFUSAL_TTL_MS - 1 }),
      refused({ topic: "none" }),
      fact(),
    ];
    const recs = refusalRecordsFrom(facts, NOW);
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.cls === "medical")).toBe(true);
    expect(new Set(recs.map((r) => r.family))).toEqual(new Set(["claude-opus-5"]));
  });

  it("reports a (family, class) only from the second refusal, as the router's veto does", () => {
    const one = refusalRecordsFrom([refused()], NOW);
    expect(activeRefusalVetoes(one, NOW)).toEqual([]);
    const two = refusalRecordsFrom([refused(), refused({ ts: NOW - 1000 })], NOW);
    expect(activeRefusalVetoes(two, NOW)).toEqual([
      { family: "claude-opus-5", cls: "medical", count: 2 },
    ]);
  });

  it("vetoes the family for that class in the router itself, and not for another class", () => {
    const records = refusalRecordsFrom([refused(), refused({ ts: NOW - 1000 })], NOW);
    const route = (topic: "medical" | "none") =>
      routeCall(
        callParams({
          rungs: [R.opus, R.sonnet, R.haiku],
          refusals: records,
          task: taskRead({ topic: answered(topic, 0.95) }),
          freshPoint: true,
        }),
      )!;
    expect(route("medical").vetoes.some((v) => v.key === OPUS)).toBe(true);
    expect(route("none").vetoes.some((v) => v.key === OPUS)).toBe(false);
  });
});

describe("exploration", () => {
  const opt = (key: string, quality: number) => ({ rung: { key, effort: "" }, quality });
  const a = opt("p/a", 70);
  const b = opt("p/b", 68);
  const c = opt("p/c", 60);
  const base = { options: [a, b, c], pick: a, bar: 65, calls: 0, explored: 0, rand: 0.01 };

  it("only on overnight work: nothing for waiting or today", () => {
    expect(exploreOption({ ...base, urgency: "whenever" })).toBe(b);
    expect(exploreOption({ ...base, urgency: "waiting" })).toBeUndefined();
    expect(exploreOption({ ...base, urgency: "today" })).toBeUndefined();
  });

  it("only an option that still clears the bar, and never the pick itself", () => {
    const r = exploreOption({ ...base, urgency: "whenever" });
    expect(r).not.toBe(a);
    expect(r).not.toBe(c);
    expect(exploreOption({ ...base, urgency: "whenever", options: [a, c] })).toBeUndefined();
    expect(exploreOption({ ...base, urgency: "whenever", options: [a] })).toBeUndefined();
  });

  it("at most five per cent of a job's calls, and only on a small draw", () => {
    expect(EXPLORE_SHARE).toBe(0.05);
    expect(exploreOption({ ...base, urgency: "whenever", rand: 0.05 })).toBeUndefined();
    expect(exploreOption({ ...base, urgency: "whenever", rand: 0.9 })).toBeUndefined();
    expect(exploreOption({ ...base, urgency: "whenever", calls: 99, explored: 5 })).toBeUndefined();
    expect(exploreOption({ ...base, urgency: "whenever", calls: 99, explored: 4 })).toBe(b);
  });

  it("is the same for the same draw, and a bigger draw reaches further down the list", () => {
    const wide = {
      ...base,
      urgency: "whenever" as const,
      options: [a, b, opt("p/d", 69), opt("p/e", 66)],
    };
    const lo = exploreOption({ ...wide, rand: 0.001 });
    expect(exploreOption({ ...wide, rand: 0.001 })).toBe(lo);
    expect(exploreOption({ ...wide, rand: 0.049 })).not.toBe(lo);
  });

  it("over a thousand draws explores about five per cent and every alternative gets tried", () => {
    let explored = 0;
    const seen = new Set<string>();
    const wide = {
      ...base,
      urgency: "whenever" as const,
      options: [a, b, opt("p/d", 69), opt("p/e", 66)],
    };
    for (let i = 0; i < 1000; i++) {
      const r = exploreOption({ ...wide, calls: 1000, explored: 0, rand: i / 1000 });
      if (r) {
        explored += 1;
        seen.add(r.rung.key);
      }
    }
    expect(explored).toBe(50);
    expect(seen).toEqual(new Set(["p/b", "p/d", "p/e"]));
  });
});
