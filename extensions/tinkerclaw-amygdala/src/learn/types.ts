/**
 * Contracts of the learning loop (design doc §7.3). Shared by labels, precedents, replay, the change engine, retune
 * and the nightly lane so each can be built and tested against an interface.
 */
import type { Change, Cutoff, Question, Response } from "../types.js";

/** Fields of a question a reword may change; the wording itself only ever comes from a proposer, never from code. */
export interface RewordCandidate {
  instructions?: string;
  criteria?: Question["criteria"];
  fields?: Question["fields"];
  cutoff?: Cutoff;
}

/** What may be proposed. Hard rules are code (rules.ts) and are not proposable: they are not questions. */
export type Proposal =
  | { kind: "cutoff"; scope: "global"; questionId: string; cutoff: Cutoff }
  | { kind: "cutoff"; scope: "context"; questionId: string; contextKey: string; cutoff: Cutoff }
  | { kind: "reword"; questionId: string; candidate: RewordCandidate }
  | { kind: "retire"; questionId: string };

export type RejectReason =
  | "must-catch-lost"
  | "controls-held"
  | "hard-rule"
  | "unknown-question"
  | "blocked"
  | "no-effect";

export type DeferReason = "cap-week" | "cap-day" | "auto-loosen-off";

export type ChangeOutcome =
  | { outcome: "applied"; change: Change }
  | { outcome: "pending"; change: Change }
  | { outcome: "rejected"; change: Change | null; reason: RejectReason }
  | { outcome: "deferred"; reason: DeferReason };

/** The engine that replays, gates, applies, approves and undoes changes (changes.ts). Retune and nightly use only this. */
export interface ChangeEngineApi {
  propose(p: Proposal, o?: { proposedBy?: Change["proposedBy"] }): Promise<ChangeOutcome>;
  approve(changeId: string, yes: boolean): Promise<ChangeOutcome>;
  undo(changeId: string): { ok: boolean; change?: Change; reason?: string };
  pending(): Change[];
}

/** A failing case handed to the proposer: what the situation was, what was expected, what the family did. */
export interface FailingCase {
  caseId: string;
  expected: string;
  got: Response["kind"];
  answers: Record<string, unknown>;
}

export interface ProposerInput {
  question: Question;
  failing: FailingCase[];
}

/** The proposer is a language model in production and a scripted function in tests. It never grades itself. */
export type Proposer = (input: ProposerInput) => Promise<RewordCandidate | null>;
