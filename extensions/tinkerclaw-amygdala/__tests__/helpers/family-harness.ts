/**
 * Shared test harness for the family decision tables (Phase D). Every family test builds situations from case
 * files, scripts verdicts by question id, and asserts on the severity of the response, in the same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnState } from "../../src/context.js";
import type { Family, FamilyResult } from "../../src/families/types.js";
import { QuestionBook } from "../../src/question-book.js";
import { severity } from "../../src/respond.js";
import { buildSituation, type SessionContext } from "../../src/situation.js";
import type { CaseFile, Question, Response, Seam, Situation, Verdict } from "../../src/types.js";

const root = new URL("../..", import.meta.url).pathname;
export const seedDir = join(root, "questions");
export const casesRoot = join(root, "cases");
export const book = new QuestionBook({ seedDir });

export function loadCaseFile(kind: "must-catch" | "controls", family: string): CaseFile[] {
  try {
    return (
      JSON.parse(readFileSync(join(casesRoot, kind, `${family}.json`), "utf8")) as {
        cases: CaseFile[];
      }
    ).cases;
  } catch {
    return [];
  }
}

export function freshState(over: Partial<TurnState> = {}): TurnState {
  return {
    sessionKey: "s",
    turnId: "s#1",
    seenNotes: new Set(),
    notesThisCall: 0,
    sendBackAttempts: 0,
    precedentFloor: 0,
    stopTask: false,
    scheduledJobs: [],
    misreadingRisk: "low",
    readings: [],
    futilityWarnings: 0,
    turnHeld: false,
    hurry: false,
    stepCount: 0,
    curiosityStep: -100,
    ...over,
  };
}

/** A full Situation for a seam: built normally, then the case's own fields laid over it. */
export function caseSituation(
  c: CaseFile | null,
  seam: Seam,
  ctx: Partial<SessionContext> = {},
  extra: Partial<Situation> = {},
): Situation {
  const base = buildSituation(
    { seam, sessionKey: "s", turnId: "s#1", now: 1_000, originKind: "synthetic" },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo", ...ctx },
  );
  const { originKind: _o, ...fields } = (c?.situation ?? {}) as Record<string, unknown>;
  return { ...base, ...fields, ...extra } as Situation;
}

/**
 * A verdict for a seed question with the right shape. noul: `answer` is the probability. score: the level (float).
 * choice: the chosen option, `p` its probability (default 0.9), the rest spread over the other options.
 */
export function V(questionId: string, answer: string | number, p = 0.9): Verdict {
  const q = book.get(questionId) as Question;
  if (!q) throw new Error(`no seed question ${questionId}`);
  const base = {
    id: `v-${questionId}`,
    situationId: "sit",
    questionId,
    questionVersion: q.version,
    type: q.type,
    confidence: 0.9,
    cacheHit: false,
    latencyMs: 100,
    tokensIn: 100,
    tokensOut: 5,
    costUsd: 0,
    ts: 1,
  };
  if (q.type === "noul") return { ...base, answer: Number(answer), prob: Number(answer) };
  if (q.type === "score") {
    const levels = (q.criteria as string[]).length;
    return { ...base, answer: Number(answer), prob: Number(answer) / (levels - 1) };
  }
  const options = Object.keys(q.criteria as Record<string, unknown>);
  const rest = options.filter((o) => o !== answer);
  const probs: Record<string, number> = { [String(answer)]: p };
  for (const o of rest) probs[o] = (1 - p) / rest.length;
  return { ...base, answer: String(answer), prob: p, probs };
}

/** The questions a step asked, by id, at the version each verdict was answered under (what `decide` passes as `asked`). */
export function askedFor(vs: Verdict[]): Map<string, Question> {
  const m = new Map<string, Question>();
  for (const v of vs) {
    const q = book.get(v.questionId, v.questionVersion);
    if (q) m.set(q.id, q);
  }
  return m;
}

/** Run one step through a family the way `decide` does: enrich, observe, decide. */
export function result(
  f: Family,
  seam: Seam,
  s: Situation,
  vs: Verdict[],
  state = freshState(),
): FamilyResult | null {
  const asked = askedFor(vs);
  f.enrich?.(seam, s, state);
  f.observe?.(seam, s, vs, state, asked);
  return f.decide(seam, s, vs, state, asked);
}

/** The response of a family at a seam (proceed when it has no opinion). */
export function respond(
  f: Family,
  seam: Seam,
  s: Situation,
  vs: Verdict[],
  state = freshState(),
): Response {
  return result(f, seam, s, vs, state)?.response ?? { kind: "proceed" };
}

/** must-catch: at least this severe. control: at most this severe. */
export function meetsFloor(r: Response, floor: Response["kind"]): boolean {
  return severity(r) >= severity({ kind: floor } as Response);
}
export function meetsCeiling(r: Response, ceiling: Response["kind"]): boolean {
  return severity(r) <= severity({ kind: ceiling } as Response);
}

/**
 * The verdicts a case scripts through its `answers` (noul: answer = probability; score: the level; choice: the option,
 * `prob` its probability). A case with no `answers` yields none.
 */
export function verdictsFromCase(c: CaseFile): Verdict[] {
  return Object.entries(c.answers ?? {}).map(([id, a]) => {
    const v = V(id, a.answer as string | number, a.prob ?? 0.9);
    return a.probs ? { ...v, probs: a.probs } : v;
  });
}
