/**
 * FORK: tinkerclaw-pulse-panel — plugin entry.
 *
 * The "real control panel with graphs" half of the former
 * tinkerclaw-control-panel monolith (split 2026-07-24): KPI pollers +
 * metric/observation RPCs behind the exec-mode Pulse tab. Installable on its
 * own — the task/cron panels are sibling plugins with their own manifests.
 *
 * Metrics live in the SAME SQLite file as the task panel
 * (`~/.openclaw/data/control-panel/store.db`, WAL) — both plugins run
 * in-process in the gateway, and the schema bootstrap is idempotent, so
 * whichever plugin boots first creates it.
 */
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerPulsePanelMethods } from "./src/gateway.js";
import { resolveControlPanelConfig, type ControlPanelPluginConfig } from "./src/paths.js";
import { startPollerSubsystem } from "./src/pollers/index.js";
import { getDb } from "./src/store/db.js";

export default definePluginEntry({
  id: "tinkerclaw-pulse-panel",
  name: "Pulse Panel",
  description:
    "FORK: exec-mode Pulse tab — KPI pollers (github/npm/ga4/moltbook/…) + metric graph RPCs. Split from tinkerclaw-control-panel.",
  register(api: OpenClawPluginApi) {
    const cfg = resolveControlPanelConfig((api.pluginConfig ?? {}) as ControlPanelPluginConfig);

    // Eagerly open the SQLite store so any schema-bootstrap error surfaces at
    // boot, not on the first RPC.
    getDb(cfg);

    registerPulsePanelMethods({ api, cfg });

    // KPI poller subsystem: seeds initial SNAPSHOT metrics on first boot,
    // then polls every metric whose cadence is due on a 60s tick.
    startPollerSubsystem(cfg, api.logger);

    api.logger.info(`tinkerclaw-pulse-panel: ready (dbPath=${cfg.dbPath})`);
  },
});
