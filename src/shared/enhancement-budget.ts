// How often the 800 ms short-list budget was missed, and what the evidence says about why (Broca retrieval v2, phase A).
//
// WHAT THIS IS FOR. The list the agent sees is built by Jev when Jev answers inside the budget and by local word
// matching otherwise. The ledger records which one a task got but not WHY a list was local. This module reads the
// two sources that do carry a trace of it and says exactly how far they go:
//   - the gateway journal's `[hook-span]` line, which gives the time the Thalamus prompt hook took, per prompt; the
//     ledger timestamp and that line sit 1 to 9 ms apart (measured over 723 of 730 rows), so they join exactly;
//   - the amygdala's own verdict table, which records latency and the skip reason (`timeout`, `breaker-open`,
//     `not-allowed`, `error`) of every Jev ask it made.
//
// WHAT IT CAN SEPARATE. A local list that took the whole budget (late), one that came back at once (fast), a private
// source (never asked), and a Jev list (answered, with its latency). The amygdala's asks are reported on their own.
// WHAT IT CANNOT. A fast local list is a breaker that is open, an immediate error or an incomplete verdict: the
// ledger does not keep which. Nothing here claims to know; the recommendation is to record the reason at the source.

import type { ReplayCase } from "./enhancement-replay.js";

export type HookSpan = { ts: number; ms: number };

const SPAN_LINE = /^(\S+) \[hooks\] \[hook-span\] hook=(\S+) plugin=(\S+) ms=(\d+)\s*$/;

/** The spans of one hook of one plugin, oldest first, from journal text (`journalctl -o cat`). */
export function parseHookSpans(
  journal: string,
  want: { hook: string; plugin: string },
): HookSpan[] {
  const out: HookSpan[] = [];
  for (const line of journal.split("\n")) {
    const m = SPAN_LINE.exec(line);
    if (!m || m[2] !== want.hook || m[3] !== want.plugin) continue;
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts)) out.push({ ts, ms: Number(m[4]) });
  }
  return out.toSorted((a, b) => a.ts - b.ts);
}

/** The span that ended 0..100 ms after the ledger wrote the row, or null. The row is written inside the hook. */
export function spanFor(spans: readonly HookSpan[], ledgerTs: number): HookSpan | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].ts < ledgerTs - 50) lo = mid + 1;
    else hi = mid;
  }
  const s = spans[lo];
  return s && s.ts <= ledgerTs + 100 ? s : null;
}

export type ListClass =
  | "jev-answered"
  | "late-local"
  | "fast-local"
  | "mid-local"
  | "private-source"
  | "not-asked"
  | "no-span";

export const BUDGET_MS = 800;
/** A local list that came back in under this was not waiting on Jev. */
export const FAST_MS = 300;

export function classifyList(
  c: Pick<ReplayCase, "listSource" | "listReason" | "source">,
  span: HookSpan | null,
  o: { budgetMs?: number; fastMs?: number } = {},
): ListClass {
  if (c.listSource === "jev") return "jev-answered";
  if (c.listReason === "not-asked") return "not-asked";
  if (c.source.startsWith("channel:")) return "private-source";
  if (!span) return "no-span";
  if (span.ms >= (o.budgetMs ?? BUDGET_MS)) return "late-local";
  return span.ms < (o.fastMs ?? FAST_MS) ? "fast-local" : "mid-local";
}

export type LatencyStats = {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  over800: number;
  over1500: number;
};

export function latencyStats(values: readonly number[]): LatencyStats {
  const v = values.toSorted((a, b) => a - b);
  const at = (q: number) =>
    v.length === 0 ? 0 : v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return {
    n: v.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: v.length === 0 ? 0 : v[v.length - 1],
    over800: v.filter((x) => x >= 800).length,
    over1500: v.filter((x) => x >= 1500).length,
  };
}

// ─── the amygdala's own asks ────────────────────────────────────────────────────────────────────

export type AmygdalaAsk = {
  ts: number;
  /** `null` when Jev answered. */
  skipped: "not-allowed" | "breaker-open" | "timeout" | "error" | null;
  latencyMs: number;
};

export type AmygdalaSummary = {
  asks: number;
  answered: number;
  bySkip: Record<string, number>;
  answeredLatency: LatencyStats;
};

export function summarizeAmygdala(asks: readonly AmygdalaAsk[]): AmygdalaSummary {
  const bySkip: Record<string, number> = {};
  for (const a of asks) if (a.skipped) bySkip[a.skipped] = (bySkip[a.skipped] ?? 0) + 1;
  const answered = asks.filter((a) => a.skipped === null);
  return {
    asks: asks.length,
    answered: answered.length,
    bySkip,
    answeredLatency: latencyStats(answered.map((a) => a.latencyMs)),
  };
}

/** The amygdala ask nearest in time to `ts`, within `windowMs`. `asks` must be sorted by ts. */
export function nearestAsk(
  asks: readonly AmygdalaAsk[],
  ts: number,
  windowMs: number,
): AmygdalaAsk | null {
  let lo = 0;
  let hi = asks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (asks[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  let best: AmygdalaAsk | null = null;
  for (const i of [lo - 1, lo]) {
    const a = asks[i];
    if (
      a &&
      Math.abs(a.ts - ts) <= windowMs &&
      (!best || Math.abs(a.ts - ts) < Math.abs(best.ts - ts))
    ) {
      best = a;
    }
  }
  return best;
}

/** The calendar day (Madrid) a timestamp falls on, as YYYY-MM-DD. */
export const madridDay = (ts: number): string =>
  new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
