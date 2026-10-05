// THALAMUS v4 — the offline tests of paper section 10 that can run without a paid call or a live gateway.
//
// WHAT THIS IS FOR. Paper section 10 says what would prove the design, and each test could fail. Three of them can be run
// now, on recorded data, without spending anything:
//   test 3  the cache ledger. Replay real call sequences through the ledger and compare what it predicts for each call
//           (how many input tokens are already cached) with what the provider billed. The switch rule is only as good as
//           these numbers. The replay also checks the time-to-live assumption, by the gap since the conversation's last call.
//   test 4  digests. On long results whose answer is one detail, count the details a digest loses and the extra reads needed
//           to recover them. Here the digesters are deterministic stand-ins, so the test measures the COUNTING and the
//           recovery path, not any model's digests; a model's digests are measured when a paid run is allowed (Phase H).
//   test 7  overhead. Time the router and the local reads (in the extension's bench; it needs a clock and a runtime).
//
// HONESTY. Each function returns numbers and the conditions they hold under. Nothing here decides anything.
//
// PURE. No clock, no I/O, no randomness (a seed is an argument).

import {
  applyCallUsage,
  predictCall,
  type CacheLedger,
  ledgerKey,
} from "./thalamus-cache-ledger.js";
import { cachePolicyFor, ratesFor } from "./thalamus-price-table.js";

export type CallRow = {
  src: string;
  /** Milliseconds. */
  ts: number;
  /** The conversation this call belongs to; the cache is per conversation and model. */
  conv: string;
  /** `provider/model`. */
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  durationMs?: number;
  /** When the provider reports which tier the write landed in. */
  cache5m?: number | null;
  cache1h?: number | null;
};

export type Confusion = { tp: number; fp: number; fn: number; tn: number };

export type CacheModelRow = {
  model: string;
  scored: number;
  actualCached: number;
  predictedCached: number;
  /** Sum of |predicted - actual| over the sum of actual: the share of cached tokens mispredicted. */
  wape: number;
  /** (predicted - actual) / actual: positive means the ledger thinks more is warm than was. */
  bias: number;
  warm: Confusion & { accuracy: number };
};

export type GapRow = {
  bucket: string;
  n: number;
  actualWarmShare: number;
  predictedWarmShare: number;
};

export type CacheEval = {
  calls: number;
  scored: number;
  /** Not scored, and why. */
  skipped: { firstOfConversation: number; noCachePolicy: number; tooSmall: number };
  cachedTokens: { actual: number; predicted: number; wape: number; bias: number };
  warm: Confusion & { accuracy: number };
  byModel: CacheModelRow[];
  /** Is a conversation still warm after this long? What happened, and what the ledger said. */
  byGap: GapRow[];
  /** The input-side bill: what the ledger's prediction implies against what the counts say was billed (list price, USD). */
  inputBill: { actualUsd: number; predictedUsd: number; relError: number };
  /** How often each write tier was seen, for the calls that report one. */
  tiers: { fiveMinute: number; oneHour: number; unreported: number };
};

const GAPS: Array<[label: string, maxMs: number]> = [
  ["under 1 min", 60_000],
  ["1 to 5 min", 5 * 60_000],
  ["5 to 30 min", 30 * 60_000],
  ["30 to 60 min", 60 * 60_000],
  ["over 60 min", Number.POSITIVE_INFINITY],
];

const share = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const conf = (): Confusion => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
const acc = (c: Confusion): number => share(c.tp + c.tn, c.tp + c.fp + c.fn + c.tn);

/**
 * Replay the rows in time order through the cache ledger. For each call the ledger is asked what would be cached before the
 * call is seen, then told what really happened. The first call the data holds for a conversation and model is not scored
 * (the conversation may have begun before the data did), a model with no cache figure is not scored, and a prompt under
 * `minPrompt` tokens is not scored (too small to cache on most providers).
 */
export function evaluateCacheLedger(
  rows: readonly CallRow[],
  o: { defaultTier?: "5m" | "1h"; minPrompt?: number } = {},
): CacheEval {
  const minPrompt = o.minPrompt ?? 1024;
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  let ledger: CacheLedger = new Map();
  const lastSeen = new Map<string, number>();
  const skipped = { firstOfConversation: 0, noCachePolicy: 0, tooSmall: 0 };
  const total = { actual: 0, predicted: 0, abs: 0 };
  const warm = conf();
  const model = new Map<
    string,
    { n: number; actual: number; predicted: number; abs: number; warm: Confusion }
  >();
  const gap = GAPS.map(([bucket]) => ({ bucket, n: 0, actualWarm: 0, predictedWarm: 0 }));
  const bill = { actual: 0, predicted: 0 };
  const tiers = { fiveMinute: 0, oneHour: 0, unreported: 0 };

  for (const r of sorted) {
    const prompt = r.input + r.cacheRead + r.cacheWrite;
    const k = ledgerKey(r.conv, r.model);
    const policy = cachePolicyFor(r.model);
    const tier: "5m" | "1h" =
      (r.cache1h ?? 0) > 0 ? "1h" : (r.cache5m ?? 0) > 0 ? "5m" : (o.defaultTier ?? "1h");
    if ((r.cache1h ?? 0) > 0) tiers.oneHour += 1;
    else if ((r.cache5m ?? 0) > 0) tiers.fiveMinute += 1;
    else tiers.unreported += 1;

    const prev = lastSeen.get(k);
    if (prev === undefined) skipped.firstOfConversation += 1;
    else if (!policy) skipped.noCachePolicy += 1;
    else if (prompt < minPrompt) skipped.tooSmall += 1;
    else {
      const p = predictCall(ledger, r.conv, r.model, prompt, r.ts, policy);
      const predictedWarm = p.cachedIn > 0;
      const actualWarm = r.cacheRead > 0;
      total.actual += r.cacheRead;
      total.predicted += p.cachedIn;
      total.abs += Math.abs(p.cachedIn - r.cacheRead);
      const c = predictedWarm ? (actualWarm ? "tp" : "fp") : actualWarm ? "fn" : "tn";
      warm[c] += 1;
      const m = model.get(r.model) ?? { n: 0, actual: 0, predicted: 0, abs: 0, warm: conf() };
      m.n += 1;
      m.actual += r.cacheRead;
      m.predicted += p.cachedIn;
      m.abs += Math.abs(p.cachedIn - r.cacheRead);
      m.warm[c] += 1;
      model.set(r.model, m);
      const gi = GAPS.findIndex(([, max]) => r.ts - prev < max);
      gap[gi].n += 1;
      if (actualWarm) gap[gi].actualWarm += 1;
      if (predictedWarm) gap[gi].predictedWarm += 1;
      const rates = ratesFor(r.model, prompt);
      if (rates) {
        const read = rates.cacheReadPerMTok ?? rates.inputPerMTok;
        const wm = tier === "1h" ? policy.write1hMult : policy.write5mMult;
        bill.actual +=
          (r.input * rates.inputPerMTok +
            r.cacheRead * read +
            r.cacheWrite * rates.inputPerMTok * wm) /
          1e6;
        bill.predicted +=
          (p.uncachedIn * rates.inputPerMTok +
            p.cachedIn * read +
            p.writeIn * rates.inputPerMTok * wm) /
          1e6;
      }
    }
    ledger = policy
      ? applyCallUsage(
          ledger,
          {
            conversationKey: r.conv,
            modelKey: r.model,
            nowMs: r.ts,
            input: r.input,
            cacheRead: r.cacheRead,
            cacheWrite: r.cacheWrite,
            writeTier: tier,
          },
          policy,
        )
      : ledger;
    lastSeen.set(k, r.ts);
  }

  const scored = warm.tp + warm.fp + warm.fn + warm.tn;
  return {
    calls: rows.length,
    scored,
    skipped,
    cachedTokens: {
      actual: total.actual,
      predicted: total.predicted,
      wape: share(total.abs, total.actual),
      bias: share(total.predicted - total.actual, total.actual),
    },
    warm: { ...warm, accuracy: acc(warm) },
    byModel: [...model.entries()]
      .map(([name, m]) => ({
        model: name,
        scored: m.n,
        actualCached: m.actual,
        predictedCached: m.predicted,
        wape: share(m.abs, m.actual),
        bias: share(m.predicted - m.actual, m.actual),
        warm: { ...m.warm, accuracy: acc(m.warm) },
      }))
      .sort((a, b) => b.scored - a.scored),
    byGap: gap.map((g) => ({
      bucket: g.bucket,
      n: g.n,
      actualWarmShare: share(g.actualWarm, g.n),
      predictedWarmShare: share(g.predictedWarm, g.n),
    })),
    inputBill: {
      actualUsd: bill.actual,
      predictedUsd: bill.predicted,
      relError: share(bill.predicted - bill.actual, bill.actual),
    },
    tiers,
  };
}

// ─── test 4: digests ────────────────────────────────────────────────────────────────────────────

export type DigestCase = { raw: string; needle: string };

/** A long synthetic tool result with one detail in it, at a chosen fraction of the way through. Deterministic from `seed`. */
export function syntheticLongResult(seed: number, lines: number, at: number): DigestCase {
  let s = (seed * 2654435761) >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const words = [
    "status",
    "ok",
    "queued",
    "retry",
    "worker",
    "shard",
    "latency",
    "cache",
    "miss",
    "hit",
    "batch",
    "commit",
  ];
  const out: string[] = [];
  const needle = `invoice ${1000 + Math.floor(next() * 9000)} total ${(100 + next() * 9000).toFixed(2)} EUR due 2026-${String(1 + Math.floor(next() * 12)).padStart(2, "0")}-15`;
  const pos = Math.min(lines - 1, Math.max(0, Math.floor(at * lines)));
  for (let i = 0; i < lines; i++) {
    if (i === pos) out.push(needle);
    else
      out.push(
        `${String(i).padStart(5, "0")} ${Array.from({ length: 10 }, () => words[Math.floor(next() * words.length)]).join(" ")} ${Math.floor(next() * 100000)}`,
      );
  }
  return { raw: out.join("\n"), needle };
}

export type DigestLoss = {
  cases: number;
  /** The detail is not in the digest. */
  lost: number;
  lostShare: number;
  /** One read of the raw result, by name, recovers a lost detail; this counts those reads. */
  extraReads: number;
  /** Lost details the raw read brought back. Every one, or the recall path is broken. */
  recovered: number;
  /** Mean digest size against the raw result, in characters. */
  keptShare: number;
};

/**
 * For each case: does the digest still hold the detail? If not, recall the raw result (one extra read) and see whether the
 * detail is there. The digester and the recall are arguments, so this counts what any digester loses.
 */
export function digestLoss(
  cases: readonly DigestCase[],
  digester: (raw: string) => string,
  recall: (raw: string) => string = (raw) => raw,
): DigestLoss {
  let lost = 0;
  let recovered = 0;
  let kept = 0;
  for (const c of cases) {
    const d = digester(c.raw);
    kept += share(d.length, c.raw.length);
    if (!d.includes(c.needle)) {
      lost += 1;
      if (recall(c.raw).includes(c.needle)) recovered += 1;
    }
  }
  return {
    cases: cases.length,
    lost,
    lostShare: share(lost, cases.length),
    extraReads: lost,
    recovered,
    keptShare: share(kept, cases.length),
  };
}

/** Deterministic stand-in digesters, from crude to ideal, to show what the count measures. */
export const DIGESTERS = {
  /** Keep the start and the end and drop the middle: what truncation does. */
  headTail:
    (keep: number) =>
    (raw: string): string => {
      const lines = raw.split("\n");
      const head = Math.ceil(lines.length * keep * 0.75);
      const tail = Math.ceil(lines.length * keep * 0.25);
      return [...lines.slice(0, head), "...", ...lines.slice(lines.length - tail)].join("\n");
    },
  /** Keep lines that look like facts (a currency, a date, a word such as invoice or total) and a few at each end. */
  extractive: (raw: string): string => {
    const lines = raw.split("\n");
    const facts = lines.filter((l) =>
      /\b(EUR|USD|invoice|total|due|error|fail)\b|\d{4}-\d{2}-\d{2}/i.test(l),
    );
    return [...lines.slice(0, 3), ...facts, ...lines.slice(-3)].join("\n");
  },
} as const;
