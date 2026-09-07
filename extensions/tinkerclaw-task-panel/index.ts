/**
 * FORK: tinkerclaw-task-panel — plugin entry.
 *
 * The task-manager half of the former tinkerclaw-control-panel monolith
 * (split 2026-07-24): SQLite task board + axes + est-presets + calendar
 * cache behind the exec-mode Today tab. Installable on its own — the
 * pulse/cron panels are sibling plugins with their own manifests.
 *
 * On-disk state stays at `~/.openclaw/data/control-panel/store.db` — the
 * SAME file the old plugin used (live task data; never moved/renamed). The
 * pulse panel opens the same WAL file for its metrics tables; both run
 * in-process in the gateway and the schema bootstrap is idempotent.
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerTaskPanelMethods } from "./src/gateway.js";
import { resolveControlPanelConfig, type ControlPanelPluginConfig } from "./src/paths.js";
import { getDb } from "./src/store/db.js";

export default definePluginEntry({
  id: "tinkerclaw-task-panel",
  name: "Task Panel",
  description:
    "FORK: exec-mode Today tab — live task board + axes + est-presets + calendar cache. Split from tinkerclaw-control-panel. Replaces Todoist.",
  register(api: OpenClawPluginApi) {
    const cfg = resolveControlPanelConfig((api.pluginConfig ?? {}) as ControlPanelPluginConfig);

    // Eagerly open the SQLite store so any schema-bootstrap error surfaces at
    // boot, not on the first RPC.
    getDb(cfg);

    registerTaskPanelMethods({ api, cfg });

    api.logger.info(
      `tinkerclaw-task-panel: ready (dbPath=${cfg.dbPath}, briefingImport=${cfg.briefingImport}, calendarSync=${cfg.calendarSync.enabled})`,
    );
  },
});
