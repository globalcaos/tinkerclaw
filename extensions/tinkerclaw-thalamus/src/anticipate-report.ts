// The anticipation report (2026-10-25): does a pointer on the desk save rounds?
//
// WHAT THIS IS FOR. The post's claim is that with a few pointers on the desk the agent "starts the first round already
// knowing where to look, and often answers in it". This reads the ledger rows (`enh_uses`) and splits the owner's tasks
// three ways: no pointer found, pointers found but only watched (`anticipate.mode` watch, or the agent was not shown
// them), and pointers shown. For each group: how many tasks, their rounds (model calls), the share answered in one
// round, and how often the agent opened a pointed note or chat and in which round. A watched pointer opened in round 3
// is two rounds the pointer would have saved; a shown pointer opened in round 1 is the claim working.
//
// PURE. Rows in, numbers out. `thalamus.anticipate.report` is its gateway method.

import type { UseRow } from "./store.js";

export type AnticipateGroup = {
  tasks: number;
  /** Tasks whose model calls were counted. */
  withRounds: number;
  meanRounds?: number;
  /** Share of the counted tasks answered in a single round. */
  oneRound?: number;
  /** Tasks where the agent opened at least one pointed note or chat. */
  pointerOpened: number;
  /** The mean round of the first opening, over those tasks. */
  meanOpenRound?: number;
  /** Rounds spent before the opening, summed over the watched tasks: what showing the pointer could have saved. */
  roundsBeforeOpen: number;
};

export type AnticipateReport = {
  sinceTs: number;
  tasks: number;
  none: AnticipateGroup;
  watched: AnticipateGroup;
  shown: AnticipateGroup;
  /** Why no pointer was looked for, by count. */
  skips: Record<string, number>;
  /** Pointers found, by kind. */
  found: { note: number; chat: number };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function group(rows: readonly UseRow[]): AnticipateGroup {
  const counted = rows.filter((r) => typeof r.rounds === "number" && r.rounds > 0);
  const opened = rows
    .map((r) =>
      Math.min(
        ...(r.pointers ?? []).flatMap((p) => (p.usedRound === undefined ? [] : [p.usedRound])),
      ),
    )
    .filter((n) => Number.isFinite(n));
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    tasks: rows.length,
    withRounds: counted.length,
    ...(counted.length
      ? {
          meanRounds: round2(sum(counted.map((r) => r.rounds as number)) / counted.length),
          oneRound: round2(counted.filter((r) => r.rounds === 1).length / counted.length),
        }
      : {}),
    pointerOpened: opened.length,
    ...(opened.length ? { meanOpenRound: round2(sum(opened) / opened.length) } : {}),
    roundsBeforeOpen: sum(opened.map((n) => n - 1)),
  };
}

export function anticipateReport(rows: readonly UseRow[], sinceTs: number): AnticipateReport {
  const mine = rows.filter((r) => r.ts >= sinceTs);
  const skips: Record<string, number> = {};
  const found = { note: 0, chat: 0 };
  const none: UseRow[] = [];
  const watched: UseRow[] = [];
  const shown: UseRow[] = [];
  for (const r of mine) {
    if (r.pointerSkip) {
      skips[r.pointerSkip] = (skips[r.pointerSkip] ?? 0) + 1;
    }
    const ps = r.pointers ?? [];
    for (const p of ps) {
      found[p.kind] += 1;
    }
    if (ps.length === 0) {
      none.push(r);
    } else if (ps.some((p) => p.injected)) {
      shown.push(r);
    } else {
      watched.push(r);
    }
  }
  return {
    sinceTs,
    tasks: mine.length,
    none: group(none),
    watched: group(watched),
    shown: group(shown),
    skips,
    found,
  };
}
