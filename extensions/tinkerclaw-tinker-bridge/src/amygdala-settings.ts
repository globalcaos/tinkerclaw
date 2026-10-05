// FORK 2026-09-29 (digital amygdala C5): picks the ONE claude-cli `--settings` file the bridge
// passes. Pure and tiny on purpose: it only stats, never reads, writes or merges. With the new
// plugin's files absent it reproduces the v3.1 behaviour exactly (v3.1 file iff it exists).

export interface SettingsPaths {
  v31: string;
  next: string;
  effective: string;
}

/** null = the file does not exist. */
export type StatFn = (p: string) => { mtimeMs: number } | null;

/** A stat that throws is treated as "does not exist"; no exception escapes. */
function safeStat(stat: StatFn, p: string): { mtimeMs: number } | null {
  try {
    return stat(p);
  } catch {
    return null;
  }
}

export function resolveAmygdalaSettings(paths: SettingsPaths, stat: StatFn): string | null {
  const v31 = safeStat(stat, paths.v31);
  const next = safeStat(stat, paths.next);
  if (!next) {
    return v31 ? paths.v31 : null;
  }
  const effective = safeStat(stat, paths.effective);
  const newest = Math.max(next.mtimeMs, v31 ? v31.mtimeMs : Number.NEGATIVE_INFINITY);
  if (effective && effective.mtimeMs >= newest) {
    return paths.effective;
  }
  // Stale or missing effective file: keep v3.1 enforcing until the plugin refreshes it.
  if (v31) {
    return paths.v31;
  }
  return paths.next;
}

/** The `--settings <file>` argv fragment, or [] when no file applies (no flag at all). */
export function amygdalaSettingsArgs(paths: SettingsPaths, stat: StatFn): string[] {
  const chosen = resolveAmygdalaSettings(paths, stat);
  return chosen ? ["--settings", chosen] : [];
}
