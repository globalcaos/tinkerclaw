/**
 * FORK 2026-05-12 — `gateway.slo.burnRate({slo?})`
 *
 * Compute service-level-objective burn rate for the fork's declared SLOs.
 *
 * Today we ship three starter SLOs (see TINKER_UI_DESIGN_BIBLE/slos.md):
 *   1. cron-success-7d: 95% of cron runs succeed over a rolling 7-day window
 *   2. cron-freshness:  every cron job ran within 24h of expected cadence
 *   3. morning-briefing-latency: 95% complete within 300s
 *
 * The data source is `~/.openclaw/cron/runs/<job>.jsonl` — the same
 * receipts probed by `cron.lastRun`. No external metrics backend; this
 * computes burn rate from disk on each call (cheap, bounded).
 *
 * Burn rate semantics (per Nobl9 / SRE practice):
 *   - target: 95% success → error budget = 5% of N events
 *   - actual: M% failures in the window
 *   - burnRate = (actualFailRate) / (budgetFailRate)  — > 1 means exhausted
 *
 * Scope: READ_SCOPE. Reads disk-only state; no credentials.
 */

import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

const CRON_RUNS_DIR = path.resolve(os.homedir(), ".openclaw/cron/runs");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type CronReceipt = {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  durationMs?: number;
  runAtMs?: number;
  nextRunAtMs?: number;
};

type SloResult = {
  id: string;
  description: string;
  targetPct: number;
  windowDescription: string;
  observedPct: number | null;
  budgetRemainingPct: number;
  burnRate: number | null;
  status: "healthy" | "burning" | "exhausted" | "no-data";
  sampleCount: number;
  details?: Record<string, unknown>;
};

async function readReceipts(jobId: string, cutoffMs: number): Promise<CronReceipt[]> {
  const file = path.join(CRON_RUNS_DIR, `${jobId}.jsonl`);
  try {
    const raw = await readFile(file, "utf8");
    const out: CronReceipt[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CronReceipt;
        if (parsed.action && parsed.action !== "finished") continue;
        if (typeof parsed.ts === "number" && parsed.ts < cutoffMs) continue;
        out.push(parsed);
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function listJobIds(): Promise<string[]> {
  try {
    const entries = await readdir(CRON_RUNS_DIR);
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

function classify(observedPct: number | null, targetPct: number): SloResult["status"] {
  if (observedPct === null) return "no-data";
  if (observedPct >= targetPct) return "healthy";
  const burnRate = (100 - observedPct) / (100 - targetPct);
  if (burnRate >= 1) return "exhausted";
  return "burning";
}

function computeBurnRate(observedPct: number | null, targetPct: number): number | null {
  if (observedPct === null) return null;
  const budgetSize = 100 - targetPct;
  if (budgetSize <= 0) return null;
  const errorRate = 100 - observedPct;
  return Number((errorRate / budgetSize).toFixed(3));
}

async function evaluateCronSuccess7d(): Promise<SloResult> {
  const target = 95;
  const now = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;
  let total = 0;
  let ok = 0;
  const failingJobs: Array<{ jobId: string; failures: number; runs: number }> = [];
  for (const jobId of await listJobIds()) {
    const receipts = await readReceipts(jobId, cutoff);
    let jobOk = 0;
    for (const r of receipts) {
      total += 1;
      if (r.status === "ok") {
        ok += 1;
        jobOk += 1;
      }
    }
    if (receipts.length > 0 && jobOk < receipts.length) {
      failingJobs.push({
        jobId,
        runs: receipts.length,
        failures: receipts.length - jobOk,
      });
    }
  }
  failingJobs.sort((a, b) => b.failures - a.failures);
  const observed = total === 0 ? null : (ok / total) * 100;
  return {
    id: "cron-success-7d",
    description: "≥95% of cron runs succeed over the rolling 7-day window",
    targetPct: target,
    windowDescription: "rolling 7 days",
    observedPct: observed === null ? null : Number(observed.toFixed(2)),
    budgetRemainingPct: observed === null ? 100 : Number(Math.max(0, observed - target).toFixed(2)),
    burnRate: computeBurnRate(observed, target),
    status: classify(observed, target),
    sampleCount: total,
    details: { failingJobs: failingJobs.slice(0, 5) },
  };
}

async function evaluateCronFreshness(): Promise<SloResult> {
  const target = 100;
  const now = Date.now();
  let total = 0;
  let fresh = 0;
  const stale: Array<{ jobId: string; lastRunAgoMs: number | null }> = [];
  for (const jobId of await listJobIds()) {
    total += 1;
    const receipts = await readReceipts(jobId, now - 30 * ONE_DAY_MS);
    const lastOk = receipts.filter((r) => r.status === "ok").at(-1);
    if (!lastOk) {
      stale.push({ jobId, lastRunAgoMs: null });
      continue;
    }
    const ageMs = now - (lastOk.ts ?? 0);
    if (ageMs < ONE_DAY_MS) {
      fresh += 1;
    } else {
      stale.push({ jobId, lastRunAgoMs: ageMs });
    }
  }
  const observed = total === 0 ? null : (fresh / total) * 100;
  return {
    id: "cron-freshness",
    description: "Every cron job has a successful run within the last 24 hours",
    targetPct: target,
    windowDescription: "current state",
    observedPct: observed === null ? null : Number(observed.toFixed(2)),
    budgetRemainingPct: observed === null ? 100 : Math.max(0, observed - target),
    burnRate: computeBurnRate(observed, target),
    status:
      observed === null
        ? "no-data"
        : observed === 100
          ? "healthy"
          : observed === 0
            ? "exhausted"
            : "burning",
    sampleCount: total,
    details: { staleJobs: stale.slice(0, 10) },
  };
}

async function evaluateMorningBriefingLatency(): Promise<SloResult> {
  const target = 95;
  const latencyBudgetMs = 300_000;
  const now = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;
  const receipts = await readReceipts("morning-briefing", cutoff);
  const withDuration = receipts.filter(
    (r) => typeof r.durationMs === "number" && r.status === "ok",
  );
  if (withDuration.length === 0) {
    return {
      id: "morning-briefing-latency",
      description: "≥95% of successful morning-briefing runs complete within 300s",
      targetPct: target,
      windowDescription: "rolling 7 days (successful runs only)",
      observedPct: null,
      budgetRemainingPct: 100,
      burnRate: null,
      status: "no-data",
      sampleCount: 0,
    };
  }
  const fastEnough = withDuration.filter(
    (r) => (r.durationMs ?? Infinity) <= latencyBudgetMs,
  ).length;
  const observed = (fastEnough / withDuration.length) * 100;
  const sorted = withDuration.map((r) => r.durationMs ?? 0).sort((a, b) => a - b);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    id: "morning-briefing-latency",
    description: "≥95% of successful morning-briefing runs complete within 300s",
    targetPct: target,
    windowDescription: "rolling 7 days (successful runs only)",
    observedPct: Number(observed.toFixed(2)),
    budgetRemainingPct: Number(Math.max(0, observed - target).toFixed(2)),
    burnRate: computeBurnRate(observed, target),
    status: classify(observed, target),
    sampleCount: withDuration.length,
    details: {
      latencyBudgetMs,
      p50Ms: sorted[Math.floor(sorted.length / 2)] ?? null,
      p95Ms: sorted[p95Idx] ?? null,
      maxMs: sorted[sorted.length - 1] ?? null,
    },
  };
}

export const sloBurnRateHandlers: GatewayRequestHandlers = {
  "gateway.slo.burnRate": async ({ params, respond }) => {
    const p = (params ?? {}) as { slo?: unknown };
    const filterId = typeof p.slo === "string" ? p.slo.trim() : "";
    const all = await Promise.all([
      evaluateCronSuccess7d(),
      evaluateCronFreshness(),
      evaluateMorningBriefingLatency(),
    ]);
    const filtered = filterId ? all.filter((s) => s.id === filterId) : all;
    const anyBurning = filtered.some((s) => s.status === "burning" || s.status === "exhausted");
    respond(
      true,
      {
        capturedAt: new Date().toISOString(),
        anyBurning,
        slos: filtered,
      },
      undefined,
    );
  },
};
