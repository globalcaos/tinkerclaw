/**
 * FORK: tinkerclaw-pulse-panel — KPI poller subsystem (v3.5).
 *
 * Strategy for turning single-point gauges (GitHub stars right now, npm
 * downloads this week, etc.) into time-series the Graphs tab can render as
 * sparklines:
 *
 *   1. Each KPI is a metric_definition with class='SNAPSHOT' and a
 *      cadence_seconds (e.g. 21600 = 6h).
 *   2. `source` encodes both the poller and its arguments using "key:args"
 *      notation, e.g. "github.stargazers:<owner>/<repo>".
 *   3. A 60s cron tick walks every SNAPSHOT metric whose latest observation
 *      is older than cadence_seconds and writes a new observation row.
 *   4. Over time the observation table accumulates a series; the UI renders
 *      ≥2 points as a sparkline and falls back to a text line for ≤1.
 *
 * Errors during a single poll log and skip; the metric retries with a backoff
 * (2, 4, 8 … minutes, capped at its own cadence — see `isDue`). Boot
 * does an immediate pass for any metric with zero observations so the first
 * data point lands within seconds, not the next tick.
 *
 * NETWORK DISCLOSURE (2026-09-08). This subsystem performs RECURRING OUTBOUND
 * REQUESTS on a background timer for as long as the gateway runs: a tick every
 * `polling.tickSeconds` (default 60s) polls every metric whose own
 * `cadence_seconds` is due. It ships with NO metrics of its own — the seed list
 * is operator-supplied config — so a fresh install makes no third-party request
 * until someone adds a metric. Which hosts are contacted follows entirely from
 * the metric sources configured: api.github.com, api.npmjs.org,
 * oauth2.googleapis.com + analyticsdata.googleapis.com, www.googleapis.com,
 * www.moltbook.com. Set
 * `polling.enabled: false` to keep the RPCs and stop the timer.
 */
import type Database from "better-sqlite3";
import type { ControlPanelResolvedConfig, SeedMetricConfig } from "../paths.js";
import { getDb } from "../store/db.js";
import { addMetric, recordObservation } from "../store/observations.js";
import { configurePollerCredentials, PollerNotConfiguredError } from "./credentials.js";
import { ga4Sessions } from "./ga4.js";
import {
  githubActivityDaily,
  fetchActivityTimeline,
  parseActivityArgs,
  type ActivityMetric,
} from "./github-activity.js";
import { githubTrafficDaily } from "./github-traffic.js";
import {
  fetchStargazerTimeline,
  githubForks,
  githubOpenIssues,
  githubStargazers,
} from "./github.js";
import { localStateValue, MissingLocalStateKeyError } from "./localstate.js";
import { moltbookKarma, moltbookPosts, moltbookComments, moltbookFollowers } from "./moltbook.js";
import { npmDownloadsMonthly, npmDownloadsWeekly } from "./npm.js";
import { demoWebsiteVisits } from "./website.js";
import { youtubeChannelStats } from "./youtube.js";

export type PollerFn = (args: string) => Promise<number>;

export const POLLER_REGISTRY: Map<string, PollerFn> = new Map([
  ["github.stargazers", githubStargazers],
  // FORK 2026-06-05 — real DAILY clones/views (REST, token), replaces 14d-total-as-daily.
  ["github.traffic.daily", githubTrafficDaily],
  // FORK 2026-09-10 — the architect's own daily commits / lines on the default branch.
  ["github.activity", githubActivityDaily],
  ["github.forks", githubForks],
  ["github.open_issues", githubOpenIssues],
  ["npm.downloads.weekly", npmDownloadsWeekly],
  ["npm.downloads.monthly", npmDownloadsMonthly],
  // Stub until the user picks a real analytics provider (Plausible / Umami /
  // GoatCounter / GA4 / Search Console). The graph still populates so the
  // Graphs section has something to render against the KPI section.
  ["demo.website.visits", demoWebsiteVisits],
  // FORK 2026-06-05 — real GA4 traffic (SA-authenticated Data API), replaces the stub.
  ["ga4.sessions", ga4Sessions],
  // FORK 2026-06-04 — online-presence pollers (execmode-pulse graphs).
  ["moltbook.karma", moltbookKarma],
  ["moltbook.posts", moltbookPosts],
  ["moltbook.comments", moltbookComments],
  ["moltbook.followers", moltbookFollowers],
  // Generic: read a numeric value out of an online-presence state JSON the
  // crons already maintain (fork traffic, clawhub installs, inbound links).
  ["localstate", localStateValue],
  // FORK 2026-06-14 — YouTube channel public stats (Data API key, no expiry).
  ["youtube.channelStats", youtubeChannelStats],
]);

type Logger = {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

/**
 * Metric seeding is OPERATOR-SUPPLIED. Earlier releases shipped a hardcoded
 * list of the fork author's own repositories, GA4 property ids, YouTube channel
 * and ClawHub slugs, which meant every install began polling one specific
 * person's accounts on boot. The list now comes from
 * `plugins.tinkerclaw-pulse-panel.seedMetrics` and is empty by default.
 *
 * `template` discriminates which section the UI renders the metric in:
 *   - "single-stat"  → KPIs section (compact one-liner)
 *   - "sparkline"    → Graphs section (chart block)
 */
const DEFAULT_SEED_CADENCE_SECONDS = 21600;
const DEFAULT_SEED_TEMPLATE = "sparkline" as const;

function seedKpisIfMissing(cfg: ControlPanelResolvedConfig, log: Logger): void {
  const seeds: SeedMetricConfig[] = cfg.seedMetrics;
  if (seeds.length === 0) return;
  const db = getDb(cfg);
  for (const spec of seeds) {
    if (!spec?.id || !spec?.source) {
      (log.warn ?? log.info).call(
        log,
        `[pulse-panel] ignoring seedMetrics entry without both id and source: ${JSON.stringify(spec)}`,
      );
      continue;
    }
    const template = spec.template ?? DEFAULT_SEED_TEMPLATE;
    const existing = db
      .prepare(`SELECT template FROM metric_definition WHERE id = ?`)
      .get(spec.id) as { template: string } | undefined;
    if (!existing) {
      addMetric(cfg, {
        id: spec.id,
        class: "SNAPSHOT",
        source: spec.source,
        cadence_seconds: spec.cadenceSeconds ?? DEFAULT_SEED_CADENCE_SECONDS,
        template,
        retention_days: 365,
      });
      log.info(
        `[pulse-panel] seeded KPI ${spec.id} (source=${spec.source}, cadence=${spec.cadenceSeconds ?? DEFAULT_SEED_CADENCE_SECONDS}s)`,
      );
      continue;
    }
    // Reconcile the template if the seed spec evolves between releases.
    // Cadence/source stay user-customizable; template is a UI hint owned by
    // the seed and not surfaced as a config.
    if (existing.template !== template) {
      db.prepare(`UPDATE metric_definition SET template = ?, updated_at = ? WHERE id = ?`).run(
        template,
        Date.now(),
        spec.id,
      );
      log.info(`[pulse-panel] reconciled template ${spec.id}: ${existing.template} → ${template}`);
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

/**
 * FORK 2026-10-07 — consecutive failures per metric, so a metric that keeps
 * failing backs off instead of being retried (and logged) on every tick. A
 * failing metric never gets an observation, so before this it counted as
 * overdue forever: on Goku 21 such metrics × 4 plugin loads wrote ~121k warn
 * lines a day, 93% of its gateway journal.
 */
const failures = new Map<string, { at: number; count: number }>();

/**
 * Whether a metric should be polled now. Healthy metrics are due one cadence
 * after their last observation; a failing one retries after 2^count minutes,
 * never later than its cadence. Exported for tests.
 */
export function isDue(
  now: number,
  lastObservationTs: number,
  cadenceSeconds: number,
  failure?: { at: number; count: number },
): boolean {
  if (failure) {
    return now - failure.at >= Math.min(cadenceSeconds * 1000, 60_000 * 2 ** failure.count);
  }
  return now - lastObservationTs >= cadenceSeconds * 1000;
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
): Promise<boolean> {
  const { key, args } = splitSource(metric.source);
  const poller = POLLER_REGISTRY.get(key);
  if (!poller) {
    (log.warn ?? log.info).call(
      log,
      `[pulse-panel] no poller registered for source key "${key}" (metric ${metric.id})`,
    );
    return false;
  }
  try {
    const value = await poller(args);
    recordObservation(cfg, { metric_id: metric.id, value });
    log.info(`[pulse-panel] polled ${metric.id} → ${value}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof MissingLocalStateKeyError) {
      // Optional metric not present in the localstate file this cycle — quiet
      // skip (debug, never per-cycle error/warn spam). Series with data are
      // unaffected; a real failure (bad file, non-numeric value) still warns.
      log.debug?.(`[pulse-panel] skip ${metric.id} (no data yet): ${msg}`);
      return false;
    }
    if (err instanceof PollerNotConfiguredError) {
      // The operator has not supplied this poller's credential. That is a
      // normal steady state, not a failure — skip quietly every cycle.
      log.debug?.(`[pulse-panel] skip ${metric.id} (not configured): ${msg}`);
      return false;
    }
    (log.warn ?? log.info).call(log, `[pulse-panel] poll failed for ${metric.id}: ${msg}`);
    return false;
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
  log.info(`[pulse-panel] on-demand poll ${metricId} → ${value}`);
  return { value, ts };
}

/**
 * FORK 2026-06-26 — seed the exact "GitHub stars" curve for a Pulse graph.
 * Reconstructs the true series from GitHub: an origin dot (value 0) at the
 * repo's created_at, then a cumulative point (1, 2, … N) at each stargazer's
 * starred_at. Recorded at the EXACT event timestamps; ON CONFLICT(metric_id,
 * ts) makes it idempotent, so re-running on each boot refreshes the curve and
 * captures any new stars' precise timestamps without duplicating points. The
 * live poller still appends the `now` tip between boots. Best-effort: a
 * GitHub hiccup logs and is retried on the next boot.
 *
 * 2026-09-08: applies to EVERY metric whose source key is `github.stargazers`,
 * rather than to one hardcoded metric id pointing at one specific repository.
 */
async function backfillStargazerTimelines(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
): Promise<void> {
  const db = getDb(cfg);
  const defs = db
    .prepare(`SELECT id, source FROM metric_definition WHERE source LIKE 'github.stargazers:%'`)
    .all() as Array<{ id: string; source: string }>;
  for (const def of defs) {
    const { args } = splitSource(def.source);
    try {
      const { createdAtMs, starredAtMs } = await fetchStargazerTimeline(args);
      recordObservation(cfg, { metric_id: def.id, value: 0, ts: createdAtMs });
      starredAtMs.forEach((ts, i) => {
        recordObservation(cfg, { metric_id: def.id, value: i + 1, ts });
      });
      log.info(`[pulse-panel] backfilled ${def.id}: 0@created + ${starredAtMs.length} star points`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (log.warn ?? log.info).call(
        log,
        `[pulse-panel] stargazer backfill failed for ${def.id}: ${msg}`,
      );
    }
  }
}

/**
 * FORK 2026-09-10 — seed the daily GitHub-activity curve (commits / lines
 * added / lines deleted) from GraphQL history. One observation per UTC day;
 * empty days are recorded as 0 so the line sits on the floor between bursts.
 * Idempotent via ON CONFLICT(metric_id, ts). Sibling metrics for the same
 * owner/repo share one fetch (60s cache in fetchActivityTimeline).
 */
async function backfillActivityTimelines(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
): Promise<void> {
  const db = getDb(cfg);
  const defs = db
    .prepare(`SELECT id, source FROM metric_definition WHERE source LIKE 'github.activity:%'`)
    .all() as Array<{ id: string; source: string }>;
  const byRepo = new Map<string, Array<{ id: string; metric: ActivityMetric }>>();
  for (const def of defs) {
    const { args } = splitSource(def.source);
    try {
      const parsed = parseActivityArgs(args);
      const key = `${parsed.owner}/${parsed.repo}`;
      const list = byRepo.get(key) ?? [];
      list.push({ id: def.id, metric: parsed.metric });
      byRepo.set(key, list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (log.warn ?? log.info).call(log, `[pulse-panel] skip activity backfill ${def.id}: ${msg}`);
    }
  }
  for (const [repoKey, metrics] of byRepo) {
    const [owner, repo] = repoKey.split("/");
    try {
      const days = await fetchActivityTimeline(owner, repo);
      for (const m of metrics) {
        for (const d of days) {
          recordObservation(cfg, { metric_id: m.id, value: d[m.metric], ts: d.ts });
        }
        log.info(`[pulse-panel] backfilled ${m.id}: ${days.length} daily ${m.metric} points`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PollerNotConfiguredError) {
        log.debug?.(`[pulse-panel] skip activity backfill ${repoKey} (not configured): ${msg}`);
        continue;
      }
      (log.warn ?? log.info).call(
        log,
        `[pulse-panel] activity backfill failed for ${repoKey}: ${msg}`,
      );
    }
  }
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
    const failure = failures.get(m.id);
    if (opts.forceMissingOnly) {
      if (lastTs !== 0) continue;
    } else if (!isDue(now, lastTs, m.cadence_seconds, failure)) {
      continue;
    }
    if (await pollOne(cfg, m, log)) {
      failures.delete(m.id);
    } else {
      failures.set(m.id, { at: Date.now(), count: (failure?.count ?? 0) + 1 });
    }
  }
}

export function startPollerSubsystem(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
): { stop: () => void } {
  // Install operator-supplied credentials before any poll can run. Pollers with
  // nothing configured throw PollerNotConfiguredError and are skipped quietly.
  configurePollerCredentials(cfg.credentials);
  seedKpisIfMissing(cfg, log);

  if (!cfg.polling.enabled) {
    log.info("[pulse-panel] polling disabled by config — RPCs served, no background fetches");
    return { stop: () => {} };
  }

  // Immediate pass for any metric that has no observations yet. Runs async,
  // doesn't block plugin boot; first data points land within seconds.
  void tick(cfg, log, { forceMissingOnly: true }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    (log.warn ?? log.info).call(log, `[pulse-panel] initial poll pass failed: ${msg}`);
  });
  // FORK 2026-06-26 — rebuild the exact star-gain curve (origin dot + per-star
  // points) on each boot; idempotent, non-blocking.
  void backfillStargazerTimelines(cfg, log);
  // FORK 2026-09-10 — rebuild the architect's daily commit/line curve on each boot.
  void backfillActivityTimelines(cfg, log);
  const handle = setInterval(() => {
    void tick(cfg, log, { forceMissingOnly: false }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      (log.warn ?? log.info).call(log, `[pulse-panel] poller tick failed: ${msg}`);
    });
  }, cfg.polling.tickSeconds * 1000);
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
