// The routing reader: task, step, outcome and enhancement reads (design doc sections 10 and 13A; paper P§4, P§7).
//
// WHAT THIS IS FOR. It is the one place that decides whether Jev is asked, builds the questions, turns the
// verdicts into typed reads and a short list, and falls back to local rules whenever Jev may not or cannot answer.
//
// THE PRIVACY ORDER (paper P§4, "Privacy comes first"; charter default). Decided from the SOURCE, before any
// question is built and before anything leaves the machine:
//   1. Jev off, no way to ask                          -> local rules, no call
//   2. a real situation and real sending not allowed   -> local rules, no call   (Jev sees synthetic cases only)
//   3. a private source not approved for Jev           -> local rules, no call
//   4. otherwise                                       -> one call for the task read AND the enhancement ranking
// Tests assert on the mock's call count, not on what it was sent.
//
// ONE CALL, TWO JOBS. The task read and the enhancement ranking go in the same request: the five task
// questions, the family question, and one within-family question per family.

import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import {
  answeredChoice,
  buildEnhancementQuestions,
  type EnhancementQuestions,
  buildFitQuestion,
  buildShortlist,
  FIT_READS,
  groupFamilies,
  isPrivateSource,
  jointProbabilities,
  localOutcomeRead,
  localShortlist,
  localStepRead,
  localTaskRead,
  notAsked,
  outcomeReadFromVerdicts,
  READ_CONFIDENCE_FLOOR,
  stepReadFromVerdicts,
  taskReadFromVerdicts,
  withFits,
  type CalibrationMap,
  type EnhancementCard,
  type FitKind,
  type OutcomeRead,
  type Shortlist,
  type StepRead,
  type TaskRead,
} from "openclaw/plugin-sdk/fork-thalamus";
import { buildParallelQuestions, type LoadedQuestions } from "./questions.js";

/** What Jev is shown. Only the request text ever leaves; the client's `buildState` redacts it. */
export type RoutingSituation = {
  id: string;
  request: { value: string };
  /** A step only: the tool about to run and its arguments (redacted when sent). Never its output or a reply. */
  tool?: { value: string };
  args?: { value: unknown };
};

export type AskFn = (
  situation: RoutingSituation,
  questions: JevQuestion[],
  opt?: { budgetMs?: number },
) => Promise<JevVerdict[]>;

export type ReaderConfig = {
  /** `jev.enabled`. */
  jevEnabled: boolean;
  /** `jev.sendRealSituations`: real content may go to Jev. Synthetic cases always may. */
  sendRealSituations: boolean;
  confidenceFloor: number;
  privateSources: readonly string[];
  /** Private sources Jev may nevertheless read. */
  jevApprovedSources: readonly string[];
  budgetMs?: number;
  /** Largest option count (cards plus "none") asked as one flat question; above it, families. Default `FLAT_MAX_OPTIONS`. */
  flatMaxOptions?: number;
};

export const DEFAULT_READER_CONFIG: ReaderConfig = {
  jevEnabled: false,
  sendRealSituations: false,
  confidenceFloor: READ_CONFIDENCE_FLOOR,
  privateSources: ["channel:*"],
  jevApprovedSources: [],
};

export type ReaderDeps = {
  /** Undefined when there is no way to ask (no key, no client). */
  ask?: AskFn;
  /** The questions ride on the amygdala's call (see provider.ts), so this reader needs no client of its own. */
  rides?: boolean;
  questions: LoadedQuestions;
  cards: () => readonly EnhancementCard[];
  calibration?: () => CalibrationMap | undefined;
  config: ReaderConfig;
};

export type ReadInput = {
  id: string;
  ts: number;
  sessionKey: string;
  text: string;
  /** Where the task came from, e.g. "tinker", "channel:whatsapp". */
  source: string;
  trigger?: string;
  /** A test case or a labelled example, not a live conversation. */
  synthetic?: boolean;
};

export type WhyLocal =
  | "jev-off"
  | "real-not-allowed"
  | "private-source"
  | "jev-silent"
  | "no-key"
  | "counted";

export type TaskReadResult = {
  task: TaskRead;
  shortlist: Shortlist;
  usedJev: boolean;
  /** Why Jev was not (successfully) used; absent when it was. */
  local?: WhyLocal;
  private: boolean;
  /** The option-set version the enhancement question was asked with; 0 when not asked. */
  enhancementVersion: number;
  verdicts: JevVerdict[];
};

const situationOf = (i: {
  id: string;
  text: string;
  toolName?: string;
  args?: unknown;
}): RoutingSituation => ({
  id: i.id,
  request: { value: i.text },
  ...(i.toolName ? { tool: { value: i.toolName } } : {}),
  ...(i.args !== undefined && i.args !== null ? { args: { value: i.args } } : {}),
});

export class RoutingReader {
  constructor(private readonly d: ReaderDeps) {}

  /** May Jev be asked about this input at all? Decided from the source, before any question is built. */
  gate(i: ReadInput): { allowed: true } | { allowed: false; why: WhyLocal } {
    const c = this.d.config;
    if (!c.jevEnabled) return { allowed: false, why: "jev-off" };
    if (!this.d.ask && !this.d.rides) return { allowed: false, why: "no-key" };
    if (i.synthetic !== true && !c.sendRealSituations)
      return { allowed: false, why: "real-not-allowed" };
    const approved = c.jevApprovedSources.some((s) => isPrivateSource(i.source, [s]));
    if (isPrivateSource(i.source, c.privateSources) && !approved) {
      return { allowed: false, why: "private-source" };
    }
    return { allowed: true };
  }

  /** The step and outcome questions, for a caller that puts them in someone else's request. */
  stepQuestions(): JevQuestion[] {
    return this.d.questions.step;
  }

  outcomeQuestions(): JevQuestion[] {
    return this.d.questions.outcome;
  }

  isPrivate(i: ReadInput): boolean {
    return isPrivateSource(i.source, this.d.config.privateSources);
  }

  private localTask(i: ReadInput, why: WhyLocal): TaskReadResult {
    const cards = this.d.cards();
    return {
      task: localTaskRead({
        id: i.id,
        ts: i.ts,
        sessionKey: i.sessionKey,
        text: i.text,
        trigger: i.trigger,
        private: this.isPrivate(i),
        floor: this.d.config.confidenceFloor,
      }),
      shortlist: cards.length > 0 ? localShortlist(i.text, cards) : notAsked("local"),
      usedJev: false,
      local: why,
      private: this.isPrivate(i),
      enhancementVersion: 0,
      verdicts: [],
    };
  }

  /**
   * The questions of a task read: the five task questions plus the enhancement ranking, or nothing when Jev may
   * not be asked. Shared by the standalone read and by the provider that rides on the amygdala's call.
   */
  taskQuestions(
    i: ReadInput,
  ):
    | { allowed: false; why: WhyLocal }
    | { allowed: true; questions: JevQuestion[]; enh?: EnhancementQuestions } {
    const g = this.gate(i);
    if (!g.allowed) return g;
    const cards = this.d.cards().filter((c) => c.status === "active");
    const grouping = groupFamilies(cards);
    const enh =
      cards.length > 0 && grouping.families.length > 0
        ? buildEnhancementQuestions(
            grouping,
            new Map(cards.map((c) => [c.id, c])),
            this.d.questions.enhancement,
            { flatMaxOptions: this.d.config.flatMaxOptions },
          )
        : undefined;
    return { allowed: true, questions: [...this.d.questions.task, ...(enh?.questions ?? [])], enh };
  }

  /** Turn the verdicts of `taskQuestions` into the task read and the short list. */
  interpretTask(i: ReadInput, verdicts: JevVerdict[], enh?: EnhancementQuestions): TaskReadResult {
    if (verdicts.length === 0 || verdicts.every((v) => v.skipped !== undefined)) {
      return this.localTask(i, "jev-silent");
    }
    const task = taskReadFromVerdicts(
      { id: i.id, ts: i.ts, sessionKey: i.sessionKey, floor: this.d.config.confidenceFloor },
      verdicts,
      this.isPrivate(i),
    );
    let shortlist: Shortlist = notAsked("jev");
    if (enh) {
      const joint = jointProbabilities(verdicts, enh.families);
      // The list is built from the probabilities by share (paper 7.1), with "none fits" among the options. It is NOT
      // floored on the verdicts' confidence: a family read that splits (code 0.47, data 0.46) with a member read of 0.99
      // is a joint of about 0.46, still a card worth listing, and flooring it dropped to word matching (phase H2). A
      // ranking built on a missing answer is still not handed over: that goes to the local list.
      shortlist = joint.complete
        ? buildShortlist(joint, { calibration: this.d.calibration?.() })
        : localShortlist(i.text, this.d.cards());
    }
    return {
      task,
      shortlist,
      usedJev: true,
      private: this.isPrivate(i),
      enhancementVersion: enh?.version ?? 0,
      verdicts,
    };
  }

  /** The task read and the enhancement ranking, in one call when Jev may be asked. */
  async readTask(i: ReadInput): Promise<TaskReadResult> {
    const built = this.taskQuestions(i);
    if (!built.allowed) return this.localTask(i, built.why);
    let verdicts: JevVerdict[];
    try {
      verdicts = await this.d.ask!(situationOf({ id: i.id, text: i.text }), built.questions, {
        budgetMs: this.d.config.budgetMs,
      });
    } catch {
      return this.localTask(i, "jev-silent");
    }
    return this.interpretTask(i, verdicts, built.enh);
  }

  /**
   * The fit-kind read for the top entries. Meant to run while the first model call runs, so it costs no time.
   * A local list, or a silent Jev, leaves the entries unlabelled.
   */
  async readFit(i: ReadInput, list: Shortlist): Promise<Shortlist> {
    if (!list.shown || list.source !== "jev") return list;
    const g = this.gate(i);
    if (!g.allowed) return list;
    const byId = new Map(this.d.cards().map((c) => [c.id, c]));
    const top = list.entries.slice(0, FIT_READS);
    const questions = top
      .map((e) => byId.get(e.cardId))
      .map((card, k) =>
        card ? buildFitQuestion(card, k + 1, this.d.questions.enhancement) : undefined,
      )
      .filter((q): q is JevQuestion => q !== undefined);
    if (questions.length === 0) return list;
    let verdicts: JevVerdict[];
    try {
      verdicts = await this.d.ask!(situationOf({ id: i.id, text: i.text }), questions, {
        budgetMs: this.d.config.budgetMs,
      });
    } catch {
      return list;
    }
    const fits = new Map<string, ReturnType<typeof answeredChoice<FitKind>>>();
    top.forEach((e, k) => {
      const v = verdicts.find((x) => x.questionId === `enh-fit-${k + 1}`);
      const a = answeredChoice<FitKind>(
        v,
        ["made-for", "by-structure", "covers-part"],
        "made-for",
        this.d.config.confidenceFloor,
      );
      if (a.source === "jev") fits.set(e.cardId, a);
    });
    return withFits(list, fits);
  }

  /** The step read. Asked only when Jev may be, otherwise local rules. */
  async readStep(
    i: ReadInput & { callIndex: number; toolName?: string; external?: boolean; args?: unknown },
    pending: readonly string[] = [],
  ): Promise<{ step: StepRead; usedJev: boolean; local?: WhyLocal }> {
    const g = this.gate(i);
    const local = (why: WhyLocal) => ({
      step: localStepRead({
        id: i.id,
        ts: i.ts,
        sessionKey: i.sessionKey,
        callIndex: i.callIndex,
        toolName: i.toolName,
        external: i.external,
        floor: this.d.config.confidenceFloor,
      }),
      usedJev: false,
      local: why,
    });
    if (!g.allowed) return local(g.why);
    const par = buildParallelQuestions(pending, this.d.questions.parallel);
    let verdicts: JevVerdict[];
    try {
      verdicts = await this.d.ask!(
        situationOf({ id: i.id, text: i.text, toolName: i.toolName, args: i.args }),
        [...this.d.questions.step, ...par.questions],
        {
          budgetMs: this.d.config.budgetMs,
        },
      );
    } catch {
      return local("jev-silent");
    }
    if (verdicts.length === 0 || verdicts.every((v) => v.skipped !== undefined))
      return local("jev-silent");
    return {
      step: stepReadFromVerdicts(
        {
          id: i.id,
          ts: i.ts,
          sessionKey: i.sessionKey,
          callIndex: i.callIndex,
          floor: this.d.config.confidenceFloor,
        },
        verdicts,
        par.asked,
      ),
      usedJev: true,
    };
  }

  /** The outcome read. "Stuck" comes from the error count with no call at all. */
  async readOutcome(
    i: ReadInput & {
      callIndex: number;
      repeatedErrors?: number;
      refused?: boolean;
      failed?: boolean;
    },
  ): Promise<{ outcome: OutcomeRead; usedJev: boolean; local?: WhyLocal }> {
    const env = {
      id: i.id,
      ts: i.ts,
      sessionKey: i.sessionKey,
      callIndex: i.callIndex,
      floor: this.d.config.confidenceFloor,
    };
    const localRead = (why: WhyLocal) => ({
      outcome: localOutcomeRead({
        ...env,
        repeatedErrors: i.repeatedErrors,
        refused: i.refused,
        failed: i.failed,
      }),
      usedJev: false,
      local: why,
    });
    if ((i.repeatedErrors ?? 0) >= 2) return localRead("counted");
    const g = this.gate(i);
    if (!g.allowed) return localRead(g.why);
    let verdicts: JevVerdict[];
    try {
      verdicts = await this.d.ask!(
        situationOf({ id: i.id, text: i.text }),
        this.d.questions.outcome,
        {
          budgetMs: this.d.config.budgetMs,
        },
      );
    } catch {
      return localRead("jev-silent");
    }
    if (verdicts.length === 0 || verdicts.every((v) => v.skipped !== undefined))
      return localRead("jev-silent");
    return {
      outcome: outcomeReadFromVerdicts(env, verdicts, i.repeatedErrors ?? 0),
      usedJev: true,
    };
  }
}
