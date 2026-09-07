/**
 * FORK: tinkerclaw-control-panel — DEPRECATED shell (2026-07-24).
 *
 * The monolith was split into three independently installable panels:
 *   - extensions/tinkerclaw-pulse-panel  — KPI pollers + metric graphs
 *     (pulsepanel.* RPCs; also serves the legacy control-panel.{list,
 *     add-metric,record,query,metrics.poll} names)
 *   - extensions/tinkerclaw-task-panel   — task board + axes + est-presets +
 *     calendar cache (taskpanel.* RPCs; also serves the legacy
 *     control-panel.{tasks,calendar,axes,est-presets}.* names). Keeps the
 *     live SQLite at ~/.openclaw/data/control-panel/store.db.
 *   - extensions/tinkerclaw-cron-panel   — NEW read-only cron board
 *     (cronpanel.* RPCs over ~/.openclaw/cron/ registry + reports)
 *
 * This entry registers NOTHING — it exists only so an allowlist entry naming
 * "tinkerclaw-control-panel" keeps loading cleanly on gateways that still
 * carry it. Remove the allowlist entry at leisure; docs/SPEC.md retains the
 * historical design.
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

export default definePluginEntry({
  id: "tinkerclaw-control-panel",
  name: "Control Panel (deprecated)",
  description:
    "DEPRECATED shell — split into tinkerclaw-pulse-panel / tinkerclaw-task-panel / tinkerclaw-cron-panel on 2026-07-24. Registers nothing.",
  register(api: OpenClawPluginApi) {
    api.logger.info(
      "tinkerclaw-control-panel: deprecated shell — functionality moved to tinkerclaw-{pulse,task,cron}-panel; nothing registered.",
    );
  },
});
