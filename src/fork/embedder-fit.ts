// FORK 2026-10-29: the ONE canonical per-machine embedder decision (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
//
// Embeddings exist to put the right memory in front of an agent when its question and the note
// share few words. Without them the agent spends another model step searching again, or goes
// without. This module decides, per machine and from measurements taken on that machine, whether
// the vector half of memory search runs at all, with which model, and within which bounds.
//
// The time account behind every threshold here (design principles #19, #20, #25):
//   saving per day = real searches per day x recall gain over word search x the cost of one miss
//   cost per day   = the query embed on the caller's path
//                    + contention c x background embedder seconds per day
// Vectors run only while the saving exceeds the cost and indexing drains new memory faster than it
// arrives; otherwise the install runs word search, which keeps indexing. Each threshold below says
// what it protects, the measurement it comes from, its break-even, and what would move it.
//
// One owner per derivation (#18): the ladder of measured models, the threshold formulas,
// decideEmbedderFit, the git-ignored record <stateDir>/memory/embedder-fit.json, the cheap machine
// fingerprint, and applyEmbedderFit, the single seam resolveMemorySearchConfig returns through.
// The fit CLI, the runtime governor and the gateway-start check import these names and re-derive
// nothing.
//
// Import discipline: src/agents/memory-search.ts imports this file and the plugin SDK bundles that
// resolver, so this file is pure functions plus synchronous record IO: node builtins,
// resolveStateDir and one type-only import. No network, no child processes, no logger, no import
// of the governor. Its two caches belong to each bundled copy and re-read the file when it
// changes, so nothing here needs a cross-bundle globalThis slot.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { MetricProvenance } from "../infra/algorithm-metrics.js";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const SECONDS_PER_DAY = 86_400;
/** The record keeps its newest 20 fits, enough to see two fits in a row with the same decision. */
const HISTORY_CAP = 20;

// -------------------------------------------------------------------------------------------------
// (1) Types
// -------------------------------------------------------------------------------------------------

/**
 * One number with its provenance (rule 1 of the algorithm-metrics ledger). An unknown number is
 * omitted, never written as 0. `denominator` names what a share or rate is out of.
 */
export type Measured = {
  value: number;
  unit: string;
  n?: number;
  denominator?: string;
  provenance: MetricProvenance;
  source: string;
};

/**
 * What the machine is, read synchronously and without network. When a field changes, the record's
 * measurements no longer describe this machine and the fit runs again.
 */
export type CheapFingerprint = {
  arch: string;
  platform: string;
  cpuModel: string;
  logicalCores: number;
  /** cgroup v2 cpu.max of this process in cores (its tightest ancestor); null for 'max' or absent. */
  cpuQuotaCores: number | null;
  /** Total RAM in whole GiB. */
  totalRamGiB: number;
  gpu: {
    /** /dev/nvidia0 exists. */
    nvidia: boolean;
    /** /dev/kfd exists (AMD compute). */
    amdKfd: boolean;
    /** Any /dev/dri/renderD* node exists. */
    renderNode: boolean;
    /** darwin on arm64. */
    appleSilicon: boolean;
  };
};

/** What can embed here. remoteKeys holds provider ids that have a key, never the key values. */
export type EmbedderInventory = {
  ollama: {
    baseUrl: string;
    reachable: boolean;
    version?: string;
    models: Array<{ name: string; digest: string }>;
  };
  nodeLlamaCpp: boolean;
  remoteKeys: string[];
};

/** One model as the fit measured it on this machine. */
export type CandidateMeasurement = {
  provider: string;
  model: string;
  /**
   * FORK 2026-10-30: the base URL a non-Ollama provider was measured at, so the record keys its
   * endpoint as the governor does (fitEndpointKeyFor). Ollama's is the inventory's URL. Records
   * written before this field have none, and key that provider by its id alone, as they did.
   */
  baseUrl?: string;
  /** The first request after an unload: model load plus the first embed. */
  coldLoadMs?: number;
  queryP50Ms: number;
  queryP95Ms: number;
  /** Theta: tokens/s at the derived batch size and concurrency. */
  tokensPerSec: Measured;
  tokensPerSecLow95: number;
  tokensPerSecHigh95: number;
  /** p95/p50 of per-batch service time. */
  batchDispersion: number;
  /** Service time of a one-token request. */
  overheadMs: number;
  rssBytes?: number;
  /** Host cores the embedder keeps busy while it serves: s in the idle gate. */
  embedCores?: number;
  /** Throughput with 2 requests in flight minus 1 in flight, and the per-batch sigma of it. */
  parallelGain?: { delta: number; sigma: number };
  /** options.num_thread, kept only when it measured faster beyond 2 sigma. */
  numThread?: number;
  /** cosine(paraphrase pair) > cosine(unrelated pair) on the built-in pairs. */
  sanityOk: boolean;
};

/**
 * The memory corpus. Token counts are file tokens; decideEmbedderFit multiplies them by the chunk
 * overlap factor chunkTokens / (chunkTokens - overlapTokens), 1.25 for 400-token chunks with 80
 * overlap.
 */
export type CorpusStats = {
  files: number;
  tokens: Measured;
  ingestTokensPerDay: Measured;
  /** Peak day / mean day of ingest. */
  burstFactor: Measured;
  chunkTokens: number;
  overlapTokens: number;
  /**
   * Session-transcript tokens per day, when measured. Read only when the config lists 'sessions':
   * the fit never adds sessions by itself.
   */
  sessionIngestTokensPerDay?: Measured;
};

export type ThresholdName =
  | "context"
  | "ram"
  | "query"
  | "batch"
  | "keep-up"
  | "gain"
  | "demand"
  | "step-up";

/** One threshold's outcome: what it protects, the value, its break-even and the labelled inputs. */
export type ThresholdVerdict = {
  name: ThresholdName;
  /** The model the verdict is about (provider-qualified when not Ollama). */
  model?: string;
  objective: string;
  value: number;
  breakEven: number;
  pass: boolean;
  formula: string;
  inputs: Record<string, Measured>;
};

export type FitMode = "off" | "memory" | "memory+sessions";

export type FitDecision = {
  mode: FitMode;
  provider?: string;
  model?: string;
  numThread?: number;
  /** Q*: real searches per day at which background embedding repays its cost; omitted when never. */
  demandBreakEvenPerDay?: number;
  /** Demand is unknown or under Q*, and the initial backlog takes longer than one fit. */
  dormantUntilDemand: boolean;
  reasons: string[];
  verdicts: ThresholdVerdict[];
  proposal?: { text: string; command: string };
};

export type EmbedderConsent = {
  remote: null | { provider: string; grantedAt: string; via: "installer" | "doctor" | "flag" };
};

export type EmbedderFitHistoryEntry = { at: string; mode: FitMode; model?: string; reason: string };

/** The git-ignored per-machine record, <stateDir>/memory/embedder-fit.json. */
export type EmbedderFitRecord = {
  schemaVersion: 1;
  createdAt: string;
  fingerprint: CheapFingerprint;
  inventory: EmbedderInventory;
  candidates: CandidateMeasurement[];
  corpus?: CorpusStats;
  missCostSec: Measured;
  nonEnglishShare: Measured;
  contention?: Measured;
  fitWallSeconds: Measured;
  decision: FitDecision;
  consent: EmbedderConsent;
  tool: { command: string; version: string };
  /** Oldest first. writeEmbedderFit appends the record's own entry and keeps the newest 20. */
  history: EmbedderFitHistoryEntry[];
};

// -------------------------------------------------------------------------------------------------
// (2) The embedder ladder
// -------------------------------------------------------------------------------------------------

export type LadderPriors = {
  /** Hybrid R@5 on the whole eval, on its English queries and on its non-English queries. */
  r5Hybrid: number;
  r5HybridEn: number;
  r5HybridNonEn: number;
  /** Hybrid R@5 minus FTS-OR R@5 on the whole eval. */
  deltaVsFtsOr: number;
  /** Discordant queries against FTS-OR: [only hybrid found the target, only words found it]. */
  discordant: [number, number];
  /** Two-sided sign test over `discordant`, derived by signTestP. */
  signP: number;
  tokensPerSecRef: number;
  queryP50MsRef: number;
  queryP95MsRef: number;
  rssMBRef: number;
};

export type LadderEntry = {
  model: string;
  status: "preferred" | "fallback";
  dims: number;
  contextTokens: number;
  multilingual: boolean;
  /** Download size. */
  sizeMB: number;
  priors: LadderPriors;
  source: string;
};

/** The one reference eval every ladder prior comes from. */
export const LADDER_REFERENCE_SOURCE =
  "reference eval: Raspberry Pi 5, Ollama 0.40.11 in a 2-CPU container, 2026-10-29; one private corpus of 100 files; 40 frozen queries (30 EN, 10 ES/CA); hybrid = 0.7 cosine + 0.3 BM25 over an OR-of-keywords query";

/** Word search alone (BM25 over an OR of keywords) on the same eval: the baseline vectors must beat. */
export const FTS_OR_REFERENCE = Object.freeze({ r5: 0.625, r5En: 0.7, r5NonEn: 0.4 });

/**
 * Two-sided exact sign test over discordant pairs [wins, losses], ties dropped:
 * p = min(1, 2 x P(X <= min(wins, losses))) with X ~ Binomial(wins + losses, 1/2).
 * Objective: the gain gate admits a vector half only when its paired win over word search is
 * unlikely to be chance. 10 vs 1 gives 0.0117; 5 vs 0 gives 0.0625.
 */
export function signTestP(discordant: readonly [number, number]): number {
  const wins = Math.max(0, Math.floor(discordant[0]));
  const losses = Math.max(0, Math.floor(discordant[1]));
  const n = wins + losses;
  if (n === 0) {
    return 1;
  }
  let binomial = 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k++) {
    tail += binomial;
    binomial = (binomial * (n - k)) / (k + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

function withSignP(priors: Omit<LadderPriors, "signP">): LadderPriors {
  return { ...priors, signP: signTestP(priors.discordant) };
}

// Measured on the reference eval and kept OFF the ladder:
// - all-minilm: its 256-token context cuts the 400-token chunks the index writes;
// - snowflake-arctic-embed:33m: cosine R@5 0.525, below word search alone (FTS-OR 0.625);
// - embeddinggemma: 17.7 tokens/s on the reference host, and its eval run was contaminated.
// node-llama-cpp is recorded in the inventory but is not a candidate until the reference eval
// measures a GGUF model.
//
// Rules for the ladder:
// - a fallback model is used only when it is already installed and no preferred model is; the fit
//   never pulls one;
// - a new model becomes preferred only when it beats the top preferred model on the eval with
//   p < 0.05. granite-embedding:278m is the second preferred model because no measured model
//   dominates it (best R@5, multilingual); its +0.125 over granite-embedding:30m (5 vs 0,
//   p 0.0625) is not significant, so the step-up formula chooses between the two per machine.
const LADDER: LadderEntry[] = [
  {
    model: "granite-embedding:30m",
    status: "preferred",
    dims: 384,
    contextTokens: 512,
    multilingual: false,
    sizeMB: 62,
    priors: withSignP({
      r5Hybrid: 0.85,
      r5HybridEn: 0.933,
      r5HybridNonEn: 0.6,
      deltaVsFtsOr: 0.225,
      discordant: [10, 1],
      tokensPerSecRef: 338.2,
      queryP50MsRef: 77,
      queryP95MsRef: 1672,
      rssMBRef: 92,
    }),
    source: LADDER_REFERENCE_SOURCE,
  },
  {
    model: "granite-embedding:278m",
    status: "preferred",
    dims: 768,
    contextTokens: 512,
    multilingual: true,
    sizeMB: 562,
    priors: withSignP({
      r5Hybrid: 0.975,
      r5HybridEn: 1,
      r5HybridNonEn: 0.9,
      deltaVsFtsOr: 0.35,
      discordant: [14, 0],
      tokensPerSecRef: 167.1,
      queryP50MsRef: 179,
      queryP95MsRef: 539,
      rssMBRef: 693,
    }),
    source: `${LADDER_REFERENCE_SOURCE}. Against granite-embedding:30m: +0.125 R@5 (5 vs 0 discordant, p 0.0625, not significant)`,
  },
  {
    model: "nomic-embed-text",
    status: "fallback",
    dims: 768,
    contextTokens: 2048,
    multilingual: false,
    sizeMB: 274,
    priors: withSignP({
      r5Hybrid: 0.875,
      r5HybridEn: 1,
      r5HybridNonEn: 0.5,
      deltaVsFtsOr: 0.25,
      discordant: [10, 0],
      tokensPerSecRef: 138.9,
      queryP50MsRef: 978,
      queryP95MsRef: 2834,
      rssMBRef: 338,
    }),
    source: LADDER_REFERENCE_SOURCE,
  },
  {
    model: "mxbai-embed-large",
    status: "fallback",
    dims: 1024,
    contextTokens: 512,
    multilingual: false,
    sizeMB: 669,
    priors: withSignP({
      r5Hybrid: 0.9,
      r5HybridEn: 0.967,
      r5HybridNonEn: 0.7,
      deltaVsFtsOr: 0.275,
      discordant: [12, 1],
      tokensPerSecRef: 95.6,
      queryP50MsRef: 423,
      queryP95MsRef: 8609,
      rssMBRef: 690,
    }),
    source: `${LADDER_REFERENCE_SOURCE}. Its query p95 was inflated by queueing behind another client`,
  },
];

/** The measured models. The only home of embedding model names in the fork paths (#18). */
export const EMBEDDER_LADDER: readonly LadderEntry[] = Object.freeze(LADDER);

// -------------------------------------------------------------------------------------------------
// (3) Ceilings and labelled priors
// -------------------------------------------------------------------------------------------------

/**
 * Today's constants, kept only as ceilings or labelled priors (#19): a derived bound may come out
 * lower, never higher.
 */
export const EMBED_CEILINGS = Object.freeze({
  /** Most tokens one background batch carries (today's EMBEDDING_BATCH_MAX_TOKENS). */
  batchTokens: 8000,
  /** Ceiling of the derived batch deadline (today's 10-minute local timeout). */
  batchDeadlineMs: 600_000,
  /** Ceiling of the derived per-query deadline (today's 60 s query timeout). */
  queryDeadlineMs: 60_000,
  /** Labelled prior for a remote batch until 20 live calls are measured (today's 120 s). */
  remotePriorBatchDeadlineMs: 120_000,
  /** Most requests in flight per endpoint (today's EMBEDDING_INDEX_CONCURRENCY). */
  indexConcurrency: 4,
  /** Longest breaker cool-down: 6 h. */
  breakerCooldownMaxMs: 21_600_000,
  /** Longest per-turn wait of the prefrontal semantic lane. */
  laneBudgetMs: 1000,
});

/**
 * t_miss when this install has fewer than 20 model steps to measure: the median gap from a tool
 * result to the next assistant message (81 steps) on the reference install. A labelled prior; the
 * fit replaces it with this install's own median.
 */
export const MISS_COST_PRIOR: Readonly<Measured> = {
  value: 21.57,
  unit: "s",
  n: 81,
  provenance: "third-party-reported",
  source:
    "measured on another install, 2026-10-29: median gap from a tool result to the next assistant message",
};

/** L when fewer than 50 typed prompts were measured: the reference eval's own mix, 10 of 40. */
export const NON_ENGLISH_SHARE_PRIOR: Readonly<Measured> = {
  value: 0.25,
  unit: "share",
  denominator: "typed prompts",
  provenance: "estimated",
  source: "the reference eval's own language mix (10 of 40 queries)",
};

/** c when CPU pressure was not measured (it is read on Linux only): 1, the worst case. */
const CONTENTION_UNMEASURED: Readonly<Measured> = {
  value: 1,
  unit: "owner-s per background-s",
  provenance: "estimated",
  source: "contention not measured: c = 1, the worst case",
};

/**
 * H, the days over which a decision's initial backlog is charged in the demand account.
 * Objective: charge each model its one-off backlog as a daily cost, so the demand and step-up
 * break-evens compare like with like. Derived from: how long a decision stands; 30 is a labelled
 * prior until days since the last decision change are measured. Break-even: a shorter H charges
 * the backlog harder and favours the cheaper model. Changes when re-fits come faster or slower.
 */
export const DEMAND_HORIZON_PRIOR_DAYS = 30;

/**
 * The gain gate's significance level. Objective: admit the vector half only where its win over word
 * search is unlikely to be chance. Derived from: the paired sign test on the frozen 40-query eval.
 * Break-even: p = 0.05, one false admission in 20. Changes with a larger or different eval.
 */
export const GAIN_SIGNIFICANCE = 0.05;

/**
 * Bounds of the breaker threshold F. Objective: one failure is never enough evidence to stop an
 * endpoint (2), and a dead endpoint costs at most 5 timed-out batches before it is stopped (5).
 * Design bounds, not measurements: the measured part is the formula between them.
 */
const BREAKER_MIN_FAILURES = 2;
const BREAKER_MAX_FAILURES = 5;

// -------------------------------------------------------------------------------------------------
// (4) Threshold formulas. Pure; every working bound the governor uses comes from here.
// -------------------------------------------------------------------------------------------------

/**
 * deltaR, the recall gain of a model's hybrid search over word search alone, weighted by the
 * install's language mix. Objective: what one query gains from the vector half.
 * Formula: deltaR = (1 - L) x (R@5en - FTS-OR R@5en) + L x (R@5nonEn - FTS-OR R@5nonEn), with L the
 * non-English share of typed prompts. Changes with the language mix or a new eval.
 */
export function recallGainFor(entry: Pick<LadderEntry, "priors">, nonEnglishShare: number): number {
  const share = isFiniteNumber(nonEnglishShare)
    ? clamp(nonEnglishShare, 0, 1)
    : NON_ENGLISH_SHARE_PRIOR.value;
  return (
    (1 - share) * (entry.priors.r5HybridEn - FTS_OR_REFERENCE.r5En) +
    share * (entry.priors.r5HybridNonEn - FTS_OR_REFERENCE.r5NonEn)
  );
}

/**
 * K, the keep-up ratio. Objective: background embedding must drain new memory faster than it
 * arrives. Formula: K = theta x D x 86,400 / I (theta tokens/s, D the idle share, I tokens/day
 * including chunk overlap). Break-even K = 1; the working requirement is K >= burst, so a peak day
 * drains within a day. Changes with the machine, the model, the writing rate and host load.
 */
export function keepUpRatio(p: {
  tokensPerSec: number;
  idleShare: number;
  ingestTokensPerDay: number;
}): number {
  if (!(p.tokensPerSec > 0)) {
    return 0;
  }
  if (!(p.ingestTokensPerDay > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return (p.tokensPerSec * clamp(p.idleShare, 0, 1) * SECONDS_PER_DAY) / p.ingestTokensPerDay;
}

/**
 * B_q, the query budget. Objective: a query embed the caller waits for must cost less than the time
 * the vector half saves on that query. Formula: B_q = deltaR x t_miss. Changes with a faster agent
 * model (t_miss) or a different model or language mix (deltaR).
 */
export function queryBreakEvenMs(p: { recallGain: number; missCostMs: number }): number {
  return p.recallGain * p.missCostMs;
}

/**
 * Background batch size. Objective: a batch must fit its own deadline and must not hold a one-slot
 * embedder longer than a foreground query can wait. Formula: batchTokens = clamp(theta x (B_q -
 * t_q95), one chunk, ceiling), counted in tokens. With no slack the batch is one chunk.
 */
export function batchPlan(p: {
  tokensPerSec: number;
  queryBudgetMs: number;
  queryP95Ms: number;
  chunkTokens: number;
  ceilingTokens?: number;
}): { batchTokens: number; slackMs: number } {
  const chunk = Math.max(1, Math.round(p.chunkTokens));
  const ceiling = Math.max(chunk, p.ceilingTokens ?? EMBED_CEILINGS.batchTokens);
  const slackMs = Math.max(0, p.queryBudgetMs - p.queryP95Ms);
  const raw = (p.tokensPerSec * slackMs) / 1000;
  const batchTokens = Math.floor(clamp(Number.isNaN(raw) ? chunk : raw, chunk, ceiling));
  return { batchTokens, slackMs: Number.isNaN(slackMs) ? 0 : slackMs };
}

/**
 * Per-request deadline. Objective: give up on a request exactly when it can no longer be healthy.
 * Formula: min(ceiling, coldLoad + overhead + tokens / theta_low x 1000 x dispersion). Dispersion is
 * the prior 2 until 20 calls are measured. Changes with theta, dispersion and model residency.
 */
export function requestDeadlineMs(p: {
  tokens: number;
  tokensPerSecLow: number;
  dispersion?: number;
  overheadMs?: number;
  coldLoadMs?: number;
  ceilingMs: number;
}): number {
  if (!(p.tokensPerSecLow > 0)) {
    return p.ceilingMs;
  }
  const dispersion = isFiniteNumber(p.dispersion) ? Math.max(1, p.dispersion) : 2;
  const overhead = isFiniteNumber(p.overheadMs) ? Math.max(0, p.overheadMs) : 0;
  const cold = isFiniteNumber(p.coldLoadMs) ? Math.max(0, p.coldLoadMs) : 0;
  const tokens = isFiniteNumber(p.tokens) ? Math.max(0, p.tokens) : 0;
  return Math.min(p.ceilingMs, cold + overhead + (tokens / p.tokensPerSecLow) * 1000 * dispersion);
}

/** One model's daily account, the input of the demand and step-up break-evens. */
export type DemandAccount = {
  /** c, owner-seconds lost per background second; unmeasured counts as 1. */
  contention?: number;
  /** C_idx: embedder seconds per day for new ingest (I / theta). */
  dailyEmbedSec: number;
  /** C_pend: embedder seconds the current backlog needs (pending tokens / theta). */
  pendingEmbedSec: number;
  /** H: days over which the backlog is charged. */
  horizonDays: number;
  recallGain: number;
  missCostSec: number;
  queryP50Sec: number;
};

/**
 * Q*, the demand break-even. Objective: embed in the background only while real searches repay
 * what embedding costs. Formula: Q* = c x (C_idx + C_pend / H) / (deltaR x t_miss - t_q50), in
 * searches per day; Infinity when one search saves no more than its query embed costs. Changes
 * when demand appears, contention is measured, or quality, language mix or t_miss move.
 */
export function demandBreakEvenPerDay(p: DemandAccount): number {
  const perSearchSec = p.recallGain * p.missCostSec - p.queryP50Sec;
  if (!(perSearchSec > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  const q = (contentionOrWorst(p.contention) * dailyCostSec(p)) / perSearchSec;
  return Number.isFinite(q) ? q : Number.POSITIVE_INFINITY;
}

/**
 * Q*_step, the step-up break-even. Objective: pay for a bigger model only when its extra recall buys
 * more time than its extra cost. Formula: the demand formula on the differences,
 * c x deltaC_day / (delta-deltaR x t_miss - delta t_q50); Infinity when the dearer model saves no
 * more per search. decideEmbedderFit adds the negligible-cost clause on top (see assessStepUp).
 */
export function stepUpBreakEvenPerDay(cheaper: DemandAccount, dearer: DemandAccount): number {
  const extraPerSearchSec =
    (dearer.recallGain - cheaper.recallGain) * dearer.missCostSec -
    (dearer.queryP50Sec - cheaper.queryP50Sec);
  if (!(extraPerSearchSec > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  const c = contentionOrWorst(dearer.contention ?? cheaper.contention);
  const q = (c * (dailyCostSec(dearer) - dailyCostSec(cheaper))) / extraPerSearchSec;
  return Number.isFinite(q) ? Math.max(0, q) : Number.POSITIVE_INFINITY;
}

/**
 * The RAM floor. Objective: the resident model must not push the host into swap.
 * Formula: max(1.5 GiB, 10% of RAM). Declared twin: extensions/tinkerclaw-tinker-bridge/src/
 * worker-pool.ts holds the same floor for idle workers; never import across the extension boundary.
 */
export function memoryFloorBytes(totalRamBytes: number): number {
  return Math.max(1.5 * GIB, 0.1 * (isFiniteNumber(totalRamBytes) ? totalRamBytes : 0));
}

/** Spare RAM for resident embedding models: min(MemAvailable - floor, the endpoint's cap). */
export function ramSpareBytes(p: {
  memAvailableBytes: number;
  totalRamBytes: number;
  endpointCapBytes?: number;
}): number {
  const cap =
    isFiniteNumber(p.endpointCapBytes) && p.endpointCapBytes > 0
      ? p.endpointCapBytes
      : Number.POSITIVE_INFINITY;
  return Math.min(p.memAvailableBytes - memoryFloorBytes(p.totalRamBytes), cap);
}

/**
 * The RAM gate. Objective: the resident model must not push the host into swap.
 * Formula: fits iff rss + other resident <= min(MemAvailable - floor, endpoint cap). Changes with
 * RAM size, other resident models, gateway growth and the container cap.
 */
export function ramFits(p: {
  rssBytes: number;
  memAvailableBytes: number;
  totalRamBytes: number;
  otherResidentBytes?: number;
  endpointCapBytes?: number;
}): boolean {
  const other = isFiniteNumber(p.otherResidentBytes) ? Math.max(0, p.otherResidentBytes) : 0;
  return p.rssBytes + other <= ramSpareBytes(p);
}

/**
 * F, the breaker threshold. Objective: stop paying for an endpoint that cannot answer, while a
 * false trip stays rarer than once a day. Formula: F = clamp(ceil(ln(1/N) / ln p), 2, 5), with p the
 * healthy failure rate and N batches per day. Changes with endpoint reliability and batch rate.
 */
export function breakerThreshold(p: {
  baselineFailureRate: number;
  batchesPerDay: number;
}): number {
  const raw = Math.ceil(Math.log(1 / p.batchesPerDay) / Math.log(p.baselineFailureRate));
  if (Number.isNaN(raw)) {
    return BREAKER_MIN_FAILURES;
  }
  return clamp(raw, BREAKER_MIN_FAILURES, BREAKER_MAX_FAILURES);
}

/**
 * Breaker cool-down. Objective: re-probe a dead endpoint rarely, but soon after it can recover.
 * Formula: min(6 h, 2 x the batch deadline x 2^(trips - 1)).
 */
export function breakerCooldownMs(p: { deadlineMs: number; consecutiveTrips: number }): number {
  const trips = isFiniteNumber(p.consecutiveTrips)
    ? Math.max(1, Math.floor(p.consecutiveTrips))
    : 1;
  const ms = 2 * Math.max(0, p.deadlineMs) * 2 ** (trips - 1);
  return Number.isFinite(ms)
    ? Math.min(EMBED_CEILINGS.breakerCooldownMaxMs, ms)
    : EMBED_CEILINGS.breakerCooldownMaxMs;
}

/**
 * The idle gate. Objective: background embedding uses idle CPU only, so live turns are not starved.
 * Formula: open iff load1 - s x u + s <= logical cores, with s the embedder's cores and u the
 * governor's own duty over the last 60 s. An unmeasured s counts as one core: one request in flight
 * keeps at least one core busy on a CPU endpoint (a labelled assumption; a GPU measures near 0).
 */
export function idleGateOpen(p: {
  load1: number;
  logicalCores: number;
  embedCores: number;
  ownDuty: number;
}): boolean {
  const s = isFiniteNumber(p.embedCores) ? Math.max(0, p.embedCores) : 1;
  const u = isFiniteNumber(p.ownDuty) ? clamp(p.ownDuty, 0, 1) : 0;
  return p.load1 - s * u + s <= p.logicalCores;
}

/**
 * Trial length of a self-retiring lane, by the rule of three. Objective: retire a per-turn lane that
 * rescues nothing worth its cost (#25). Break-even rescue rate P* = mean_q / t_miss; the trial runs
 * n = ceil(3 / P*) = ceil(3 x t_miss / mean_q) invocations.
 */
export function trialInvocations(p: { missCostMs: number; meanQueryMs: number }): number {
  if (!(p.meanQueryMs > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!(p.missCostMs > 0)) {
    return 0;
  }
  return Math.ceil((3 * p.missCostMs) / p.meanQueryMs);
}

// -------------------------------------------------------------------------------------------------
// (5) decideEmbedderFit: measurements in, one decision out. Pure and deterministic.
// -------------------------------------------------------------------------------------------------

/** Everything the fit measured, plus the config facts the decision must respect. */
export type EmbedderFitInput = {
  fingerprint: CheapFingerprint;
  inventory: EmbedderInventory;
  candidates: CandidateMeasurement[];
  corpus?: CorpusStats;
  /** t_miss: what one missed recall costs, the median model step. */
  missCostSec: Measured;
  /** L: the non-English share of typed prompts. */
  nonEnglishShare: Measured;
  /** c: owner-seconds lost per background embedder second; unmeasured counts as 1. */
  contention?: Measured;
  memAvailableBytes: number;
  totalRamBytes: number;
  /** The embedder endpoint's own memory cap (a container limit), when known. */
  endpointCapBytes?: number;
  /** Q: real memory searches per day; absent at install. */
  demandPerDay?: Measured;
  /** memorySearch.sources as configured. The fit never adds 'sessions'. */
  explicitSources: string[];
  consent: EmbedderConsent;
  fitWallSeconds: Measured;
  /** memorySearch.provider before the seam: 'auto' asks the fit, anything else is a pin. */
  rawProvider: string;
  /** memorySearch.model when pinned: narrows the pin's proposal to that model. */
  rawModel?: string;
};

const OBJECTIVES: Record<ThresholdName, string> = {
  context: "Every chunk fits the model's context, so no chunk is embedded cut short.",
  ram: "The resident model must not push the host into swap.",
  query:
    "A query embed the caller waits for must cost less than the time the vector half saves on that query.",
  batch:
    "One chunk must fit inside its own request deadline, or every background batch would time out.",
  "keep-up":
    "Background embedding must drain new memory faster than it arrives, using only idle CPU.",
  gain: "Vectors run only where the paired eval shows hybrid search beats word search, and the model works here.",
  demand: "Embed in the background only while real searches repay what embedding costs.",
  "step-up":
    "Pay for a bigger model only when its extra recall buys more time than its extra cost; where that cost is negligible, the more precise model wins.",
};

type CorpusView = {
  stats: CorpusStats;
  chunkTokens: number;
  overlapFactor: number;
  /** I: tokens/day to embed, chunk overlap included. */
  ingestTokensPerDay: number;
  sessionIngestTokensPerDay: number | undefined;
  /** B: peak day / mean day, at least 1. */
  burst: number;
  /** Corpus tokens x overlap: everything a new model must embed once. */
  backlogTokens: number;
};

type DecideContext = {
  L: number;
  nonEnglishShare: Measured;
  missCost: Measured;
  contention: Measured;
  fitWall: Measured | undefined;
  fitWallSec: number;
  corpus: CorpusView | undefined;
  memAvailableBytes: number;
  totalRamBytes: number;
  endpointCapBytes: number | undefined;
  ollamaEndpoint: EmbeddingEndpointClass;
  consentProvider: string | undefined;
  standIn: { entry: LadderEntry; gain: number };
};

type Assessment = {
  candidate: CandidateMeasurement;
  label: string;
  entry: LadderEntry | undefined;
  remote: boolean;
  /** Why this candidate cannot be chosen whatever its verdicts say. */
  excluded: string | undefined;
  gain: number;
  gainInput: Measured | undefined;
  gates: ThresholdVerdict[];
  survives: boolean;
};

/**
 * Map one machine's measurements to one decision:
 * - per measured candidate, the gates context, ram, query (t_q95 <= B_q), batch (one chunk fits its
 *   deadline), keep-up (K at full idle >= burst, recording the least idle share B / K) and gain
 *   (paired p < 0.05 against word search);
 * - the cheapest preferred survivor by measured theta, stepped up to a dearer one only when
 *   assessStepUp says it pays;
 * - an installed fallback only when no preferred model is installed, with a proposal to pull the
 *   cheapest preferred one;
 * - a remote candidate only with recorded consent, and only when no local model survives;
 * - 'memory+sessions' only when the config lists sessions and keep-up passes with their ingest;
 * - dormant while demand is unknown or under Q* and the backlog takes longer than one fit;
 * - with a pinned provider, the same decision plus a proposal naming each gate the pin fails;
 * - no survivor: 'off', with every failing verdict in the reasons.
 */
export function decideEmbedderFit(input: EmbedderFitInput): FitDecision {
  const ctx = decideContext(input);
  const assessed = input.candidates.map((c) => assessCandidate(c, ctx));
  const reasons: string[] = [];
  const verdicts: ThresholdVerdict[] = [];
  for (const a of assessed) {
    verdicts.push(...a.gates);
  }

  const survivors = assessed.filter((a) => a.survives).sort((x, y) => thetaOf(y) - thetaOf(x));
  const preferred = survivors.filter((a) => !a.remote && a.entry?.status === "preferred");
  const fallback = survivors.filter((a) => !a.remote && a.entry?.status === "fallback");
  const remote = survivors.filter((a) => a.remote);
  const preferredInstalled = isPreferredInstalled(input);
  const corpus = ctx.corpus;

  let pick: Assessment | undefined;
  let proposal: FitDecision["proposal"];
  if (preferred.length > 0 && corpus) {
    let current = preferred[0];
    reasons.push(
      `${current.label}: the cheapest preferred model that passed every gate (${fmt(thetaOf(current))} tokens/s measured here)`,
    );
    for (const dearer of preferred.slice(1)) {
      const step = assessStepUp(current, dearer, input.demandPerDay, corpus, ctx);
      verdicts.push(step.verdict);
      reasons.push(step.reason);
      if (step.verdict.pass) {
        current = dearer;
      }
    }
    pick = current;
  } else if (fallback.length > 0 && !preferredInstalled) {
    pick = fallback[0];
    reasons.push(
      `${pick.label}: an installed fallback model that passed every gate; no preferred model is installed`,
    );
    proposal = pullPreferredProposal(`${pick.label} works here, but `);
  } else if (remote.length > 0) {
    pick = remote[0];
    reasons.push(
      `${pick.label}: remote, with recorded consent (memory text leaves this machine); no local model passed every gate`,
    );
  }
  if (!pick && fallback.length > 0 && preferredInstalled) {
    reasons.push(
      `a preferred model is installed, so the installed fallback ${fallback.map((a) => a.label).join(", ")} is not used`,
    );
  }

  let mode: FitMode = "off";
  let dormantUntilDemand = false;
  let demandBreakEven: number | undefined;
  const demand = measuredOrUndefined(input.demandPerDay, "searches/day");
  if (pick && corpus) {
    const sessions = decideSessions(pick, input, corpus, reasons, verdicts);
    mode = sessions.mode;
    const account = accountFor(pick, ctx, corpus, sessions.dailyTokens);
    const qStar = demandBreakEvenPerDay(account);
    const backlogSec = corpus.backlogTokens / thetaOf(pick);
    dormantUntilDemand =
      (demand === undefined || demand.value < qStar) && backlogSec > ctx.fitWallSec;
    if (Number.isFinite(qStar)) {
      demandBreakEven = qStar;
    } else {
      reasons.push(
        `${pick.label}: one search saves no more than its query embed costs, so background embedding never repays itself here`,
      );
    }
    if (demand) {
      verdicts.push(demandVerdict(pick, demand, qStar, account, ctx));
    }
    reasons.push(dormancyReason(dormantUntilDemand, demand, qStar, backlogSec, ctx.fitWallSec));
  } else {
    pick = undefined;
    offReasons(assessed, input, ctx, reasons);
    proposal ??= offProposal(input, preferredInstalled);
  }

  const unconsented = input.inventory.remoteKeys.filter((id) => id !== ctx.consentProvider);
  if (mode === "off" && unconsented.length > 0) {
    reasons.push(
      `a key exists for ${unconsented.join(", ")}; remote embedding runs only after an explicit yes, because memory text would leave this machine (openclaw embedder fit --allow-remote <provider>)`,
    );
  }

  const pinProposal = pinAdvice(input, assessed, pick, reasons);
  if (pinProposal) {
    proposal = pinProposal;
  }

  return {
    mode,
    ...(pick ? { provider: pick.candidate.provider, model: pick.candidate.model } : {}),
    ...(pick && isFiniteNumber(pick.candidate.numThread)
      ? { numThread: pick.candidate.numThread }
      : {}),
    ...(demandBreakEven !== undefined ? { demandBreakEvenPerDay: demandBreakEven } : {}),
    dormantUntilDemand,
    reasons: [...new Set(reasons)],
    verdicts,
    ...(proposal ? { proposal } : {}),
  };
}

function decideContext(input: EmbedderFitInput): DecideContext {
  const nonEnglishShare = measuredOr(input.nonEnglishShare, "share", NON_ENGLISH_SHARE_PRIOR);
  const L = clamp(nonEnglishShare.value, 0, 1);
  const missCostIn = measuredOr(input.missCostSec, "s", MISS_COST_PRIOR);
  const contentionIn = measuredOrUndefined(input.contention, "owner-s per background-s");
  const fitWall = measuredOrUndefined(input.fitWallSeconds, "s");
  return {
    L,
    nonEnglishShare,
    missCost: missCostIn.value > 0 ? missCostIn : { ...MISS_COST_PRIOR },
    contention:
      contentionIn && contentionIn.value >= 0 ? contentionIn : { ...CONTENTION_UNMEASURED },
    fitWall,
    fitWallSec: fitWall && fitWall.value >= 0 ? fitWall.value : 0,
    corpus: corpusView(input.corpus),
    memAvailableBytes: input.memAvailableBytes,
    totalRamBytes: input.totalRamBytes,
    endpointCapBytes:
      isFiniteNumber(input.endpointCapBytes) && input.endpointCapBytes > 0
        ? input.endpointCapBytes
        : undefined,
    ollamaEndpoint: classifyEmbeddingEndpoint({
      providerId: "ollama",
      baseUrl: input.inventory.ollama.baseUrl,
    }),
    consentProvider: input.consent.remote?.provider,
    standIn: weakestLadderPrior(L),
  };
}

function corpusView(stats: CorpusStats | undefined): CorpusView | undefined {
  if (!stats || !(stats.chunkTokens >= 1)) {
    return undefined;
  }
  const tokens = stats.tokens.value;
  const ingest = stats.ingestTokensPerDay.value;
  const burst = stats.burstFactor.value;
  if (!isNonNegative(tokens) || !isNonNegative(ingest) || !isFiniteNumber(burst)) {
    return undefined;
  }
  const chunkTokens = Math.round(stats.chunkTokens);
  const overlapTokens = clamp(Math.round(stats.overlapTokens), 0, chunkTokens - 1);
  const overlapFactor =
    chunkTokens / (chunkTokens - (Number.isNaN(overlapTokens) ? 0 : overlapTokens));
  const session = stats.sessionIngestTokensPerDay?.value;
  return {
    stats,
    chunkTokens,
    overlapFactor,
    ingestTokensPerDay: ingest * overlapFactor,
    sessionIngestTokensPerDay: isNonNegative(session) ? session * overlapFactor : undefined,
    burst: Math.max(1, burst),
    backlogTokens: tokens * overlapFactor,
  };
}

function assessCandidate(c: CandidateMeasurement, ctx: DecideContext): Assessment {
  const isOllama = c.provider === "ollama";
  const label = isOllama ? c.model : `${c.provider}/${c.model}`;
  const entry = isOllama ? ladderEntryFor(c.model) : undefined;
  const endpoint = isOllama
    ? ctx.ollamaEndpoint
    : classifyEmbeddingEndpoint({ providerId: c.provider });
  const remote = endpoint === "remote";
  let excluded: string | undefined;
  if (endpoint === "inproc") {
    excluded = `${label}: in-process embedding is recorded but is not a candidate until the reference eval measures a GGUF model`;
  } else if (isOllama && !entry) {
    excluded = `${label}: not on the embedder ladder (no paired eval against word search)`;
  } else if (remote && ctx.consentProvider !== c.provider) {
    excluded = `${label}: remote, and no recorded consent names ${c.provider}; memory text would leave this machine`;
  }
  // A consented remote model has no paired eval: the weakest ladder prior stands in, labelled
  // 'estimated', so its query budget and gain gate never assume more than any measured model.
  const prior = entry ?? (remote ? ctx.standIn.entry : undefined);
  if (!prior) {
    return {
      candidate: c,
      label,
      entry,
      remote,
      excluded,
      gain: Number.NaN,
      gainInput: undefined,
      gates: [],
      survives: false,
    };
  }
  const gain = entry ? recallGainFor(entry, ctx.L) : ctx.standIn.gain;
  const gainInput = entry
    ? m(
        gain,
        "R@5 over word search",
        "third-party-reported",
        `${prior.source}; weighted by the non-English share ${fmt(ctx.L)}`,
      )
    : m(
        gain,
        "R@5 over word search",
        "estimated",
        `no paired eval of ${label}: the weakest ladder prior (${prior.model}) stands in, weighted by the non-English share ${fmt(ctx.L)}`,
      );
  const gates = gateVerdicts(c, { label, entry, prior, gainInput, remote }, ctx);
  const survives = excluded === undefined && ctx.corpus !== undefined && gates.every((v) => v.pass);
  return { candidate: c, label, entry, remote, excluded, gain, gainInput, gates, survives };
}

function gateVerdicts(
  c: CandidateMeasurement,
  a: {
    label: string;
    entry: LadderEntry | undefined;
    prior: LadderEntry;
    gainInput: Measured;
    remote: boolean;
  },
  ctx: DecideContext,
): ThresholdVerdict[] {
  const gates: ThresholdVerdict[] = [];
  const corpus = ctx.corpus;
  const ladderSource = `ladder prior for ${a.prior.model}; ${a.prior.source}`;
  const here = (what: string): string => `fit on this machine: ${a.label} ${what}`;

  if (corpus && a.entry) {
    gates.push(
      makeVerdict(
        "context",
        a.label,
        a.entry.contextTokens,
        corpus.chunkTokens,
        a.entry.contextTokens >= corpus.chunkTokens,
        "model context tokens >= chunk tokens (a remote model's context is not on the ladder and is not checked)",
        {
          contextTokens: m(a.entry.contextTokens, "tokens", "third-party-reported", ladderSource),
          chunkTokens: m(
            corpus.chunkTokens,
            "tokens",
            "local-measured",
            "memorySearch.chunking.tokens",
          ),
        },
      ),
    );
  }

  if (!a.remote) {
    const rssMeasured = isFiniteNumber(c.rssBytes) && c.rssBytes >= 0;
    const rss =
      isFiniteNumber(c.rssBytes) && c.rssBytes >= 0 ? c.rssBytes : a.prior.priors.rssMBRef * MIB;
    const ram = {
      rssBytes: rss,
      memAvailableBytes: ctx.memAvailableBytes,
      totalRamBytes: ctx.totalRamBytes,
      otherResidentBytes: 0,
      endpointCapBytes: ctx.endpointCapBytes,
    };
    const inputs: Record<string, Measured> = {
      rssBytes: rssMeasured
        ? m(rss, "bytes", "local-measured", here("resident size"))
        : m(rss, "bytes", "third-party-reported", ladderSource),
      memAvailableBytes: m(
        ctx.memAvailableBytes,
        "bytes",
        "local-measured",
        "MemAvailable at fit time",
      ),
      floorBytes: m(
        memoryFloorBytes(ctx.totalRamBytes),
        "bytes",
        "local-measured",
        "max(1.5 GiB, 10% of RAM)",
      ),
    };
    if (ctx.endpointCapBytes !== undefined) {
      inputs.endpointCapBytes = m(
        ctx.endpointCapBytes,
        "bytes",
        "local-measured",
        "the embedder endpoint's memory cap",
      );
    }
    gates.push(
      makeVerdict(
        "ram",
        a.label,
        rss,
        ramSpareBytes(ram),
        ramFits(ram),
        "rss + other resident <= min(MemAvailable - max(1.5 GiB, 10% of RAM), endpoint cap)",
        inputs,
      ),
    );
  }

  const budgetMs = queryBreakEvenMs({
    recallGain: a.gainInput.value,
    missCostMs: ctx.missCost.value * 1000,
  });
  gates.push(
    makeVerdict(
      "query",
      a.label,
      c.queryP95Ms,
      budgetMs,
      c.queryP95Ms <= budgetMs,
      "t_q95 <= B_q = deltaR x t_miss (the vector-scan time t_scan is measured at runtime, not here)",
      {
        queryP95Ms: m(c.queryP95Ms, "ms", "local-measured", here("query p95")),
        recallGain: a.gainInput,
        nonEnglishShare: ctx.nonEnglishShare,
        missCostSec: ctx.missCost,
      },
    ),
  );

  if (corpus) {
    const oneChunkMs = requestDeadlineMs({
      tokens: corpus.chunkTokens,
      tokensPerSecLow: c.tokensPerSecLow95,
      dispersion: c.batchDispersion,
      overheadMs: c.overheadMs,
      coldLoadMs: c.coldLoadMs,
      ceilingMs: Number.POSITIVE_INFINITY,
    });
    const batchInputs: Record<string, Measured> = {
      tokensPerSecLow95: m(
        c.tokensPerSecLow95,
        "tokens/s",
        "local-measured",
        here("throughput, low end of the 95% band"),
      ),
      batchDispersion: m(
        c.batchDispersion,
        "p95/p50",
        "local-measured",
        here("batch time dispersion"),
      ),
      overheadMs: m(c.overheadMs, "ms", "local-measured", here("one-token request")),
      chunkTokens: m(
        corpus.chunkTokens,
        "tokens",
        "local-measured",
        "memorySearch.chunking.tokens",
      ),
    };
    if (isFiniteNumber(c.coldLoadMs)) {
      batchInputs.coldLoadMs = m(c.coldLoadMs, "ms", "local-measured", here("cold load"));
    }
    gates.push(
      makeVerdict(
        "batch",
        a.label,
        oneChunkMs,
        EMBED_CEILINGS.batchDeadlineMs,
        oneChunkMs <= EMBED_CEILINGS.batchDeadlineMs,
        "coldLoad + overhead + chunkTokens / theta_low95 x 1000 x dispersion <= the batch deadline ceiling",
        batchInputs,
      ),
    );

    const keepUp = keepUpRatio({
      tokensPerSec: c.tokensPerSec.value,
      idleShare: 1,
      ingestTokensPerDay: corpus.ingestTokensPerDay,
    });
    gates.push(
      makeVerdict(
        "keep-up",
        a.label,
        keepUp,
        corpus.burst,
        keepUp >= corpus.burst,
        "K = theta x 86,400 / I >= burst B at full idle (D = 1); the governor must keep the idle share >= B / K",
        {
          tokensPerSec: c.tokensPerSec,
          ingestTokensPerDay: ingestMeasured(corpus),
          burstFactor: corpus.stats.burstFactor,
          minIdleShare: minIdleShareMeasured(keepUp, corpus.burst),
        },
      ),
    );
  }

  const sane = c.sanityOk !== false;
  const signP = a.prior.priors.signP;
  const [wins, losses] = a.prior.priors.discordant;
  const standInNote = a.entry
    ? ""
    : `; no paired eval of ${a.label}, so the weakest ladder prior (${a.prior.model}) stands in`;
  gates.push(
    makeVerdict(
      "gain",
      a.label,
      signP,
      GAIN_SIGNIFICANCE,
      sane && signP < GAIN_SIGNIFICANCE,
      sane
        ? `paired sign test of hybrid vs FTS-OR on the reference eval (${wins} vs ${losses} discordant): p < ${GAIN_SIGNIFICANCE}${standInNote}`
        : "the sanity pairs failed on this machine (paraphrases did not score above unrelated text), so the eval prior does not apply",
      { signP: m(signP, "p-value", a.entry ? "third-party-reported" : "estimated", ladderSource) },
    ),
  );

  return gates;
}

// Step-up (#19). The demand formula alone is scale-free in theta: with unknown demand the reference
// is the cheaper model's own Q*, and both sides scale as 1/theta, so a GPU at 20,000 / 12,000
// tokens/s would decide exactly like the reference Pi at 338 / 167. The design's objective adds that
// where the extra cost is negligible, the more precise model wins. Negligible is measured against
// the fit itself: the governor may run one re-measure per 24 h, so one fit's wall time per day is
// overhead this design already accepts. A dearer model whose extra embedder seconds per day
// (deltaC_day, the numerator of Q*_step before contention) stay within one fit's wall time wins on
// quality, provided it saves more per search. Reference Pi: deltaC_day 2,287 s against a 150 s fit,
// so the formula decides (30m). A GPU at 20,000 / 12,000 tokens/s: about 25 s, so 278m.
function assessStepUp(
  cheaper: Assessment,
  dearer: Assessment,
  demandIn: Measured | undefined,
  corpus: CorpusView,
  ctx: DecideContext,
): { verdict: ThresholdVerdict; reason: string } {
  const cheap = accountFor(cheaper, ctx, corpus, corpus.ingestTokensPerDay);
  const dear = accountFor(dearer, ctx, corpus, corpus.ingestTokensPerDay);
  const qStep = stepUpBreakEvenPerDay(cheap, dear);
  const demand = measuredOrUndefined(demandIn, "searches/day");
  const reference = demand ? demand.value : demandBreakEvenPerDay(cheap);
  const extraDailySec = dailyCostSec(dear) - dailyCostSec(cheap);
  const extraPerSearchSec =
    (dear.recallGain - cheap.recallGain) * dear.missCostSec -
    (dear.queryP50Sec - cheap.queryP50Sec);
  const pays = qStep <= reference;
  const negligible = extraPerSearchSec > 0 && extraDailySec <= ctx.fitWallSec;
  const inputs: Record<string, Measured> = {
    contention: ctx.contention,
    extraEmbedSecPerDay: m(
      extraDailySec,
      "s/day",
      "estimated",
      `deltaC_day of ${dearer.label} over ${cheaper.label}: the difference of I / theta + backlog / theta / H`,
    ),
    missCostSec: ctx.missCost,
    demandReference:
      demand ??
      m(reference, "searches/day", "estimated", `no measured demand: ${cheaper.label}'s own Q*`),
  };
  if (cheaper.gainInput) {
    inputs.recallGainCheaper = cheaper.gainInput;
  }
  if (dearer.gainInput) {
    inputs.recallGainDearer = dearer.gainInput;
  }
  if (ctx.fitWall) {
    inputs.fitWallSeconds = ctx.fitWall;
  }
  const verdict = makeVerdict(
    "step-up",
    dearer.label,
    qStep,
    reference,
    pays || negligible,
    "Q*_step = c x deltaC_day / (delta-deltaR x t_miss - delta t_q50) <= demand reference, or deltaC_day <= one fit's wall time (negligible: the more precise model wins)",
    inputs,
  );
  let reason: string;
  if (pays) {
    reason = `${dearer.label} over ${cheaper.label}: the step-up pays above ${fmt(qStep)} searches/day and the demand reference is ${fmt(reference)}/day`;
  } else if (negligible) {
    reason = `${dearer.label} over ${cheaper.label}: it costs ${fmt(extraDailySec)} more embedder-s/day, no more than one fit (${fmt(ctx.fitWallSec)} s), so the more precise model wins`;
  } else {
    const referenceNote = demand ? "" : ` (${cheaper.label}'s own Q*)`;
    reason = `${dearer.label} not chosen: the step-up pays above ${fmt(qStep)} searches/day, the demand reference is ${fmt(reference)}/day${referenceNote}, and its extra ${fmt(extraDailySec)} embedder-s/day exceed one fit (${fmt(ctx.fitWallSec)} s)`;
  }
  return { verdict, reason };
}

function accountFor(
  a: Assessment,
  ctx: DecideContext,
  corpus: CorpusView,
  dailyTokens: number,
): DemandAccount {
  const theta = thetaOf(a);
  return {
    contention: ctx.contention.value,
    dailyEmbedSec: dailyTokens / theta,
    pendingEmbedSec: corpus.backlogTokens / theta,
    horizonDays: DEMAND_HORIZON_PRIOR_DAYS,
    recallGain: a.gain,
    missCostSec: ctx.missCost.value,
    queryP50Sec: a.candidate.queryP50Ms / 1000,
  };
}

function decideSessions(
  pick: Assessment,
  input: EmbedderFitInput,
  corpus: CorpusView,
  reasons: string[],
  verdicts: ThresholdVerdict[],
): { mode: FitMode; dailyTokens: number } {
  const memoryOnly: { mode: FitMode; dailyTokens: number } = {
    mode: "memory",
    dailyTokens: corpus.ingestTokensPerDay,
  };
  if (!Array.isArray(input.explicitSources) || !input.explicitSources.includes("sessions")) {
    return memoryOnly;
  }
  if (pick.remote) {
    reasons.push(
      "sessions are listed in config, but remote consent covers memory files only; memory only",
    );
    return memoryOnly;
  }
  const sessionTokens = corpus.sessionIngestTokensPerDay;
  if (sessionTokens === undefined) {
    reasons.push(
      "sessions are listed in config, but their ingest was not measured, so the fit leaves them undecided; memory only",
    );
    return memoryOnly;
  }
  const total = corpus.ingestTokensPerDay + sessionTokens;
  const keepUp = keepUpRatio({
    tokensPerSec: thetaOf(pick),
    idleShare: 1,
    ingestTokensPerDay: total,
  });
  const pass = keepUp >= corpus.burst;
  const sessionStats = corpus.stats.sessionIngestTokensPerDay;
  verdicts.push(
    makeVerdict(
      "keep-up",
      pick.label,
      keepUp,
      corpus.burst,
      pass,
      "with sessions: K = theta x 86,400 / (I_memory + I_sessions) >= burst B at full idle",
      {
        tokensPerSec: pick.candidate.tokensPerSec,
        ingestTokensPerDay: ingestMeasured(corpus),
        sessionIngestTokensPerDay: m(
          sessionTokens,
          "tokens/day",
          sessionStats?.provenance ?? "estimated",
          `${sessionStats?.source ?? "session transcripts"}; x ${fmt(corpus.overlapFactor)} chunk overlap`,
        ),
        burstFactor: corpus.stats.burstFactor,
        minIdleShare: minIdleShareMeasured(keepUp, corpus.burst),
      },
    ),
  );
  if (pass) {
    reasons.push(
      `sessions: listed in config, and keep-up passes with them (K ${fmt(keepUp)} >= burst ${fmt(corpus.burst)})`,
    );
    return { mode: "memory+sessions", dailyTokens: total };
  }
  reasons.push(
    `sessions are listed in config but fail keep-up with them (K ${fmt(keepUp)} < burst ${fmt(corpus.burst)}); memory only`,
  );
  return memoryOnly;
}

function demandVerdict(
  pick: Assessment,
  demand: Measured,
  qStar: number,
  account: DemandAccount,
  ctx: DecideContext,
): ThresholdVerdict {
  const inputs: Record<string, Measured> = {
    demandPerDay: demand,
    contention: ctx.contention,
    dailyEmbedSec: m(account.dailyEmbedSec, "s/day", "estimated", "ingest tokens/day / theta"),
    pendingEmbedSec: m(
      account.pendingEmbedSec,
      "s",
      "estimated",
      "corpus tokens x overlap / theta",
    ),
    horizonDays: m(
      account.horizonDays,
      "days",
      "estimated",
      "labelled prior: how long a decision stands",
    ),
    missCostSec: ctx.missCost,
    queryP50Sec: m(
      account.queryP50Sec,
      "s",
      "local-measured",
      `fit on this machine: ${pick.label} query p50`,
    ),
  };
  if (pick.gainInput) {
    inputs.recallGain = pick.gainInput;
  }
  return makeVerdict(
    "demand",
    pick.label,
    demand.value,
    qStar,
    demand.value >= qStar,
    "Q >= Q* = c x (C_idx + C_pend / H) / (deltaR x t_miss - t_q50)",
    inputs,
  );
}

function dormancyReason(
  dormant: boolean,
  demand: Measured | undefined,
  qStar: number,
  backlogSec: number,
  fitWallSec: number,
): string {
  const demandText = demand ? `${fmt(demand.value)}/day` : "not measured yet";
  if (dormant) {
    return `dormant until demand: background embedding waits for ${fmt(qStar)} real searches/day (demand ${demandText}); the initial backlog needs ${fmt(backlogSec)} s at full idle, more than one fit (${fmt(fitWallSec)} s)`;
  }
  if (demand && demand.value >= qStar) {
    return `armed: demand ${demandText} covers the break-even ${fmt(qStar)}/day`;
  }
  return `armed: the initial backlog needs ${fmt(backlogSec)} s at full idle, no more than one fit (${fmt(fitWallSec)} s)`;
}

function offReasons(
  assessed: Assessment[],
  input: EmbedderFitInput,
  ctx: DecideContext,
  reasons: string[],
): void {
  for (const a of assessed) {
    if (a.excluded) {
      reasons.push(a.excluded);
    }
    for (const v of a.gates) {
      if (!v.pass) {
        reasons.push(
          `${a.label}: ${v.name} failed (${fmt(v.value)} vs break-even ${fmt(v.breakEven)})`,
        );
      }
    }
  }
  if (!ctx.corpus && assessed.some((a) => a.gates.length > 0)) {
    reasons.push(
      "the memory corpus was not measured, so keep-up and dormancy cannot be checked; word search only",
    );
  }
  if (assessed.length === 0) {
    const ollama = input.inventory.ollama;
    if (!ollama.reachable) {
      reasons.push(
        `no embedding endpoint: Ollama at ${ollama.baseUrl || "its default address"} is not reachable, and no consented remote provider was measured`,
      );
    } else if (!ollama.models.some((x) => ladderEntryFor(x.name) !== undefined)) {
      reasons.push("Ollama is reachable, but no model from the embedder ladder is installed");
    } else {
      reasons.push("ladder models are installed, but none was measured");
    }
  }
}

function offProposal(
  input: EmbedderFitInput,
  preferredInstalled: boolean,
): FitDecision["proposal"] {
  if (!input.inventory.ollama.reachable) {
    return {
      text: "Install Ollama, then measure this machine and pull the model that fits it:",
      command: "openclaw embedder fit --pull",
    };
  }
  return preferredInstalled ? undefined : pullPreferredProposal("");
}

function pinAdvice(
  input: EmbedderFitInput,
  assessed: Assessment[],
  pick: Assessment | undefined,
  reasons: string[],
): FitDecision["proposal"] {
  const raw = typeof input.rawProvider === "string" ? input.rawProvider.trim() : "";
  if (!raw || raw === "auto") {
    return undefined;
  }
  reasons.push(
    `memorySearch.provider is pinned to ${raw}: the pin stays, and this decision only advises`,
  );
  const rawModel = typeof input.rawModel === "string" ? input.rawModel.trim() : "";
  const pinned = assessed.find(
    (a) => a.candidate.provider === raw && (!rawModel || sameModel(a.candidate.model, rawModel)),
  );
  if (!pinned) {
    if (raw !== "none") {
      const what = rawModel ? `${raw}/${rawModel}` : raw;
      reasons.push(`the pinned ${what} was not measured, so the fit cannot check it`);
    }
    return undefined;
  }
  const failing = pinned.gates.filter((v) => !v.pass);
  if (failing.length === 0) {
    if (pinned.gates.length === 0 && pinned.excluded) {
      reasons.push(`the pinned model cannot be checked (${pinned.excluded})`);
    }
    return undefined;
  }
  const fails = failing
    .map((v) => `${v.name} (${fmt(v.value)} vs break-even ${fmt(v.breakEven)})`)
    .join(", ");
  const instead = pick
    ? `the fit would choose ${pick.label}`
    : "the fit would run word search only";
  return {
    text: `The pinned ${pinned.label} fails ${fails}; ${instead}. To follow the fit, remove the pin (here, or in the agent's own memorySearch override):`,
    command:
      "openclaw config unset agents.defaults.memorySearch.provider && openclaw config unset agents.defaults.memorySearch.model",
  };
}

function pullPreferredProposal(lead: string): { text: string; command: string } {
  const target = cheapestPreferredEntry();
  const sentence = `the ladder prefers ${target.model} (${target.sizeMB} MB download), which no measured model dominates on the reference eval. Pull it and measure this machine again:`;
  return {
    text: lead ? `${lead}${sentence}` : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`,
    command: "openclaw embedder fit --pull",
  };
}

function cheapestPreferredEntry(): LadderEntry {
  let best = EMBEDDER_LADDER[0];
  for (const e of EMBEDDER_LADDER) {
    if (
      e.status === "preferred" &&
      (best.status !== "preferred" || e.priors.tokensPerSecRef > best.priors.tokensPerSecRef)
    ) {
      best = e;
    }
  }
  return best;
}

function weakestLadderPrior(nonEnglishShare: number): { entry: LadderEntry; gain: number } {
  let entry = EMBEDDER_LADDER[0];
  let gain = recallGainFor(entry, nonEnglishShare);
  for (const e of EMBEDDER_LADDER) {
    const g = recallGainFor(e, nonEnglishShare);
    if (g < gain) {
      entry = e;
      gain = g;
    }
  }
  return { entry, gain };
}

function isPreferredInstalled(input: EmbedderFitInput): boolean {
  const names = [
    ...input.inventory.ollama.models.map((x) => x.name),
    ...input.candidates.filter((c) => c.provider === "ollama").map((c) => c.model),
  ];
  return names.some((name) => ladderEntryFor(name)?.status === "preferred");
}

function makeVerdict(
  name: ThresholdName,
  model: string,
  value: number,
  breakEven: number,
  pass: boolean,
  formula: string,
  inputs: Record<string, Measured>,
): ThresholdVerdict {
  return { name, model, objective: OBJECTIVES[name], value, breakEven, pass, formula, inputs };
}

function ingestMeasured(corpus: CorpusView): Measured {
  return m(
    corpus.ingestTokensPerDay,
    "tokens/day",
    corpus.stats.ingestTokensPerDay.provenance,
    `${corpus.stats.ingestTokensPerDay.source}; x ${fmt(corpus.overlapFactor)} chunk overlap`,
  );
}

function minIdleShareMeasured(keepUp: number, burst: number): Measured {
  return m(
    keepUp > 0 ? burst / keepUp : Number.POSITIVE_INFINITY,
    "share of wall time",
    "estimated",
    "B / K: the least idle share the governor must give background embedding",
  );
}

function thetaOf(a: Assessment): number {
  return a.candidate.tokensPerSec.value;
}

// -------------------------------------------------------------------------------------------------
// (6) The record
// -------------------------------------------------------------------------------------------------

/** Where the fit and the governor keep their per-machine state. None of it is config. */
export function embedderFitPaths(stateDir: string = resolveStateDir()): {
  record: string;
  governor: string;
  lock: string;
} {
  const dir = path.join(stateDir, "memory");
  return {
    record: path.join(dir, "embedder-fit.json"),
    governor: path.join(dir, "embedder-governor.json"),
    lock: path.join(dir, "embedder-fit.lock"),
  };
}

/** The record's path, or null for a test runner given no state dir: then no record IO at all. */
function recordFileFor(stateDir: string | undefined): string | null {
  // No test reads or writes the host's record: the governor's sandbox rule, not imported (#20).
  const testRunner = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
  if (stateDir === undefined && testRunner && !process.env.OPENCLAW_STATE_DIR?.trim()) {
    return null;
  }
  return embedderFitPaths(stateDir).record;
}

const FIT_MODES: readonly FitMode[] = ["off", "memory", "memory+sessions"];
let fitCache: { file: string; identity: string; record: EmbedderFitRecord | null } | undefined;
const warnedFitProblems = new Set<string>();

/**
 * The record, or null when it is missing or unparseable, or when a test runner gave no state dir
 * (recordFileFor: then no file is touched). Synchronous, one statSync per call: the file is
 * re-read only when its inode, size or mtime changes. One warn per distinct problem; a good read
 * clears them. Callers must not mutate the returned object (it is the cached copy).
 */
export function readEmbedderFit(stateDir?: string): EmbedderFitRecord | null {
  let file: string | null;
  try {
    file = recordFileFor(stateDir);
  } catch (err) {
    warnFitProblem("state-dir", "", `cannot resolve the state dir (${errorText(err)})`);
    return null;
  }
  if (file === null) {
    return null;
  }
  let identity: string;
  try {
    const st = fs.statSync(file);
    identity = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    if (!isMissingFileError(err)) {
      warnFitProblem(
        "stat",
        file,
        `cannot read ${file} (${errorText(err)}); memory search runs without a fit`,
      );
    }
    return null;
  }
  if (fitCache && fitCache.file === file && fitCache.identity === identity) {
    return fitCache.record;
  }
  let record: EmbedderFitRecord | null = null;
  try {
    record = normalizeRecord(JSON.parse(fs.readFileSync(file, "utf8"), decodeNonFinite));
    if (record) {
      clearFitProblems(file);
    } else {
      warnFitProblem(
        "shape",
        file,
        `${file} is not a schemaVersion 1 embedder-fit record; memory search runs without a fit`,
      );
    }
  } catch (err) {
    warnFitProblem(
      "parse",
      file,
      `${file} cannot be parsed (${errorText(err)}); memory search runs without a fit`,
    );
  }
  fitCache = { file, identity, record };
  return record;
}

/**
 * Write the record atomically (tmp file, fsync, rename) with mode 0600. The history carries over
 * from the record on disk, gains this record's own entry and keeps the newest 20. Returns what was
 * written; throws when the write fails, since the fit must not report a decision it did not store.
 * In a sandboxed test (recordFileFor) it writes nothing and returns what it would have written.
 */
export function writeEmbedderFit(rec: EmbedderFitRecord, stateDir?: string): EmbedderFitRecord {
  const file = recordFileFor(stateDir);
  const prior = readEmbedderFit(stateDir);
  const out: EmbedderFitRecord = {
    ...rec,
    schemaVersion: 1,
    history: mergeHistory([...(prior?.history ?? []), ...rec.history, historyEntryFor(rec)]),
  };
  if (file === null) {
    return out;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.embedder-fit.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(out, encodeNonFinite, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left to remove
    }
    throw err;
  }
  return out;
}

function historyEntryFor(rec: EmbedderFitRecord): EmbedderFitHistoryEntry {
  const entry: EmbedderFitHistoryEntry = {
    at: rec.createdAt,
    mode: rec.decision.mode,
    reason: rec.decision.reasons[0] ?? rec.decision.mode,
  };
  if (rec.decision.model) {
    entry.model = rec.decision.model;
  }
  return entry;
}

function mergeHistory(entries: EmbedderFitHistoryEntry[]): EmbedderFitHistoryEntry[] {
  const byKey = new Map<string, EmbedderFitHistoryEntry>();
  for (const entry of entries) {
    if (entry && typeof entry.at === "string") {
      byKey.set(`${entry.at}|${entry.mode}|${entry.model ?? ""}`, entry);
    }
  }
  return [...byKey.values()].sort(compareHistoryEntries).slice(-HISTORY_CAP);
}

function compareHistoryEntries(x: EmbedderFitHistoryEntry, y: EmbedderFitHistoryEntry): number {
  if (x.at === y.at) {
    return 0;
  }
  return x.at < y.at ? -1 : 1;
}

function normalizeRecord(parsed: unknown): EmbedderFitRecord | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const rec = parsed as Partial<EmbedderFitRecord>;
  const decision = rec.decision;
  if (
    rec.schemaVersion !== 1 ||
    !decision ||
    typeof decision !== "object" ||
    !FIT_MODES.includes(decision.mode)
  ) {
    return null;
  }
  if (!rec.fingerprint || typeof rec.fingerprint !== "object") {
    return null;
  }
  rec.candidates = Array.isArray(rec.candidates) ? rec.candidates : [];
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  decision.reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  decision.verdicts = Array.isArray(decision.verdicts) ? decision.verdicts : [];
  return rec as EmbedderFitRecord;
}

/** JSON has no Infinity: a break-even that never pays is stored as the string "Infinity". */
function encodeNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) {
      return null;
    }
    return value > 0 ? "Infinity" : "-Infinity";
  }
  return value;
}

function decodeNonFinite(_key: string, value: unknown): unknown {
  if (value === "Infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (value === "-Infinity") {
    return Number.NEGATIVE_INFINITY;
  }
  return value;
}

function warnFitProblem(kind: string, file: string, message: string): void {
  const key = `${kind}|${file}`;
  if (warnedFitProblems.has(key)) {
    return;
  }
  if (warnedFitProblems.size >= 64) {
    warnedFitProblems.clear();
  }
  warnedFitProblems.add(key);
  console.warn(`[embedder-fit] ${message}`);
}

function clearFitProblems(file: string): void {
  for (const key of warnedFitProblems) {
    if (key.endsWith(`|${file}`)) {
      warnedFitProblems.delete(key);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// (7) Fingerprints
// -------------------------------------------------------------------------------------------------

let fingerprintMemo: CheapFingerprint | undefined;

/** This machine's cheap fingerprint: synchronous, no network, read once per process. */
export function cheapFingerprint(): CheapFingerprint {
  fingerprintMemo ??= readCheapFingerprint();
  return { ...fingerprintMemo, gpu: { ...fingerprintMemo.gpu } };
}

const FINGERPRINT_SCALARS = [
  "arch",
  "platform",
  "cpuModel",
  "logicalCores",
  "cpuQuotaCores",
  "totalRamGiB",
] as const;
const FINGERPRINT_GPU = ["nvidia", "amdKfd", "renderNode", "appleSilicon"] as const;

/** The fingerprint fields that differ ("gpu.nvidia" for a GPU flag); ["fingerprint"] when one is missing. */
export function fingerprintDiff(
  a: CheapFingerprint | null | undefined,
  b: CheapFingerprint | null | undefined,
): string[] {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return ["fingerprint"];
  }
  const changed: string[] = [];
  for (const field of FINGERPRINT_SCALARS) {
    if ((a[field] ?? null) !== (b[field] ?? null)) {
      changed.push(field);
    }
  }
  for (const field of FINGERPRINT_GPU) {
    if (Boolean(a.gpu?.[field]) !== Boolean(b.gpu?.[field])) {
      changed.push(`gpu.${field}`);
    }
  }
  return changed;
}

/**
 * How the ladder-known Ollama models changed from a (the record) to b (now): "+model" added,
 * "-model" removed, "~model" re-pulled with a new digest. Chat models, reachability and the server
 * version are ignored. An unreachable b carries no model information, so it reports nothing; an
 * unreachable a (a fit that found no endpoint) reports every ladder model b now has.
 */
export function inventoryDiff(
  a: EmbedderInventory | null | undefined,
  b: EmbedderInventory | null | undefined,
): string[] {
  if (!b?.ollama?.reachable) {
    return [];
  }
  const before = ladderModelDigests(a);
  const after = ladderModelDigests(b);
  const changes: string[] = [];
  for (const [model, digest] of after) {
    const old = before.get(model);
    if (old === undefined) {
      changes.push(`+${model}`);
    } else if (digest && old && digest !== old) {
      changes.push(`~${model}`);
    }
  }
  for (const model of before.keys()) {
    if (!after.has(model)) {
      changes.push(`-${model}`);
    }
  }
  return changes;
}

function ladderModelDigests(inv: EmbedderInventory | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const model of inv?.ollama?.models ?? []) {
    const entry = ladderEntryFor(typeof model?.name === "string" ? model.name : "");
    if (entry) {
      out.set(entry.model, typeof model.digest === "string" ? model.digest : "");
    }
  }
  return out;
}

/** cgroup v2 cpu.max ("<quota> <period>") in cores; null for "max" or anything unparseable. */
export function parseCgroupCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max") {
    return null;
  }
  const q = Number(quota);
  const p = Number(period ?? "100000");
  if (!(q > 0) || !(p > 0)) {
    return null;
  }
  return Math.round((q / p) * 100) / 100;
}

/** The cgroup v2 path in /proc/self/cgroup (the "0::" line); null on a v1-only host. */
export function cgroupV2PathFrom(procSelfCgroup: string): string | null {
  for (const line of procSelfCgroup.split("\n")) {
    if (line.startsWith("0::")) {
      return line.slice(3).trim() || "/";
    }
  }
  return null;
}

function readCheapFingerprint(): CheapFingerprint {
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  let logicalCores = cpus.length;
  if (logicalCores === 0) {
    logicalCores = typeof os.availableParallelism === "function" ? os.availableParallelism() : 1;
  }
  return {
    arch,
    platform,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    logicalCores,
    cpuQuotaCores: readCgroupCpuQuotaCores(),
    totalRamGiB: Math.round(os.totalmem() / GIB),
    gpu: {
      nvidia: fs.existsSync("/dev/nvidia0"),
      amdKfd: fs.existsSync("/dev/kfd"),
      renderNode: hasRenderNode(),
      appleSilicon: platform === "darwin" && arch === "arm64",
    },
  };
}

/** The tightest cpu.max quota from this process's cgroup up to the root: the one that applies. */
function readCgroupCpuQuotaCores(): number | null {
  if (process.platform !== "linux") {
    return null;
  }
  let rel: string | null;
  try {
    rel = cgroupV2PathFrom(fs.readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
  if (rel === null) {
    return null;
  }
  const root = "/sys/fs/cgroup";
  let dir = path.posix.join(root, rel).replace(/\/+$/, "");
  let tightest: number | null = null;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const quota = parseCgroupCpuMax(fs.readFileSync(path.posix.join(dir, "cpu.max"), "utf8"));
      if (quota !== null) {
        tightest = tightest === null ? quota : Math.min(tightest, quota);
      }
    } catch {
      // no cpu.max at this level (the root cgroup has none)
    }
    if (dir === root || !dir.startsWith(`${root}/`)) {
      break;
    }
    dir = path.posix.dirname(dir);
  }
  return tightest;
}

function hasRenderNode(): boolean {
  try {
    return fs.readdirSync("/dev/dri").some((name) => name.startsWith("renderD"));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// (8) The seam
// -------------------------------------------------------------------------------------------------

/**
 * The single seam: resolveMemorySearchConfig returns applyEmbedderFit(resolved). Only when the
 * provider is 'auto': a record measured on this machine (cheap fingerprint unchanged) whose decision
 * is not 'off' supplies provider and model; otherwise the copy says provider 'none' and model ''
 * (word search, still indexing). 'auto' asks for the fit's choice, so its model is replaced too. An
 * explicit provider comes back untouched, no other key is filled, and it never throws: on any error
 * it returns its input unchanged.
 */
export function applyEmbedderFit<T extends { provider: string; model: string }>(resolved: T): T {
  try {
    if (resolved.provider !== "auto") {
      return resolved;
    }
    const rec = readEmbedderFit();
    const decision = rec?.decision;
    if (
      rec &&
      decision &&
      decision.mode !== "off" &&
      typeof decision.provider === "string" &&
      decision.provider !== "" &&
      decision.provider !== "auto" &&
      decision.provider !== "none" &&
      typeof decision.model === "string" &&
      decision.model !== "" &&
      fingerprintDiff(rec.fingerprint, cheapFingerprint()).length === 0
    ) {
      return { ...resolved, provider: decision.provider, model: decision.model };
    }
    return { ...resolved, provider: "none", model: "" };
  } catch {
    return resolved;
  }
}

// -------------------------------------------------------------------------------------------------
// (9) Helpers for the other units
// -------------------------------------------------------------------------------------------------

/** True when memory search runs words only: no config, no provider, or provider 'none'. */
export function isEmbeddingOff(ms: { provider?: string | null } | null | undefined): boolean {
  return !ms || !ms.provider || ms.provider === "none";
}

export type EmbeddingEndpointClass = "inproc" | "local-http" | "remote";

/**
 * Where an embedding request goes. 'inproc' for providerId 'local'; 'local-http' for loopback,
 * localhost, a unix socket, RFC1918, link-local, ULA, a Docker bridge or a single-label container
 * name; otherwise 'remote' (memory text leaves the local network). With no baseUrl, Ollama's
 * default endpoint is loopback and every other provider's default is its public API.
 */
export function classifyEmbeddingEndpoint(p: {
  providerId: string;
  baseUrl?: string | null;
}): EmbeddingEndpointClass {
  if (p.providerId === "local") {
    return "inproc";
  }
  const raw = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
  if (!raw) {
    return p.providerId === "ollama" ? "local-http" : "remote";
  }
  if (UNIX_SOCKET_URL.test(raw) || raw.startsWith("/")) {
    return "local-http";
  }
  const url = parseUrl(raw);
  return url && isLocalHost(url.hostname) ? "local-http" : "remote";
}

/** One queue per endpoint: providerId plus the lowercased URL origin, or providerId alone. */
export function endpointKeyFor(p: { providerId: string; baseUrl?: string | null }): string {
  const raw = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
  if (!raw) {
    return p.providerId;
  }
  if (UNIX_SOCKET_URL.test(raw)) {
    return `${p.providerId}|${raw.toLowerCase()}`;
  }
  const url = parseUrl(raw);
  if (!url) {
    return p.providerId;
  }
  const origin = url.origin === "null" ? `${url.protocol}${url.pathname}` : url.origin;
  return `${p.providerId}|${origin.toLowerCase()}`;
}

/** The working bounds the fit measured for one provider/model on this machine. */
export type FitBudget = {
  concurrency: number;
  batchTokens: number;
  batchDeadlineMs: number;
  queryDeadlineMs: number;
  tokensPerSec: number;
  tokensPerSecLow: number;
  dispersion: number;
  overheadMs: number;
  coldLoadMs?: number;
  numThread?: number;
  embedCores?: number;
  fitWallSeconds: number;
};

/**
 * The base URL the record measured a provider at: the inventory's Ollama URL for 'ollama'. For any
 * other provider, the URL kept on its candidate (FORK 2026-10-30), the decided model's first when
 * several of its candidates kept one; none in a record written before candidates kept a URL.
 */
function recordedBaseUrl(rec: EmbedderFitRecord, providerId: string): string | undefined {
  if (providerId === "ollama") {
    return rec.inventory?.ollama?.baseUrl;
  }
  const measuredAt = rec.candidates.filter(
    (c) => c?.provider === providerId && typeof c.baseUrl === "string" && c.baseUrl.trim() !== "",
  );
  const decided = rec.decision.provider === providerId ? rec.decision.model : undefined;
  const pick = decided ? measuredAt.find((c) => sameModel(c.model, decided)) : undefined;
  return (pick ?? measuredAt[0])?.baseUrl;
}

/**
 * FORK 2026-10-30: the endpoint key the record measured a provider at, endpointKeyFor of
 * recordedBaseUrl. Its measurements describe that endpoint only, so a governor uses them only when
 * this equals its own key (review finding #3). It is the key the governor writes its snapshot
 * under, so `openclaw embedder status` and the fit's measured demand read it too. A provider the
 * record kept no URL for keys as its id alone.
 */
export function fitEndpointKeyFor(rec: EmbedderFitRecord, providerId: string): string {
  return endpointKeyFor({ providerId, baseUrl: recordedBaseUrl(rec, providerId) });
}

/**
 * The record's working bounds for one provider/model at one endpoint, or null when there is no
 * record, it was measured on another machine or at another endpoint (fitEndpointKeyFor, FORK
 * 2026-10-30), it lacks the corpus, or it never measured that model. Concurrency is 1 per local
 * endpoint unless the measured parallel gain beats 2 sigma (then 2), and the ceiling for a remote
 * one. The batch deadline is the resident one: the governor adds the cold-load term.
 */
export function fitBudgetFor(
  p: { providerId: string; model: string; endpointKey: string },
  stateDir?: string,
): FitBudget | null {
  try {
    const rec = readEmbedderFit(stateDir);
    if (!rec || fingerprintDiff(rec.fingerprint, cheapFingerprint()).length > 0) {
      return null;
    }
    if (fitEndpointKeyFor(rec, p.providerId) !== p.endpointKey) {
      return null;
    }
    const cand = rec.candidates.find(
      (c) => c.provider === p.providerId && sameModel(c.model, p.model),
    );
    const chunkTokens = rec.corpus?.chunkTokens;
    if (!cand || !isFiniteNumber(chunkTokens) || chunkTokens < 1) {
      return null;
    }
    const share = clamp(rec.nonEnglishShare.value, 0, 1);
    const entry = cand.provider === "ollama" ? ladderEntryFor(cand.model) : undefined;
    const gain = entry ? recallGainFor(entry, share) : weakestLadderPrior(share).gain;
    const queryBudgetMs = queryBreakEvenMs({
      recallGain: gain,
      missCostMs: rec.missCostSec.value * 1000,
    });
    const plan = batchPlan({
      tokensPerSec: cand.tokensPerSec.value,
      queryBudgetMs,
      queryP95Ms: cand.queryP95Ms,
      chunkTokens,
    });
    const endpoint = classifyEmbeddingEndpoint({
      providerId: cand.provider,
      baseUrl: recordedBaseUrl(rec, cand.provider),
    });
    const parallel = cand.parallelGain;
    const parallelPays =
      parallel !== undefined && parallel.sigma >= 0 && parallel.delta > 2 * parallel.sigma;
    const budget: FitBudget = {
      concurrency:
        endpoint === "remote"
          ? EMBED_CEILINGS.indexConcurrency
          : Math.min(EMBED_CEILINGS.indexConcurrency, parallelPays ? 2 : 1),
      batchTokens: plan.batchTokens,
      batchDeadlineMs: requestDeadlineMs({
        tokens: plan.batchTokens,
        tokensPerSecLow: cand.tokensPerSecLow95,
        dispersion: cand.batchDispersion,
        overheadMs: cand.overheadMs,
        ceilingMs: EMBED_CEILINGS.batchDeadlineMs,
      }),
      queryDeadlineMs: Math.max(1, Math.min(EMBED_CEILINGS.queryDeadlineMs, queryBudgetMs)),
      tokensPerSec: cand.tokensPerSec.value,
      tokensPerSecLow: cand.tokensPerSecLow95,
      dispersion: cand.batchDispersion,
      overheadMs: cand.overheadMs,
      fitWallSeconds: rec.fitWallSeconds.value,
    };
    if (isFiniteNumber(cand.coldLoadMs)) {
      budget.coldLoadMs = cand.coldLoadMs;
    }
    const numThread =
      cand.numThread ??
      (sameModel(rec.decision.model ?? "", cand.model) ? rec.decision.numThread : undefined);
    if (isFiniteNumber(numThread)) {
      budget.numThread = numThread;
    }
    if (isFiniteNumber(cand.embedCores)) {
      budget.embedCores = cand.embedCores;
    }
    return budget;
  } catch {
    return null;
  }
}

/** The slice of OpenClawConfig that readRawMemorySearchProvider reads. */
export type MemorySearchProviderView =
  | {
      agents?: {
        defaults?: { memorySearch?: { provider?: string | null } | null } | null;
        list?: ReadonlyArray<
          | { id?: string | null; memorySearch?: { provider?: string | null } | null }
          | null
          | undefined
        > | null;
      } | null;
    }
  | null
  | undefined;

/**
 * The configured memorySearch.provider before the seam: the agent's override, then the defaults,
 * then 'auto'. The same precedence as mergeConfig in src/agents/memory-search.ts.
 */
export function readRawMemorySearchProvider(
  cfg: MemorySearchProviderView,
  agentId: string,
): string {
  const id = normalizeAgentIdForLookup(agentId);
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const entry = list.find(
    (item) =>
      item !== null && typeof item === "object" && normalizeAgentIdForLookup(item.id) === id,
  );
  return entry?.memorySearch?.provider ?? cfg?.agents?.defaults?.memorySearch?.provider ?? "auto";
}

/** Lowercase, no "ollama/" prefix, ":latest" when untagged: how Ollama and the ladder name a model. */
export function normalizeEmbeddingModelName(name: string): string {
  let n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (n.startsWith("ollama/")) {
    n = n.slice("ollama/".length);
  }
  if (n && !n.includes(":")) {
    n = `${n}:latest`;
  }
  return n;
}

/** The ladder entry for an Ollama model name, or undefined when the ladder does not know it. */
export function ladderEntryFor(model: string): LadderEntry | undefined {
  const key = normalizeEmbeddingModelName(model);
  if (!key) {
    return undefined;
  }
  return EMBEDDER_LADDER.find((e) => normalizeEmbeddingModelName(e.model) === key);
}

/** Tests only: forget the memoized fingerprint, the cached record and the warned problems. */
export function __resetEmbedderFitForTest(): void {
  fingerprintMemo = undefined;
  fitCache = undefined;
  warnedFitProblems.clear();
}

// -------------------------------------------------------------------------------------------------
// Internals
// -------------------------------------------------------------------------------------------------

const UNIX_SOCKET_URL = /^(?:unix|http\+unix|https\+unix):/i;
const VALID_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function sameModel(a: string, b: string): boolean {
  const x = normalizeEmbeddingModelName(a);
  return x !== "" && x === normalizeEmbeddingModelName(b);
}

/**
 * Declared twin of normalizeAgentId (src/routing/session-key.ts), so the agent lookup matches
 * resolveAgentConfig exactly. Local because this file may not import beyond its allowlist.
 */
function normalizeAgentIdForLookup(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return "main";
  }
  const lower = trimmed.toLowerCase();
  if (VALID_AGENT_ID.test(trimmed)) {
    return lower;
  }
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) {
    return false;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "host.docker.internal" ||
    host === "gateway.docker.internal"
  ) {
    return true;
  }
  const v4 = parseIpv4(host);
  if (v4) {
    return isLocalIpv4(v4);
  }
  if (host.includes(":")) {
    return isLocalIpv6(host);
  }
  // A single-label name resolves only on the local network: a Docker bridge service name such as
  // the embedder's own container, or a LAN host.
  return !host.includes(".");
}

function parseIpv4(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return undefined;
  }
  const octets = match.slice(1).map((x) => Number(x));
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/** Loopback, this-host, RFC1918 (Docker bridges included) and link-local. */
function isLocalIpv4([a, b]: number[]): boolean {
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Loopback, unspecified, IPv4-mapped local, ULA (fc00::/7) and link-local (fe80::/10). */
function isLocalIpv6(host: string): boolean {
  if (host === "::1" || host === "::") {
    return true;
  }
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = mapped[1];
    const dotted = parseIpv4(tail);
    if (dotted) {
      return isLocalIpv4(dotted);
    }
    const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (!hextets) {
      return false;
    }
    const hi = Number.parseInt(hextets[1], 16);
    const lo = Number.parseInt(hextets[2], 16);
    return isLocalIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function dailyCostSec(a: DemandAccount): number {
  const horizon = a.horizonDays > 0 ? a.horizonDays : 1;
  return Math.max(0, a.dailyEmbedSec) + Math.max(0, a.pendingEmbedSec) / horizon;
}

function contentionOrWorst(c: number | undefined): number {
  return isFiniteNumber(c) && c >= 0 ? c : 1;
}

function m(
  value: number,
  unit: string,
  provenance: MetricProvenance,
  source: string,
  n?: number,
): Measured {
  return n === undefined
    ? { value, unit, provenance, source }
    : { value, unit, n, provenance, source };
}

function measuredOrUndefined(x: unknown, unit: string): Measured | undefined {
  if (typeof x === "number") {
    return Number.isFinite(x)
      ? m(x, unit, "estimated", "passed as a bare number, provenance not given")
      : undefined;
  }
  if (x && typeof x === "object" && isFiniteNumber((x as { value?: unknown }).value)) {
    return x as Measured;
  }
  return undefined;
}

function measuredOr(x: unknown, unit: string, fallback: Readonly<Measured>): Measured {
  return measuredOrUndefined(x, unit) ?? { ...fallback };
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonNegative(x: unknown): x is number {
  return isFiniteNumber(x) && x >= 0;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function fmt(n: number): string {
  if (Number.isNaN(n)) {
    return "n/a";
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? "inf" : "-inf";
  }
  const abs = Math.abs(n);
  if (abs >= 100) {
    return String(Math.round(n));
  }
  if (abs >= 1) {
    return String(Math.round(n * 10) / 10);
  }
  return String(Number(n.toPrecision(2)));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
