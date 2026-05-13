/**
 * FORK: tinkerclaw-control-panel — KPI poller subsystem (v3.5).
 *
 * Strategy for turning single-point gauges (GitHub stars right now, npm
 * downloads this week, etc.) into time-series the Graphs tab can render as
 * sparklines:
 *
 *   1. Each KPI is a metric_definition with class='SNAPSHOT' and a
 *      cadence_seconds (e.g. 21600 = 6h).
 *   2. `source` encodes both the poller and its arguments using "key:args"
 *      notation, e.g. "github.stargazers:globalcaos/tinkerclaw".
 *   3. A 60s cron tick walks every SNAPSHOT metric whose latest observation
 *      is older than cadence_seconds and writes a new observation row.
 *   4. Over time the observation table accumulates a series; the UI renders
 *      ≥2 points as a sparkline and falls back to a text line for ≤1.
 *
 * Errors during a single poll log and skip — the next tick retries. Boot
 * does an immediate pass for any metric with zero observations so the first
 * data point lands within seconds, not the next 60s tick.
 */
import type Database from "better-sqlite3";
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "../store/db.js";
import { addMetric, recordObservation } from "../store/observations.js";
import { githubForks, githubOpenIssues, githubStargazers } from "./github.js";
import { npmDownloadsMonthly, npmDownloadsWeekly } from "./npm.js";
import { demoWebsiteVisits } from "./website.js";

export type PollerFn = (args: string) => Promise<number>;

export const POLLER_REGISTRY: Map<string, PollerFn> = new Map([
  ["github.stargazers", githubStargazers],
  ["github.forks", githubForks],
  ["github.open_issues", githubOpenIssues],
  ["npm.downloads.weekly", npmDownloadsWeekly],
  ["npm.downloads.monthly", npmDownloadsMonthly],
  // Stub until the user picks a real analytics provider (Plausible / Umami /
  // GoatCounter / GA4 / Search Console). The graph still populates so the
  // Graphs section has something to render against the KPI section.
  ["demo.website.visits", demoWebsiteVisits],
]);

type Logger = { info: (msg: string) => void; warn?: (msg: string) => void };

type SeedSpec = {
  id: string;
  source: string;
  cadence_seconds: number;
  template: "sparkline" | "single-stat";
};

// Initial KPI set. Adding more is just `control-panel.add-metric` from the
// CLI or by extending this array.
//
// `template` discriminates which section the UI renders the metric in:
//   - "single-stat"  → KPIs section (compact one-liner)
//   - "sparkline"    → Graphs section (chart block)
//
// Cadence picks: github KPIs move slowly (6h), website visits should track
// finer (1h) so the demo graph fills out in minutes rather than days.
const SEED_KPIS: SeedSpec[] = [
  {
    id: "kpi.github.stars.tinkerclaw",
    source: "github.stargazers:globalcaos/tinkerclaw",
    cadence_seconds: 21600,
    template: "single-stat",
  },
  {
    id: "kpi.github.forks.tinkerclaw",
    source: "github.forks:globalcaos/tinkerclaw",
    cadence_seconds: 21600,
    template: "single-stat",
  },
  {
    id: "kpi.github.open_issues.tinkerclaw",
    source: "github.open_issues:globalcaos/tinkerclaw",
    cadence_seconds: 21600,
    template: "single-stat",
  },
  // FORK 2026-05-13 — placeholder website-visits graph. `demo.website.visits`
  // produces deterministic-noise values until the user names their analytics
  // provider; swap the source string to e.g. "plausible.visitors:tinkerzone.com"
  // when wiring Plausible/Umami/GA4/Search Console.
  {
    id: "graph.website.visits.daily",
    source: "demo.website.visits:default",
    cadence_seconds: 3600,
    template: "sparkline",
  },
];

function seedKpisIfMissing(cfg: ControlPanelResolvedConfig, log: Logger): void {
  const db = getDb(cfg);
  for (const spec of SEED_KPIS) {
    const existing = db
      .prepare(`SELECT template FROM metric_definition WHERE id = ?`)
      .get(spec.id) as { template: string } | undefined;
    if (!existing) {
      addMetric(cfg, {
        id: spec.id,
        class: "SNAPSHOT",
        source: spec.source,
        cadence_seconds: spec.cadence_seconds,
        template: spec.template,
        retention_days: 365,
      });
      log.info(
        `[control-panel] seeded KPI ${spec.id} (source=${spec.source}, cadence=${spec.cadence_seconds}s)`,
      );
      continue;
    }
    // Reconcile the template if the seed spec evolves between releases.
    // Cadence/source stay user-customizable; template is a UI hint owned by
    // the seed and not surfaced as a config.
    if (existing.template !== spec.template) {
      db.prepare(`UPDATE metric_definition SET template = ?, updated_at = ? WHERE id = ?`).run(
        spec.template,
        Date.now(),
        spec.id,
      );
      log.info(
        `[control-panel] reconciled template ${spec.id}: ${existing.template} → ${spec.template}`,
      );
    }
  }
}

type PollableMetric = {
  id: string;
  source: string;
  cadence_seconds: number;
};

function listPollable(db: Database.Database): PollableMetric[] {
  return db
    .prepare(
      `SELECT id, source, cadence_seconds
         FROM metric_definition
        WHERE class = 'SNAPSHOT'
          AND cadence_seconds IS NOT NULL
          AND cadence_seconds > 0`,
    )
    .all() as PollableMetric[];
}

function latestObservationTs(db: Database.Database, metricId: string): number {
  const row = db
    .prepare(`SELECT MAX(ts) AS ts FROM observation WHERE metric_id = ?`)
    .get(metricId) as { ts: number | null };
  return row.ts ?? 0;
}

function splitSource(source: string): { key: string; args: string } {
  const idx = source.indexOf(":");
  if (idx < 0) return { key: source, args: "" };
  return { key: source.slice(0, idx), args: source.slice(idx + 1) };
}

async function pollOne(
  cfg: ControlPanelResolvedConfig,
  metric: PollableMetric,
  log: Logger,
): Promise<void> {
  const { key, args } = splitSource(metric.source);
  const poller = POLLER_REGISTRY.get(key);
  if (!poller) {
    (log.warn ?? log.info).call(
      log,
      `[control-panel] no poller registered for source key "${key}" (metric ${metric.id})`,
    );
    return;
  }
  try {
    const value = await poller(args);
    recordObservation(cfg, { metric_id: metric.id, value });
    log.info(`[control-panel] polled ${metric.id} → ${value}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (log.warn ?? log.info).call(log, `[control-panel] poll failed for ${metric.id}: ${msg}`);
  }
}

/**
 * Public entry for the on-demand refresh button. Looks up the metric by id,
 * runs its poller, records the observation. Throws if the metric doesn't
 * exist or the source key isn't registered (so the RPC layer can surface a
 * useful error to the UI).
 */
export async function pollMetricNow(
  cfg: ControlPanelResolvedConfig,
  metricId: string,
  log: Logger,
): Promise<{ value: number; ts: number }> {
  const db = getDb(cfg);
  const metric = db
    .prepare(`SELECT id, source, cadence_seconds FROM metric_definition WHERE id = ?`)
    .get(metricId) as PollableMetric | undefined;
  if (!metric) throw new Error(`no metric with id ${metricId}`);
  const { key, args } = splitSource(metric.source);
  const poller = POLLER_REGISTRY.get(key);
  if (!poller) throw new Error(`no poller registered for source key "${key}"`);
  const value = await poller(args);
  const ts = Date.now();
  recordObservation(cfg, { metric_id: metricId, value, ts });
  log.info(`[control-panel] on-demand poll ${metricId} → ${value}`);
  return { value, ts };
}

async function tick(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
  opts: { forceMissingOnly: boolean },
): Promise<void> {
  const db = getDb(cfg);
  const metrics = listPollable(db);
  const now = Date.now();
  for (const m of metrics) {
    const lastTs = latestObservationTs(db, m.id);
    if (opts.forceMissingOnly) {
      if (lastTs !== 0) continue;
    } else {
      const overdueBy = now - lastTs - m.cadence_seconds * 1000;
      if (overdueBy < 0) continue;
    }
    await pollOne(cfg, m, log);
  }
}

const TICK_INTERVAL_MS = 60_000;

export function startPollerSubsystem(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
): { stop: () => void } {
  seedKpisIfMissing(cfg, log);
  // Immediate pass for any metric that has no observations yet. Runs async,
  // doesn't block plugin boot; first data points land within seconds.
  void tick(cfg, log, { forceMissingOnly: true }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    (log.warn ?? log.info).call(log, `[control-panel] initial poll pass failed: ${msg}`);
  });
  const handle = setInterval(() => {
    void tick(cfg, log, { forceMissingOnly: false }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      (log.warn ?? log.info).call(log, `[control-panel] poller tick failed: ${msg}`);
    });
  }, TICK_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
