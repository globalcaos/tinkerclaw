/**
 * FORK: tinkerclaw-people — public API barrel.
 *
 * Re-exports the small subset of the OpenClaw plugin SDK we use, so the rest
 * of the plugin source can pin to one import path. Mirrors the convention in
 * extensions/memory-wiki/api.ts.
 */
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/plugin-entry";
