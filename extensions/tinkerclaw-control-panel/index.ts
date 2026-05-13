/**
 * FORK: tinkerclaw-control-panel — plugin entry.
 *
 * Wires the native Control Panel — Exec-mode HUD with graphs + calendar strip +
 * live task board (SPEC v3.1). This entry resolves config and registers the
 * gateway methods that the UI and the LLM call. UI surfaces (Dev/Exec toggle,
 * left panel) ship in a subsequent phase.
 *
 * On-disk state lives at `~/.openclaw/data/control-panel/store.db` — a single
 * better-sqlite3 file holding metrics, tasks, briefing-pass tracking, and the
 * calendar event cache. Plugin is fully in-process; no Docker, no Grafana, no
 * external service.
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerControlPanelMethods } from "./src/gateway.js";
import { resolveControlPanelConfig, type ControlPanelPluginConfig } from "./src/paths.js";
import { startPollerSubsystem } from "./src/pollers/index.js";
import { getDb } from "./src/store/db.js";

export default definePluginEntry({
  id: "tinkerclaw-control-panel",
  name: "Control Panel",
  description:
    "FORK: native Control Panel — Exec-mode HUD (graphs + calendar + tasks) + inline ctrl-panel fence-block. Replaces Todoist. Spec: docs/SPEC.md (v3.1).",
  register(api: OpenClawPluginApi) {
    const cfg = resolveControlPanelConfig((api.pluginConfig ?? {}) as ControlPanelPluginConfig);

    // Eagerly open the SQLite store so any schema-bootstrap error surfaces at
    // boot, not on the first RPC.
    getDb(cfg);

    registerControlPanelMethods({ api, cfg });

    // FORK 2026-05-13 — KPI poller subsystem. Seeds initial SNAPSHOT metrics
    // (github stars/forks/issues for tinkerclaw) on first boot, then polls
    // every metric whose cadence is due on a 60s tick. Lets the Graphs tab
    // render gauges as sparklines instead of static one-shot numbers.
    startPollerSubsystem(cfg, api.logger);

    api.logger.info(
      `tinkerclaw-control-panel: ready (dbPath=${cfg.dbPath}, briefingImport=${cfg.briefingImport}, calendarSync=${cfg.calendarSync.enabled})`,
    );
  },
});
