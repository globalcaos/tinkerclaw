import { describe, expect, it } from "vitest";
import {
  applyCallUsage,
  EMPTY_CACHE_LEDGER,
  isWarm,
  ledgerKey,
  predictCall,
  pruneLedger,
  warmUntilMs,
} from "./thalamus-cache-ledger.js";
import { cachePolicyFor } from "./thalamus-price-table.js";
import { HAIKU, NOW, OPUS, SONNET, GROK } from "./thalamus-v4.test-support.js";

const opusPolicy = cachePolicyFor(OPUS)!;
const grokPolicy = cachePolicyFor(GROK)!;
const HOUR = 3_600_000;
const MIN = 60_000;

const write = (t: number, tokens: number, tier: "5m" | "1h" = "1h") => ({
  conversationKey: "c",
  modelKey: OPUS,
  nowMs: t,
  input: 10,
  cacheRead: 0,
  cacheWrite: tokens,
  writeTier: tier,
});

describe("cache ledger: warming and expiry", () => {
  it("a write warms the model until the tier's lifetime ends", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), opusPolicy);
    const e = l.get(ledgerKey("c", OPUS))!;
    expect(e.warmTokens).toBe(4420);
    expect(e.ttlMs).toBe(HOUR);
    expect(warmUntilMs(e)).toBe(NOW + HOUR);
    expect(isWarm(e, NOW + 59 * MIN)).toBe(true);
    expect(isWarm(e, NOW + 61 * MIN)).toBe(false);
  });

  it("a five-minute write expires in five minutes", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 5000, "5m"), opusPolicy);
    const e = l.get(ledgerKey("c", OPUS))!;
    expect(isWarm(e, NOW + 4 * MIN)).toBe(true);
    expect(isWarm(e, NOW + 6 * MIN)).toBe(false);
  });

  it("a read refreshes the lifetime it found", () => {
    let l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), opusPolicy);
    l = applyCallUsage(
      l,
      {
        conversationKey: "c",
        modelKey: OPUS,
        nowMs: NOW + 50 * MIN,
        input: 5,
        cacheRead: 4420,
        cacheWrite: 0,
      },
      opusPolicy,
    );
    const e = l.get(ledgerKey("c", OPUS))!;
    expect(e.lastReadAtMs).toBe(NOW + 50 * MIN);
    expect(isWarm(e, NOW + 100 * MIN)).toBe(true);
    expect(isWarm(e, NOW + 111 * MIN)).toBe(false);
  });

  it("does not mutate the ledger it was given", () => {
    const before = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), opusPolicy);
    const size = before.size;
    applyCallUsage(before, write(NOW + 1, 9000), opusPolicy);
    expect(before.size).toBe(size);
    expect(before.get(ledgerKey("c", OPUS))!.warmTokens).toBe(4420);
    expect(EMPTY_CACHE_LEDGER.size).toBe(0);
  });

  it("ignores negative or non-finite counts", () => {
    const l = applyCallUsage(
      EMPTY_CACHE_LEDGER,
      {
        conversationKey: "c",
        modelKey: OPUS,
        nowMs: NOW,
        input: -5,
        cacheRead: Number.NaN,
        cacheWrite: 100,
      },
      opusPolicy,
    );
    expect(l.get(ledgerKey("c", OPUS))!.warmTokens).toBe(100);
  });

  it("records nothing for a model with no cache figure, and prices its input in full", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), undefined);
    expect(l).toBe(EMPTY_CACHE_LEDGER);
    expect(predictCall(l, "c", OPUS, 1000, NOW, undefined)).toEqual({
      cachedIn: 0,
      uncachedIn: 1000,
      writeIn: 0,
    });
  });
});

describe("cache ledger: predicting a call", () => {
  it("reads the warm part and writes the new part on a vendor that charges to write", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), opusPolicy);
    expect(predictCall(l, "c", OPUS, 5329, NOW + 1000, opusPolicy)).toEqual({
      cachedIn: 4420,
      uncachedIn: 0,
      writeIn: 909,
    });
  });

  it("replays probe P2: after a warm Haiku call, Sonnet starts cold and writes the whole thread", () => {
    // Probe P2, 2026-09-30: call 1 on Haiku read 4,249 cached tokens; call 2, moved to Sonnet 5.5
    // with a 5,329-token thread, showed cache_read 0 and cache_creation 5,329.
    const haikuPolicy = cachePolicyFor(HAIKU)!;
    const l = applyCallUsage(
      EMPTY_CACHE_LEDGER,
      {
        conversationKey: "c",
        modelKey: HAIKU,
        nowMs: NOW,
        input: 10,
        cacheRead: 4249,
        cacheWrite: 0,
      },
      haikuPolicy,
    );
    expect(l.get(ledgerKey("c", HAIKU))!.warmTokens).toBe(4249);
    expect(predictCall(l, "c", SONNET, 5329, NOW + 500, cachePolicyFor(SONNET))).toEqual({
      cachedIn: 0,
      uncachedIn: 0,
      writeIn: 5329,
    });
  });

  it("never predicts more cached tokens than the prompt has", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 9000), opusPolicy);
    expect(predictCall(l, "c", OPUS, 4000, NOW, opusPolicy)).toEqual({
      cachedIn: 4000,
      uncachedIn: 0,
      writeIn: 0,
    });
  });

  it("predicts nothing warm once the entry has expired", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420, "5m"), opusPolicy);
    expect(predictCall(l, "c", OPUS, 5000, NOW + 10 * MIN, opusPolicy)).toEqual({
      cachedIn: 0,
      uncachedIn: 0,
      writeIn: 5000,
    });
  });

  it("keeps a separate entry for another conversation", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4420), opusPolicy);
    expect(predictCall(l, "other", OPUS, 5000, NOW, opusPolicy).cachedIn).toBe(0);
  });

  it("treats an automatic cache as warm for the whole prompt and charges no write", () => {
    const l = applyCallUsage(
      EMPTY_CACHE_LEDGER,
      {
        conversationKey: "c",
        modelKey: GROK,
        nowMs: NOW,
        input: 200,
        cacheRead: 8000,
        cacheWrite: 0,
      },
      grokPolicy,
    );
    expect(l.get(ledgerKey("c", GROK))!.warmTokens).toBe(8200);
    expect(predictCall(l, "c", GROK, 9000, NOW + 1000, grokPolicy)).toEqual({
      cachedIn: 8200,
      uncachedIn: 800,
      writeIn: 0,
    });
  });
});

describe("cache ledger: replay of recorded call sequences (P9 test 3, offline half)", () => {
  // A small seeded generator, so the sequences are fixed and the test is reproducible.
  let seed = 20260930;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it("predicts the next call's cached tokens exactly across 20 sequences within the lifetime", () => {
    for (let s = 0; s < 20; s++) {
      let ledger = EMPTY_CACHE_LEDGER;
      let t = NOW;
      let thread = 2000 + Math.floor(rnd() * 3000);
      ledger = applyCallUsage(ledger, { ...write(t, thread), input: 0 }, opusPolicy);
      for (let call = 0; call < 12; call++) {
        t += Math.floor(rnd() * 4 * MIN);
        const grow = Math.floor(rnd() * 800);
        const prompt = thread + grow;
        const predicted = predictCall(ledger, "c", OPUS, prompt, t, opusPolicy);
        // What the vendor would bill: it reads the whole previous prompt and writes the new part.
        expect(predicted.cachedIn, `seq ${s} call ${call}`).toBe(thread);
        expect(predicted.writeIn, `seq ${s} call ${call}`).toBe(grow);
        ledger = applyCallUsage(
          ledger,
          {
            conversationKey: "c",
            modelKey: OPUS,
            nowMs: t,
            input: 0,
            cacheRead: thread,
            cacheWrite: grow,
          },
          opusPolicy,
        );
        thread = prompt;
      }
    }
  });
});

describe("cache ledger: pruning", () => {
  it("drops entries cold for longer than the grace period and keeps the rest", () => {
    let l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4000, "5m"), opusPolicy);
    l = applyCallUsage(
      l,
      { ...write(NOW + 3 * HOUR, 4000, "1h"), conversationKey: "fresh" },
      opusPolicy,
    );
    const pruned = pruneLedger(l, NOW + 3 * HOUR + MIN);
    expect(pruned.has(ledgerKey("c", OPUS))).toBe(false);
    expect(pruned.has(ledgerKey("fresh", OPUS))).toBe(true);
  });

  it("returns the same ledger when nothing is stale", () => {
    const l = applyCallUsage(EMPTY_CACHE_LEDGER, write(NOW, 4000), opusPolicy);
    expect(pruneLedger(l, NOW + MIN)).toBe(l);
  });
});
