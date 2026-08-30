import { describe, expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes Anthropic-style snake_case usage", () => {
    const usage = normalizeUsage({
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      total_tokens: 1790,
    });
    expect(usage).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 50,
      cacheWrite: 200,
      total: 1790,
    });
  });

  it("normalizes OpenAI-style prompt/completion usage", () => {
    const usage = normalizeUsage({
      prompt_tokens: 987,
      completion_tokens: 123,
      total_tokens: 1110,
    });
    expect(usage).toEqual({
      input: 987,
      output: 123,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 1110,
    });
  });

  it("normalizes llama.cpp completion timings", () => {
    const usage = normalizeUsage({
      timings: {
        prompt_n: 30_834,
        predicted_n: 34,
      },
    });
    expect(usage).toEqual({
      input: 30_834,
      output: 34,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("clamps negative and fractional usage counts to safe integers", () => {
    const usage = normalizeUsage({
      input: -12.8,
      output: 9.9,
      cacheRead: -1,
      cacheWrite: 3.2,
      total: -99,
    });
    expect(usage).toEqual({
      input: 0,
      output: 9,
      cacheRead: 0,
      cacheWrite: 3,
      total: 0,
    });
  });

  it("caps extremely large usage counts at Number.MAX_SAFE_INTEGER", () => {
    const usage = normalizeUsage({
      input: 1e308,
      output: Number.MAX_SAFE_INTEGER + 1000,
    });
    expect(usage).toEqual({
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("returns undefined for empty usage objects", () => {
    expect(normalizeUsage({})).toBeUndefined();
  });

  it("guards against empty/zero usage overwrites", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
    expect(hasNonzeroUsage(null)).toBe(false);
    expect(hasNonzeroUsage({})).toBe(false);
    expect(hasNonzeroUsage({ input: 0, output: 0 })).toBe(false);
    expect(hasNonzeroUsage({ input: 1 })).toBe(true);
    expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  });

  // FORK 2026-07-28 — REWRITTEN, deliberately, not deleted.
  //
  // This case used to assert `.toBe(2_400_027)` under the title "does not clamp derived
  // session total tokens to the context window". Its real intent — never FABRICATE a
  // window-sized value (i.e. never return 200_000 just because the input was bigger) — is
  // preserved and asserted below. Its literal assertion, however, encoded the turn-aggregate
  // bug: 2,400,000 cacheRead against a 200,000 window is not a context size, it is an
  // accumulator that leaked into a snapshot field. Persisting it as SessionEntry.totalTokens
  // is what drove compaction on sessions at a few percent of real fill (measured 2026-07-28:
  // 6,448,106 tokens reported at 644.8% of a 1M window).
  //
  // New contract: an implausible value is reported as UNKNOWN (undefined), never as a raw
  // aggregate and never as a fabricated clamp. Callers map undefined to totalTokensFresh:false.
  it("reports an implausible aggregate as unknown, and never fabricates a clamped value", () => {
    const derived = deriveSessionTotalTokens({
      usage: {
        input: 27,
        cacheRead: 2_400_000,
        cacheWrite: 0,
        total: 2_402_300,
      },
      contextTokens: 200_000,
    });

    expect(derived).toBeUndefined();
    // The original guarantee this test was written to protect: no clamped-to-window fake.
    expect(derived).not.toBe(200_000);
    expect(derived).not.toBe(2_400_027);
  });

  it("uses prompt tokens when within context window", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 2_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(1_550);
  });

  it("prefers explicit prompt token overrides", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 9_999,
        },
        promptTokens: 65_000,
        contextTokens: 200_000,
      }),
    ).toBe(65_000);
  });
});
