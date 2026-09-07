/**
 * FORK: tinkerclaw-cron-panel — plugin entry.
 *
 * NEW panel (2026-07-24, exec-panel split): read-only board over the cron
 * registry (`~/.openclaw/cron/jobs.json` + `jobs-state.json`) joined with the
 * per-run report files under `~/.openclaw/cron/reports/<date>/<job>.md`
 * (CRON_REPORT_CONTRACT.md Layer 1). Every registered job appears
 * automatically; a job that never reported shows as `silent` — the panel's
 * staleness/silence detector is the point of the feature.
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { resolveCronPanelConfig, type CronPanelPluginConfig } from "./src/cron-data.js";
import { registerCronPanelMethods } from "./src/gateway.js";

export default definePluginEntry({
  id: "tinkerclaw-cron-panel",
  name: "Cron Panel",
  description:
    "FORK: exec-mode Crons tab — read-only board of cron jobs joined with their delta reports (status/headline/silence).",
  register(api: OpenClawPluginApi) {
    const cfg = resolveCronPanelConfig((api.pluginConfig ?? {}) as CronPanelPluginConfig);
    registerCronPanelMethods({ api, cfg });
    api.logger.info(`tinkerclaw-cron-panel: ready (cronDir=${cfg.cronDir})`);
  },
});
