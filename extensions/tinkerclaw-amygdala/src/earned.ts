/**
 * Progressive activation (2026-10-15). Switching all of Amygdala to enforce at once would block work, and the current
 * clutter is unwanted too, so rules activate progressively, with a model standing in for the owner's feedback.
 *
 * In shadow mode every flag is only a record. A rule (family + kind + reason code, drivers included) starts to ACT on its
 * own once the reviewer (Sonnet, `judge`) has judged enough of its flags over the last `days` and found them worth it:
 * at least `minReviews` reviews, a `minUseful` share useful, at most a `maxHarmful` share harmful. It stops again the
 * moment its numbers fall below the bar. Only kinds that steer the agent's own thinking can earn this: a note (a line in
 * its context) and a send-back (the reply goes back to be finished, at most twice a turn). Holds, proof checks and
 * questions to the owner never do: those stop the work and stay the owner's decision (`mode: "enforce"`).
 *
 * Why per reason code with its drivers: on 2026-10-15 `claim-unsupported[claim-record]` was judged useful 60% of the
 * time and `claim-unsupported[claim-support]` 11%; one bar for both would have switched on the bad one.
 */
import type { AmygdalaStore } from "./store.js";

export interface EarnedConfig {
  enabled: boolean;
  days: number;
  minReviews: number;
  minUseful: number;
  maxHarmful: number;
  /** Only reviews by a model whose id starts with this count (Grok and Haiku disagreed 19% vs 60% useful). */
  judge: string;
}

export const DEFAULT_EARNED: EarnedConfig = {
  enabled: true,
  days: 14,
  minReviews: 20,
  minUseful: 0.5,
  maxHarmful: 0.1,
  judge: "claude-code/claude-sonnet",
};

/** The kinds that may act on earned trust: they change what the agent thinks, never whether the owner can work. */
export const EARNED_KINDS: ReadonlySet<string> = new Set(["note", "send-back"]);

export interface EarnedRow {
  family: string;
  kind: string;
  reasonCode: string;
  n: number;
  useful: number;
  harmful: number;
}

export const earnedKey = (family: string, kind: string, reasonCode: string): string =>
  `${family}|${kind}|${reasonCode}`;

/** The rules that clear the bar. Pure, so the test and the status read the same rule. */
export function earnedSet(rows: readonly EarnedRow[], c: EarnedConfig): Set<string> {
  const out = new Set<string>();
  if (!c.enabled) return out;
  for (const r of rows) {
    if (!EARNED_KINDS.has(r.kind) || r.n < c.minReviews) continue;
    if (r.useful / r.n >= c.minUseful && r.harmful / r.n <= c.maxHarmful)
      out.add(earnedKey(r.family, r.kind, r.reasonCode));
  }
  return out;
}

export interface Earned {
  has(family: string, kind: string, reasonCode: string): boolean;
  /** Every reviewed rule of an earnable kind with its numbers and whether it acts, for the status. */
  report(): (EarnedRow & { acts: boolean })[];
}

/** Reads the store at most every `ttlMs`; a failed read leaves nothing earned until the next refresh. */
export function createEarned(
  store: AmygdalaStore,
  c: EarnedConfig,
  now: () => number = Date.now,
  ttlMs = 10 * 60_000,
): Earned {
  let at = -Infinity;
  let rows: EarnedRow[] = [];
  let set = new Set<string>();
  const refresh = (): void => {
    const t = now();
    if (t - at < ttlMs) return;
    at = t;
    try {
      rows = store.earnedStats(t - c.days * 86_400_000, c.judge);
      set = earnedSet(rows, c);
    } catch {
      set = new Set();
    }
  };
  return {
    has(family, kind, reasonCode) {
      if (!c.enabled || !EARNED_KINDS.has(kind)) return false;
      refresh();
      return set.has(earnedKey(family, kind, reasonCode));
    },
    report() {
      refresh();
      return rows
        .filter((r) => EARNED_KINDS.has(r.kind))
        .map((r) => ({ ...r, acts: set.has(earnedKey(r.family, r.kind, r.reasonCode)) }))
        .sort((a, b) => b.n - a.n);
    },
  };
}
