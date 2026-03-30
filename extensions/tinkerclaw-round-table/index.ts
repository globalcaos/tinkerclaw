import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "tinkerclaw-round-table",
  name: "Round Table",
  description:
    "SYNAPSE — Multi-model debate via RAAC protocol with cognitive diversity scoring.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    api.logger.info(
      `[round-table] initializing (depth=${cfg.defaultDepth ?? "standard"})`,
    );
    // Tool registration will be added in Task 2.3
  },
});
