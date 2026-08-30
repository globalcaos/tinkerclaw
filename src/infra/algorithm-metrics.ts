// FORK 2026-07-28 (the architect: "numerically trace the effectiveness of different algorithms to feed
// it later into the papers") — the ALGORITHM EFFECTIVENESS LEDGER.
//
// Companion to instrument-liveness.ts. That module answers "is this on the traffic path?";
// this one answers "and how well is it working?" — as numbers durable enough to publish.
//
// WHY IT LOOKS LIKE THIS. Every design rule below is a scar from this week:
//
//  1. EVERY NUMBER CARRIES ITS PROVENANCE. The compaction disaster was a turn AGGREGATE read as
//     a context snapshot — 6,448,106 tokens reported on a window of 1,000,000 whose real
//     context was 52,116. The figure was not wrong; its PROVENANCE was unrecorded, so nothing
//     could tell a per-call snapshot from an accumulator. `source` is therefore required.
//  2. EVERY RATIO CARRIES ITS DENOMINATOR. The cache panel rendered "645%" because it had a
//     numerator and no sanity check against the window. Ratios are never stored — only the
//     parts — so any later analysis can check the denominator itself.
//  3. MEASURED vs ESTIMATED IS EXPLICIT. A paper that mixes them silently is worthless. A
//     budget gate here once scored a ~15k-token system prompt as ZERO; that was an estimate
//     presented as a measurement.
//  4. APPEND-ONLY AND VERSIONED. Papers need reproducibility across months, so the schema
//     carries a version and records are never rewritten.
//  5. THE ALGORITHM AND ITS VARIANT ARE SEPARATE FIELDS. Comparing strategies is the entire
//     point: `algorithm:"compaction"` + `variant:"engram-pointer"` vs `variant:"llm-summary"`
//     must be groupable without parsing prose.
//
// This never throws into a serving path, and it never blocks one.
import { appendFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { noteInstrumentFired } from "./instrument-liveness.js";

const log = createSubsystemLogger("infra/algorithm-metrics");

/** Bump ONLY on a breaking field change; analyses filter on it. */
export const ALGORITHM_METRICS_SCHEMA_VERSION = 1;

export type MetricProvenance =
  /** A figure observed for exactly ONE API call / one operation. The trustworthy kind. */
  | "per-call-measured"
  /** Summed across a turn or run. NEVER comparable to a context window. */
  | "turn-aggregate"
  /** Computed from content we hold (e.g. a char count over real messages). */
  | "local-measured"
  /** A heuristic. Say so. */
  | "estimated"
  /** Reported by a provider/third party we did not verify. */
  | "third-party-reported";

export interface AlgorithmOutcome {
  /** Family under comparison: "compaction" | "prompt-cache" | "compression" | "context-budget" | … */
  algorithm: string;
  /** The specific strategy within the family — this is what gets compared. */
  variant: string;
  /** What happened: "fired" | "skipped" | "failed" | "no-op" | "observed". */
  outcome: string;
  /**
   * Numeric fields. Store PARTS, never ratios (rule 2). Units belong in the key:
   * `contextTokens`, `windowTokens`, `bytesIn`, `bytesOut`, `durationMs`, `tokensBefore`…
   */
  metrics: Record<string, number>;
  /** Provenance PER metric key. A key absent from here is treated as unverified. */
  provenance: Record<string, MetricProvenance>;
  sessionKey?: string;
  model?: string;
  provider?: string;
  /** Config that shaped this run (e.g. compaction mode) — needed to segment later. */
  config?: Record<string, string | number | boolean>;
  /** Free-text only for things no number can carry, e.g. an error message. */
  note?: string;
}

/**
 * Resolve the ledger path, or `undefined` to write nothing.
 *
 * FORK 2026-07-28 — TEST SANDBOX GUARD, added within the hour of shipping this module because
 * it immediately did the thing it was meant to prevent: a vitest run wrote 32 SYNTHETIC rows
 * (`sessionKey:"main"`, fixture models) straight into the production ledger. This file is
 * intended to feed published papers, so fixtures mixed with measurements is not untidiness —
 * it is the exact "measured vs estimated" contamination rule 3 above forbids.
 *
 * Same class as two earlier incidents on this deployment: a test that unlinked the LIVE session
 * map (4,641 resume bindings, restored from backup), and `context-anatomy.test.ts` writing to
 * the production DB. The rule that came out of those: a test must be sandboxed by CONSTRUCTION,
 * not by remembering to set an env var.
 *
 * So under a test runner the production path is refused outright. A test that genuinely wants
 * to exercise the writer must opt in with an explicit `OPENCLAW_ALGORITHM_METRICS_PATH`.
 */
function resolveLedgerPath(): string | undefined {
  const override = process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return undefined;
  }
  return join(homedir(), ".openclaw", "data", "algorithm-metrics.jsonl");
}

/** Drop non-finite values rather than poisoning a later mean with NaN/Infinity. */
function sanitizeMetrics(metrics: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Record one algorithm outcome. Fire-and-forget: never awaited by a serving path.
 *
 * Also notes liveness for `algorithm:variant`, so an algorithm that stops producing outcomes
 * shows up as a silent instrument instead of as an absence nobody notices.
 */
export function recordAlgorithmOutcome(outcome: AlgorithmOutcome): void {
  try {
    const metrics = sanitizeMetrics(outcome.metrics);
    const record = {
      v: ALGORITHM_METRICS_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      algorithm: outcome.algorithm,
      variant: outcome.variant,
      outcome: outcome.outcome,
      metrics,
      provenance: outcome.provenance,
      ...(outcome.sessionKey ? { sessionKey: outcome.sessionKey } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.provider ? { provider: outcome.provider } : {}),
      ...(outcome.config ? { config: outcome.config } : {}),
      ...(outcome.note ? { note: outcome.note } : {}),
    };

    // Liveness is in-memory and harmless under test, so it is noted either way.
    noteInstrumentFired(`algorithm:${outcome.algorithm}`, `${outcome.variant}/${outcome.outcome}`);

    const path = resolveLedgerPath();
    if (!path) {
      // Sandbox guard: no production ledger under a test runner. See resolveLedgerPath().
      return;
    }
    appendFile(path, JSON.stringify(record) + "\n", (err) => {
      if (err) {
        log.debug(`algorithm-metrics append failed: ${String(err)}`);
      }
    });
  } catch {
    /* telemetry must never disturb the path it observes */
  }
}

/**
 * Convenience for the comparison this deployment most needs answered.
 *
 * The central claim to be settled with data: caching, compaction and compression contend over
 * ONE resource — the prompt prefix — so a compaction is not merely the cost of its summary, it
 * DETONATES a cached prefix that was serving ~10^8 cache-read tokens. Recording the cache state
 * alongside every compaction is what turns that argument into a measurement.
 */
export function recordCompactionOutcome(params: {
  variant: string;
  outcome: string;
  /** REAL context size, per-call measured. Never a turn aggregate — see rule 1. */
  contextTokens?: number;
  contextTokensSource?: MetricProvenance;
  windowTokens?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
  /** Cache-read tokens standing to be invalidated by this compaction, if known. */
  cacheReadTokensAtRisk?: number;
  sessionKey?: string;
  model?: string;
  provider?: string;
  compactionMode?: string;
  note?: string;
}): void {
  const metrics: Record<string, number> = {};
  const provenance: Record<string, MetricProvenance> = {};
  const put = (k: string, v: number | undefined, p: MetricProvenance) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      metrics[k] = v;
      provenance[k] = p;
    }
  };

  put("contextTokens", params.contextTokens, params.contextTokensSource ?? "estimated");
  put("windowTokens", params.windowTokens, "local-measured");
  put("tokensBefore", params.tokensBefore, "third-party-reported");
  put("tokensAfter", params.tokensAfter, "third-party-reported");
  put("durationMs", params.durationMs, "local-measured");
  put("cacheReadTokensAtRisk", params.cacheReadTokensAtRisk, "third-party-reported");

  recordAlgorithmOutcome({
    algorithm: "compaction",
    variant: params.variant,
    outcome: params.outcome,
    metrics,
    provenance,
    sessionKey: params.sessionKey,
    model: params.model,
    provider: params.provider,
    ...(params.compactionMode ? { config: { compactionMode: params.compactionMode } } : {}),
    note: params.note,
  });
}

/** Prompt-cache effectiveness for ONE API call. Parts only — the ratio is derived later. */
export function recordCacheOutcome(params: {
  variant: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per-call context size when genuinely known; omit rather than pass an aggregate. */
  contextTokens?: number;
  windowTokens?: number;
  sessionKey?: string;
  model?: string;
  provider?: string;
  /** How the caller knows these are per-call — the field that would have prevented 645%. */
  source: MetricProvenance;
}): void {
  const metrics: Record<string, number> = {
    inputTokens: params.inputTokens,
    cacheReadTokens: params.cacheReadTokens,
    cacheWriteTokens: params.cacheWriteTokens,
  };
  const provenance: Record<string, MetricProvenance> = {
    inputTokens: params.source,
    cacheReadTokens: params.source,
    cacheWriteTokens: params.source,
  };
  if (typeof params.contextTokens === "number" && Number.isFinite(params.contextTokens)) {
    metrics.contextTokens = params.contextTokens;
    provenance.contextTokens = params.source;
  }
  if (typeof params.windowTokens === "number" && Number.isFinite(params.windowTokens)) {
    metrics.windowTokens = params.windowTokens;
    provenance.windowTokens = "local-measured";
  }

  recordAlgorithmOutcome({
    algorithm: "prompt-cache",
    variant: params.variant,
    outcome: "observed",
    metrics,
    provenance,
    sessionKey: params.sessionKey,
    model: params.model,
    provider: params.provider,
  });
}

/** Compression effectiveness. bytesIn/bytesOut only — the saving is derived, never stored. */
export function recordCompressionOutcome(params: {
  variant: string;
  outcome: string;
  bytesIn: number;
  bytesOut: number;
  durationMs?: number;
  /** Times the ORIGINAL had to be fetched back — the honest cost side of CCR. */
  retrievals?: number;
  contentClass?: string;
  sessionKey?: string;
  note?: string;
}): void {
  const metrics: Record<string, number> = {
    bytesIn: params.bytesIn,
    bytesOut: params.bytesOut,
  };
  const provenance: Record<string, MetricProvenance> = {
    bytesIn: "local-measured",
    bytesOut: "local-measured",
  };
  if (typeof params.durationMs === "number") {
    metrics.durationMs = params.durationMs;
    provenance.durationMs = "local-measured";
  }
  if (typeof params.retrievals === "number") {
    metrics.retrievals = params.retrievals;
    provenance.retrievals = "local-measured";
  }

  recordAlgorithmOutcome({
    algorithm: "compression",
    variant: params.variant,
    outcome: params.outcome,
    metrics,
    provenance,
    sessionKey: params.sessionKey,
    ...(params.contentClass ? { config: { contentClass: params.contentClass } } : {}),
    note: params.note,
  });
}
