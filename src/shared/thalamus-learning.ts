// THALAMUS v4 — learning without a training run (design doc section 13; paper J19 v4.1 section 8).
//
// WHAT THIS IS FOR. Each night the ledger of outcomes updates what the router believes about each rung. For every kind of
// work, kind of step and rung it counts successes, retries, refusals, cost and time. An estimate starts at the public map
// and moves toward the ledger's own record as the evidence grows: a rung with ten outcomes stays close to the map, and one
// with a thousand follows its record. Nothing is trained; a number moves because a count moved.
//
// HOW IT WAS DERIVED. Paper 8: "An estimate starts at the public map and moves toward the ledger's own record as the
// evidence grows." That is a Beta-style shrinkage, `posterior = (kappa x prior + wins) / (kappa + n)`, with `kappa` = 10, so
// n = 10 weighs the record as much as the map (half way) and n = 1000 leaves the map a one per cent share. Every outcome
// is joined to the model that ACTUALLY answered (the usage event's model), never to the pick: v2's registry gave credit to
// models that never ran, and this keeps that from happening again. A win is a call that ended `done` and was not refused.
//
// WHAT WOULD CHANGE IT. `LEARNING_KAPPA` is a starting value; paper test 2 (outcomes against honest baselines) tunes it.
// `EXPLORE_SHARE` (5 %) and the rule that exploration runs on overnight work only are the owner's to widen.
//
// PURE. No clock, no I/O, no randomness: `rand` is an argument.

import { aaFamilyOf } from "./aa-effort-index.js";
import {
  REFUSAL_TTL_MS,
  REFUSAL_VETO_COUNT,
  type RefusalRecord,
  type SubjectClass,
} from "./thalamus-feasibility.js";
import type { TaskDomain } from "./thalamus-frontier.js";
import { cachePolicyFor, ratesFor } from "./thalamus-price-table.js";
import { DEFAULT_EUR_PER_USD, type RungTime } from "./thalamus-price.js";
import type { StepKind, Urgency } from "./thalamus-v4-types.js";

/** Weight of the public map, in outcomes. n = kappa weighs the record and the map equally. */
export const LEARNING_KAPPA = 10;

/** An estimate from the ledger alone needs at least this many outcomes when there is no public map to start from. */
export const MIN_OUTCOMES_WITHOUT_MAP = 20;

export function posterior(
  prior: number,
  wins: number,
  n: number,
  kappa: number = LEARNING_KAPPA,
): number {
  const p = Math.min(1, Math.max(0, prior));
  const w = Math.max(0, Math.min(wins, n));
  const total = Math.max(0, n);
  return (kappa * p + w) / (kappa + total);
}

/** One recorded call, joined to what answered it. */
export type OutcomeFact = {
  ts: number;
  domain: TaskDomain;
  topic: SubjectClass;
  stepKind: StepKind;
  /** The route key of the model that ANSWERED (`provider/model`), never the pick. */
  rungKey: string;
  outcome: "done" | "retry" | "stuck" | "refused" | "check" | "error";
  refused: boolean;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  durationMs: number;
  ttftMs?: number;
};

export type EstimateKey = { domain: TaskDomain; stepKind: StepKind; rung: string };

export type Counts = {
  n: number;
  wins: number;
  retries: number;
  refusals: number;
  /** EUR at list price from the recorded counts; calls with no price row add nothing. */
  costSum: number;
  /** Seconds. */
  timeSum: number;
};

export type Estimate = EstimateKey &
  Counts & {
    /** What the public map said, and what the ledger moved it to. */
    prior: number;
    posterior: number;
  };

const keyOf = (k: EstimateKey): string => `${k.domain}\u0000${k.stepKind}\u0000${k.rung}`;

/** List-price euros for one call from its recorded counts. Undefined when the model has no price row. */
export function costFromCounts(
  f: Pick<OutcomeFact, "rungKey" | "input" | "cacheRead" | "cacheWrite" | "output">,
): number | undefined {
  const total = f.input + f.cacheRead + f.cacheWrite;
  const rates = ratesFor(f.rungKey, total);
  if (!rates) return undefined;
  const policy = cachePolicyFor(f.rungKey);
  const readRate = rates.cacheReadPerMTok ?? rates.inputPerMTok;
  const writeMult = policy ? policy.write1hMult : 1;
  const usd =
    (f.input * rates.inputPerMTok +
      f.cacheRead * readRate +
      f.cacheWrite * rates.inputPerMTok * writeMult +
      f.output * rates.outputPerMTok) /
    1e6;
  return usd * DEFAULT_EUR_PER_USD;
}

export function aggregate(facts: readonly OutcomeFact[]): Map<string, EstimateKey & Counts> {
  const out = new Map<string, EstimateKey & Counts>();
  for (const f of facts) {
    const k: EstimateKey = { domain: f.domain, stepKind: f.stepKind, rung: f.rungKey };
    const id = keyOf(k);
    const c = out.get(id) ?? {
      ...k,
      n: 0,
      wins: 0,
      retries: 0,
      refusals: 0,
      costSum: 0,
      timeSum: 0,
    };
    c.n += 1;
    if (f.outcome === "done" && !f.refused) c.wins += 1;
    if (f.outcome === "retry" || f.outcome === "stuck") c.retries += 1;
    if (f.refused || f.outcome === "refused") c.refusals += 1;
    c.costSum += costFromCounts(f) ?? 0;
    c.timeSum += Math.max(0, f.durationMs) / 1000;
    out.set(id, c);
  }
  return out;
}

/** The estimates, each moved from its public prior toward the record. `priorFor` is the public map's number for the key. */
export function estimates(
  counts: ReadonlyMap<string, EstimateKey & Counts>,
  priorFor: (k: EstimateKey) => number,
  kappa: number = LEARNING_KAPPA,
): Estimate[] {
  return [...counts.values()]
    .map((c) => {
      const prior = Math.min(1, Math.max(0, priorFor(c)));
      return { ...c, prior, posterior: posterior(prior, c.wins, c.n, kappa) };
    })
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * The router's domain strength with the ledger folded in. For a route and a kind of work it pools the estimates over the
 * kinds of step and moves the public number toward the record. Where there is no public number the ledger speaks alone,
 * but only after `minN` outcomes, so a first lucky call never ranks a rung. Anything else is `base`'s answer, untouched.
 */
export function learnedStrengthFor(
  base: (key: string, domain: TaskDomain) => number | undefined,
  table: readonly Estimate[],
  o: { kappa?: number; minN?: number } = {},
): (key: string, domain: TaskDomain) => number | undefined {
  const kappa = o.kappa ?? LEARNING_KAPPA;
  const minN = o.minN ?? MIN_OUTCOMES_WITHOUT_MAP;
  const pooled = new Map<string, { n: number; wins: number }>();
  for (const e of table) {
    const k = `${e.rung}\u0000${e.domain}`;
    const p = pooled.get(k) ?? { n: 0, wins: 0 };
    p.n += e.n;
    p.wins += e.wins;
    pooled.set(k, p);
  }
  return (key, domain) => {
    const prior = base(key, domain);
    const rec = pooled.get(`${key}\u0000${domain}`);
    if (!rec || rec.n === 0) return prior;
    if (prior === undefined)
      return rec.n >= minN ? posterior(0.5, rec.wins, rec.n, kappa) : undefined;
    return posterior(prior, rec.wins, rec.n, kappa);
  };
}

// ─── time ───────────────────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile of a list; `q` in [0, 1]. */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

export type RungTimeStats = {
  rung: string;
  n: number;
  durationP50Sec: number;
  /** The figure the hedge margin waits for. */
  durationP95Sec: number;
  ttftWarmP50Sec?: number;
  ttftColdP50Sec?: number;
  ttftP95Sec?: number;
  tokensPerSecP50?: number;
  /** The slow end: 5th percentile of output speed. */
  tokensPerSecP5?: number;
};

/** Time per rung from the calls that answered. A rung with fewer than `minN` calls has no figure: the class default stands. */
export function rungTimeStats(facts: readonly OutcomeFact[], minN = 20): RungTimeStats[] {
  const by = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    if (!(f.durationMs > 0)) continue;
    const list = by.get(f.rungKey) ?? [];
    list.push(f);
    by.set(f.rungKey, list);
  }
  const out: RungTimeStats[] = [];
  for (const [rung, list] of by) {
    if (list.length < minN) continue;
    const dur = list.map((f) => f.durationMs / 1000);
    const withTtft = list.filter((f) => f.ttftMs !== undefined && f.ttftMs >= 0);
    const warm = withTtft
      .filter((f) => f.cacheRead >= f.input + f.cacheWrite)
      .map((f) => (f.ttftMs as number) / 1000);
    const cold = withTtft
      .filter((f) => f.cacheRead < f.input + f.cacheWrite)
      .map((f) => (f.ttftMs as number) / 1000);
    const tps = list
      .filter((f) => f.output > 0)
      .map((f) => {
        const gen = f.durationMs - (f.ttftMs ?? 0);
        return f.output / Math.max(0.05, (gen > 0 ? gen : f.durationMs) / 1000);
      });
    out.push({
      rung,
      n: list.length,
      durationP50Sec: percentile(dur, 0.5) as number,
      durationP95Sec: percentile(dur, 0.95) as number,
      ...(warm.length ? { ttftWarmP50Sec: percentile(warm, 0.5) } : {}),
      ...(cold.length ? { ttftColdP50Sec: percentile(cold, 0.5) } : {}),
      ...(withTtft.length
        ? {
            ttftP95Sec: percentile(
              withTtft.map((f) => (f.ttftMs as number) / 1000),
              0.95,
            ),
          }
        : {}),
      ...(tps.length
        ? { tokensPerSecP50: percentile(tps, 0.5), tokensPerSecP5: percentile(tps, 0.05) }
        : {}),
    });
  }
  return out.sort((a, b) => a.rung.localeCompare(b.rung));
}

/**
 * A `RungTime` from the measured figures, the class default where a figure is missing. `typical` is the median (what the
 * price charges); `slow` is the slow end (first token at p95, speed at p5), which is what a hedge waits past.
 */
export function rungTimeFrom(
  stats: RungTimeStats | undefined,
  fallback: RungTime,
  which: "typical" | "slow",
): RungTime {
  if (!stats) return fallback;
  const warm = which === "slow" ? (stats.ttftP95Sec ?? stats.ttftWarmP50Sec) : stats.ttftWarmP50Sec;
  const cold = which === "slow" ? (stats.ttftP95Sec ?? stats.ttftColdP50Sec) : stats.ttftColdP50Sec;
  const tps = which === "slow" ? stats.tokensPerSecP5 : stats.tokensPerSecP50;
  return {
    ttftColdSec: cold ?? fallback.ttftColdSec,
    ttftWarmSec: Math.min(warm ?? fallback.ttftWarmSec, cold ?? Number.POSITIVE_INFINITY),
    tokensPerSec: tps && tps > 0 ? tps : fallback.tokensPerSec,
    thinkSec: fallback.thinkSec,
  };
}

// ─── refusals ───────────────────────────────────────────────────────────────────────────────────

/**
 * The refusals in the ledger as the veto reads them: a refused call in a class (topic) other than `none`, by the AA family
 * of the model that refused, inside the 30 days an observation counts. The veto itself (two in a class) lives in
 * `thalamus-feasibility.ts` and is reused, not copied.
 */
export function refusalRecordsFrom(facts: readonly OutcomeFact[], nowMs: number): RefusalRecord[] {
  const out: RefusalRecord[] = [];
  for (const f of facts) {
    if (!(f.refused || f.outcome === "refused") || f.topic === "none") continue;
    if (nowMs - f.ts >= REFUSAL_TTL_MS) continue;
    const slash = f.rungKey.indexOf("/");
    out.push({
      family: aaFamilyOf(slash >= 0 ? f.rungKey.slice(slash + 1) : f.rungKey),
      cls: f.topic,
      atMs: f.ts,
    });
  }
  return out;
}

export type ActiveRefusal = { family: string; cls: SubjectClass; count: number };

/** The (family, class) pairs the records have already vetoed: the same count the router applies. */
export function activeRefusalVetoes(
  records: readonly RefusalRecord[],
  nowMs: number,
): ActiveRefusal[] {
  const n = new Map<string, ActiveRefusal>();
  for (const r of records) {
    if (nowMs - r.atMs >= REFUSAL_TTL_MS) continue;
    const k = `${r.family}\u0000${r.cls}`;
    const e = n.get(k) ?? { family: r.family, cls: r.cls, count: 0 };
    e.count += 1;
    n.set(k, e);
  }
  return [...n.values()]
    .filter((e) => e.count >= REFUSAL_VETO_COUNT)
    .sort((a, b) => `${a.family}${a.cls}`.localeCompare(`${b.family}${b.cls}`));
}

// ─── exploration ────────────────────────────────────────────────────────────────────────────────

/** At most this share of an overnight job's calls tries an option the router would not normally take. */
export const EXPLORE_SHARE = 0.05;

type Explorable = { rung: { key: string; effort: string }; quality: number };

/**
 * So the record does not freeze on early winners, now and then take an option the router would not. ONLY for work whose
 * urgency is `whenever`, where a worse answer costs little; only an option that still clears the bar (so the answer is not
 * worse by the router's own measure); never the pick itself; and never more than `EXPLORE_SHARE` of the job's calls.
 * `rand` in [0, 1) decides both whether and which, so the same number gives the same answer.
 */
export function exploreOption<T extends Explorable>(p: {
  urgency: Urgency;
  options: readonly T[];
  pick: T;
  /** The quality an option must clear. */
  bar: number;
  /** Calls this job has made, and how many of them explored. */
  calls: number;
  explored: number;
  rand: number;
}): T | undefined {
  if (p.urgency !== "whenever") return undefined;
  if (p.rand >= EXPLORE_SHARE) return undefined;
  if (p.explored / (p.calls + 1) >= EXPLORE_SHARE) return undefined;
  const other = p.options
    .filter(
      (o) =>
        o.quality >= p.bar &&
        `${o.rung.key}@${o.rung.effort}` !== `${p.pick.rung.key}@${p.pick.rung.effort}`,
    )
    .sort((a, b) =>
      `${a.rung.key}@${a.rung.effort}`.localeCompare(`${b.rung.key}@${b.rung.effort}`),
    );
  if (other.length === 0) return undefined;
  return other[Math.min(other.length - 1, Math.floor((p.rand / EXPLORE_SHARE) * other.length))];
}
