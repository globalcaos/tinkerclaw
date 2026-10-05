/**
 * Two-sided replay for the learning loop (design doc §7.3 item 3). A case file scripts how the judge answers, so a
 * change to a question can be replayed with no Jev call: the same case is run through every family under the view of
 * the questions BEFORE a proposal and under the view AFTER it, and the two response sets are compared.
 * Pure: no store writes, no clock, no network.
 */
import { newTurnState } from "../context.js";
import { crosses } from "../families/common.js";
import type { Family } from "../families/types.js";
import type { QuestionBook } from "../question-book.js";
import { mergeResponses, SEVERITY, type Candidate } from "../respond.js";
import { buildSituation } from "../situation.js";
import type { AmygdalaStore } from "../store.js";
import type { CaseFile, Question, Response, Seam, Situation, Verdict } from "../types.js";
import { contextKey } from "./keys.js";
import type { Proposal } from "./types.js";

/** The effective question at a situation: version, cut-off and any per-context override already applied. */
export type QuestionView = (id: string, s: Situation) => Question | undefined;

export interface AnswerOverride {
  answer: string | number | boolean;
  prob?: number;
  probs?: Record<string, number>;
}

/** The CURRENT view: the active version of the book, plus a stored context override when its context key matches. */
export function viewFrom(book: QuestionBook, store: AmygdalaStore): QuestionView {
  return (id, s) => {
    const q = book.get(id);
    if (!q) return undefined;
    const ov = store.getContextOverride(id, contextKey(s, id));
    return ov ? { ...q, cutoff: ov } : q;
  };
}

/** The view AFTER a proposal. A retired question is `off`: it is not asked, so it yields no answer. */
export function viewWith(base: QuestionView, p: Proposal): QuestionView {
  return (id, s) => {
    const q = base(id, s);
    if (!q || id !== p.questionId) return q;
    if (p.kind === "cutoff") {
      if (p.scope === "context" && contextKey(s, id) !== p.contextKey) return q;
      return { ...q, cutoff: p.cutoff };
    }
    if (p.kind === "retire") return { ...q, status: "off" };
    const c = p.candidate;
    return {
      ...q,
      ...(c.instructions !== undefined ? { instructions: c.instructions } : {}),
      ...(c.criteria !== undefined ? { criteria: c.criteria } : {}),
      ...(c.fields !== undefined ? { fields: c.fields } : {}),
      ...(c.cutoff !== undefined ? { cutoff: c.cutoff } : {}),
      version: q.version + 1,
      parent: q.version,
      origin: "learned",
    };
  };
}

export interface CaseResult {
  caseId: string;
  kind: CaseFile["kind"];
  response: Response["kind"];
  /** Meets its floor (must-catch) or ceiling (control). */
  ok: boolean;
}

// pre-tool first: a case that answers a pre-tool question is a pre-tool step, whatever else it answers.
const SEAM_PREFERENCE: readonly Seam[] = ["pre-tool", "stop", "post-tool", "prompt"];

// Case fields that production feeds `buildSituation` through the session context rather than the tool input.
const SESSION_FIELDS = [
  "request",
  "toolRecord",
  "restatement",
  "expectation",
  "draftCommitments",
  "repeatedErrors",
  "stepsSinceNewFact",
  "recentHolds",
  "standingFacts",
  "provenance",
  "holdNeeds",
  "candidates",
  "scheduledJobs",
  "claims",
  "similarIncidents",
] as const;

/**
 * A situation for the case at a seam (default pre-tool), built the way production builds one: the case's tool and
 * command go through `buildSituation`, so the derived fields (effect class, targets) exist even when the case does not
 * write them out; then the case's own fields are laid over the result and win. Without the derivation a case that
 * omits `effectClass` reached the families with none, and a change to a question was replayed against a step the real
 * system would have read differently.
 */
export function caseSituation(c: CaseFile, seam: Seam = "pre-tool"): Situation {
  const own = structuredClone(c.situation) as Record<string, { value?: unknown } | string>;
  const val = (name: string): unknown =>
    (own[name] as { value?: unknown } | undefined)?.value ?? undefined;
  const session: Record<string, unknown> = { workspaceRoot: "/work/demo", homeDir: "/home/demo" };
  for (const k of SESSION_FIELDS) if (val(k) !== undefined) session[k] = val(k);
  const command = val("command");
  const base = buildSituation(
    {
      seam,
      sessionKey: "replay",
      turnId: `${c.id}#1`,
      now: 1_000,
      originKind: "synthetic",
      tool: val("tool") as string | undefined,
      toolInput:
        typeof command === "string"
          ? { command }
          : (val("args") as Record<string, unknown> | undefined),
      prompt: seam === "prompt" ? (val("request") as string | undefined) : undefined,
      reply: val("reply") as string | undefined,
    },
    session as unknown as Parameters<typeof buildSituation>[1],
  );
  const { originKind: _o, ...fields } = own;
  return { ...base, ...fields, seam } as Situation;
}

/** The seam of the case's answered questions; a retired or unknown question does not count. */
export function caseSeam(c: CaseFile, view: QuestionView): Seam {
  const probe = caseSituation(c);
  const qs = Object.keys(c.answers ?? {})
    .map((id) => view(id, probe))
    .filter((q): q is Question => q !== undefined && q.status === "active");
  for (const seam of SEAM_PREFERENCE) if (qs.some((q) => q.seams.includes(seam))) return seam;
  return "pre-tool";
}

/** Verdicts the case scripts, shaped by the effective question's type. Retired or unknown questions give none. */
export function verdictsFromAnswers(
  c: CaseFile,
  s: Situation,
  view: QuestionView,
  override?: Record<string, AnswerOverride>,
): Verdict[] {
  const out: Verdict[] = [];
  for (const [id, scripted] of Object.entries(c.answers ?? {})) {
    const q = view(id, s);
    if (!q || q.status !== "active") continue;
    const a = override?.[id] ?? scripted;
    const base = {
      id: `replay-${c.id}-${id}`,
      situationId: s.id,
      questionId: id,
      questionVersion: q.version,
      type: q.type,
      confidence: 0.9,
      cacheHit: false,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      ts: s.ts,
    };
    if (q.type === "noul") {
      out.push({ ...base, answer: Number(a.answer), prob: Number(a.answer) });
    } else if (q.type === "score") {
      const levels = Array.isArray(q.criteria) ? q.criteria.length : 2;
      out.push({
        ...base,
        answer: Number(a.answer),
        prob: Number(a.answer) / Math.max(1, levels - 1),
      });
    } else {
      const p = a.prob ?? 0.9;
      const rest = Object.keys(q.criteria as Record<string, unknown>).filter((o) => o !== a.answer);
      const probs: Record<string, number> = a.probs ?? { [String(a.answer)]: p };
      if (!a.probs) for (const o of rest) probs[o] = (1 - p) / Math.max(1, rest.length);
      out.push({ ...base, answer: String(a.answer), prob: p, probs });
    }
  }
  return out;
}

function meets(c: CaseFile, r: Response): boolean {
  if (c.mustBeAtLeast !== undefined && SEVERITY[r.kind] < SEVERITY[c.mustBeAtLeast]) return false;
  if (c.mustBeAtMost !== undefined && SEVERITY[r.kind] > SEVERITY[c.mustBeAtMost]) return false;
  return true;
}

/** Runs one case the way `decide` does (enrich all, observe all, decide all, merge by severity) with a fresh turn state. */
export function runCase(
  c: CaseFile,
  view: QuestionView,
  families: Family[],
  override?: Record<string, AnswerOverride>,
): CaseResult {
  const seam = caseSeam(c, view);
  const s = caseSituation(c, seam);
  // A case that scripts a procedure choice names its candidates in the request text, not in a field: list three.
  if (c.answers?.["procedure-choice"] && s.candidates.value === null) {
    s.candidates = {
      value: [1, 2, 3].map((n) => ({
        id: `replay-candidate-${n}`,
        description: "test-description",
      })),
      origin: "derived",
    };
  }
  const state = newTurnState("replay", `${c.id}#1`);
  // The must-catch cases are written for a request whose reading is still open (the family tests replay them the same
  // way); with a settled reading the safety table alone would not reach their floor and they could never be "lost".
  if (c.kind === "must-catch") state.misreadingRisk = "high";
  const verdicts = verdictsFromAnswers(c, s, view, override);
  const asked = new Map<string, Question>();
  for (const v of verdicts) {
    const q = view(v.questionId, s);
    if (q) asked.set(q.id, q);
  }
  for (const f of families) f.enrich?.(seam, s, state);
  for (const f of families) f.observe?.(seam, s, verdicts, state, asked);
  const cands: Candidate[] = [];
  for (const f of families) {
    const res = f.decide(seam, s, verdicts, state, asked);
    if (res) cands.push({ response: res.response, family: f.id, reasonCode: res.reasonCode });
  }
  const response = mergeResponses(cands).response;
  return { caseId: c.id, kind: c.kind, response: response.kind, ok: meets(c, response) };
}

export function replayCorpus(
  cases: CaseFile[],
  view: QuestionView,
  families: Family[],
  overrides?: ReadonlyMap<string, Record<string, AnswerOverride>>,
): CaseResult[] {
  return cases.map((c) => runCase(c, view, families, overrides?.get(c.id)));
}

/** What the exceptional test (C12) reads off a case. */
export function caseDetail(c: CaseFile): {
  effectClass: string | null;
  danger: number | null;
  egress: boolean;
} {
  const d = c.answers?.["danger-level"]?.answer;
  const tier = c.answers?.["data-tier"]?.answer;
  const dest = c.answers?.["destination-privacy"]?.answer;
  return {
    effectClass: (c.situation.effectClass?.value as string | null | undefined) ?? null,
    danger: typeof d === "number" ? d : null,
    egress: tier === "harmful-if-seen" && (dest === "shared" || dest === "public"),
  };
}

/** The verdicts of one stored situation reduced to the same three facts (the stored history's side of the exceptional test). */
export function storedDetail(
  s: Situation | undefined,
  verdicts: readonly Verdict[],
): { effectClass: string | null; danger: number | null; egress: boolean } {
  const ans = (id: string) => verdicts.find((v) => v.questionId === id && !v.skipped)?.answer;
  const d = ans("danger-level");
  return {
    effectClass: s?.effectClass.value ?? null,
    danger: typeof d === "number" ? d : null,
    egress:
      ans("data-tier") === "harmful-if-seen" &&
      (ans("destination-privacy") === "shared" || ans("destination-privacy") === "public"),
  };
}

/** For the stored history: does this verdict reach the cut-off of the question under a view? */
export function verdictCrosses(view: QuestionView, s: Situation, v: Verdict): boolean {
  return crosses(view(v.questionId, s), v);
}
