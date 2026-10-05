import { describe, expect, it } from "vitest";
import { applyCallUsage, EMPTY_CACHE_LEDGER } from "./thalamus-cache-ledger.js";
import { allowedFeeds, enumerateOptions } from "./thalamus-options.js";
import { cachePolicyFor } from "./thalamus-price-table.js";
import {
  amortize,
  barFor,
  DEPTH_RELIEF,
  P_FAIL_CEILING,
  priceOption,
  qualityOf,
  type PriceContext,
} from "./thalamus-price.js";
import type { Option } from "./thalamus-v4-types.js";
import { GROK, HAIKU, NOW, OPUS, R, rung, supplies } from "./thalamus-v4.test-support.js";

const ctx = (over: Partial<PriceContext> = {}): PriceContext => ({
  cache: EMPTY_CACHE_LEDGER,
  conversationKey: "conv",
  nowMs: NOW,
  supplies: supplies(),
  urgency: "whenever",
  depth: "routine",
  slackSec: 0,
  qualityFor: (_k, _e, smart) => smart,
  ...over,
});

const opt = (
  r = R.opus,
  feed: Option["feed"] = "thread",
  inputTokens = 100_000,
  out = 1000,
): Option => ({
  rung: r,
  feed,
  inputTokens,
  expectedOutputTokens: out,
});

const warm = (key: string, tokens: number) =>
  applyCallUsage(
    EMPTY_CACHE_LEDGER,
    {
      conversationKey: "conv",
      modelKey: key,
      nowMs: NOW - 1000,
      input: 0,
      cacheRead: tokens,
      cacheWrite: 0,
    },
    cachePolicyFor(key),
  );

describe("options", () => {
  const rungs = [R.opus, R.haiku, R.grok];

  it("allows only the thread when the step needs all of it", () => {
    expect(allowedFeeds("all", true)).toEqual(["thread"]);
  });

  it("offers a brief for the recent part, a digest only when there is a long result", () => {
    expect(allowedFeeds("recent", false)).toEqual(["thread", "brief"]);
    expect(allowedFeeds("item", false)).toEqual(["brief", "thread"]);
    expect(allowedFeeds("item", true)).toEqual(["digest", "brief", "thread"]);
  });

  it("enumerates rung x feed, in rung order", () => {
    const out = enumerateOptions({
      rungs,
      needs: "recent",
      feedTokens: { thread: 100_000, brief: 4_000 },
      expectedOutputTokens: () => 500,
    });
    expect(out).toHaveLength(6);
    expect(out.map((o) => `${o.rung.key}:${o.feed}`)).toEqual([
      `${OPUS}:thread`,
      `${OPUS}:brief`,
      `${HAIKU}:thread`,
      `${HAIKU}:brief`,
      `${GROK}:thread`,
      `${GROK}:brief`,
    ]);
    expect(out[1].inputTokens).toBe(4_000);
  });

  it("skips a feed with no token count", () => {
    const out = enumerateOptions({
      rungs,
      needs: "item",
      hasLongResult: true,
      feedTokens: { thread: 100_000 },
      expectedOutputTokens: () => 500,
    });
    expect(out.map((o) => o.feed)).toEqual(["thread", "thread", "thread"]);
  });
});

describe("price: money from the cache ledger", () => {
  it("charges a cold thread its cache write (Opus 5, 100k in, 1k out, one-hour write)", () => {
    const p = priceOption(opt(), ctx());
    // (100,000 x $5 x 2 + 1,000 x $25) / 1e6 = $1.025, x 0.92 EUR/USD
    expect(p.parts.money).toBeCloseTo(1.025 * 0.92, 6);
    expect(p.parts.moneyKnown).toBe(true);
    expect(p.prediction).toEqual({ cachedIn: 0, uncachedIn: 0, writeIn: 100_000 });
  });

  it("charges a warm thread the cache-read price", () => {
    const p = priceOption(opt(), ctx({ cache: warm(OPUS, 100_000) }));
    // (100,000 x $0.5 + 1,000 x $25) / 1e6 = $0.075
    expect(p.parts.money).toBeCloseTo(0.075 * 0.92, 6);
    expect(p.prediction.cachedIn).toBe(100_000);
  });

  it("uses the five-minute write when told to", () => {
    const p = priceOption(opt(), ctx({ writeTier: "5m" }));
    expect(p.parts.money).toBeCloseTo(((100_000 * 5 * 1.25 + 1000 * 25) / 1e6) * 0.92, 6);
  });

  it("treats a brief as one-shot input: no cache hit, no write premium", () => {
    const p = priceOption(opt(R.haiku, "brief", 3_000, 500), ctx({ cache: warm(HAIKU, 3_000) }));
    expect(p.parts.money).toBeCloseTo(((3_000 * 1 + 500 * 5) / 1e6) * 0.92, 8);
    expect(p.prediction).toEqual({ cachedIn: 0, uncachedIn: 3_000, writeIn: 0 });
  });

  it("charges an automatic-cache vendor plain input for new tokens", () => {
    const p = priceOption(opt(R.grok, "thread", 10_000, 0), ctx());
    expect(p.parts.money).toBeCloseTo(((10_000 * 2) / 1e6) * 0.92, 8);
  });

  it("falls back to v2's per-task figure, flagged, for a model with no price row", () => {
    const p = priceOption(opt(rung("openai-codex/gpt-9-unlisted", "high", 70, 3.3)), ctx());
    expect(p.parts.moneyKnown).toBe(false);
    expect(p.parts.money).toBe(3.3);
  });

  it("tags list-priced money as list, and plan-priced money as plan when a factor is set", () => {
    expect(priceOption(opt(), ctx()).moneyBasis).toBe("list");
    const plan = priceOption(opt(), ctx({ planFactor: { anthropic: 0.25 } }));
    expect(plan.moneyBasis).toBe("plan");
    expect(plan.parts.money).toBeCloseTo(priceOption(opt(), ctx()).parts.money * 0.25, 8);
    // A factor for another supply does not change this one's basis.
    expect(priceOption(opt(), ctx({ planFactor: { xai: 0.5 } })).moneyBasis).toBe("list");
  });
});

describe("price: a rung with no price row is put on the anchor's unit (B-review correction 1)", () => {
  const unknown = (cost: number) => rung("openai-codex/gpt-9-unlisted", "high", 70, cost);
  const tokens = (r: typeof R.opus) => opt(r, "thread", 100_000, 1000);

  it("prices within 1% of the anchor for the same tokens when its v2 cost equals the anchor's", () => {
    const c = ctx({ anchorRung: R.opus });
    const anchor = priceOption(tokens(R.opus), c);
    const u = priceOption(tokens(unknown(R.opus.cost)), c);
    expect(u.parts.moneyKnown).toBe(false);
    expect(u.parts.unanchored).toBe(false);
    expect(u.parts.money / anchor.parts.money).toBeGreaterThan(0.99);
    expect(u.parts.money / anchor.parts.money).toBeLessThan(1.01);
  });

  it("scales by the v2 cost ratio", () => {
    const c = ctx({ anchorRung: R.opus });
    const anchor = priceOption(tokens(R.opus), c);
    expect(priceOption(tokens(unknown(R.opus.cost / 2)), c).parts.money).toBeCloseTo(
      anchor.parts.money / 2,
      8,
    );
    expect(priceOption(tokens(unknown(R.opus.cost * 3)), c).parts.money).toBeCloseTo(
      anchor.parts.money * 3,
      8,
    );
  });

  it("is not a per-task figure any more: the anchor's per-call money, not v2's cost", () => {
    const u = priceOption(tokens(unknown(R.opus.cost)), ctx({ anchorRung: R.opus }));
    expect(u.parts.money).not.toBe(R.opus.cost);
  });

  it("is unanchored when the anchor has no price row either", () => {
    const u = priceOption(tokens(unknown(5)), ctx({ anchorRung: unknown(5) }));
    expect(u.parts.moneyKnown).toBe(false);
    expect(u.parts.unanchored).toBe(true);
  });

  it("is unanchored when there is no anchor at all, or the anchor's cost is not positive", () => {
    expect(priceOption(tokens(unknown(5)), ctx()).parts.unanchored).toBe(true);
    expect(
      priceOption(tokens(unknown(5)), ctx({ anchorRung: { ...R.opus, cost: 0 } })).parts.unanchored,
    ).toBe(true);
  });

  it("leaves a priced rung alone whatever the anchor is", () => {
    const p = priceOption(tokens(R.opus), ctx({ anchorRung: unknown(5) }));
    expect(p.parts.moneyKnown).toBe(true);
    expect(p.parts.unanchored).toBe(false);
  });
});

describe("price: pace, time and risk", () => {
  it("makes a scarce supply dearer and an expiring one cheaper, with a floor", () => {
    const base = priceOption(opt(), ctx()).price;
    const scarce = priceOption(opt(), ctx({ supplies: supplies({ anthropic: { shadow: 0.5 } }) }));
    expect(scarce.parts.pace).toBeCloseTo(1.3, 10);
    expect(scarce.price).toBeCloseTo(base * 1.3, 8);
    const cheap = priceOption(opt(), ctx({ supplies: supplies({ anthropic: { shadow: -1 } }) }));
    expect(cheap.parts.pace).toBe(0.4);
  });

  it("charges time only on the critical path", () => {
    const waiting = priceOption(opt(), ctx({ urgency: "waiting", slackSec: 0 }));
    const slack = priceOption(opt(), ctx({ urgency: "waiting", slackSec: 10_000 }));
    const overnight = priceOption(opt(), ctx({ urgency: "whenever", slackSec: 0 }));
    expect(waiting.parts.critSec).toBeCloseTo(waiting.parts.timeSec, 10);
    expect(slack.parts.critSec).toBe(0);
    expect(waiting.price).toBeGreaterThan(slack.price);
    expect(slack.price).toBeCloseTo(overnight.price, 10);
  });

  it("charges more time for a cold start than a warm one", () => {
    const cold = priceOption(opt(), ctx());
    const hot = priceOption(opt(), ctx({ cache: warm(OPUS, 100_000) }));
    expect(cold.parts.timeSec).toBeGreaterThan(hot.parts.timeSec);
  });

  it("adds the expected cost of failing, clamped", () => {
    const clean = priceOption(opt(), ctx());
    const risky = priceOption(opt(), ctx({ pFailFor: () => 0.2 }));
    expect(risky.price).toBeCloseTo(clean.price + 0.2 * risky.parts.recovery, 8);
    expect(priceOption(opt(), ctx({ pFailFor: () => 5 })).parts.pFail).toBe(P_FAIL_CEILING);
    expect(priceOption(opt(), ctx({ pFailFor: () => -1 })).parts.pFail).toBe(0);
  });

  it("puts the quality estimate on the option", () => {
    const p = priceOption(opt(), ctx({ qualityFor: (_k, _e, smart) => smart + 3 }));
    expect(p.quality).toBe(73);
  });
});

describe("price: averaging a thread over the run (P§5.1)", () => {
  const warmOpus = () =>
    priceOption(opt(R.opus, "thread", 100_000, 100), ctx({ cache: warm(OPUS, 100_000) }));
  const coldHaiku = () =>
    priceOption(opt(R.haiku, "thread", 100_000, 100), ctx({ cache: warm(OPUS, 100_000) }));
  const at = (o: ReturnType<typeof warmOpus>, n: number) =>
    amortize(o, n, ctx({ cache: warm(OPUS, 100_000) })).runPrice;

  it("leaves one-shot feeds and a single step alone", () => {
    const o = coldHaiku();
    expect(amortize(o, 1, ctx()).runPrice).toBe(o.price);
    const brief = priceOption(opt(R.haiku, "brief", 3_000), ctx());
    expect(amortize(brief, 10, ctx()).runPrice).toBe(brief.price);
  });

  it("keeps a warm incumbent's average at its per-step price", () => {
    const o = warmOpus();
    expect(at(o, 8)).toBeCloseTo(o.price, 10);
  });

  it("makes a cold cheaper candidate win exactly where N* says: between 4 and 5 steps for Opus 5 -> Haiku 4.5", () => {
    // N* = 4.75 with the one-hour write. Outputs are tiny here, so input dominates.
    const opus = warmOpus();
    const haiku = coldHaiku();
    expect(at(haiku, 4)).toBeGreaterThan(at(opus, 4));
    expect(at(haiku, 5)).toBeLessThan(at(opus, 5));
    expect(at(haiku, 2)).toBeGreaterThan(at(opus, 2));
    expect(at(haiku, 15)).toBeLessThan(at(opus, 15));
  });
});

describe("quality and the dial's bar", () => {
  it("is the general height when domain strength is unknown", () => {
    expect(qualityOf(70, undefined, 0.5)).toBe(70);
    expect(qualityOf(70, 0.5, undefined)).toBe(70);
  });

  it("moves by strength relative to the anchor", () => {
    expect(qualityOf(70, 0.8, 0.6)).toBeCloseTo(74, 10);
    expect(qualityOf(70, 0.4, 0.6)).toBeCloseTo(66, 10);
  });

  it("relaxes the bar for a mechanical step and not for a deep one", () => {
    expect(barFor(60, "deep")).toBe(60);
    expect(barFor(60, "routine")).toBe(60 - DEPTH_RELIEF.routine);
    expect(barFor(60, "mechanical")).toBe(60 - DEPTH_RELIEF.mechanical);
    expect(DEPTH_RELIEF.mechanical).toBeGreaterThan(DEPTH_RELIEF.routine);
  });
});
