// THALAMUS v4 — the cache ledger (design doc sections 7-8; paper J19 v4.0 P§3 "cache state").
//
// WHAT THIS IS FOR. A model that has been reading a conversation re-reads it from its cache at a
// fraction of the price, and a model that starts cold pays in full. The router can only price a
// switch honestly if it knows, for each (conversation, model), how much of the conversation is
// warm and until when. This module is that ledger as a pure reducer.
//
// HOW IT IS FED. From counts, never from guesses (paper P§3): every response reports its cached
// and uncached tokens. In the gateway those counts arrive on the `stream: "call"` agent-event bus
// (`call-telemetry.ts`), exact on both lanes. Phase D wires that feed; this file only reduces.
//
// PURE: no clock, no I/O. `nowMs` is always an argument, and every function returns a new Map.

import type { CacheLedgerEntry, CachePolicy, CallPrediction } from "./thalamus-v4-types.js";

export type CacheLedger = ReadonlyMap<string, CacheLedgerEntry>;

export const EMPTY_CACHE_LEDGER: CacheLedger = new Map();

export function ledgerKey(conversationKey: string, modelKey: string): string {
  return `${conversationKey}\u0000${modelKey}`;
}

/** What one finished (or usage-reporting) call tells the ledger. */
export type CallUsage = {
  conversationKey: string;
  modelKey: string;
  nowMs: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Which write tier the new tokens landed in, when the call says. */
  writeTier?: "5m" | "1h";
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** The instant this entry stops being warm. Reads refresh it ("cache hits and refreshes"). */
export function warmUntilMs(e: CacheLedgerEntry): number {
  return Math.max(e.writtenAtMs, e.lastReadAtMs) + e.ttlMs;
}

export function isWarm(e: CacheLedgerEntry | undefined, nowMs: number): boolean {
  return e !== undefined && e.warmTokens > 0 && nowMs < warmUntilMs(e);
}

const n0 = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Fold one call's counts into the ledger.
 *
 * After a call the model holds the cached part of the prompt: what it read plus what it wrote.
 * An automatic cache (no write premium) also keeps the uncached part of the prompt, so for those
 * vendors the whole prompt is warm. A call that wrote starts a fresh lifetime in the tier it
 * wrote to; a call that only read refreshes the lifetime it found. No policy means the vendor
 * has no cache we can rely on: the ledger records nothing for it.
 */
export function applyCallUsage(
  ledger: CacheLedger,
  usage: CallUsage,
  policy: CachePolicy | undefined,
): CacheLedger {
  if (!policy) return ledger;
  const input = n0(usage.input);
  const read = n0(usage.cacheRead);
  const write = n0(usage.cacheWrite);
  const warm = policy.automatic ? input + read + write : read + write;
  if (warm <= 0) return ledger;

  const key = ledgerKey(usage.conversationKey, usage.modelKey);
  const prev = ledger.get(key);
  const wrote = write > 0 || (policy.automatic && input > 0);
  const tierTtl =
    usage.writeTier === "1h" ? ONE_HOUR_MS : usage.writeTier === "5m" ? FIVE_MIN_MS : undefined;
  const ttlMs = wrote ? (tierTtl ?? prev?.ttlMs ?? policy.ttlMs) : (prev?.ttlMs ?? policy.ttlMs);

  const next: CacheLedgerEntry = {
    conversationKey: usage.conversationKey,
    modelKey: usage.modelKey,
    warmTokens: warm,
    writtenAtMs: wrote ? usage.nowMs : (prev?.writtenAtMs ?? usage.nowMs),
    ttlMs,
    lastReadAtMs: read > 0 ? usage.nowMs : (prev?.lastReadAtMs ?? 0),
  };
  const out = new Map(ledger);
  out.set(key, next);
  return out;
}

/**
 * What a call of `promptTokens` on this model would bill, given what is warm.
 *
 * Warm tokens are read at the cache price. The rest of the prompt is a write for a vendor that
 * charges one (the whole thread on a cold model: the paper's "write it into its own cache") and
 * plain input for an automatic cache. No policy: every token is plain input.
 */
export function predictCall(
  ledger: CacheLedger,
  conversationKey: string,
  modelKey: string,
  promptTokens: number,
  nowMs: number,
  policy: CachePolicy | undefined,
): CallPrediction {
  const total = n0(promptTokens);
  if (!policy) return { cachedIn: 0, uncachedIn: total, writeIn: 0 };
  const entry = ledger.get(ledgerKey(conversationKey, modelKey));
  const cachedIn = isWarm(entry, nowMs) ? Math.min(entry!.warmTokens, total) : 0;
  const rest = total - cachedIn;
  return policy.automatic
    ? { cachedIn, uncachedIn: rest, writeIn: 0 }
    : { cachedIn, uncachedIn: 0, writeIn: rest };
}

/** Drop entries that have been cold for longer than `graceMs`. Keeps the Map from growing forever. */
export function pruneLedger(
  ledger: CacheLedger,
  nowMs: number,
  graceMs = ONE_HOUR_MS,
): CacheLedger {
  let changed = false;
  const out = new Map<string, CacheLedgerEntry>();
  for (const [k, e] of ledger) {
    if (nowMs - warmUntilMs(e) > graceMs) {
      changed = true;
      continue;
    }
    out.set(k, e);
  }
  return changed ? out : ledger;
}
