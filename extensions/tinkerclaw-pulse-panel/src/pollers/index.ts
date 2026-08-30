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
import { ga4Sessions } from "./ga4.js";
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
  // FORK 2026-06-05 — real DAILY clones/views (gh CLI), replaces 14d-total-as-daily.
  ["github.traffic.daily", githubTrafficDaily],
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
    // FORK 2026-06-26 — promoted from a single-stat KPI to a real graph (its own
    // "GitHub stars" card in the Pulse Graphs section). The curve is seeded from
    // the exact GitHub stargazer timeline by backfillStargazerTimeline(): an
    // origin dot at value 0 on the repo's created_at, plus one cumulative point
    // per star gained. The 6h poller keeps appending the live tip forward.
    // Group "stars" (id segment[1]) keeps it off the github-traffic card so the
    // 0–N star scale isn't crushed by cumulative views/clones.
    id: "graph.stars.tinkerclaw",
    source: "github.stargazers:globalcaos/tinkerclaw",
    cadence_seconds: 21600,
    template: "sparkline",
  },
  // FORK 2026-06-04 — forks + open-issues KPIs removed at the owner's request.
  // FORK 2026-05-13 — placeholder website-visits graph. `demo.website.visits`
  // produces deterministic-noise values until the user names their analytics
  // provider; swap the source string to e.g. "plausible.visitors:tinkerzone.com"
  // when wiring Plausible/Umami/GA4/Search Console.
  {
    // FORK 2026-06-05 — real GA4 sessions for thetinkerzone.com (property 529436250).
    id: "graph.website.visits.daily",
    source: "ga4.sessions:529436250",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // FORK 2026-06-14 — sprintpaper.com visits (rendered in colibri-logo green #b6f02c,
  // cumulative — see SERIES_STYLE in tinker-ui/src/app.ts). LIVE: the GA4 service account
  // was granted Viewer on the SprintPaper.com property (541325538, account 5961104,
  // measurement G-M0HB6LJB33) on 2026-06-14.
  {
    id: "graph.website.visits.sprintpaper",
    source: "ga4.sessions:541325538",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // ── Online presence (FORK 2026-06-04 — execmode-pulse graphs) ──────────────
  // Moltbook standing — live API; account fixed by ~/.config/moltbook creds.
  {
    id: "kpi.moltbook.karma",
    source: "moltbook.karma:self",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "kpi.moltbook.posts",
    source: "moltbook.posts:self",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.moltbook.comments",
    source: "moltbook.comments:self",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.moltbook.followers",
    source: "moltbook.followers:self",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // Fork traffic + ClawHub installs — read off engagement-state.json (kept by
  // the 08:00 online-engagement cron) so we need no GitHub-traffic auth.
  {
    id: "graph.github.traffic.views14d",
    source: "github.traffic.daily:views:globalcaos/tinkerclaw",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.github.traffic.clones14d",
    source: "github.traffic.daily:clones:globalcaos/tinkerclaw",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // FORK 2026-06-06 — ClawHub REINSTATED (appeal #2517). Tracks via engagement-state.
  // FORK 2026-06-14 — read tracked_slugs_state (the LIVE exact block the 08:00 cron
  // refreshes: jarvis-voice 4916, growing daily) NOT our_skills (a stale rounded block
  // frozen at 4800 for a week → the graph read 4.8k while clawhub.ai showed 4.9k).
  // FORK 2026-06-14 — ClawHub VIEWS (downloads, a fetch/vanity counter) — one series per skill.
  {
    id: "graph.clawhub.jarvis-voice",
    source: "localstate:engagement-state.json#clawhub.tracked_slugs_state.jarvis-voice.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.whatsapp-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.whatsapp-ultimate.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.youtube-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.youtube-ultimate.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.chatgpt-exporter-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.chatgpt-exporter-ultimate.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.token-panel-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.token-panel-ultimate.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.shell-security-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.shell-security-ultimate.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhub.outlook-hack",
    source: "localstate:engagement-state.json#clawhub.tracked_slugs_state.outlook-hack.downloads",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // FORK 2026-06-14 — ClawHub INSTALLS (the honest adoption count) — one series per skill.
  {
    id: "graph.clawhubinstalls.jarvis-voice",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.jarvis-voice.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.whatsapp-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.whatsapp-ultimate.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.youtube-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.youtube-ultimate.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.chatgpt-exporter-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.chatgpt-exporter-ultimate.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.token-panel-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.token-panel-ultimate.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.shell-security-ultimate",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.shell-security-ultimate.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.outlook-hack",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.outlook-hack.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.clawhubinstalls.teams-hack",
    source:
      "localstate:engagement-state.json#clawhub.tracked_slugs_state.teams-hack.installsAllTime",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // Inbound links — fed by the weekly Inbound-Marketing cron's audit
  // (inbound-campaign-state.json); pollers error+retry until it first exists.
  // FORK 2026-06-05 — split per destination target × {external (organic, others
  // created), ours (we created)}. UI colors one hue per target and dashes the
  // "ours" line; see SERIES_STYLE in tinker-ui/src/app.ts.
  {
    id: "graph.inbound.tinkerclaw.external",
    source: "localstate:inbound-campaign-state.json#inbound_targets.tinkerclaw.external",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.inbound.tinkerclaw.ours",
    source: "localstate:inbound-campaign-state.json#inbound_targets.tinkerclaw.ours",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.inbound.thetinkerzone.external",
    source: "localstate:inbound-campaign-state.json#inbound_targets.thetinkerzone.external",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.inbound.thetinkerzone.ours",
    source: "localstate:inbound-campaign-state.json#inbound_targets.thetinkerzone.ours",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.inbound.sprintpaper.external",
    source: "localstate:inbound-campaign-state.json#inbound_targets.sprintpaper.external",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.inbound.sprintpaper.ours",
    source: "localstate:inbound-campaign-state.json#inbound_targets.sprintpaper.ours",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  // FORK 2026-06-14 — YouTube: thetinkerzone channel (UCh_am-9EG0_a-DBronOMC4w)
  // public stats via Data API key. Absolute monotonic totals (growing line, NOT
  // cumulative). Subs + total views + video count, one chart at the end.
  {
    id: "graph.youtube.subscribers",
    source: "youtube.channelStats:subscribers:UCh_am-9EG0_a-DBronOMC4w",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.youtube.views",
    source: "youtube.channelStats:views:UCh_am-9EG0_a-DBronOMC4w",
    cadence_seconds: 86400,
    template: "sparkline",
  },
  {
    id: "graph.youtube.videos",
    source: "youtube.channelStats:videos:UCh_am-9EG0_a-DBronOMC4w",
    cadence_seconds: 86400,
    template: "sparkline",
  },
];

function seedKpisIfMissing(cfg: ControlPanelResolvedConfig, log: Logger): void {
  const db = getDb(cfg);
  // FORK 2026-06-26 — one-time migration: the stars metric moved from the
  // single-stat KPI id `kpi.github.stars.tinkerclaw` to the graph id
  // `graph.stars.tinkerclaw`. Drop the old definition (and its sparse poll
  // history) so the stale KPI row stops rendering; the new graph rebuilds the
  // true curve from GitHub via backfillStargazerTimeline().
  const oldStars = db
    .prepare(`SELECT 1 FROM metric_definition WHERE id = ?`)
    .get("kpi.github.stars.tinkerclaw");
  if (oldStars) {
    db.prepare(`DELETE FROM observation WHERE metric_id = ?`).run("kpi.github.stars.tinkerclaw");
    db.prepare(`DELETE FROM metric_definition WHERE id = ?`).run("kpi.github.stars.tinkerclaw");
    log.info(`[pulse-panel] migrated kpi.github.stars.tinkerclaw → graph.stars.tinkerclaw`);
  }
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
        `[pulse-panel] seeded KPI ${spec.id} (source=${spec.source}, cadence=${spec.cadence_seconds}s)`,
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
        `[pulse-panel] reconciled template ${spec.id}: ${existing.template} → ${spec.template}`,
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
      `[pulse-panel] no poller registered for source key "${key}" (metric ${metric.id})`,
    );
    return;
  }
  try {
    const value = await poller(args);
    recordObservation(cfg, { metric_id: metric.id, value });
    log.info(`[pulse-panel] polled ${metric.id} → ${value}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof MissingLocalStateKeyError) {
      // Optional metric not present in the localstate file this cycle — quiet
      // skip (debug, never per-cycle error/warn spam). Series with data are
      // unaffected; a real failure (bad file, non-numeric value) still warns.
      log.debug?.(`[pulse-panel] skip ${metric.id} (no data yet): ${msg}`);
      return;
    }
    (log.warn ?? log.info).call(log, `[pulse-panel] poll failed for ${metric.id}: ${msg}`);
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
 * FORK 2026-06-26 — seed the exact "GitHub stars" curve for the Pulse graph.
 * Reconstructs the true series from GitHub: an origin dot (value 0) at the
 * repo's created_at, then a cumulative point (1, 2, … N) at each stargazer's
 * starred_at. Recorded at the EXACT event timestamps; ON CONFLICT(metric_id,
 * ts) makes it idempotent, so re-running on each boot refreshes the curve and
 * captures any new stars' precise timestamps without duplicating points. The
 * live 6h poller still appends the `now` tip between boots. Best-effort: a
 * GitHub hiccup logs and is retried on the next boot.
 */
async function backfillStargazerTimeline(
  cfg: ControlPanelResolvedConfig,
  log: Logger,
): Promise<void> {
  const metricId = "graph.stars.tinkerclaw";
  const db = getDb(cfg);
  const def = db.prepare(`SELECT source FROM metric_definition WHERE id = ?`).get(metricId) as
    | { source: string }
    | undefined;
  if (!def) return; // seed hasn't run yet / metric removed
  const { args } = splitSource(def.source);
  try {
    const { createdAtMs, starredAtMs } = await fetchStargazerTimeline(args);
    recordObservation(cfg, { metric_id: metricId, value: 0, ts: createdAtMs });
    starredAtMs.forEach((ts, i) => {
      recordObservation(cfg, { metric_id: metricId, value: i + 1, ts });
    });
    log.info(`[pulse-panel] backfilled ${metricId}: 0@created + ${starredAtMs.length} star points`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (log.warn ?? log.info).call(log, `[pulse-panel] stargazer backfill failed: ${msg}`);
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
    (log.warn ?? log.info).call(log, `[pulse-panel] initial poll pass failed: ${msg}`);
  });
  // FORK 2026-06-26 — rebuild the exact star-gain curve (origin dot + per-star
  // points) on each boot; idempotent, non-blocking.
  void backfillStargazerTimeline(cfg, log);
  const handle = setInterval(() => {
    void tick(cfg, log, { forceMissingOnly: false }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      (log.warn ?? log.info).call(log, `[pulse-panel] poller tick failed: ${msg}`);
    });
  }, TICK_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
