// THALAMUS v4 — the nightly card loop, its runtime half (design doc 13A.6; paper J19 v4.1 section 7.4).
//
// WHAT THIS IS FOR. Reads the use ledger, measures how much the agent follows position, finds the misses, asks a writer for
// one small edit per group of similar misses, replays each edit on held-out tasks, and keeps only what the pure rules allow:
// the weighted mean reciprocal rank must rise and every pinned case must keep its rank or improve. It refits the
// calibration map and writes proposals for people. The arithmetic is in `src/shared/thalamus-card-loop.ts`; this file is
// the plumbing around it.
//
// A DRY RUN WRITES NOTHING. It returns the same report a real run would, so the owner can read what a night would do.
//
// PRIVACY (paper 7.4, last paragraph). Replay sends task text to a model, so only tasks from sources approved for Jev enter
// the replay set, redacted, and private tasks never do; the writer sees those redacted texts and nothing else. A task with
// no replay text cannot be replayed: a pin on such a task is counted in the report, not silently dropped.
//
// THE WRITER IS INJECTED and its proposal is a routed call in production; tests use a mock. NO WRITER, NO EDITS: the rest of
// the run (rates, calibration, proposals) still happens.
//
// WHAT THIS DOES NOT DO. It never creates, merges or retires an enhancement: merge and new-enhancement ideas are rows in
// `enh_proposals` for a person. Jev is not called here; the default ranker is local word matching, and a Jev-backed ranker
// is an argument.

import {
  applyEdit,
  estimateRates,
  evaluateEdit,
  fitCalibrationFrom,
  groupMisses,
  localRank,
  missesFrom,
  proposalsFrom,
  weightOf,
  type CardEdit,
  type EnhancementCard,
  type MissGroup,
  type Ranker,
  type ReplayTask,
  type UseLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusStore, UseRow } from "./store.js";

/** The groups worth an edit in one night: the heaviest few. */
export const MAX_GROUPS_PER_NIGHT = 5;
/** How far back the ledger is read. */
export const LOOKBACK_DAYS = 90;

export type CardWriter = {
  /** One small edit for a group of similar misses, or none. `examples` are redacted texts from approved sources. */
  propose(input: {
    card: EnhancementCard;
    group: MissGroup;
    examples: string[];
  }): Promise<CardEdit[]>;
};

export type Attempt = {
  cardId: string;
  groupKind: MissGroup["kind"];
  edit: CardEdit["kind"];
  kept: boolean;
  why: string;
  before: number;
  after: number;
  n: number;
  newVersion?: number;
};

export type CardLoopReport = {
  dry: boolean;
  uses: number;
  rates: { source: "prior" | "measured"; tasks: number; pi: number[] };
  misses: number;
  groups: number;
  replaySet: number;
  pinnedReplayable: number;
  pinsWithoutText: number;
  attempts: Attempt[];
  kept: number;
  calibration: { points: number; n: number; fromShuffled: boolean };
  proposals: { found: number; added: number };
  writer: "used" | "none";
};

export type CardLoopDeps = {
  store: () => ThalamusStore | undefined;
  now: () => number;
  writer?: CardWriter;
  /** The ranker replay uses. Default: local word matching (what private tasks get), so a run needs no outside call. */
  rank?: Ranker;
  onError?: (err: unknown) => void;
};

const defaultRank: Ranker = (text, cards) => localRank(text, cards).map((r) => r.cardId);

const asLike = (u: UseRow): UseLike => ({
  taskId: u.taskId,
  shuffled: u.shuffled,
  shown: u.shown.map((s) => ({ cardId: s.cardId, rank: s.rank, prob: s.prob })),
  noneFits: u.noneFits,
  used: u.used.map((x) => ({
    cardId: x.cardId,
    onList: x.onList,
    ...(x.rank !== undefined ? { rank: x.rank } : {}),
  })),
  outcome: u.outcome,
  ...(u.taskKind ? { taskKind: u.taskKind } : {}),
  private: u.private,
});

export function createCardLoop(d: CardLoopDeps) {
  const rank = d.rank ?? defaultRank;

  async function run(o: { dry: boolean }): Promise<CardLoopReport | undefined> {
    const store = d.store();
    if (!store) return undefined;
    const now = d.now();
    const since = now - LOOKBACK_DAYS * 86_400_000;
    const rows = store.listUses({ sinceTs: since });
    const uses = rows.map(asLike);
    const rates = estimateRates(uses);
    const misses = missesFrom(uses, rates);
    const groups = groupMisses(misses);

    // The held-out set: tasks whose redacted text is on file (approved sources only), with the card the agent used.
    const useById = new Map(rows.map((u) => [u.taskId, u]));
    const pins = store.listPins();
    const pinnedTasks = new Set(pins.map((p) => `${p.taskId}\u0000${p.cardId}`));
    const replay: ReplayTask[] = [];
    for (const t of store.listReplayTexts({ sinceTs: since, limit: 500 })) {
      const u = useById.get(t.taskId);
      if (!u || u.private || u.outcome === "retried") continue;
      for (const x of u.used) {
        replay.push({
          taskId: t.taskId,
          text: t.text,
          usedCardId: x.cardId,
          weight: weightOf(x.onList ? x.rank : undefined, rates.pi),
          pinned: pinnedTasks.has(`${t.taskId}\u0000${x.cardId}`),
        });
      }
    }
    // An owner's pin names its card outright, even when the use row does not list it.
    const haveText = new Map(
      store.listReplayTexts({ sinceTs: 0, limit: 5000 }).map((t) => [t.taskId, t.text]),
    );
    let pinsWithoutText = 0;
    for (const p of pins) {
      const text = haveText.get(p.taskId);
      if (text === undefined) {
        pinsWithoutText += 1;
        continue;
      }
      if (!replay.some((r) => r.taskId === p.taskId && r.usedCardId === p.cardId)) {
        replay.push({
          taskId: p.taskId,
          text,
          usedCardId: p.cardId,
          weight: weightOf(undefined, rates.pi),
          pinned: true,
        });
      }
    }

    let cards = store.activeCards();
    const attempts: Attempt[] = [];
    let kept = 0;
    if (d.writer) {
      for (const group of groups.slice(0, MAX_GROUPS_PER_NIGHT)) {
        const card = cards.find((c) => c.id === group.cardId);
        if (!card) continue;
        const examples = group.taskIds
          .map((id) => haveText.get(id))
          .filter((x): x is string => typeof x === "string")
          .slice(0, 5);
        let edits: CardEdit[] = [];
        try {
          edits = (await d.writer.propose({ card, group, examples })).slice(0, 1);
        } catch (err) {
          d.onError?.(err);
        }
        for (const edit of edits) {
          const next = applyEdit(card, edit);
          if (!next) {
            attempts.push({
              cardId: card.id,
              groupKind: group.kind,
              edit: edit.kind,
              kept: false,
              why: "invalid-edit",
              before: 0,
              after: 0,
              n: 0,
            });
            continue;
          }
          const after = cards.map((c) => (c.id === card.id ? next : c));
          const v = evaluateEdit({ tasks: replay, before: cards, after, rank });
          const attempt: Attempt = {
            cardId: card.id,
            groupKind: group.kind,
            edit: edit.kind,
            kept: v.keep,
            why: v.why,
            before: v.before,
            after: v.after,
            n: v.n,
          };
          if (v.keep) {
            attempt.newVersion = next.version;
            kept += 1;
            if (!o.dry)
              store.addCardVersion(next, {
                createdAt: now,
                parent: card.version,
                replay: { before: v.before, after: v.after, n: v.n },
              });
            cards = after;
          }
          attempts.push(attempt);
        }
      }
    }

    const cal = fitCalibrationFrom(uses);
    const found = proposalsFrom(uses);
    let added = 0;
    if (!o.dry) {
      store.putRates(
        { pi: rates.pi, picked: rates.picked, tasks: rates.tasks, source: rates.source },
        now,
      );
      if (cal.map.length > 0)
        store.putCalibration(cal.map, { n: cal.n, fromShuffled: cal.fromShuffled }, now);
      for (const p of found)
        if (store.addProposal({ id: p.key, kind: p.kind, payload: p.payload, createdAt: now }))
          added += 1;
    } else {
      const have = new Set(store.listProposals().map((p) => p.id));
      added = found.filter((p) => !have.has(p.key)).length;
    }

    return {
      dry: o.dry,
      uses: uses.length,
      rates: { source: rates.source, tasks: rates.tasks, pi: rates.pi },
      misses: misses.length,
      groups: groups.length,
      replaySet: replay.length,
      pinnedReplayable: replay.filter((r) => r.pinned).length,
      pinsWithoutText,
      attempts,
      kept,
      calibration: { points: cal.map.length, n: cal.n, fromShuffled: cal.fromShuffled },
      proposals: { found: found.length, added },
      writer: d.writer ? "used" : "none",
    };
  }

  return { run };
}

export type CardLoop = ReturnType<typeof createCardLoop>;
