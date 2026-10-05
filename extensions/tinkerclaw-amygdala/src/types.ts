/**
 * Shared types of the digital amygdala (design doc §2:
 * docs/plans/2026-09-29-digital-amygdala-design.md). Every module imports from here.
 */

export type Seam = "prompt" | "pre-tool" | "post-tool" | "stop";
export type Origin = "observed" | "derived" | "inferred" | "missing";
export type EffectClass =
  | "read"
  | "local-write"
  | "send"
  | "spend"
  | "restart-own-system"
  | "delete"
  | "other";
export type FamilyId = "safety" | "second-opinion" | "double-check" | "efficiency" | "personality";
export const FAMILY_IDS: readonly FamilyId[] = [
  "safety",
  "second-opinion",
  "double-check",
  "efficiency",
  "personality",
];

/**
 * The families as the J11 paper names them (Chapter 6), in the paper's order, each with its prompts in the order a
 * step meets them. The panel groups the Jev prompts this way and every prompt file opens with its family line
 * (the architect 2026-10-01: "they should be classified into families, like the paper"). Learning (§6.6) asks Jev nothing of
 * its own: it retunes these. A new prompt goes in its family's list (a test checks every seed is listed once).
 */
export const FAMILY_PAPER: readonly {
  id: FamilyId;
  title: string;
  subtitle: string;
  section: string;
  prompts: readonly string[];
}[] = [
  {
    id: "safety",
    title: "Safety",
    subtitle: "no action you would regret",
    section: "6.1",
    prompts: [
      "runs-or-quotes",
      "danger-level",
      "instruction-source",
      "data-tier",
      "destination-privacy",
      "repeat-effect",
      "recent-investment",
      "stops-own-system",
      "same-goal-as-held",
      "evidence-present",
    ],
  },
  {
    id: "second-opinion",
    title: "Second opinion",
    subtitle: "did it understand you, and does it stay on course?",
    section: "6.2",
    prompts: [
      "misreading-screen",
      "reading-confirmed",
      "reading-ruled-out",
      "commitment-changed",
      "excess-scope",
      "standing-fact-clash",
      "purpose-unclear",
    ],
  },
  {
    id: "double-check",
    title: "Double-check",
    subtitle: 'is every "done" real, and is the answer complete?',
    section: "6.3",
    prompts: [
      "claim-record",
      "claim-source",
      "claim-support",
      "stale-state-claim",
      "dodged-work",
      "weakens-own-check",
      "refusal",
    ],
  },
  {
    id: "personality",
    title: "Personality",
    subtitle: "curiosity, surprise and a steady voice",
    section: "6.4",
    prompts: ["worth-knowing", "surprise", "novelty"],
  },
  {
    id: "efficiency",
    title: "Efficiency",
    subtitle: "the right procedure, the right model, no wasted loops",
    section: "6.5",
    prompts: ["procedure-choice", "request-difficulty", "progress-made"],
  },
];

/** A situation field. A field that cannot be computed is `{value:null, origin:"missing"}`, never guessed. */
export interface Field<T = unknown> {
  value: T | null;
  origin: Origin;
  source?: string;
}

export interface ResolvedTarget {
  path: string;
  kind: "file" | "dir" | "url" | "address" | "host" | "unknown";
  /** The raw text this target was resolved from (text processing only, never shell evaluation). */
  resolvedFrom: string;
}

export interface ToolRecordEntry {
  tool: string;
  /** Short digest of the arguments, not the arguments themselves. */
  argsDigest: string;
  exit: number | null;
  filesWritten: string[];
  effects: EffectClass[];
  ts: number;
  /**
   * Shape of the result, never its text (2026-10-03, for personality's surprise): how many non-empty lines it had
   * (0 = came back empty) and whether it failed. Content stays on the machine.
   */
  outputLines?: number;
  failed?: boolean;
}

export interface Commitment {
  payer: string | null;
  amount: string | null;
  date: string | null;
  condition: string | null;
  /** How firmly the draft commits the user: "might offer" is not "will pay". */
  firmness: "may" | "will" | "owed" | null;
}

export interface Claim {
  text: string;
  kind: "done" | "state" | "other";
  source: "observed" | "told" | "stored" | "inferred" | "assumed" | null;
  support: boolean | null;
}

export interface TargetHistory {
  ageH: number;
  sizeB: number;
  edits72h: number;
  authors72h: number;
  lastMentionedByUser: number | null;
}

/** The record of §7.1 / Appendix B. Every field carries its origin. */
export interface Situation {
  id: string;
  ts: number;
  sessionKey: string;
  turnId: string;
  seam: Seam;
  originKind: "real" | "synthetic";
  tool: Field<string>;
  args: Field<Record<string, unknown>>;
  command: Field<string>;
  effectClass: Field<EffectClass>;
  targets: Field<ResolvedTarget[]>;
  targetHistory: Field<TargetHistory>;
  scratch: Field<boolean>;
  toolRecord: Field<ToolRecordEntry[]>;
  request: Field<string>;
  restatement: Field<string>;
  expectation: Field<string>;
  draftCommitments: Field<Commitment[]>;
  repeatedErrors: Field<number>;
  stepsSinceNewFact: Field<number>;
  recentHolds: Field<{ goalFp: string; ts: number }[]>;
  standingFacts: Field<string[]>;
  similarIncidents: Field<string[]>;
  reply: Field<string>;
  claims: Field<Claim[]>;
  /** Which read content looked like instructions (for the "whose instruction" question). */
  provenance: Field<{ callId: string; instructionLike: boolean }[]>;
  /** Evidence kinds an outstanding proof check is waiting for (set while a hold is open). */
  holdNeeds: Field<EvidenceKind[]>;
  /** Shortlisted skills/recipes for the procedure choice (the question's options are this list plus "none"). */
  candidates: Field<{ id: string; description: string }[]>;
  /** Jobs scheduled to run later (for "promise of later work"). */
  scheduledJobs: Field<string[]>;
  /** How often this kind of target/step has been seen (drives novelty habituation). */
  contextCounts: Field<{ seen: number; alarms: number }>;
}

/** Names of the fields a question may read. */
export type SituationFieldName = Exclude<
  keyof Situation,
  "id" | "ts" | "sessionKey" | "turnId" | "seam" | "originKind"
>;
export const SITUATION_FIELD_NAMES: readonly SituationFieldName[] = [
  "tool",
  "args",
  "command",
  "effectClass",
  "targets",
  "targetHistory",
  "scratch",
  "toolRecord",
  "request",
  "restatement",
  "expectation",
  "draftCommitments",
  "repeatedErrors",
  "stepsSinceNewFact",
  "recentHolds",
  "standingFacts",
  "similarIncidents",
  "reply",
  "claims",
  "provenance",
  "holdNeeds",
  "candidates",
  "scheduledJobs",
  "contextCounts",
];

/**
 * When an answer acts. `negate` on a choice means "any option other than `option`" (e.g. anything but "same");
 * a level cut-off has exactly one of `atOrAbove` / `atOrBelow`; `none` is a question that never acts alone
 * (it records provenance or feeds another signal).
 */
export type Cutoff =
  | { kind: "prob"; at: number }
  | { kind: "level"; atOrAbove?: number; atOrBelow?: number }
  | { kind: "choice"; option: string; at: number; negate?: boolean }
  | { kind: "none" };

export type QuestionType = "noul" | "choice" | "score";

/** One immutable version of a question. `instructions` is THE wording and exists only in questions/<family>/<id>.md (or a learned overlay). */
export interface Question {
  id: string;
  version: number;
  family: FamilyId;
  seams: Seam[];
  type: QuestionType;
  /** choice: option → description|null; score: ordered levels; noul: optional {true,false}. */
  criteria: Record<string, string | null> | string[];
  instructions: string;
  fields: SituationFieldName[];
  cutoff: Cutoff;
  purpose: string;
  origin: string;
  retirement: string;
  /** Ids of cases in cases/must-catch/. */
  mustCatch: string[];
  status: "active" | "off";
  parent?: number;
  /** Human name shown in the UI (never the instructions). */
  name: string;
}

export interface Verdict {
  id: string;
  situationId: string;
  questionId: string;
  questionVersion: number;
  type: QuestionType;
  answer: string | number | boolean;
  prob: number;
  confidence: number;
  probs?: Record<string, number>;
  cacheHit: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped?: "not-allowed" | "breaker-open" | "timeout" | "error";
  ts: number;
}

export type EvidenceKind = "listing" | "references" | "backup" | "user-request" | "prior-failure";

export type Response =
  | { kind: "proceed" }
  | {
      kind: "note";
      templateId: string;
      slots: Record<string, string | number>;
      channel: "additionalContext";
    }
  | {
      kind: "proof";
      templateId: string;
      slots: Record<string, string | number>;
      needs: EvidenceKind[];
    }
  | {
      kind: "ask";
      askId: string;
      options: { id: string; label: string; hint?: string }[];
      preselect?: string;
    }
  | { kind: "hold"; ruleOrQuestion: string; releasable: "user-only" }
  | {
      kind: "send-back";
      templateId: string;
      slots: Record<string, string | number>;
      attempt: 1 | 2;
    }
  /** The reply declined the task. Never acts on the agent; the UI offers Rewind / Keep and Thalamus gets an event. */
  | { kind: "refusal" };

export interface Decision {
  situationId: string;
  response: Response;
  family: FamilyId | "hard-rule" | "fallback";
  reasonCode: string;
  verdictIds: string[];
  mode: "shadow" | "enforce";
  enforced: boolean;
  degraded: boolean;
}

export interface Intervention {
  id: string;
  decisionId: string;
  kind: Response["kind"];
  state: "open" | "released" | "denied" | "settled" | "expired";
  ts: number;
  closedTs?: number;
}

export type LabelKind = "outcome" | "judge" | "useful" | "miss" | "undone";

export interface Label {
  id: string;
  targetId: string;
  targetKind: "decision" | "verdict";
  kind: LabelKind;
  value: -1 | 0 | 1;
  source: "user" | "override" | "outcome";
  weight: 1 | 2 | 3;
  ts: number;
}

export interface Precedent {
  id: string;
  featureKey: string;
  tokens: string[];
  incidentRef: string;
  label: "should-hold" | "harmless";
  ts: number;
  hits: number;
}

export interface ContextCount {
  contextKey: string;
  questionId: string;
  alarms: number;
  falseAlarms: number;
  confirms: number;
  lastTs: number;
}

export type ChangeKind = "tighten" | "loosen" | "reword" | "retire" | "context-loosen";

export interface ReplayReport {
  cases: number;
  relaxed: number;
  tightened: number;
  mustCatchTotal: number;
  mustCatchLost: number;
  heldOutBetter: boolean | null;
  liveCalls: number;
  /** Two-sided replay: the controls (cases that must proceed) that the change would newly push over their ceiling. */
  controlsTotal?: number;
  controlsNewlyHeld?: number;
  /** The proposal this report belongs to, so an approval or an undo can act on exactly what was replayed. */
  proposal?: unknown;
}

export interface Change {
  id: string;
  ts: number;
  questionId: string;
  fromVersion: number;
  toVersion: number | null;
  kind: ChangeKind;
  exceptional: boolean;
  status: "applied" | "pending" | "rejected" | "undone";
  replay: ReplayReport;
  proposedBy: "code" | "nightly-proposer";
}

/** A must-catch case file (cases/must-catch/*.json). `origin: "eval"` cases never enter replay. */
export interface CaseFile {
  id: string;
  /** must-catch: never lose it; control: must proceed (a guard that holds everything fails these); eval: never replayed. */
  kind: "must-catch" | "control" | "replay" | "eval";
  description: string;
  situation: Partial<Situation> & { originKind: "synthetic" };
  /** must-catch cases: the response must be at least this severe. */
  mustBeAtLeast?: Response["kind"];
  /** control cases: the response must be at most this severe (usually "proceed" or "note"). */
  mustBeAtMost?: Response["kind"];
  /**
   * How the judge answers this case, per question id, so a family can be replayed with no Jev call (unit tests now,
   * the learning loop's replay in Phase E). noul: `answer` is the probability; score: the level; choice: the option
   * with its `prob` (and optional `probs`).
   */
  answers?: Record<
    string,
    { answer: string | number | boolean; prob?: number; probs?: Record<string, number> }
  >;
}
