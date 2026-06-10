/**
 * FORK: tinkerclaw-orca — public API barrel.
 *
 * Re-exports the plugin SDK types the plugin uses, so the entry imports from
 * one path. Mirrors extensions/tinkerclaw-control-panel/api.ts.
 */
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/plugin-entry";
