// THALAMUS v4 — the nightly learning run (design doc section 13; paper J19 v4.1 section 8, "Learning without a training run").
//
// WHAT THIS IS FOR. One function the owner (or, once he registers it, a cron) calls through the gateway method
// `thalamus.learning.run`. It reads the outcomes the router recorded, moves each estimate from the public map toward the
// record, measures how long each rung really takes (the figure a hedge waits past), finds the refusals the veto is built
// from, and runs the card loop. It returns a report of what changed.
//
// NO CRON ENTRY. Registering this run on a schedule is a live change and stays the owner's. Nothing here schedules itself.
//
// A DRY RUN WRITES NOTHING and gives the same report, so the owner can read what a night would do. A real run needs
// `learning.enabled`; without it the method answers `learning-disabled` and touches nothing.
//
// JOINED BY WHO ANSWERED. Outcomes are grouped by the model that answered the call (the usage event's model), never by the
// pick, so credit never goes to a model that did not run (the v2 registry's fault).

import {
  activeRefusalVetoes,
  aggregate,
  domainStrengthFor,
  estimates,
  refusalRecordsFrom,
  rungTimeStats,
  type ActiveRefusal,
  type Estimate,
  type EstimateKey,
  type RungTimeStats,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { CardLoop, CardLoopReport } from "./card-loop.js";
import type { ThalamusConfig } from "./config.js";
import type { ThalamusStore } from "./store.js";

export type Mover = {
  domain: string;
  stepKind: string;
  rung: string;
  n: number;
  /** The estimate before this run, absent for a new one. */
  from?: number;
  to: number;
};

export type LearningReport = {
  dry: boolean;
  ts: number;
  /** Outcomes read (calls with an outcome and a recorded kind of work). */
  facts: number;
  estimates: { total: number; changed: number; new: number; movers: Mover[] };
  rungTimes: Array<{ rung: string; n: number; p50Sec: number; p95Sec: number }>;
  refusals: { records: number; vetoes: ActiveRefusal[] };
  cards: CardLoopReport | null;
};

export type LearningResult = { ok: true; report: LearningReport } | { ok: false; error: string };

export type LearningDeps = {
  cfg: () => ThalamusConfig;
  store: () => ThalamusStore | undefined;
  now: () => number;
  cardLoop?: () => CardLoop | undefined;
  /** The public map's number for a kind of work, step and rung: the prior the record moves from. */
  priorFor?: (k: EstimateKey) => number;
  /** Called after a real run wrote, so the router can start using what was learned without a restart. */
  onApplied?: (table: Estimate[], times: RungTimeStats[]) => void;
  onError?: (err: unknown) => void;
};

/** What the public map says, or an open mind where it says nothing. */
export const publicPrior = (k: EstimateKey): number =>
  domainStrengthFor(k.rung, k.domain)?.p ?? 0.5;

const MOVERS_SHOWN = 8;
const EPS = 1e-9;

export function createLearning(d: LearningDeps) {
  const priorFor = d.priorFor ?? publicPrior;

  async function run(o: { dry: boolean }): Promise<LearningResult> {
    const store = d.store();
    if (!store) return { ok: false, error: "not-running" };
    const cfg = d.cfg();
    if (!o.dry && !cfg.learning.enabled) return { ok: false, error: "learning-disabled" };
    const now = d.now();

    const facts = store.outcomeFacts();
    const table = estimates(aggregate(facts), priorFor);
    const previous = new Map(
      store.getEstimates().map((e) => [`${e.domain}\u0000${e.stepKind}\u0000${e.rung}`, e]),
    );
    const movers: Mover[] = [];
    let changed = 0;
    let added = 0;
    for (const e of table) {
      const before = previous.get(`${e.domain}\u0000${e.stepKind}\u0000${e.rung}`);
      if (!before) added += 1;
      if (!before || Math.abs(before.posterior - e.posterior) > EPS) {
        if (before) changed += 1;
        movers.push({
          domain: e.domain,
          stepKind: e.stepKind,
          rung: e.rung,
          n: e.n,
          ...(before ? { from: before.posterior } : {}),
          to: e.posterior,
        });
      }
    }
    movers.sort(
      (a, b) =>
        Math.abs(b.to - (b.from ?? 0.5)) - Math.abs(a.to - (a.from ?? 0.5)) ||
        a.rung.localeCompare(b.rung),
    );

    const times = rungTimeStats(facts);
    const records = refusalRecordsFrom(facts, now);
    const vetoes = activeRefusalVetoes(records, now);

    let cards: CardLoopReport | null = null;
    try {
      cards = (await d.cardLoop?.()?.run({ dry: o.dry })) ?? null;
    } catch (err) {
      d.onError?.(err);
    }

    const report: LearningReport = {
      dry: o.dry,
      ts: now,
      facts: facts.length,
      estimates: {
        total: table.length,
        changed,
        new: added,
        movers: movers.slice(0, MOVERS_SHOWN),
      },
      rungTimes: times.map((t) => ({
        rung: t.rung,
        n: t.n,
        p50Sec: t.durationP50Sec,
        p95Sec: t.durationP95Sec,
      })),
      refusals: { records: records.length, vetoes },
      cards,
    };
    if (!o.dry) {
      store.putEstimates(table, now);
      store.putRungTimes(times, now);
      store.recordLearningRun({ ts: now, mode: cfg.mode, dry: false, report });
      d.onApplied?.(table, times);
    }
    return { ok: true, report };
  }

  return { run };
}

export type Learning = ReturnType<typeof createLearning>;
