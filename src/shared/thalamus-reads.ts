// THALAMUS v4 — the three reads, as verdicts turned into typed answers (design doc section 10; paper P§4).
//
// WHAT THIS IS FOR. Jev describes; the prices decide. This module is the seam between the two: it turns
// the verdicts of a Jev call into `TaskRead`, `StepRead` and `OutcomeRead`, and it builds the same reads
// from local rules when Jev is not consulted (a private source, no key, a breaker open, a late answer).
//
// HOW IT WAS DERIVED. The paper's rule (P§4, "when the reader is unsure"): low confidence never makes a route
// cheaper or riskier. So every answer that is missing, skipped, off-list or below the floor becomes a
// `fallback` answer holding the CAUTIOUS value, and `routeCall` reads `source === "fallback"` as "nobody
// checked". Local rules are honest about being weak: their confidence sits below the default floor
// on purpose, so a local read is treated as unsure and the router takes the cautious options.
//
// WHERE THE WORDING LIVES. Nowhere here. The questions are in `extensions/tinkerclaw-thalamus/questions/*.json`;
// this file knows only their ids and the option keys the answers must come from.
//
// PURE. No clock, no I/O; ids and times are arguments.

import type { JevVerdict } from "../infra/jev/types.js";
import type { SubjectClass } from "./thalamus-feasibility.js";
import { classifySubject } from "./thalamus-feasibility.js";
import { classifyTaskDomain, TASK_DOMAINS, type TaskDomain } from "./thalamus-frontier.js";
import type {
  Answered,
  Depth,
  Needs,
  OutcomeRead,
  OutcomeState,
  Shape,
  StepKind,
  StepRead,
  TaskRead,
  Urgency,
} from "./thalamus-v4-types.js";

// ─── question ids and the options their answers must come from ─────────────────────────────────

export const TASK_QUESTION_IDS = [
  "route-work-kind",
  "route-difficulty",
  "route-topic-class",
  "route-urgency",
  "route-shape",
] as const;
export const STEP_QUESTION_IDS = [
  "step-kind",
  "step-depth",
  "step-context-need",
  "step-run-length",
  "step-commits-or-claims",
] as const;
/** Asked once per pending item: the id is this prefix and the item's 1-based position in the list sent. */
export const STEP_PARALLEL_PREFIX = "step-parallel-ok-";
export const OUTCOME_QUESTION_IDS = ["outcome-state"] as const;

export const WORK_KINDS: readonly TaskDomain[] = [...TASK_DOMAINS, "general"];
export const TOPIC_CLASSES: readonly SubjectClass[] = [
  "none",
  "medical",
  "security",
  "legal",
  "sensitive",
];
export const URGENCIES: readonly Urgency[] = ["waiting", "today", "whenever"];
export const SHAPES: readonly Shape[] = ["answer", "parts", "chain"];
export const STEP_KINDS: readonly StepKind[] = ["plan", "tool", "read", "write", "check", "answer"];
export const NEEDS: readonly Needs[] = ["all", "recent", "item"];
export const OUTCOMES: readonly OutcomeState[] = ["done", "retry", "stuck", "refused", "check"];

/** Below this Jev confidence an answer is unsure. The same starting value `routeCall` uses. */
export const READ_CONFIDENCE_FLOOR = 0.6;

/** A local rule's confidence. Below the floor on purpose: a local read is a stand-in, not a check. */
export const LOCAL_CONFIDENCE = 0.5;

/** "The same failure twice" is code: a repeated error count at or above this is `stuck` without a call. */
export const STUCK_AFTER_ERRORS = 2;

// ─── the cautious values ───────────────────────────────────────────────────────────────────────

/**
 * What an unsure answer stands for. Chosen so that using it can never make a route cheaper or riskier:
 * a harder task, a deeper step, the whole thread, no run ahead (so no switch), and the step assumed to
 * commit (so it is checked). The topic stays `none` but carries `source: "fallback"`, which the router
 * reads as "the topic was not checked" and answers by leaving out every restricted vendor.
 */
export const CAUTIOUS = {
  kind: "general" as TaskDomain,
  difficulty: 4 as const,
  topic: "none" as SubjectClass,
  urgency: "today" as Urgency,
  shape: "chain" as Shape,
  stepKind: "tool" as StepKind,
  depth: "deep" as Depth,
  needs: "all" as Needs,
  runLength: 0 as const,
  commits: true,
  outcome: "check" as OutcomeState,
};

const fallback = <T>(value: T, conf = 0): Answered<T> => ({ value, conf, source: "fallback" });

// ─── verdict -> answer ─────────────────────────────────────────────────────────────────────────

/** A verdict Jev actually answered: not skipped, and of the type the question was. */
function usable(v: JevVerdict | undefined, type: JevVerdict["type"]): v is JevVerdict {
  return v !== undefined && v.skipped === undefined && v.type === type;
}

export function answeredChoice<T extends string>(
  v: JevVerdict | undefined,
  allowed: readonly T[],
  cautious: T,
  floor = READ_CONFIDENCE_FLOOR,
): Answered<T> {
  if (!usable(v, "choice") || typeof v.answer !== "string" || !allowed.includes(v.answer as T)) {
    return fallback(cautious);
  }
  if (v.confidence < floor) return fallback(cautious, v.confidence);
  return { value: v.answer as T, conf: v.confidence, source: "jev" };
}

/**
 * A score is a 0-based level; `offset` maps it onto the value (difficulty is 1..5, so offset 1).
 *
 * Jev answers a score as an expected level, a fraction such as 3.24 or 4.88 (measured live, phase H). It is rounded to the
 * nearest level. The ends are clamped: a value up to one level past either end is a rounding artefact of the scale and
 * lands on the end level. Further out, or not a finite number, is a malformed answer and falls back.
 */
export function answeredScore<T extends number>(
  v: JevVerdict | undefined,
  levels: number,
  offset: number,
  cautious: T,
  floor = READ_CONFIDENCE_FLOOR,
): Answered<T> {
  if (!usable(v, "score") || typeof v.answer !== "number" || !Number.isFinite(v.answer)) {
    return fallback(cautious);
  }
  if (v.answer < -1 || v.answer > levels) return fallback(cautious);
  if (v.confidence < floor) return fallback(cautious, v.confidence);
  const level = Math.min(levels - 1, Math.max(0, Math.round(v.answer)));
  return { value: (level + offset) as T, conf: v.confidence, source: "jev" };
}

/**
 * A probability that a statement is true. The value is whether it is more likely true than not.
 *
 * Jev sends a true/false answer as a bare probability with no confidence (measured live, phase H: the client records 0).
 * The confidence is therefore how far the probability is from a coin toss, `max(p, 1 - p)`: 0.5 is unsure, 0.95 is sure.
 * A positive confidence the vendor does send can only lower that, never raise it.
 */
export function answeredNoul(
  v: JevVerdict | undefined,
  cautious: boolean,
  floor = READ_CONFIDENCE_FLOOR,
): Answered<boolean> {
  if (!usable(v, "noul") || typeof v.answer !== "number") return fallback(cautious);
  if (!Number.isFinite(v.answer) || v.answer < 0 || v.answer > 1) return fallback(cautious);
  const fromProbability = Math.max(v.answer, 1 - v.answer);
  const conf = v.confidence > 0 ? Math.min(v.confidence, fromProbability) : fromProbability;
  if (conf < floor) return fallback(cautious, conf);
  return { value: v.answer >= 0.5, conf, source: "jev" };
}

const byQuestion = (vs: readonly JevVerdict[]): Map<string, JevVerdict> =>
  new Map(vs.map((v) => [v.questionId, v]));

export type ReadEnvelope = { id: string; ts: number; sessionKey: string; floor?: number };

export function taskReadFromVerdicts(
  e: ReadEnvelope,
  verdicts: readonly JevVerdict[],
  isPrivate: boolean,
): TaskRead {
  const m = byQuestion(verdicts);
  const f = e.floor ?? READ_CONFIDENCE_FLOOR;
  return {
    id: e.id,
    ts: e.ts,
    sessionKey: e.sessionKey,
    kind: answeredChoice(m.get("route-work-kind"), WORK_KINDS, CAUTIOUS.kind, f),
    difficulty: answeredScore<1 | 2 | 3 | 4 | 5>(
      m.get("route-difficulty"),
      5,
      1,
      CAUTIOUS.difficulty,
      f,
    ),
    topic: answeredChoice(m.get("route-topic-class"), TOPIC_CLASSES, CAUTIOUS.topic, f),
    urgency: answeredChoice(m.get("route-urgency"), URGENCIES, CAUTIOUS.urgency, f),
    shape: answeredChoice(m.get("route-shape"), SHAPES, CAUTIOUS.shape, f),
    private: isPrivate,
  };
}

const DEPTHS: readonly Depth[] = ["mechanical", "routine", "deep"];

function depthFrom(v: JevVerdict | undefined, floor: number): Answered<Depth> {
  const level = answeredScore<0 | 1 | 2>(v, DEPTHS.length, 0, 2, floor);
  return level.source === "fallback"
    ? { ...level, value: CAUTIOUS.depth }
    : { ...level, value: DEPTHS[level.value] };
}

export function stepReadFromVerdicts(
  e: ReadEnvelope & { callIndex: number },
  verdicts: readonly JevVerdict[],
  /** The pending items that were asked about, in the order sent: item n is question `step-parallel-ok-n`. */
  pendingItems: readonly string[] = [],
): StepRead {
  const m = byQuestion(verdicts);
  const f = e.floor ?? READ_CONFIDENCE_FLOOR;
  const parallelOk: StepRead["parallelOk"] = {};
  pendingItems.forEach((item, i) => {
    parallelOk[item] = answeredNoul(m.get(`${STEP_PARALLEL_PREFIX}${i + 1}`), false, f);
  });
  return {
    id: e.id,
    ts: e.ts,
    sessionKey: e.sessionKey,
    callIndex: e.callIndex,
    kind: answeredChoice(m.get("step-kind"), STEP_KINDS, CAUTIOUS.stepKind, f),
    depth: depthFrom(m.get("step-depth"), f),
    needs: answeredChoice(m.get("step-context-need"), NEEDS, CAUTIOUS.needs, f),
    runLength: answeredScore<0 | 1 | 2 | 3 | 4>(
      m.get("step-run-length"),
      5,
      0,
      CAUTIOUS.runLength,
      f,
    ),
    parallelOk,
    commitsOrClaims: answeredNoul(m.get("step-commits-or-claims"), CAUTIOUS.commits, f),
  };
}

/**
 * The outcome read. "Stuck" is the same failure twice, which the harness counts: at or above
 * `STUCK_AFTER_ERRORS` repeated errors the answer is `stuck` without asking Jev.
 */
export function outcomeReadFromVerdicts(
  e: ReadEnvelope & { callIndex: number },
  verdicts: readonly JevVerdict[],
  repeatedErrors = 0,
): OutcomeRead {
  const f = e.floor ?? READ_CONFIDENCE_FLOOR;
  const state: Answered<OutcomeState> =
    repeatedErrors >= STUCK_AFTER_ERRORS
      ? { value: "stuck", conf: 1, source: "local" }
      : answeredChoice(byQuestion(verdicts).get("outcome-state"), OUTCOMES, CAUTIOUS.outcome, f);
  return { id: e.id, ts: e.ts, callIndex: e.callIndex, state };
}

// ─── local rules: private sources, no key, Jev down ────────────────────────────────────────────

const local = <T>(value: T): Answered<T> => ({ value, conf: LOCAL_CONFIDENCE, source: "local" });

const LIST_CUES = /(^|\n)\s*(?:[-*•]|\d+[.)])\s+\S/g;
const PARTS_CUES =
  /\b(each of|every one of|for each|for every|all of the|one by one|per file|per item)\b/i;
const CHAIN_CUES =
  /\b(then|after that|afterwards|step by step|first[, ].*\bthen\b|once .* is done)\b/i;
const PROOF_CUES =
  /\b(prove|proof|derive|research|investigate|design a|architecture|root cause|novel)\b/i;
const CODE_CUES = /(```|\bimplement\b|\brefactor\b|\bdebug\b|\bfix (the )?bug\b|\bmigrate\b)/i;

function localDifficulty(text: string): 1 | 2 | 3 | 4 | 5 {
  if (PROOF_CUES.test(text)) return 5;
  if (CODE_CUES.test(text) || text.length > 1500) return 4;
  if (text.length < 160) return 2;
  return 3;
}

function localShape(text: string): Shape {
  const items = text.match(LIST_CUES)?.length ?? 0;
  if (items >= 3 || PARTS_CUES.test(text)) return "parts";
  if (CHAIN_CUES.test(text) || text.length > 400) return "chain";
  return "answer";
}

export type LocalTaskContext = ReadEnvelope & {
  text: string;
  /** What started the task: a person waiting, or a cron / heartbeat / background job. */
  trigger?: "user" | "cron" | "heartbeat" | "background" | string;
  private: boolean;
};

export function localTaskRead(c: LocalTaskContext): TaskRead {
  const background =
    c.trigger === "cron" || c.trigger === "heartbeat" || c.trigger === "background";
  return {
    id: c.id,
    ts: c.ts,
    sessionKey: c.sessionKey,
    kind: local(classifyTaskDomain(c.text)),
    difficulty: local(localDifficulty(c.text)),
    topic: local(classifySubject(c.text)),
    urgency: local<Urgency>(background ? "whenever" : "waiting"),
    shape: local(localShape(c.text)),
    private: c.private,
  };
}

const READ_TOOLS =
  /^(read|grep|glob|ls|webfetch|websearch|web_fetch|web_search|memory_search|sessions_history)$/i;
export const WRITE_TOOLS = /^(write|edit|notebookedit|multiedit|apply_patch)$/i;
const PLAN_TOOLS = /^(task|agent|todowrite|enterplanmode|sessions_spawn|subagents)$/i;

export type LocalStepContext = ReadEnvelope & {
  callIndex: number;
  toolName?: string;
  /** The harness's own classification: the step changes something outside the conversation. */
  external?: boolean;
};

export function localStepRead(c: LocalStepContext): StepRead {
  const name = c.toolName ?? "";
  const kind: StepKind = READ_TOOLS.test(name)
    ? "read"
    : WRITE_TOOLS.test(name)
      ? "write"
      : PLAN_TOOLS.test(name)
        ? "plan"
        : "tool";
  return {
    id: c.id,
    ts: c.ts,
    sessionKey: c.sessionKey,
    callIndex: c.callIndex,
    kind: local(kind),
    depth: local<Depth>("routine"),
    needs: local<Needs>("all"),
    runLength: local<0 | 1 | 2 | 3 | 4>(0),
    parallelOk: {},
    commitsOrClaims: local(c.external === true || WRITE_TOOLS.test(name)),
  };
}

export type LocalOutcomeContext = ReadEnvelope & {
  callIndex: number;
  repeatedErrors?: number;
  refused?: boolean;
  failed?: boolean;
};

export function localOutcomeRead(c: LocalOutcomeContext): OutcomeRead {
  const state: OutcomeState =
    (c.repeatedErrors ?? 0) >= STUCK_AFTER_ERRORS
      ? "stuck"
      : c.refused
        ? "refused"
        : c.failed
          ? "retry"
          : "done";
  const conf = state === "stuck" ? 1 : LOCAL_CONFIDENCE;
  return {
    id: c.id,
    ts: c.ts,
    callIndex: c.callIndex,
    state: { value: state, conf, source: "local" },
  };
}
