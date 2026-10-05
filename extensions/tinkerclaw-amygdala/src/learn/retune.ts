/**
 * Online retune (design doc §7.3 items 4 and 6): cut-off changes that need no model call, only stored probabilities.
 * A user-marked miss tightens the cut-off just under the verdict that stayed quiet (in that context, and globally when
 * the misses are spread and the global change is cheap); a context that raised only false alarms is loosened just
 * above the loudest of them. This module only PROPOSES: the change engine replays, caps, applies or turns a proposal
 * into a card. Hard rules are code and are never proposed here.
 */
import { crosses, isCannotTell, massOutside, optionProb } from "../families/common.js";
import type { QuestionBook } from "../question-book.js";
import type { AmygdalaStore } from "../store.js";
import type { Cutoff, Question, Situation, Verdict } from "../types.js";
import { contextKey } from "./keys.js";
import { viewFrom } from "./replay.js";
import type { ChangeEngineApi, ChangeOutcome } from "./types.js";

const DAY = 86_400_000;
const PROB_FLOOR = 0.05;
const PROB_CAP = 0.99;
const RECENT_VERDICTS = 500;
/** How far below its cut-off a quiet verdict may be and still count as a near miss (in that question's own units). */
const NEAR_MISS_PROB = 0.35;
const NEAR_MISS_LEVEL = 1;

export interface RetuneDeps {
  store: AmygdalaStore;
  book: QuestionBook;
  engine: ChangeEngineApi;
  now: () => number;
  cfg?: { minFalseAlarms: number; minRatio: number; windowDays: number; globalBudget: number };
}

const DEFAULT_CFG = { minFalseAlarms: 5, minRatio: 0.9, windowDays: 30, globalBudget: 0.02 };

const round2 = (n: number) => Math.round(n * 100) / 100;

function usable(v: Verdict): boolean {
  return !v.skipped && !isCannotTell(v);
}

/** The number a cut-off of this kind is compared with (level cut-offs compare the answer itself). */
function measureOf(c: Cutoff, v: Verdict): number | null {
  switch (c.kind) {
    case "prob":
      return v.prob;
    case "choice":
      return v.type !== "choice"
        ? null
        : c.negate
          ? massOutside(v, c.option)
          : optionProb(v, c.option);
    case "level":
      return typeof v.answer === "number" ? v.answer : null;
    case "none":
      return null;
  }
}

/** A cut-off just under a verdict that stayed below the current one, and how far below it was; null when not applicable. */
function tightenFor(q: Question, v: Verdict): { cutoff: Cutoff; gap: number } | null {
  const c = q.cutoff;
  const m = measureOf(c, v);
  if (m === null || crosses(q, v)) return null;
  if (c.kind === "prob" || c.kind === "choice") {
    const at = round2(Math.max(PROB_FLOOR, m - 0.05));
    if (at >= c.at) return null;
    return { cutoff: { ...c, at }, gap: c.at - m };
  }
  if (c.kind === "level") {
    if (c.atOrAbove !== undefined) {
      const n = Math.floor(m);
      return n < c.atOrAbove
        ? { cutoff: { kind: "level", atOrAbove: n }, gap: c.atOrAbove - m }
        : null;
    }
    if (c.atOrBelow !== undefined) {
      const n = Math.ceil(m);
      return n > c.atOrBelow
        ? { cutoff: { kind: "level", atOrBelow: n }, gap: m - c.atOrBelow }
        : null;
    }
  }
  return null;
}

/** Of two tightenings of the same question, the one that catches more. */
function tighterOf(a: Cutoff, b: Cutoff): Cutoff {
  if (a.kind === "level" && b.kind === "level") {
    if (a.atOrBelow !== undefined && b.atOrBelow !== undefined)
      return a.atOrBelow >= b.atOrBelow ? a : b;
    if (a.atOrAbove !== undefined && b.atOrAbove !== undefined)
      return a.atOrAbove <= b.atOrAbove ? a : b;
    return a;
  }
  if ((a.kind === "prob" || a.kind === "choice") && (b.kind === "prob" || b.kind === "choice")) {
    return a.at <= b.at ? a : b;
  }
  return a;
}

export async function tightenFromMisses(d: RetuneDeps, sinceTs?: number): Promise<ChangeOutcome[]> {
  const view = viewFrom(d.book, d.store);
  // question → context → the tightest cut-off any miss in that context asks for
  const wanted = new Map<string, Map<string, Cutoff>>();
  const seen = new Set<string>();
  for (const label of d.store.listLabels({ kind: "miss", sinceTs, limit: 100_000 })) {
    if (label.targetKind !== "decision" || seen.has(label.targetId)) continue;
    seen.add(label.targetId);
    const dec = d.store.getDecision(label.targetId);
    const sit = dec ? d.store.situationRecord(dec.situationId) : undefined;
    if (!dec || !sit) continue;
    // Every question that stayed quiet by a NEAR miss is a candidate: which one governed the outcome is not known, and
    // a change that alters nothing is rejected by the replay as no-effect, so proposing more than one is safe.
    for (const v of d.store.queryVerdicts({ situationId: dec.situationId })) {
      if (!usable(v)) continue;
      const q = view(v.questionId, sit);
      if (!q || q.status !== "active") continue;
      const t = tightenFor(q, v);
      if (!t || t.gap > (q.cutoff.kind === "level" ? NEAR_MISS_LEVEL : NEAR_MISS_PROB)) continue;
      const key = contextKey(sit, q.id);
      const perCtx = wanted.get(q.id) ?? new Map<string, Cutoff>();
      const prev = perCtx.get(key);
      perCtx.set(key, prev ? tighterOf(prev, t.cutoff) : t.cutoff);
      wanted.set(q.id, perCtx);
    }
  }

  const cfg = { ...DEFAULT_CFG, ...d.cfg };
  const outcomes: ChangeOutcome[] = [];
  for (const [questionId, perCtx] of wanted) {
    for (const [key, cutoff] of perCtx) {
      outcomes.push(
        await d.engine.propose(
          { kind: "cutoff", scope: "context", questionId, contextKey: key, cutoff },
          { proposedBy: "code" },
        ),
      );
    }
    if (perCtx.size < 3) continue;
    const q = d.book.get(questionId);
    if (!q) continue;
    let global: Cutoff | null = null;
    for (const c of perCtx.values()) global = global ? tighterOf(global, c) : c;
    if (!global) continue;
    const recent = d.store.queryVerdicts({ questionId }).slice(-RECENT_VERDICTS);
    const after = { ...q, cutoff: global };
    const newly = recent.filter((v) => !crosses(q, v) && crosses(after, v)).length;
    if (recent.length > 0 && newly / recent.length > cfg.globalBudget) continue;
    outcomes.push(
      await d.engine.propose(
        { kind: "cutoff", scope: "global", questionId, cutoff: global },
        { proposedBy: "code" },
      ),
    );
  }
  return outcomes;
}

/** A cut-off just above the loudest false alarm, or null when that would leave the question's scale. */
function loosenFor(q: Question, falseAlarms: Verdict[]): Cutoff | null {
  const c = q.cutoff;
  const ms = falseAlarms.map((v) => measureOf(c, v)).filter((m): m is number => m !== null);
  if (ms.length === 0) return null;
  if (c.kind === "prob" || c.kind === "choice") {
    const at = round2(Math.max(...ms) + 0.02);
    return at > PROB_CAP || at <= c.at ? null : { ...c, at };
  }
  if (c.kind === "level") {
    if (c.atOrAbove !== undefined) {
      const n = Math.floor(Math.max(...ms)) + 1;
      const top = Array.isArray(q.criteria) ? q.criteria.length - 1 : n;
      return n > top || n <= c.atOrAbove ? null : { kind: "level", atOrAbove: n };
    }
    if (c.atOrBelow !== undefined) {
      const n = Math.ceil(Math.min(...ms)) - 1;
      return n < 0 || n >= c.atOrBelow ? null : { kind: "level", atOrBelow: n };
    }
  }
  return null;
}

export async function loosenFromFalseAlarms(d: RetuneDeps): Promise<ChangeOutcome[]> {
  const cfg = { ...DEFAULT_CFG, ...d.cfg };
  const since = d.now() - cfg.windowDays * DAY;
  const rows = d.store
    .listContextCounts({ sinceTs: since })
    .filter(
      (r) =>
        r.falseAlarms >= cfg.minFalseAlarms &&
        r.confirms === 0 &&
        r.alarms > 0 &&
        r.falseAlarms / r.alarms >= cfg.minRatio,
    );
  if (rows.length === 0) return [];
  const view = viewFrom(d.book, d.store);
  const labels = d.store
    .listLabels({ sinceTs: since, limit: 100_000 })
    .filter((l) => (l.kind === "judge" || l.kind === "useful") && l.value === -1);
  const byQuestion = new Map<string, Verdict[]>();
  const verdictsOf = (qid: string) => {
    let vs = byQuestion.get(qid);
    if (!vs) byQuestion.set(qid, (vs = d.store.queryVerdicts({ questionId: qid })));
    return vs;
  };

  const outcomes: ChangeOutcome[] = [];
  for (const row of rows) {
    const q0 = d.book.get(row.questionId);
    if (!q0 || q0.status !== "active") continue;
    const all = verdictsOf(row.questionId);
    const alarms: Verdict[] = [];
    let sample: Situation | undefined;
    for (const l of labels) {
      let situationId: string | undefined;
      let picked: Verdict[] = [];
      if (l.targetKind === "decision") {
        situationId = d.store.getDecision(l.targetId)?.situationId;
        picked = all.filter((v) => v.situationId === situationId);
      } else {
        const v = all.find((x) => x.id === l.targetId);
        situationId = v?.situationId;
        picked = v ? [v] : [];
      }
      if (!situationId || picked.length === 0) continue;
      const sit = d.store.situationRecord(situationId);
      if (!sit || contextKey(sit, row.questionId) !== row.contextKey) continue;
      sample = sit;
      alarms.push(...picked.filter(usable));
    }
    if (!sample || alarms.length === 0) continue;
    const q = view(row.questionId, sample);
    if (!q) continue;
    const cutoff = loosenFor(q, alarms);
    if (!cutoff) continue;
    outcomes.push(
      await d.engine.propose(
        {
          kind: "cutoff",
          scope: "context",
          questionId: row.questionId,
          contextKey: row.contextKey,
          cutoff,
        },
        { proposedBy: "code" },
      ),
    );
  }
  return outcomes;
}

export async function retuneOnline(
  d: RetuneDeps,
  sinceTs?: number,
): Promise<{ tighten: ChangeOutcome[]; loosen: ChangeOutcome[] }> {
  const tighten = await tightenFromMisses(d, sinceTs);
  const loosen = await loosenFromFalseAlarms(d);
  return { tighten, loosen };
}

/**
 * A pure grid refit of a probability cut-off. Every cut-off that catches all must-catch probabilities is allowed;
 * among those, only the ones that keep the best recall on labelled positives; of those the fewest false alarms wins,
 * ties going to the higher cut-off. Null when no grid cut-off catches every must-catch probability.
 */
export function suggestProbCutoff(
  labelled: { prob: number; positive: boolean }[],
  mustCatchProbs: number[],
  grid: number[] = Array.from({ length: 19 }, (_, i) => round2(0.05 * (i + 1))),
): number | null {
  const eps = 1e-9;
  const floor = mustCatchProbs.length ? Math.min(...mustCatchProbs) : Infinity;
  const allowed = grid.filter((c) => c <= floor + eps);
  if (allowed.length === 0) return null;
  const positives = labelled.filter((l) => l.positive);
  const recallAt = (c: number) => positives.filter((l) => l.prob >= c - eps).length;
  const falseAt = (c: number) => labelled.filter((l) => !l.positive && l.prob >= c - eps).length;
  const bestRecall = Math.max(...allowed.map(recallAt));
  let pick: number | null = null;
  for (const c of allowed) {
    if (recallAt(c) < bestRecall) continue;
    if (pick === null || falseAt(c) < falseAt(pick) || (falseAt(c) === falseAt(pick) && c > pick))
      pick = c;
  }
  return pick;
}
