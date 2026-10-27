/**
 * FORK 2026-10-25 — a background Fractal reflection proposes sends, deletes, publishes, spends and restarts.
 *
 * The page sends each reflection into a session of its own, `agent:<id>:fractal:<P>` (tinker-ui fractal-turn.ts), and
 * this bridge starts its worker as a fork of the chat (fork-parent.ts) with every tool. Its doctrine says a send, a
 * delete, a publish, a spend or a restart comes back as the exact command for the owner, never as the action; this
 * module is the switch that makes the tinkerclaw-core plugin's PreToolUse hook enforce it
 * (claude-plugins/tinkerclaw-core/scripts/fractal-guard.mjs). Only such a worker gets the variables; every other
 * worker's environment is unchanged.
 *
 * Config: `plugins.entries.tinkerclaw-tinker-bridge.config.fractalGuard` = "enforce" (default) | "watch" | "off".
 * "watch" lets every call run and only logs what would have been denied (<state dir>/data/fractal/guard.jsonl).
 */

export const FRACTAL_GUARD_MODES = ["enforce", "watch", "off"] as const;
export type FractalGuardMode = (typeof FRACTAL_GUARD_MODES)[number];
export const DEFAULT_FRACTAL_GUARD_MODE: FractalGuardMode = "enforce";

/** The configured mode; anything that is not one of FRACTAL_GUARD_MODES reads as the default. */
export function resolveFractalGuardMode(raw: unknown): FractalGuardMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (FRACTAL_GUARD_MODES as readonly string[]).includes(v)
    ? (v as FractalGuardMode)
    : DEFAULT_FRACTAL_GUARD_MODE;
}

/** `agent:<id>:fractal:<P>`, the session a background Fractal runs in (the same test as tinker-ui's). */
export function isBackgroundFractalSession(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  const at = sessionKey.indexOf(":fractal:");
  const run = at < 0 ? "" : sessionKey.slice(at + ":fractal:".length);
  return at > 0 && run !== "" && !run.includes(":");
}

/**
 * The variables a worker for `sessionKey` gets: the mode and when it started (a file born after that is the
 * reflection's own, which it may delete), or none when the session is not a background Fractal or the guard is off.
 */
export function fractalGuardEnv(
  sessionKey: string | undefined,
  mode: FractalGuardMode | undefined,
  now: number,
): Record<string, string> {
  const m = mode ?? DEFAULT_FRACTAL_GUARD_MODE;
  if (m === "off" || !isBackgroundFractalSession(sessionKey)) {
    return {};
  }
  return { TC_FRACTAL_GUARD: m, TC_FRACTAL_GUARD_SINCE: String(now) };
}
