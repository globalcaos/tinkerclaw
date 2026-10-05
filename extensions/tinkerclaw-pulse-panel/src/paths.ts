/**
 * FORK: tinkerclaw-pulse-panel — config resolution.
 *
 * Resolves user-facing config (dataDir, polling, credentials, seedMetrics,
 * calendarSync, briefingImport, execMode) to absolute paths and concrete
 * defaults that the rest of the plugin uses.
 *
 * Two defaults are deliberately conservative:
 *   - `manageTaskSchema` is false, so this plugin never creates or migrates the
 *     task tables owned by tinkerclaw-task-panel.
 *   - `seedMetrics` is empty, so a fresh install polls NOTHING until the
 *     operator adds a metric (via config or `pulsepanel.add-metric`). Every
 *     outbound request this plugin makes traces back to a metric someone added.
 */
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";

/** One metric to create on boot if it does not already exist. */
export type SeedMetricConfig = {
  id: string;
  /** "<pollerKey>:<args>", e.g. "github.stargazers:owner/repo". */
  source: string;
  cadenceSeconds?: number;
  template?: "sparkline" | "single-stat";
};

/**
 * Operator-supplied credentials for the optional pollers. NOTHING here has a
 * default path: a poller with no credential configured is simply skipped, so
 * the plugin never reads another application's credential store on its own
 * initiative. Credentials come from plugin config ONLY — the plugin does not
 * read them from environment variables.
 */
export type PollerCredentialConfig = {
  /** Optional GitHub token. Raises the anonymous rate limit and is REQUIRED for
   *  the traffic (views/clones) endpoints. Without it, github pollers run
   *  unauthenticated against public endpoints only. */
  githubToken?: string;
  /** Path to a JSON file containing `{ "api_key": "..." }` for the Moltbook
   *  pollers. */
  moltbookApiKeyFile?: string;
  /** Path to a file containing a YouTube Data API v3 key. */
  youtubeApiKeyFile?: string;
  /** Path to a Google service-account JSON granted Viewer on the GA4 property. */
  ga4ServiceAccountFile?: string;
};

/**
 * A calendar the sync can read, written "<provider>.<account>" — for example
 * `google.primary` or `outlook.work`. The account half is whatever name the
 * operator gives that calendar; the plugin JSON schema enforces the same form.
 */
export type CalendarSyncSource = `${"google" | "outlook"}.${string}`;

export type ControlPanelPluginConfig = {
  dataDir?: string;
  /** Create + migrate the task tables owned by tinkerclaw-task-panel. Default
   *  false. Only enable when running Pulse WITHOUT that sibling plugin. */
  manageTaskSchema?: boolean;
  /** Recurring background polling of the configured metric sources. */
  polling?: {
    enabled?: boolean;
    tickSeconds?: number;
  };
  credentials?: PollerCredentialConfig;
  /** Metrics to create on first boot. Empty by default. */
  seedMetrics?: SeedMetricConfig[];
  calendarSync?: {
    enabled?: boolean;
    cadenceSeconds?: number;
    sources?: Array<CalendarSyncSource>;
  };
  briefingImport?: boolean;
  execMode?: {
    leftPanelWidthPx?: number;
    splitGraphsPct?: number;
    splitCalendarPct?: number;
    defaultModeOnLaunch?: "dev" | "exec" | "last-used";
  };
};

export type ControlPanelResolvedConfig = {
  dataDir: string;
  dbPath: string;
  manageTaskSchema: boolean;
  polling: {
    enabled: boolean;
    tickSeconds: number;
  };
  credentials: PollerCredentialConfig;
  seedMetrics: SeedMetricConfig[];
  calendarSync: {
    enabled: boolean;
    cadenceSeconds: number;
    sources: Array<CalendarSyncSource>;
  };
  briefingImport: boolean;
  execMode: {
    leftPanelWidthPx: number;
    splitGraphsPct: number;
    splitCalendarPct: number;
    defaultModeOnLaunch: "dev" | "exec" | "last-used";
  };
};

export function resolveControlPanelConfig(
  cfg: ControlPanelPluginConfig,
): ControlPanelResolvedConfig {
  const dataDir = cfg.dataDir
    ? resolveUserPath(cfg.dataDir)
    : resolveUserPath("~/.openclaw/data/control-panel");
  return {
    dataDir,
    dbPath: path.join(dataDir, "store.db"),
    manageTaskSchema: cfg.manageTaskSchema ?? false,
    polling: {
      enabled: cfg.polling?.enabled ?? true,
      // Floor of 10s so a typo cannot turn the tick into a busy loop against
      // third-party APIs. The tick only polls metrics whose own cadence is due.
      tickSeconds: Math.max(10, cfg.polling?.tickSeconds ?? 60),
    },
    credentials: resolvePollerCredentials(cfg.credentials),
    seedMetrics: cfg.seedMetrics ?? [],
    calendarSync: {
      enabled: cfg.calendarSync?.enabled ?? true,
      cadenceSeconds: cfg.calendarSync?.cadenceSeconds ?? 1800,
      sources: cfg.calendarSync?.sources ?? ["google.primary"],
    },
    briefingImport: cfg.briefingImport ?? true,
    execMode: {
      leftPanelWidthPx: cfg.execMode?.leftPanelWidthPx ?? 360,
      splitGraphsPct: cfg.execMode?.splitGraphsPct ?? 40,
      splitCalendarPct: cfg.execMode?.splitCalendarPct ?? 10,
      defaultModeOnLaunch: cfg.execMode?.defaultModeOnLaunch ?? "dev",
    },
  };
}

/**
 * Take the credentials from plugin config and expand `~` in the file paths.
 * Config is the only source: no environment variable is consulted. Absent
 * stays absent — an unset credential disables its poller rather than falling
 * back to a well-known location in another application's config directory.
 */
export function resolvePollerCredentials(
  cfg: PollerCredentialConfig | undefined,
): PollerCredentialConfig {
  const file = (configured: string | undefined): string | undefined =>
    configured ? resolveUserPath(configured) : undefined;
  return {
    githubToken: cfg?.githubToken || undefined,
    moltbookApiKeyFile: file(cfg?.moltbookApiKeyFile),
    youtubeApiKeyFile: file(cfg?.youtubeApiKeyFile),
    ga4ServiceAccountFile: file(cfg?.ga4ServiceAccountFile),
  };
}
