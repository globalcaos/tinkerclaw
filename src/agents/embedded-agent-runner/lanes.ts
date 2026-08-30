import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations need a dedicated lane
  // to avoid deadlock without widening shared nested flows.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.CronNested;
  }
  // Default embedded session runs get the sessions lane so they never compete
  // with explicit main-lane system work; per-session ordering still comes from
  // the session lane.
  return cleaned ? cleaned : CommandLane.Sessions;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
