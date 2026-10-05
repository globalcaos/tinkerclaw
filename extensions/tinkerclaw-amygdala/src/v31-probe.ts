/**
 * Digital amygdala v2 - is v3.1 already enforcing the floor?
 *
 * The floor (hard rules in the PreToolUse hook) must run exactly once. v3.1 enforces it when its
 * plugin is on, out of observe-only, hook enforcement is on and its hook settings file exists.
 * The plugin-config accessor is injected by the caller; nothing here touches the gateway.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface V31ProbeInput {
  pluginConfig: { enabled?: boolean; observeOnly?: boolean; hookEnforcement?: boolean } | undefined;
  settingsFileExists: boolean;
}

export function v31Enforcing(i: V31ProbeInput): boolean {
  const c = i.pluginConfig;
  if (!c) return false;
  return (
    c.enabled !== false &&
    c.observeOnly === false &&
    c.hookEnforcement === true &&
    i.settingsFileExists
  );
}

export function probeV31(o: {
  readPluginConfig: () => V31ProbeInput["pluginConfig"];
  settingsPath?: string;
  exists?: (p: string) => boolean;
}): boolean {
  const settingsPath =
    o.settingsPath ?? join(homedir(), ".openclaw", "data", "amygdala", "cc-hook-settings.json");
  const exists = o.exists ?? existsSync;
  try {
    return v31Enforcing({
      pluginConfig: o.readPluginConfig(),
      settingsFileExists: exists(settingsPath),
    });
  } catch {
    return false;
  }
}
