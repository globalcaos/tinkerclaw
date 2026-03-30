/**
 * FORK: Identity Persistence (CORTEX) extension entry point.
 *
 * Provides persona injection from SOUL.md, EWMA SyncScore drift detection,
 * mid-context identity reinforcement, and observation extraction. Hooks will
 * be wired in Task 3.3; this file is the scaffold only.
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "tinkerclaw-identity-persistence",
  name: "Identity Persistence",
  description:
    "CORTEX -- Persona injection from SOUL.md, EWMA SyncScore drift detection, " +
    "mid-context identity reinforcement, and observation extraction.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const threshold = (cfg.syncScoreThreshold as number) ?? 0.6;

    api.logger.info(`[identity-persistence] initializing (threshold=${threshold})`);
    // Hooks will be added in Task 3.3
  },
});
