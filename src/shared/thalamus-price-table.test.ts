import { describe, expect, it } from "vitest";
import {
  cachePolicyFor,
  modelIdOf,
  PRICE_TABLE,
  priceFor,
  ratesFor,
} from "./thalamus-price-table.js";

describe("thalamus price table: provenance", () => {
  it("every row names a source URL and either a read date or why it has none", () => {
    for (const row of PRICE_TABLE) {
      expect(row.sourceUrl, row.family).toMatch(/^https:\/\//);
      if (row.readOn === null) {
        expect(row.note, `${row.family} was not read, so it must say why`).toBeTruthy();
      } else {
        expect(row.readOn, row.family).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("has no zero input price: unknown is null, never 0", () => {
    for (const row of PRICE_TABLE) expect(row.inputPerMTok, row.family).not.toBe(0);
  });

  it("extracts the model id from a route key", () => {
    expect(modelIdOf("claude-code/claude-opus-5")).toBe("claude-opus-5");
    expect(modelIdOf("bare-model")).toBe("bare-model");
  });
});

describe("thalamus price table: Anthropic list prices", () => {
  it("keeps the cache multipliers the vendor page states", () => {
    expect(cachePolicyFor("claude-code/claude-opus-5")?.readMult).toBe(0.1);
    expect(cachePolicyFor("claude-code/claude-opus-5-5")?.readMult).toBe(0.05);
    expect(cachePolicyFor("claude-code/claude-fable-5-1")?.readMult).toBe(0.025);
    expect(cachePolicyFor("claude-code/claude-fable-5")?.readMult).toBe(0.1);
    const p = cachePolicyFor("claude-code/claude-sonnet-5-5")!;
    expect(p.write5mMult).toBe(1.25);
    expect(p.write1hMult).toBe(2);
    expect(p.automatic).toBe(false);
    expect(p.ttlKnown).toBe(true);
  });

  it("derives the dollar cache-read price the page lists", () => {
    const read = (k: string) => ratesFor(k, 1000)?.cacheReadPerMTok;
    expect(read("claude-code/claude-opus-5-5")).toBeCloseTo(0.2, 10);
    expect(read("claude-code/claude-opus-5")).toBeCloseTo(0.5, 10);
    expect(read("claude-code/claude-fable-5-1")).toBeCloseTo(0.25, 10);
    expect(read("claude-code/claude-sonnet-5-5")).toBeCloseTo(0.2, 10);
    expect(read("claude-code/claude-haiku-4-5")).toBeCloseTo(0.1, 10);
  });

  it("does not let Fable 5.1 match the Fable 5 row, or the reverse", () => {
    expect(priceFor("claude-code/claude-fable-5-1")?.family).toBe("claude-fable-5-1");
    expect(priceFor("claude-code/claude-fable-5")?.family).toBe("claude-fable-5");
    expect(priceFor("claude-code/claude-opus-5-5")?.family).toBe("claude-opus-5-5");
    expect(priceFor("claude-code/claude-opus-5")?.family).toBe("claude-opus-5");
  });

  it("matches a dated Haiku id", () => {
    expect(priceFor("claude-code/claude-haiku-4-5-20251001")?.family).toBe("claude-haiku-4-5");
  });

  it("lists input and output prices", () => {
    expect(ratesFor("claude-code/claude-opus-5-5", 1)).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
    expect(ratesFor("claude-code/claude-fable-5-1", 1)).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    expect(ratesFor("claude-code/claude-haiku-4-5", 1)).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
  });
});

describe("thalamus price table: xAI, tiers and nulls", () => {
  it("switches to the long-prompt tier at 200k tokens, all tokens", () => {
    expect(ratesFor("xai/grok-4.7", 199_999)).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 6,
      cacheReadPerMTok: 0.5,
    });
    expect(ratesFor("xai/grok-4.7", 200_000)).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 12,
      cacheReadPerMTok: 1,
    });
  });

  it("prices grok-4.5 cache reads lower than 4.7", () => {
    expect(ratesFor("xai/grok-4.5", 1)?.cacheReadPerMTok).toBeCloseTo(0.3, 10);
    expect(ratesFor("xai/grok-4.6", 1)?.cacheReadPerMTok).toBeCloseTo(0.5, 10);
  });

  it("treats xAI's cache as automatic with no write premium and an unknown lifetime", () => {
    const p = cachePolicyFor("xai/grok-4.7")!;
    expect(p.automatic).toBe(true);
    expect(p.write5mMult).toBe(1);
    expect(p.write1hMult).toBe(1);
    expect(p.ttlKnown).toBe(false);
    expect(p.ttlMs).toBe(5 * 60 * 1000);
  });

  it("prices the OpenAI models the pricing page lists", () => {
    expect(ratesFor("openai-codex/gpt-6-astra", 1)).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    expect(ratesFor("openai-codex/gpt-6-astra", 1)?.cacheReadPerMTok).toBeCloseTo(1, 10);
    expect(ratesFor("openai-codex/gpt-5.6-sol", 1)).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
    expect(ratesFor("openai-codex/gpt-5.6-terra", 1)).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 12,
    });
    expect(ratesFor("openai-codex/gpt-5.6-luna", 1)).toMatchObject({
      inputPerMTok: 0.2,
      outputPerMTok: 1.2,
    });
    expect(ratesFor("openai-codex/gpt-5.5", 1)).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 30,
    });
  });

  it("reads OpenAI's cache write as a 1.25x premium where the page lists one, and none where it does not", () => {
    expect(cachePolicyFor("openai-codex/gpt-6-astra")).toMatchObject({
      readMult: 0.1,
      write5mMult: 1.25,
      automatic: false,
      ttlKnown: false,
    });
    expect(cachePolicyFor("openai-codex/gpt-5.6-luna")?.write5mMult).toBeCloseTo(1.25, 10);
    expect(cachePolicyFor("openai-codex/gpt-5.5")).toMatchObject({
      readMult: 0.1,
      write5mMult: 1,
      automatic: true,
    });
  });

  it("leaves providers with no per-token price unpriced and without a cache figure", () => {
    for (const k of ["openai-codex/gpt-9-unlisted", "copilot/copilot-think-deeper"]) {
      const row = priceFor(k);
      expect(row, k).toBeDefined();
      expect(row!.inputPerMTok, k).toBeNull();
      expect(ratesFor(k, 1000), k).toBeUndefined();
      expect(cachePolicyFor(k), k).toBeUndefined();
    }
  });

  it("returns nothing for a model that is not in the table", () => {
    expect(priceFor("ollama/llama3")).toBeUndefined();
    expect(cachePolicyFor("ollama/llama3")).toBeUndefined();
    expect(ratesFor("ollama/llama3", 10)).toBeUndefined();
  });
});
