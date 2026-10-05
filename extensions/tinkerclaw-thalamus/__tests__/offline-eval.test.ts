import { describe, expect, it } from "vitest";
import {
  DIGESTERS,
  digestLoss,
  evaluateCacheLedger,
  syntheticLongResult,
  type CallRow,
} from "../../../src/shared/thalamus-offline-eval.js";

// Paper section 10, tests 3 and 4, on data small enough to check by hand.

const OPUS = "claude-code/claude-opus-5";
const T0 = 1_800_000_000_000;
const row = (over: Partial<CallRow>): CallRow => ({
  src: "t",
  ts: T0,
  conv: "c1",
  model: OPUS,
  input: 100,
  cacheRead: 0,
  cacheWrite: 0,
  output: 200,
  ...over,
});

describe("test 3: the cache ledger against what was billed", () => {
  // A conversation that keeps its cache: the ledger predicts every call's cached tokens exactly.
  const steady = [
    row({ ts: T0, input: 100, cacheRead: 0, cacheWrite: 20_000 }),
    row({ ts: T0 + 60_000, input: 50, cacheRead: 20_000, cacheWrite: 1_000 }),
    row({ ts: T0 + 120_000, input: 40, cacheRead: 21_000, cacheWrite: 500 }),
    // Three hours later the cache is gone, and the ledger says so.
    row({ ts: T0 + 3 * 3_600_000, input: 30, cacheRead: 0, cacheWrite: 25_000 }),
  ];

  it("scores every call but the first of a conversation, and predicts a steady conversation exactly", () => {
    const e = evaluateCacheLedger(steady);
    expect(e.calls).toBe(4);
    expect(e.skipped).toEqual({ firstOfConversation: 1, noCachePolicy: 0, tooSmall: 0 });
    expect(e.scored).toBe(3);
    expect(e.warm).toMatchObject({ tp: 2, tn: 1, fp: 0, fn: 0, accuracy: 1 });
    expect(e.cachedTokens).toEqual({ actual: 41_000, predicted: 41_000, wape: 0, bias: 0 });
    expect(e.byModel).toHaveLength(1);
    expect(e.byModel[0]).toMatchObject({ model: OPUS, scored: 3, wape: 0, bias: 0 });
  });

  it("buckets by the gap since the conversation's last call and shows what happened in each", () => {
    const e = evaluateCacheLedger(steady);
    const by = Object.fromEntries(e.byGap.map((g) => [g.bucket, g]));
    expect(by["1 to 5 min"]).toMatchObject({ n: 2, actualWarmShare: 1, predictedWarmShare: 1 });
    expect(by["over 60 min"]).toMatchObject({ n: 1, actualWarmShare: 0, predictedWarmShare: 0 });
    expect(by["under 1 min"].n).toBe(0);
  });

  it("the input-side bill from the prediction is close to the real one: it treats the tail as a write, the provider bills some of it plain", () => {
    const e = evaluateCacheLedger(steady);
    expect(e.inputBill.actualUsd).toBeGreaterThan(0);
    expect(e.inputBill.relError).toBeGreaterThan(0);
    expect(e.inputBill.relError).toBeLessThan(0.05);
  });

  it("uses the write tier the provider reports: a five-minute cache is cold after ten minutes, and the ledger knows it", () => {
    const rows = [
      row({ ts: T0, cacheWrite: 20_000, cache5m: 20_000, cache1h: 0 }),
      row({
        ts: T0 + 10 * 60_000,
        input: 50,
        cacheRead: 0,
        cacheWrite: 20_000,
        cache5m: 20_000,
        cache1h: 0,
      }),
    ];
    const told = evaluateCacheLedger(rows);
    expect(told.warm).toMatchObject({ tn: 1, fp: 0 });
    expect(told.tiers).toEqual({ fiveMinute: 2, oneHour: 0, unreported: 0 });
    // The same calls with no tier reported fall back to the one-hour assumption, and the ledger is wrong about them.
    const unknown = evaluateCacheLedger(rows.map((r) => ({ ...r, cache5m: null, cache1h: null })));
    expect(unknown.warm).toMatchObject({ fp: 1, tn: 0 });
    expect(unknown.byGap.find((g) => g.bucket === "5 to 30 min")).toMatchObject({
      n: 1,
      actualWarmShare: 0,
      predictedWarmShare: 1,
    });
    expect(unknown.tiers.unreported).toBe(2);
  });

  it("caps a prediction at the prompt's size, and reports how far off the cached tokens were, as a share of the real ones", () => {
    // The thread was compacted from 30,000 tokens to 10,100: the ledger holds 30,000 warm, but only 10,100 can be read.
    const rows = [
      row({ ts: T0, conv: "c2", cacheWrite: 30_000 }),
      row({ ts: T0 + 1000, conv: "c2", cacheRead: 10_000, cacheWrite: 0, input: 100 }),
    ];
    const e = evaluateCacheLedger(rows);
    expect(e.scored).toBe(1);
    expect(e.warm).toMatchObject({ tp: 1 });
    expect(e.cachedTokens.predicted).toBe(10_100);
    expect(e.cachedTokens.actual).toBe(10_000);
    expect(e.cachedTokens.wape).toBeCloseTo(0.01, 12);
    expect(e.cachedTokens.bias).toBeCloseTo(0.01, 12);
  });

  it("calls a cache the ledger thought warm and the provider had dropped a false warm, and a warm one it thought cold a miss", () => {
    const rows = [
      row({ ts: T0, conv: "a", cacheWrite: 20_000 }),
      row({ ts: T0 + 1000, conv: "a", input: 20_000, cacheRead: 0 }), // ledger: warm. Provider: dropped it.
      row({ ts: T0, conv: "b", cacheWrite: 20_000 }),
      row({ ts: T0 + 3 * 3_600_000, conv: "b", input: 100, cacheRead: 20_000 }), // ledger: cold by then. Provider: still had it.
    ];
    const e = evaluateCacheLedger(rows);
    expect(e.warm).toMatchObject({ fp: 1, fn: 1, tp: 0, tn: 0, accuracy: 0 });
  });

  it("does not score a model with no cache figure, a tiny prompt, or a conversation's first call, and says how many of each", () => {
    const rows = [
      row({ model: "nobody/unknown", ts: T0 }),
      row({ model: "nobody/unknown", ts: T0 + 1000 }),
      row({ ts: T0, conv: "x", cacheWrite: 500, input: 10 }),
      row({ ts: T0 + 1000, conv: "x", cacheRead: 500, input: 10 }),
    ];
    const e = evaluateCacheLedger(rows);
    expect(e.scored).toBe(0);
    expect(e.skipped).toEqual({ firstOfConversation: 2, noCachePolicy: 1, tooSmall: 1 });
  });

  it("gives the same answer for the same rows in any order", () => {
    const shuffled = [steady[2], steady[0], steady[3], steady[1]];
    expect(evaluateCacheLedger(shuffled)).toEqual(evaluateCacheLedger(steady));
  });
});

describe("test 4: digests, the details lost and the reads to get them back", () => {
  const cases = (at: number, n = 50) =>
    Array.from({ length: n }, (_, i) => syntheticLongResult(i + 1, 300, at));

  it("builds a long result with exactly one detail, at the asked place, the same every time", () => {
    const a = syntheticLongResult(7, 200, 0.5);
    const b = syntheticLongResult(7, 200, 0.5);
    expect(a).toEqual(b);
    expect(a.raw.split("\n")).toHaveLength(200);
    expect(a.raw.split("\n")[100]).toBe(a.needle);
    expect(a.raw.split("\n").filter((l) => l.includes("invoice"))).toHaveLength(1);
    expect(syntheticLongResult(8, 200, 0.5).needle).not.toBe(a.needle);
  });

  it("truncation loses a detail in the middle, keeps one at either end, and each lost detail costs one read that brings it back", () => {
    const digester = DIGESTERS.headTail(0.3);
    const middle = digestLoss(cases(0.5), digester);
    expect(middle).toMatchObject({
      cases: 50,
      lost: 50,
      lostShare: 1,
      extraReads: 50,
      recovered: 50,
    });
    expect(middle.keptShare).toBeLessThan(0.4);
    expect(digestLoss(cases(0.02), digester).lost).toBe(0);
    expect(digestLoss(cases(0.99), digester).lost).toBe(0);
  });

  it("a digester that keeps lines that look like facts loses none of these details, and a perfect one neither", () => {
    expect(digestLoss(cases(0.5), DIGESTERS.extractive).lost).toBe(0);
    expect(digestLoss(cases(0.5), (raw) => raw).lost).toBe(0);
  });

  it("counts a recall path that does not bring the detail back as lost for good", () => {
    const broken = digestLoss(cases(0.5), DIGESTERS.headTail(0.3), () => "");
    expect(broken).toMatchObject({ lost: 50, extraReads: 50, recovered: 0 });
  });

  it("handles no cases", () => {
    expect(digestLoss([], DIGESTERS.extractive)).toEqual({
      cases: 0,
      lost: 0,
      lostShare: 0,
      extraReads: 0,
      recovered: 0,
      keptShare: 0,
    });
  });
});
