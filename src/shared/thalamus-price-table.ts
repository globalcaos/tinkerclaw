// THALAMUS v4 — list prices with cache multipliers (design doc section 11.1; paper J19 v4.0 P§3).
//
// WHAT THIS IS FOR. The money term of the price function needs USD per million tokens and the
// vendor's cache multipliers. The config carries neither for the subscription providers (their
// `cost` fields are all zero), so this table is the one place they come from.
//
// HOW IT WAS DERIVED. Every row carries `sourceUrl` and `readOn`, the page it was read from and
// the date. A price or multiplier that could not be found on a vendor page is `null`, never a
// guess. A null price leaves the option unpriced (`priceFor` returns the row, `moneyKnown` goes
// false upstream); a null cache multiplier means "no cache": `cachePolicyFor` returns undefined
// and the money term charges every input token at the base price, which is the cautious side.
//
// WHAT WOULD CHANGE IT. A vendor price change or a new model. The pricing pages are re-read by
// whoever adds a row, and `readOn` is re-dated. Nothing here fetches anything: the table is pure.
//
// The row order matters: the first `match` that fits the model id wins, so the more specific
// pattern (claude-fable-5-1) sits before the general one (claude-fable-5).

import type { CachePolicy } from "./thalamus-v4-types.js";

export type LongContextTier = {
  /** Prompts at or above this many tokens are billed at the higher rate, all tokens. */
  aboveTokens: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
};

export type ModelPrice = {
  /** Stable name of the row, for tests and the panel. */
  family: string;
  /** Matched against the model id (the part of the route key after the provider). */
  match: RegExp;
  /** USD per million input tokens; null when the vendor page lists none. */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** Cache read as a multiple of base input; null when not listed (treated as no cache). */
  cacheReadMult: number | null;
  /** Cache write multiples of base input; null when the vendor charges no premium or lists none. */
  cacheWrite5mMult: number | null;
  cacheWrite1hMult: number | null;
  /** The vendor caches on its own and charges no write premium. */
  automaticCache: boolean;
  /** Lifetime of a cache entry in ms, when the page says. */
  cacheTtlMs: number | null;
  longContext?: LongContextTier;
  sourceUrl: string;
  /** ISO date the page was read; null when the page could not be read. */
  readOn: string | null;
  note?: string;
};

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const XAI_MODELS = "https://docs.x.ai/docs/models";
const READ_ON = "2026-09-30";

const M5 = 5 * 60 * 1000;

function anthropic(
  family: string,
  match: RegExp,
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadMult: number,
  note?: string,
): ModelPrice {
  return {
    family,
    match,
    inputPerMTok,
    outputPerMTok,
    cacheReadMult,
    cacheWrite5mMult: 1.25,
    cacheWrite1hMult: 2,
    automaticCache: false,
    cacheTtlMs: M5,
    sourceUrl: ANTHROPIC_PRICING,
    readOn: READ_ON,
    ...(note ? { note } : {}),
  };
}

function xai(
  family: string,
  match: RegExp,
  cacheReadPerMTok: number,
  longCacheReadPerMTok: number,
): ModelPrice {
  return {
    family,
    match,
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadMult: cacheReadPerMTok / 2,
    // The page lists no cache write price and no cache lifetime. No premium is charged in the
    // model (new tokens cost base input) and the lifetime is left null, so the ledger assumes 5 min.
    cacheWrite5mMult: null,
    cacheWrite1hMult: null,
    automaticCache: true,
    cacheTtlMs: null,
    longContext: {
      aboveTokens: 200_000,
      inputPerMTok: 4,
      outputPerMTok: 12,
      cacheReadPerMTok: longCacheReadPerMTok,
    },
    sourceUrl: XAI_MODELS,
    readOn: READ_ON,
    note: "cache write price and cache lifetime not listed on the page",
  };
}

const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";

/** OpenAI standard-tier list prices. The plan (ChatGPT/Codex) serves these models; list price is the yardstick. */
function openai(
  family: string,
  match: RegExp,
  inputPerMTok: number,
  outputPerMTok: number,
  cachedInputPerMTok: number,
  cacheWritePerMTok: number | null,
): ModelPrice {
  return {
    family,
    match,
    inputPerMTok,
    outputPerMTok,
    cacheReadMult: cachedInputPerMTok / inputPerMTok,
    // A listed write price is a premium (1.25x on the whole family); none listed means no premium.
    cacheWrite5mMult: cacheWritePerMTok === null ? null : cacheWritePerMTok / inputPerMTok,
    cacheWrite1hMult: null,
    automaticCache: cacheWritePerMTok === null,
    // The page lists no cache lifetime, so the ledger assumes 5 minutes.
    cacheTtlMs: null,
    sourceUrl: OPENAI_PRICING,
    readOn: READ_ON,
    note: "cache lifetime not listed on the page",
  };
}

/** A subscription-only provider: the vendor publishes no per-token price for the plan. */
function subscriptionOnly(
  family: string,
  match: RegExp,
  sourceUrl: string,
  readOn: string | null,
  note: string,
): ModelPrice {
  return {
    family,
    match,
    inputPerMTok: null,
    outputPerMTok: null,
    cacheReadMult: null,
    cacheWrite5mMult: null,
    cacheWrite1hMult: null,
    automaticCache: false,
    cacheTtlMs: null,
    sourceUrl,
    readOn,
    note,
  };
}

export const PRICE_TABLE: readonly ModelPrice[] = [
  // Anthropic list prices. Cache hits: 0.1x base, 0.05x on Opus 5.5, 0.025x on Fable 5.1 and Mythos 5.1.
  anthropic("claude-fable-5-1", /^claude-fable-5-1$/, 10, 50, 0.025),
  anthropic("claude-fable-5", /^claude-fable-5$/, 10, 50, 0.1),
  anthropic("claude-opus-5-5", /^claude-opus-5-5$/, 4, 20, 0.05),
  anthropic("claude-opus-5", /^claude-opus-5$/, 5, 25, 0.1),
  anthropic("claude-opus-4-8", /^claude-opus-4-8$/, 5, 25, 0.1),
  anthropic("claude-opus-4-7", /^claude-opus-4-7$/, 5, 25, 0.1),
  anthropic("claude-opus-4-6", /^claude-opus-4-6$/, 5, 25, 0.1),
  anthropic("claude-opus-4-5", /^claude-opus-4-5$/, 5, 25, 0.1),
  anthropic("claude-sonnet-5-5", /^claude-sonnet-5-5$/, 2, 10, 0.1),
  anthropic("claude-sonnet-5", /^claude-sonnet-5$/, 2, 10, 0.1),
  anthropic("claude-sonnet-4-6", /^claude-sonnet-4-6$/, 3, 15, 0.1),
  anthropic("claude-sonnet-4-5", /^claude-sonnet-4-5$/, 3, 15, 0.1),
  anthropic("claude-haiku-4-5", /^claude-haiku-4-5(-\d+)?$/, 1, 5, 0.1),

  // xAI. Cached input: $0.50 on grok-4.7 and 4.6, $0.30 on grok-4.5, both doubling above 200k.
  xai("grok-4-7", /^grok-4[.-]7$/, 0.5, 1.0),
  xai("grok-4-6", /^grok-4[.-]6$/, 0.5, 1.0),
  xai("grok-4-5", /^grok-4[.-]5$/, 0.3, 0.6),

  // OpenAI (served through the ChatGPT/Codex plan here). Read 2026-09-30 from the standard tier.
  openai("gpt-6-astra", /^gpt-6-astra$/, 10, 50, 1, 12.5),
  openai("gpt-5-6-sol", /^gpt-5[.-]6-sol$/, 4, 20, 0.4, 5),
  openai("gpt-5-6-terra", /^gpt-5[.-]6-terra$/, 2, 12, 0.2, 2.5),
  openai("gpt-5-6-luna", /^gpt-5[.-]6-luna$/, 0.2, 1.2, 0.02, 0.25),
  openai("gpt-5-5", /^gpt-5[.-]5$/, 5, 30, 0.5, null),

  // Providers with no per-token price on a vendor page: null on purpose.
  subscriptionOnly(
    "openai-other",
    /^gpt-/,
    OPENAI_PRICING,
    READ_ON,
    "a GPT model the pricing page did not list; no price was assumed",
  ),
  subscriptionOnly(
    "copilot",
    /^copilot-/,
    "https://docs.github.com/en/copilot/concepts/billing/copilot-requests",
    READ_ON,
    "billed in premium requests with per-model multipliers; the page lists no per-token price",
  ),
];

/** The model id part of a `provider/model` route key. */
export function modelIdOf(routeKey: string): string {
  const slash = routeKey.indexOf("/");
  return slash >= 0 ? routeKey.slice(slash + 1) : routeKey;
}

export function priceFor(routeKey: string): ModelPrice | undefined {
  const id = modelIdOf(routeKey);
  return PRICE_TABLE.find((row) => row.match.test(id));
}

/**
 * The cache behaviour of a route, or undefined when the model has no usable cache figure.
 * Undefined is the cautious answer: callers charge all input at the base price.
 */
export function cachePolicyFor(routeKey: string): CachePolicy | undefined {
  const row = priceFor(routeKey);
  if (!row || row.cacheReadMult === null) return undefined;
  const automatic = row.automaticCache;
  return {
    readMult: row.cacheReadMult,
    // An automatic cache charges no write premium: new tokens are plain input.
    write5mMult: automatic ? 1 : (row.cacheWrite5mMult ?? 1),
    write1hMult: automatic ? 1 : (row.cacheWrite1hMult ?? row.cacheWrite5mMult ?? 1),
    ttlMs: row.cacheTtlMs ?? M5,
    ttlKnown: row.cacheTtlMs !== null,
    automatic,
  };
}

/** USD per million tokens for one call of `promptTokens` on this route, tier-aware. */
export function ratesFor(
  routeKey: string,
  promptTokens: number,
): { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number | null } | undefined {
  const row = priceFor(routeKey);
  if (!row || row.inputPerMTok === null || row.outputPerMTok === null) return undefined;
  const tier = row.longContext;
  if (tier && promptTokens >= tier.aboveTokens) {
    return {
      inputPerMTok: tier.inputPerMTok,
      outputPerMTok: tier.outputPerMTok,
      cacheReadPerMTok: tier.cacheReadPerMTok,
    };
  }
  return {
    inputPerMTok: row.inputPerMTok,
    outputPerMTok: row.outputPerMTok,
    cacheReadPerMTok: row.cacheReadMult === null ? null : row.inputPerMTok * row.cacheReadMult,
  };
}
