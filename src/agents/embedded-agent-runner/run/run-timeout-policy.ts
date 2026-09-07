export type RunTimeoutDeadlineResolution =
  | { action: "extend"; extendMs: number }
  | { action: "abort" };

/**
 * Decides what to do when the run wall-clock deadline fires.
 *
 * Sliding-window semantics: if the agent produced a real event (stream token or
 * tool activity) within `activityGraceMs` of the deadline, the run is still
 * actively working and the deadline extends instead of aborting — bounded by
 * `hardCapMs` measured from run start. `activityGraceMs <= 0` disables the
 * sliding window entirely (legacy fixed wall-clock abort).
 */
export function resolveRunTimeoutOnDeadline(params: {
  nowMs: number;
  lastActivityAtMs: number;
  activityGraceMs: number;
  runStartedAtMs: number;
  hardCapMs: number;
}): RunTimeoutDeadlineResolution {
  const { nowMs, lastActivityAtMs, activityGraceMs, runStartedAtMs, hardCapMs } = params;
  if (activityGraceMs <= 0) {
    return { action: "abort" };
  }
  const silenceMs = nowMs - lastActivityAtMs;
  if (silenceMs >= activityGraceMs) {
    return { action: "abort" };
  }
  const elapsedMs = nowMs - runStartedAtMs;
  if (elapsedMs >= hardCapMs) {
    return { action: "abort" };
  }
  const extendMs = Math.min(activityGraceMs - silenceMs, hardCapMs - elapsedMs);
  if (extendMs <= 0) {
    return { action: "abort" };
  }
  return { action: "extend", extendMs };
}
