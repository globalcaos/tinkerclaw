/**
 * FORK: tinkerclaw-control-panel — public API barrel.
 *
 * Re-exports the plugin SDK types the rest of the plugin uses, so every src/
 * file imports from one path. Mirrors extensions/tinkerclaw-people/api.ts.
 */
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/plugin-entry";
