/**
 * Payloads of the amygdala gateway surface as the UI sees them (design doc §7.2, §9). They mirror
 * `extensions/tinkerclaw-amygdala/src/{events,status,learning}.ts`; the UI never imports the extension. Every UI module
 * (store, Jev window, cards, panel) imports its types from here. Names of questions are shown, never their wording.
 */

export type CodeDid = "ok" | "held" | "proof" | "note" | "ask" | "sent-back" | "refusal";
export type InterventionKind = "hold" | "proof" | "ask" | "note" | "send-back" | "refusal";

/** `amygdala2.decision`: one answered question. */
export interface JevDecision {
  id: string;
  ts: number;
  /** The chat tab's session key when the gateway could map it, else the Claude session id. */
  sessionKey: string;
  turnId: string;
  stepLabel: string;
  seam: string;
  questionId: string;
  questionName: string;
  version: number;
  answer: string | number | boolean;
  prob: number;
  confidence: number;
  cacheHit: boolean;
  latencyMs: number;
  /** The answer rests mainly on inferred fields. */
  weak: boolean;
  codeDid: CodeDid;
  interventionId?: string;
  /** The decision this answer drove (set on drivers only); a vote on a would-be change targets it (2026-10-02). */
  decisionId?: string;
  degraded: boolean;
  /** The tool call this decision judged, so a note can ride on that tool row. */
  toolUseId?: string;
}

/** `amygdala2.intervention`: a hold, proof check, ask, note, send-back or refusal strip. */
export interface InterventionView {
  id: string;
  /** The decision this intervention came from (labels and 👍/👎 target it). */
  decisionId?: string;
  ts: number;
  sessionKey: string;
  turnId: string;
  kind: InterventionKind;
  /** "open" waits for the user; "settled", "released", "denied", "expired" are closed. */
  state: string;
  title: string;
  chips: string[];
  cmd?: string;
  options?: { id: string; label: string; hint?: string }[];
  expiresTs?: number;
}

export interface ReplaySummary {
  cases: number;
  relaxed: number;
  tightened: number;
  mustCatchLost: number;
  controlsNewlyHeld: number;
}

/** `amygdala2.change`: a self-made change (Learning, with Undo) or an exceptional one (the only card). */
export interface ChangeView {
  id: string;
  kind: "tighten" | "loosen" | "context-loosen" | "reword" | "retire";
  questionName: string;
  from: unknown;
  to: unknown;
  exceptional: boolean;
  status: "applied" | "pending" | "rejected" | "undone";
  replaySummary: ReplaySummary;
  ts?: number;
}

/** `amygdala2.status` (event and method). */
export interface StatusView {
  ts: number;
  state: "working" | "shadow" | "degraded";
  line: string;
  mode: "shadow" | "enforce";
  floorActive: boolean;
  seams: Record<"prompt" | "pre" | "post" | "stop", { lastTs: number | null }>;
  rules: { n: number; version: number };
  judge: { lastMs: number | null; errors: number; silentSince?: number };
  spendEurToday: number;
  checksToday: number;
  heldToday: number;
  askedToday: number;
  waitingForYou: number;
  notesDropped: number;
}

/** `amygdala2.marker`: "sent back twice, delivered with a marker". */
export interface MarkerView {
  kind: "unsupported-after-two" | "refusal-rewound";
  sessionKey: string;
  turnId: string;
  items: string[];
  ts: number;
}

/** A row of the panel's Questions expander. */
export interface QuestionRow {
  id: string;
  name: string;
  version: number;
  today: number;
  /** Share of labelled answers the user agreed with, 0..1; null when nothing is labelled. */
  right: number | null;
  status: "active" | "off";
  /** The prompt's .md file; the panel opens it for editing through the `.fs-link` handler. */
  file?: string;
  /** The family as the J11 paper names it (2026-10-01); absent from an older gateway, then no group header. */
  family?: string;
  familyTitle?: string;
  familySubtitle?: string;
}

/** `amygdala2.feed`: what the UI loads on connect and after a reload. */
export interface FeedView {
  decisionEvents: JevDecision[];
  interventions: InterventionView[];
  changes: ChangeView[];
  questions: QuestionRow[];
  status: StatusView;
  spend: { eur: number; eur30: number; calls: number };
  counts: { checks: number; held: number; asked: number };
  precedents: number;
}

/** What one turn looks like to the renderers (built by the store). */
export interface TurnView {
  turnId: string;
  sessionKey: string;
  /** Time of the turn's first decision. */
  ts: number;
  decisions: JevDecision[];
  interventions: InterventionView[];
  markers: MarkerView[];
  /** Set after a Rewind; cleared by Undo. */
  rewound?: { ts: number; restoredPrompt?: string; forkSessionId?: string };
  /** The user kept a refusal (the strip is gone). */
  refusalKept?: boolean;
}

/** The three states of the dot next to Send. */
export type DotState = "green" | "amber" | "red" | "grey";
