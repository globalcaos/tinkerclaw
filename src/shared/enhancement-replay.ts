// Replay of recorded recommendation turns: the pure half (Broca retrieval v2, phase A).
//
// WHAT THIS IS FOR. The ledger records, for every task, the list the agent was shown and the recipes, skills and
// plugins it actually opened. This module turns those rows into a measurement: split them by time, rank each held-out
// task with some retriever, and count how often the card the agent really used was inside the first 1, 3, 5 or 15.
// Retrievers are plugged in as functions, so today's two (the Thalamus list as served, and the Broca recipe matcher)
// and the new recall stage are scored by the same code on the same cases.
//
// WHAT IT DOES NOT CLAIM. A recorded use is a proxy for coverage, not proof the card was the right one: the agent may
// have opened a worse card, or the right card may never have been opened. So every figure carries its denominator,
// and the numbers are experimental targets to watch, never grounds to bend a score.
//
// HOW THE CASES ARE SPLIT. By time, never at random: earlier tasks train, later tasks test, so nothing learned from a
// held-out task can reach its own candidates. House rules (always loaded, rules not task choices) are removed from the
// task statistics and listed separately.
//
// WHAT WOULD CHANGE IT. A different definition of "used" in the ledger (today every entry's `how` is "unknown"), or a
// per-task record of why a list was local, would let the cases carry the reason instead of inferring it.

import { isHouseRule, isRuntimeNotice, taskText } from "./enhancement-text.js";

export type ReplayUse = { cardId: string; onList: boolean };

export type ReplayCase = {
  taskId: string;
  ts: number;
  session: string;
  /** "tinker", "cron", "subagent", "orchestrator", "channel:whatsapp" or "". */
  source: string;
  /** The prompt as the ledger kept it (redacted, bounded). It still carries the harness envelope. */
  text: string;
  /** Card ids of the list the agent was shown, best first. */
  shown: readonly string[];
  /** The probability the list gave each shown card, as recorded. Absent for a row that kept none. */
  shownProbs?: Readonly<Record<string, number>>;
  listSource: "jev" | "local";
  listReason: string;
  used: readonly ReplayUse[];
};

/** interactive = a person typed it; automated = a cron brief; runtime = a notice the gateway or an agent injected. */
export type CaseKind = "interactive" | "automated" | "runtime";

export function classifyCase(c: Pick<ReplayCase, "source" | "text">): CaseKind {
  const text = taskText(c.text);
  if (c.source === "subagent" || c.source === "orchestrator" || isRuntimeNotice(c.text)) {
    return "runtime";
  }
  if (c.source === "cron" || text.startsWith("[cron:")) return "automated";
  return "interactive";
}

/** The cards that count as task choices for a case: what was used, minus the house rules. */
export function taskUses(c: Pick<ReplayCase, "used">): string[] {
  return [...new Set(c.used.map((u) => u.cardId).filter((id) => !isHouseRule(id)))];
}

// ─── windows and the time split ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The cases of the last `days` days, counted back from the newest case (not from the clock, so a run is repeatable). */
export function lastDays(cases: readonly ReplayCase[], days: number): ReplayCase[] {
  if (cases.length === 0) return [];
  const newest = Math.max(...cases.map((c) => c.ts));
  return cases.filter((c) => c.ts > newest - days * DAY_MS).toSorted((a, b) => a.ts - b.ts);
}

export type Split = { train: ReplayCase[]; test: ReplayCase[]; cutoffTs: number };

/**
 * Earlier cases train, later cases test. The cutoff is the timestamp of the case that starts the newest
 * `testFraction` of the cases, so a bursty week still gets a test set of the intended size; every case at or after
 * the cutoff tests, every case before it trains, and the two never share a timestamp.
 */
export function splitByTime(cases: readonly ReplayCase[], testFraction = 0.3): Split {
  const sorted = cases.toSorted((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return { train: [], test: [], cutoffTs: 0 };
  const testCount = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * testFraction)));
  const cutoffTs = sorted[sorted.length - testCount].ts;
  return {
    train: sorted.filter((c) => c.ts < cutoffTs),
    test: sorted.filter((c) => c.ts >= cutoffTs),
    cutoffTs,
  };
}

/** Test cases whose cleaned request is word for word one the training half already had (a recurring brief). */
export function repeatsOfTrain(split: Split): Set<string> {
  const seen = new Set(split.train.map((c) => taskText(c.text).toLowerCase()));
  return new Set(
    split.test.filter((c) => seen.has(taskText(c.text).toLowerCase())).map((c) => c.taskId),
  );
}

// ─── scoring ────────────────────────────────────────────────────────────────────────────────────

/** Best first. May hold house rules and ids unknown to the catalog; scoring drops the first and keeps the second. */
export type Ranker = (c: ReplayCase) => readonly string[];

export type Scored = {
  /** Cases in the slice. */
  cases: number;
  /** Cases whose only uses were house rules (counted apart; never scored). */
  houseOnly: number;
  /** Cases with no use at all (counted apart; never scored). */
  zeroUse: number;
  /** Cases with at least one task use: the denominator of every hit rate. */
  scored: number;
  hit1: number;
  hit3: number;
  hit5: number;
  hit15: number;
  /** (case, card) pairs: how many task uses there were, and how many sat in the first 15. */
  pairs: number;
  pairs15: number;
};

export const emptyScored = (): Scored => ({
  cases: 0,
  houseOnly: 0,
  zeroUse: 0,
  scored: 0,
  hit1: 0,
  hit3: 0,
  hit5: 0,
  hit15: 0,
  pairs: 0,
  pairs15: 0,
});

/** `dropHouse` removes house rules from the ranking before positions are counted (the list as served keeps them). */
export function evaluate(
  cases: readonly ReplayCase[],
  rank: Ranker,
  o: { dropHouse?: boolean } = {},
): Scored {
  const s = emptyScored();
  for (const c of cases) {
    s.cases += 1;
    const relevant = new Set(taskUses(c));
    if (relevant.size === 0) {
      if (c.used.length === 0) s.zeroUse += 1;
      else s.houseOnly += 1;
      continue;
    }
    s.scored += 1;
    const ranked = (o.dropHouse ? rank(c).filter((id) => !isHouseRule(id)) : rank(c)).slice(0, 15);
    const firstHit = ranked.findIndex((id) => relevant.has(id));
    if (firstHit === 0) s.hit1 += 1;
    if (firstHit >= 0 && firstHit < 3) s.hit3 += 1;
    if (firstHit >= 0 && firstHit < 5) s.hit5 += 1;
    if (firstHit >= 0) s.hit15 += 1;
    s.pairs += relevant.size;
    s.pairs15 += [...relevant].filter((id) => ranked.includes(id)).length;
  }
  return s;
}

export function groupCases<T extends string>(
  cases: readonly ReplayCase[],
  key: (c: ReplayCase) => T,
): Map<T, ReplayCase[]> {
  const out = new Map<T, ReplayCase[]>();
  for (const c of cases) {
    const k = key(c);
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  return out;
}

/** A hit rate as text with its denominator, e.g. `12.5% (3/24)`. */
export function rate(hit: number, of: number): string {
  return of === 0 ? "n/a (0/0)" : `${((100 * hit) / of).toFixed(1)}% (${hit}/${of})`;
}

/** Every (case, card) pair a retriever missed in its first `k`, so the misses can be read, not just counted. */
export function misses(
  cases: readonly ReplayCase[],
  rank: Ranker,
  k = 15,
): Array<{ taskId: string; cardId: string; position: number | null }> {
  const out: Array<{ taskId: string; cardId: string; position: number | null }> = [];
  for (const c of cases) {
    const ranked = rank(c).filter((id) => !isHouseRule(id));
    for (const cardId of taskUses(c)) {
      const at = ranked.indexOf(cardId);
      if (at < 0 || at >= k) out.push({ taskId: c.taskId, cardId, position: at < 0 ? null : at });
    }
  }
  return out;
}

/** How much each house rule was used, and how often it was already on the list. Reported, not scored. */
export function houseRuleUse(
  cases: readonly ReplayCase[],
): Array<{ name: string; uses: number; onList: number }> {
  const by = new Map<string, { uses: number; onList: number }>();
  for (const c of cases) {
    for (const u of c.used) {
      if (!isHouseRule(u.cardId)) continue;
      const row = by.get(u.cardId) ?? { uses: 0, onList: 0 };
      row.uses += 1;
      if (u.onList) row.onList += 1;
      by.set(u.cardId, row);
    }
  }
  return [...by.entries()].map(([name, v]) => ({ name, ...v })).toSorted((a, b) => b.uses - a.uses);
}

// ─── rows to cases ──────────────────────────────────────────────────────────────────────────────

/** A ledger row as the database returns it: the two JSON columns still text. */
export type LedgerRow = {
  task_id: string;
  ts: number;
  session: string | null;
  source: string | null;
  text_redacted: string;
  shown_json: string | null;
  list_source: string | null;
  list_reason: string | null;
  used_json: string | null;
};

const parseJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function casesFromRows(rows: readonly LedgerRow[]): ReplayCase[] {
  return rows.map((r) => ({
    taskId: r.task_id,
    ts: r.ts,
    session: r.session ?? "",
    source: r.source ?? "",
    text: r.text_redacted,
    shown: parseJson<Array<{ cardId?: string }>>(r.shown_json, [])
      .map((e) => e.cardId)
      .filter((id): id is string => typeof id === "string"),
    shownProbs: Object.fromEntries(
      parseJson<Array<{ cardId?: string; prob?: number }>>(r.shown_json, [])
        .filter(
          (e): e is { cardId: string; prob: number } =>
            typeof e.cardId === "string" && typeof e.prob === "number" && Number.isFinite(e.prob),
        )
        .map((e) => [e.cardId, e.prob] as const),
    ),
    listSource: r.list_source === "jev" ? "jev" : "local",
    listReason: r.list_reason ?? "",
    used: parseJson<Array<{ cardId?: string; onList?: boolean }>>(r.used_json, [])
      .filter((u): u is { cardId: string; onList?: boolean } => typeof u.cardId === "string")
      .map((u) => ({ cardId: u.cardId, onList: u.onList === true })),
  }));
}

/** The query that joins the ledger to the replay text. The caller runs it on a read-only handle. */
export const LEDGER_SQL = `
  SELECT u.task_id, u.ts, u.session, u.source, r.text_redacted,
         u.shown_json, u.list_source, u.list_reason, u.used_json
  FROM enh_uses u JOIN enh_replay_set r ON r.task_id = u.task_id
  ORDER BY u.ts`;
