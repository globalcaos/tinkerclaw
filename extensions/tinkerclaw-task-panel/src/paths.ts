/**
 * FORK: tinkerclaw-task-panel — config resolution.
 *
 * Resolves user-facing config (dataDir, calendarSync, briefingImport, execMode)
 * to absolute paths and concrete defaults that the rest of the plugin uses.
 */
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";

/**
 * A calendar the sync can read, written "<provider>.<account>" — for example
 * `google.primary` or `outlook.work`. The account half is whatever name the
 * operator gives that calendar; the plugin JSON schema enforces the same form.
 */
export type CalendarSyncSource = `${"google" | "outlook"}.${string}`;

export type ControlPanelPluginConfig = {
  dataDir?: string;
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
