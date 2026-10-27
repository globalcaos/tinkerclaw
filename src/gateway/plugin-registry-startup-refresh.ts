/**
 * FORK 2026-10-15 (bug-log `stale-plugin-registry-rebuild-storm`): the persisted plugin registry
 * (`~/.openclaw/plugins/installs.json`) was last written 2026-09-23. Every plugin-config edit and every deploy since
 * left it stale, and only the CLI refreshes it, so each embedded run fell back to rebuilding the index from ~146
 * manifests on the gateway's one thread: 39% of the main thread in a 20 s profile, an event loop at 100% with 5 s
 * stalls, and every tab stuck in "preparing context". At start the gateway now refreshes a stale registry once, with
 * the build that is about to run, the same call `openclaw plugins registry --refresh` makes, and says why.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { inspectPluginRegistry, refreshPluginRegistry } from "../plugins/plugin-registry.js";

export type StartupPluginRegistryRefresh = "fresh" | "refreshed" | "failed";

export async function refreshStalePluginRegistryAtStartup(params: {
  config: OpenClawConfig;
  log: { info: (message: string) => void; warn: (message: string) => void };
  inspect?: typeof inspectPluginRegistry;
  refresh?: typeof refreshPluginRegistry;
}): Promise<StartupPluginRegistryRefresh> {
  const inspect = params.inspect ?? inspectPluginRegistry;
  const refresh = params.refresh ?? refreshPluginRegistry;
  try {
    const inspection = await inspect({ config: params.config });
    if (inspection.state === "fresh") {
      return "fresh";
    }
    const reasons = inspection.refreshReasons.join(", ") || inspection.state;
    const index = await refresh({ config: params.config, reason: "manual" });
    params.log.warn(
      `plugin registry was ${inspection.state} (${reasons}); refreshed at start, ${index.plugins.length} plugins indexed`,
    );
    return "refreshed";
  } catch (err) {
    // Never block the start on it: a stale registry costs speed, not correctness.
    params.log.warn(`plugin registry refresh at start failed: ${formatErrorMessage(err)}`);
    return "failed";
  }
}
