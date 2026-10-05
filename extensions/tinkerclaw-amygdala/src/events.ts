/**
 * Gateway events for the UI (design doc §7.2). Payloads carry the question NAME, never its instructions (U9).
 * Built here, pure, so the chat window and panel tests can replay them.
 */
import type { QuestionBook } from "./question-book.js";
import type { Decision, Response, Situation, Verdict } from "./types.js";

export type CodeDid = "ok" | "held" | "proof" | "note" | "ask" | "sent-back" | "refusal";

export interface DecisionEvent {
  id: string;
  ts: number;
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
  /** The answer rests mainly on inferred fields, so it is weaker evidence. */
  weak: boolean;
  codeDid: CodeDid;
  interventionId?: string;
  /** The decision this answer drove (drivers only), so a vote on the would-be change can target it. */
  decisionId?: string;
  degraded: boolean;
  /** The tool call this decision judged (a note rides on that tool row). */
  toolUseId?: string;
}

export interface InterventionEvent {
  id: string;
  decisionId?: string;
  ts: number;
  sessionKey: string;
  turnId: string;
  kind: Response["kind"];
  state: string;
  title: string;
  chips: string[];
  cmd?: string;
  options?: { id: string; label: string; hint?: string }[];
  expiresTs?: number;
}

export function codeDidFor(kind: Response["kind"]): CodeDid {
  switch (kind) {
    case "hold":
      return "held";
    case "send-back":
      return "sent-back";
    case "proceed":
      return "ok";
    case "refusal":
      return "refusal";
    default:
      return kind;
  }
}

/** reasonCode is written as `code[driver1,driver2]`; drivers are the questions whose answers led to the response. */
export function withDrivers(code: string, drivers: string[]): string {
  return `${code}[${drivers.join(",")}]`;
}

export function parseDrivers(reasonCode: string): string[] {
  const m = /\[([^\]]*)\]$/.exec(reasonCode);
  return m && m[1] ? m[1].split(",").filter(Boolean) : [];
}

export function stepLabel(s: Situation): string {
  const tool = s.tool.value ?? s.seam;
  const what = s.command.value ?? s.targets.value?.[0]?.path ?? "";
  const label = `${tool} ${what}`.trim();
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}

/** Fields whose answers rest mainly on inferred data count as weak evidence (paper §7.1). */
export function isWeak(s: Situation, questionFields: string[]): boolean {
  const inferred = questionFields.filter(
    (f) => (s as unknown as Record<string, { origin?: string }>)[f]?.origin === "inferred",
  );
  return questionFields.length > 0 && inferred.length * 2 > questionFields.length;
}

export interface EventContext {
  situation: Situation;
  verdicts: Verdict[];
  decision: Decision;
  decisionId: string;
  book: QuestionBook;
  interventionId?: string;
  /** The tool call these answers judged (from the hook payload), so a note can ride on that tool row. */
  toolUseId?: string;
}

/** One event per answered question (skipped verdicts have no answer to show). */
export function buildDecisionEvents(c: EventContext): DecisionEvent[] {
  const drivers = new Set(parseDrivers(c.decision.reasonCode));
  const did = codeDidFor(c.decision.response.kind);
  const out: DecisionEvent[] = [];
  for (const v of c.verdicts) {
    if (v.skipped) continue;
    const q = c.book.get(v.questionId, v.questionVersion);
    out.push({
      id: v.id,
      ts: v.ts,
      sessionKey: c.situation.sessionKey,
      turnId: c.situation.turnId,
      stepLabel: stepLabel(c.situation),
      seam: c.situation.seam,
      questionId: v.questionId,
      questionName: q?.name ?? v.questionId,
      version: v.questionVersion,
      answer: v.answer,
      prob: v.prob,
      confidence: v.confidence,
      cacheHit: v.cacheHit,
      latencyMs: v.latencyMs,
      weak: q ? isWeak(c.situation, q.fields as string[]) : false,
      codeDid: drivers.has(v.questionId) ? did : "ok",
      interventionId: drivers.has(v.questionId) ? c.interventionId : undefined,
      ...(drivers.has(v.questionId) ? { decisionId: c.decisionId } : {}),
      degraded: c.decision.degraded,
      ...(c.toolUseId ? { toolUseId: c.toolUseId } : {}),
    });
  }
  return out;
}

const TITLES: Record<Response["kind"], string> = {
  hold: "Held before it ran",
  proof: "Proof asked before it runs",
  ask: "Which reading?",
  note: "Note for the agent",
  "send-back": "Reply sent back",
  proceed: "",
  refusal: "This looks like a refusal",
};

export function buildInterventionEvent(
  c: EventContext & { state: string },
): InterventionEvent | null {
  const r = c.decision.response;
  if (r.kind === "proceed") return null;
  const s = c.situation;
  const chips: string[] = [];
  if (s.effectClass.value) chips.push(`effect: ${s.effectClass.value}`);
  const h = s.targetHistory.value;
  if (h && h.edits72h > 0) chips.push(`edited ${h.edits72h}× this week`);
  if (s.scratch.value === true) chips.push("scratch area");
  return {
    id: c.interventionId ?? c.decisionId,
    decisionId: c.decisionId,
    ts: s.ts,
    sessionKey: s.sessionKey,
    turnId: s.turnId,
    kind: r.kind,
    state: c.state,
    title: TITLES[r.kind],
    chips,
    cmd: s.command.value ?? undefined,
    options: r.kind === "ask" ? r.options : undefined,
  };
}
