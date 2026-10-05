/**
 * The learning services, assembled once per runtime (design doc §7.3): labels and the counts they move, precedents,
 * the change engine, the nightly call and the rewind method. `runtime.ts` only holds one of these and forwards to it,
 * so every operation behind a gateway method can be tested here without the gateway.
 */
import { join } from "node:path";
import type { AmygdalaConfig } from "./config.js";
import type { DecideDeps, DecideResult } from "./decide.js";
import { FAMILY_FACTORIES, FAMILY_ORDER } from "./families/index.js";
import { ChangeEngine } from "./learn/changes.js";
import { createCutoffResolver, recordAlarms } from "./learn/contexts.js";
import { LabelService } from "./learn/labels.js";
import { runNightly } from "./learn/nightly.js";
import { PrecedentIndex } from "./learn/precedents.js";
import { caseSituation } from "./learn/replay.js";
import { syncBookFromStore } from "./learn/sync.js";
import type { ChangeOutcome, RewordCandidate } from "./learn/types.js";
import type { QuestionBook } from "./question-book.js";
import { RewindRegistry, rewindTurn, type RewindMethodResult, type SessionMap } from "./rewind.js";
import type { AmygdalaStore } from "./store.js";
import type { Change, Label, LabelKind, Question } from "./types.js";

export interface LearningOptions {
  store: AmygdalaStore;
  book: QuestionBook;
  jev: DecideDeps["jev"];
  config: AmygdalaConfig;
  extensionRoot: string;
  dataDir: string;
  emit: (event: string, payload: unknown) => void;
  now: () => number;
  idGen?: () => string;
  /** Phase F wires the bridge's real session map here; without one the rewind method does nothing. */
  sessionMap?: SessionMap;
}

export interface LabelInput {
  targetId: string;
  targetKind: "decision" | "verdict";
  kind: LabelKind;
  value: -1 | 0 | 1;
}

const DAY_MS = 86_400_000;

export interface Learning {
  /** The two hooks `decide` reads. */
  cutoffFor: NonNullable<DecideDeps["cutoffFor"]>;
  precedents: NonNullable<DecideDeps["precedents"]>;
  /** After every decision: count the alarms in their own context. */
  observe(result: DecideResult): void;
  label(input: LabelInput): { label: Label; precedent: boolean };
  onAnswer(interventionId: string, answer: string): void;
  approve(
    changeId: string,
    yes: boolean,
  ): Promise<{ ok: true; outcome: ChangeOutcome } | { ok: false; error: string }>;
  undo(changeId: string): { ok: boolean; change?: Change; reason?: string };
  propose(questionId: string, candidate: RewordCandidate, source: string): Promise<ChangeOutcome>;
  nightly(): ReturnType<typeof runNightly>;
  questionRecord(questionId: string): Question | undefined;
  changes(sinceDays?: number): Change[];
  pendingCount(): number;
  rewind(o: { sessionKey: string; turnId: string; undo?: boolean }): RewindMethodResult;
}

export function createLearning(o: LearningOptions): Learning {
  const { store, book, config, now } = o;
  // Versions the learning loop saved in an earlier run become known and active again.
  syncBookFromStore(book, store);

  const labels = new LabelService({ store, now, idGen: o.idGen });
  const precedents = new PrecedentIndex({ store, now, idGen: o.idGen });
  const families = FAMILY_ORDER.map((id) => FAMILY_FACTORIES[id]({ book }));
  const casesRoot = join(o.extensionRoot, "cases");

  const engine = new ChangeEngine({
    store,
    book,
    families: () => families,
    casesRoot,
    now,
    idGen: o.idGen,
    emit: o.emit,
    autoLoosen: config.learn.autoLoosen,
    caps: { perWeek: config.learn.capsPerWeek, perDay: config.learn.capsPerDay },
    // A reword is replayed with the judge itself: synthetic cases only, so nothing real leaves the machine.
    live: async (q, c) => {
      const vs = await o.jev.ask(caseSituation(c), [q], { budgetMs: config.jev.timeoutMs });
      const v = vs[0];
      return v && !v.skipped ? { answer: v.answer, prob: v.prob, probs: v.probs } : null;
    },
    maxLiveCalls: 300,
  });
  const registry = new RewindRegistry(join(o.dataDir, "rewinds.json"));

  return {
    cutoffFor: createCutoffResolver(store),
    precedents: precedents.asDecideHook(),

    observe(result) {
      try {
        recordAlarms(store, result.situation, result.decision, now());
      } catch (err) {
        console.error("[amygdala] counting alarms failed", err);
      }
    },

    label(i) {
      if (i.kind === "miss") {
        const label = labels.markMiss(i.targetId);
        // One incident becomes a precedent at once (paper §6.6).
        const p = precedents.addFromDecision(i.targetId, "should-hold");
        return { label, precedent: p !== null };
      }
      return { label: labels.label(i), precedent: false };
    },

    onAnswer(interventionId, answer) {
      try {
        labels.onIntervention(interventionId, answer);
      } catch (err) {
        console.error("[amygdala] labelling an answer failed", err);
      }
    },

    async approve(changeId, yes) {
      const c = store.getChange(changeId);
      if (!c || !c.exceptional) return { ok: false, error: "not-exceptional" };
      return { ok: true, outcome: await engine.approve(changeId, yes) };
    },

    undo: (changeId) => engine.undo(changeId),

    propose: (questionId, candidate, source) =>
      engine.propose(
        { kind: "reword", questionId, candidate },
        { proposedBy: source === "code" ? "code" : "nightly-proposer" },
      ),

    // No proposer here: the model call belongs to the by-hand script, which posts candidates back through `propose`.
    nightly: () => runNightly({ store, book, engine, now, families: () => families, casesRoot }),

    questionRecord: (id) => book.get(id),

    changes: (days = 30) => store.listChanges({ sinceTs: now() - days * DAY_MS }),

    pendingCount: () => engine.pending().length,

    rewind: (r) => {
      const rewound = registry.rewoundTurns(r.sessionKey);
      const newestTurnId = r.undo
        ? undefined
        : store.turnIdsNewestFirst(r.sessionKey).find((t) => !rewound.has(t));
      return rewindTurn({ sessionMap: o.sessionMap, registry, ...r, newestTurnId, now: now() });
    },
  };
}
