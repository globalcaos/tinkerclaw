// THALAMUS v4 — the nightly card loop, its pure half (design doc 13A.6; paper J19 v4.1 sections 7.3 and 7.4).
//
// WHAT THIS IS FOR. Jev has no weights of ours; what Thalamus can change is the text Jev reads, the cards of the
// enhancements. The text is what learns. This file holds the arithmetic of that loop and nothing else: how much each pick
// counts, what the misses are, how a proposed edit is scored on past tasks, whether it may be kept, and what goes to a
// person instead. The runtime (`extensions/tinkerclaw-thalamus/src/card-loop.ts`) reads the ledger and calls a writer.
//
// HOW IT WAS DERIVED. Paper 7.3: an agent takes the first entry because it is first, so a loop that treats every pick as
// the truth rewards Jev for whatever it already put on top and the ranking freezes. Each pick is weighted by how surprising
// it is: if the agent takes the entry at rank r in a share pi(r) of all tasks whatever the list says, a pick at rank r
// counts 1/pi(r). The rates are measured on lists shown in a shuffled order, on overnight jobs only. Until a shuffle exists
// pi is a prior and the report says so. A pick that led to a retry is no evidence it fitted. The owner's correction is the
// strongest label: a pinned case no change may make worse. Paper 7.4: an edit is kept only when it raises the weighted mean
// reciprocal rank on held-out tasks and every pinned case keeps its rank or improves.
//
// WHAT WOULD CHANGE IT. `PI_PRIOR` is the design's starting guess; `PI_KAPPA` is how many shuffled tasks the prior counts
// for; `LOW_RANK` and `CONFIDENT` define a miss. The month test of paper section 10 (test 8) decides whether the loop
// helps or only learns to agree with itself.
//
// PURE. No clock, no I/O, no randomness: `rand` is an argument.

import type { EnhancementCard, Shortlist } from "./thalamus-enhancements.js";
import { fitCalibration, type CalibrationMap } from "./thalamus-enhancements.js";

/** Share of tasks in which an agent takes the entry at rank 1..6 whatever the list says. The design's starting guess. */
export const PI_PRIOR: readonly number[] = [0.7, 0.15, 0.08, 0.05, 0.02, 0.02];
/** How many shuffled tasks the prior counts for before measurements take over. */
export const PI_KAPPA = 20;
/** No rank is rarer than this, so no pick counts more than 100. */
export const PI_FLOOR = 0.01;
/** A used enhancement at this rank or later is a miss. */
export const LOW_RANK = 3;
/** A list whose top entry has at least this probability is confident. */
export const CONFIDENT = 0.5;
/** An edit adds or replaces at most this many characters: small edits only (paper 7.4). */
export const MAX_EDIT_CHARS = 240;
/** `alsoServed` keeps at most this many lines. */
export const MAX_ALSO_SERVED = 8;

export type UseLike = {
  taskId: string;
  shuffled: boolean;
  shown: ReadonlyArray<{ cardId: string; rank: number; prob: number }>;
  noneFits: number;
  used: ReadonlyArray<{ cardId: string; onList: boolean; rank?: number }>;
  outcome: "done" | "retried" | "corrected";
  taskKind?: string;
  private?: boolean;
};

export type Rates = {
  /** pi for rank 1..6. */
  pi: number[];
  /** Shuffled tasks the rates were measured on. */
  tasks: number;
  /** How many shuffled tasks took each rank (the counts behind `pi`). */
  picked: number[];
  /** `prior` until a shuffle exists; `measured` after, still shrunk toward the prior while tasks are few. */
  source: "prior" | "measured";
};

/**
 * The share of tasks in which the agent takes each rank, from the lists that were shown shuffled. `picked(r) / tasks`,
 * shrunk toward the prior by `PI_KAPPA` tasks so a handful of shuffles cannot swing a weight, and floored at `PI_FLOOR`.
 */
export function estimateRates(uses: readonly UseLike[], kappa: number = PI_KAPPA): Rates {
  const shuffled = uses.filter((u) => u.shuffled && u.shown.length > 0 && u.outcome !== "retried");
  const tasks = shuffled.length;
  const picked = PI_PRIOR.map(() => 0);
  for (const u of shuffled) {
    const ranks = new Set<number>();
    for (const x of u.used)
      if (x.onList && x.rank !== undefined && x.rank >= 1 && x.rank <= picked.length)
        ranks.add(x.rank);
    for (const r of ranks) picked[r - 1] += 1;
  }
  const pi = PI_PRIOR.map((p, i) => Math.max(PI_FLOOR, (kappa * p + picked[i]) / (kappa + tasks)));
  return { pi, picked, tasks, source: tasks === 0 ? "prior" : "measured" };
}

/** What a pick counts: 1/pi of its rank. A pick off the list (the agent found it alone) is as surprising as the rarest rank. */
export function weightOf(rank: number | undefined, pi: readonly number[]): number {
  const floor = Math.min(...pi, 1);
  const p = rank !== undefined && rank >= 1 && rank <= pi.length ? pi[rank - 1] : floor;
  return 1 / Math.max(PI_FLOOR, p);
}

export type Miss = {
  kind: "low-rank" | "absent" | "top-unused";
  taskId: string;
  /**
   * The card the edit is about. For `low-rank` and `absent` the used card that should have ranked higher; for `top-unused`
   * the top card that drew probability it did not earn.
   */
  cardId: string;
  weight: number;
};

/**
 * The misses in the ledger (13A.6 step 1). A task that ended `retried` gives none: a pick that led to a retry is no
 * evidence that it fitted. Private tasks never enter: their cards' text may not leave the machine (paper 7.4).
 */
export function missesFrom(uses: readonly UseLike[], rates: Rates): Miss[] {
  const out: Miss[] = [];
  for (const u of uses) {
    if (u.outcome === "retried" || u.private) continue;
    const top = [...u.shown].sort((a, b) => a.rank - b.rank)[0];
    for (const x of u.used) {
      const onList = x.onList && x.rank !== undefined;
      if (!onList)
        out.push({
          kind: "absent",
          taskId: u.taskId,
          cardId: x.cardId,
          weight: weightOf(undefined, rates.pi),
        });
      else if ((x.rank as number) >= LOW_RANK)
        out.push({
          kind: "low-rank",
          taskId: u.taskId,
          cardId: x.cardId,
          weight: weightOf(x.rank, rates.pi),
        });
    }
    if (top && top.prob >= CONFIDENT && !u.used.some((x) => x.cardId === top.cardId)) {
      out.push({ kind: "top-unused", taskId: u.taskId, cardId: top.cardId, weight: 1 });
    }
  }
  return out;
}

export type MissGroup = { kind: Miss["kind"]; cardId: string; taskIds: string[]; weight: number };

/** Misses about the same card in the same way, heaviest group first: one edit is proposed for each. */
export function groupMisses(misses: readonly Miss[]): MissGroup[] {
  const by = new Map<string, MissGroup>();
  for (const m of misses) {
    const k = `${m.kind}\u0000${m.cardId}`;
    const g = by.get(k) ?? { kind: m.kind, cardId: m.cardId, taskIds: [], weight: 0 };
    g.taskIds.push(m.taskId);
    g.weight += m.weight;
    by.set(k, g);
  }
  return [...by.values()].sort(
    (a, b) => b.weight - a.weight || `${a.kind}${a.cardId}`.localeCompare(`${b.kind}${b.cardId}`),
  );
}

export type ReplayTask = {
  taskId: string;
  /** Redacted text of a task from a source Jev may read. The only content this loop ever holds. */
  text: string;
  usedCardId: string;
  weight: number;
  /** The owner said this card fits this task. */
  pinned: boolean;
};

/** Ranks the cards for a task's text: the ids, best first. In production Jev reads it; tests and private tasks use word matching. */
export type Ranker = (text: string, cards: readonly EnhancementCard[]) => readonly string[];

const rankIn = (order: readonly string[], cardId: string): number | undefined => {
  const i = order.indexOf(cardId);
  return i < 0 ? undefined : i + 1;
};

/** The weighted mean reciprocal rank: `sum w / rank / sum w`. A used card the ranking does not list counts zero. */
export function wmrr(
  tasks: readonly ReplayTask[],
  rankOf: (t: ReplayTask) => number | undefined,
): number {
  let num = 0;
  let den = 0;
  for (const t of tasks) {
    const r = rankOf(t);
    den += t.weight;
    if (r !== undefined) num += t.weight / r;
  }
  return den === 0 ? 0 : num / den;
}

export type EditVerdict = {
  keep: boolean;
  before: number;
  after: number;
  n: number;
  /** Pinned tasks whose used card ranks lower than before. */
  pinnedLost: string[];
  why: "kept" | "no-gain" | "pinned-case-lost" | "empty-replay-set";
};

/**
 * Replay a held-out set with the old cards and the new (paper 7.4 step 3): keep the edit only when the weighted mean
 * reciprocal rank rises and every pinned case keeps its rank or improves. A pinned case is checked on its own, not averaged
 * away: one lost pin refuses the edit whatever else it gained.
 */
export function evaluateEdit(p: {
  tasks: readonly ReplayTask[];
  before: readonly EnhancementCard[];
  after: readonly EnhancementCard[];
  rank: Ranker;
}): EditVerdict {
  const n = p.tasks.length;
  if (n === 0)
    return { keep: false, before: 0, after: 0, n, pinnedLost: [], why: "empty-replay-set" };
  const b = new Map<string, number | undefined>();
  const a = new Map<string, number | undefined>();
  for (const t of p.tasks) {
    b.set(t.taskId, rankIn(p.rank(t.text, p.before), t.usedCardId));
    a.set(t.taskId, rankIn(p.rank(t.text, p.after), t.usedCardId));
  }
  const before = wmrr(p.tasks, (t) => b.get(t.taskId));
  const after = wmrr(p.tasks, (t) => a.get(t.taskId));
  const pinnedLost = p.tasks
    .filter((t) => t.pinned)
    .filter(
      (t) =>
        (a.get(t.taskId) ?? Number.POSITIVE_INFINITY) >
        (b.get(t.taskId) ?? Number.POSITIVE_INFINITY),
    )
    .map((t) => t.taskId);
  if (pinnedLost.length > 0)
    return { keep: false, before, after, n, pinnedLost, why: "pinned-case-lost" };
  if (!(after > before + 1e-12))
    return { keep: false, before, after, n, pinnedLost, why: "no-gain" };
  return { keep: true, before, after, n, pinnedLost, why: "kept" };
}

export type CardEdit = {
  cardId: string;
  /** A line for `alsoServed`, a sharper `structure`, or a narrower `purpose` (13A.6 step 3). */
  kind: "also-served" | "structure" | "purpose";
  text: string;
};

const clean = (t: string): string => t.replace(/\s+/g, " ").trim();

/**
 * The card after a small edit, as the next version, or undefined when the edit is empty, too long, about another card,
 * or changes nothing. The old version is never touched: every version is kept by the store.
 */
export function applyEdit(card: EnhancementCard, edit: CardEdit): EnhancementCard | undefined {
  if (edit.cardId !== card.id) return undefined;
  const text = clean(edit.text);
  if (text.length === 0 || text.length > MAX_EDIT_CHARS) return undefined;
  let next: EnhancementCard;
  if (edit.kind === "also-served") {
    if (card.alsoServed.includes(text)) return undefined;
    next = { ...card, alsoServed: [...card.alsoServed, text].slice(-MAX_ALSO_SERVED) };
  } else if (edit.kind === "structure") {
    if (card.structure === text) return undefined;
    next = { ...card, structure: text };
  } else {
    if (card.purpose === text) return undefined;
    next = { ...card, purpose: text };
  }
  return { ...next, version: card.version + 1, origin: "nightly" };
}

/**
 * (probability, was it used) for every entry that was shown, to refit the calibration map. Shuffled lists first: where
 * the agent takes rank 1 because it is first, raw hit rates at the top are inflated. With fewer than `minShuffled` shuffled
 * tasks all tasks are used and the caller should say so.
 */
export function calibrationPairs(
  uses: readonly UseLike[],
  minShuffled = 50,
): { pairs: Array<{ p: number; hit: boolean }>; fromShuffled: boolean } {
  const ok = uses.filter((u) => u.outcome !== "retried" && u.shown.length > 0);
  const shuffled = ok.filter((u) => u.shuffled);
  const fromShuffled = shuffled.length >= minShuffled;
  const pick = fromShuffled ? shuffled : ok;
  const pairs: Array<{ p: number; hit: boolean }> = [];
  for (const u of pick)
    for (const s of u.shown)
      pairs.push({ p: s.prob, hit: u.used.some((x) => x.cardId === s.cardId) });
  return { pairs, fromShuffled };
}

export const fitCalibrationFrom = (
  uses: readonly UseLike[],
  minShuffled = 50,
): {
  map: CalibrationMap;
  fromShuffled: boolean;
  n: number;
} => {
  const { pairs, fromShuffled } = calibrationPairs(uses, minShuffled);
  return { map: fitCalibration(pairs), fromShuffled, n: pairs.length };
};

export type PersonProposal = {
  kind: "merge" | "new";
  /** A stable key so the same proposal is one row however many nights it is seen. */
  key: string;
  payload: Record<string, unknown>;
};

/** Times a pattern must repeat before it becomes a proposal. */
export const PROPOSAL_AFTER = 3;

/**
 * Proposals for people, never created by the loop (13A.6 step 6): the same ordered pair used together for one kind of task
 * three times (a merge, or a new procedure) and a kind of task done three times by hand while nothing on the list fit (a new
 * enhancement). Only finished tasks count, and never private ones.
 */
export function proposalsFrom(uses: readonly UseLike[]): PersonProposal[] {
  const pairs = new Map<string, { kind: string; first: string; second: string; n: number }>();
  const byHand = new Map<string, number>();
  for (const u of uses) {
    if (u.outcome !== "done" || u.private || !u.taskKind || u.taskKind === "general") continue;
    const ids = u.used.map((x) => x.cardId);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (ids[i] === ids[j]) continue;
        const k = `${u.taskKind}\u0000${ids[i]}\u0000${ids[j]}`;
        const e = pairs.get(k) ?? { kind: u.taskKind, first: ids[i], second: ids[j], n: 0 };
        e.n += 1;
        pairs.set(k, e);
      }
    }
    if (ids.length === 0 && u.noneFits >= 0.5)
      byHand.set(u.taskKind, (byHand.get(u.taskKind) ?? 0) + 1);
  }
  const out: PersonProposal[] = [];
  for (const e of pairs.values()) {
    if (e.n >= PROPOSAL_AFTER)
      out.push({
        kind: "merge",
        key: `merge:${e.kind}:${e.first}>${e.second}`,
        payload: { taskKind: e.kind, first: e.first, second: e.second, times: e.n },
      });
  }
  for (const [kind, n] of byHand) {
    if (n >= PROPOSAL_AFTER)
      out.push({ kind: "new", key: `new:${kind}`, payload: { taskKind: kind, times: n } });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Show this list in a shuffled order? Only on overnight jobs, only for lists of at least two, never private, and only on a small draw. */
export function shouldShuffle(p: {
  enabled: boolean;
  overnight: boolean;
  private: boolean;
  entries: number;
  rand: number;
  /** Share of eligible lists shuffled. */
  rate?: number;
}): boolean {
  if (!p.enabled || !p.overnight || p.private || p.entries < 2) return false;
  return p.rand < (p.rate ?? 0.2);
}

/**
 * The same list in another order: entries permuted (Fisher-Yates, `rand` called once per swap), ranks renumbered from 1,
 * each entry keeping its probability. The list Jev produced is untouched; this is a copy for the agent and the ledger.
 */
export function shuffleList(list: Shortlist, rand: () => number): Shortlist {
  const entries = list.entries.map((e) => ({ ...e }));
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return { ...list, entries: entries.map((e, i) => ({ ...e, rank: i + 1 })) };
}
