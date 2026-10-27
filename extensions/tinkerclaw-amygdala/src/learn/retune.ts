/**
 * Online retune (design doc §7.3 items 4 and 6): cut-off changes that need no model call, only stored probabilities.
 * A user-marked miss tightens the cut-off just under the verdict that stayed quiet (in that context, and globally when
 * the misses are spread and the global change is cheap); a context that raised only false alarms is loosened just
 * above the loudest of them. This module only PROPOSES: the change engine replays, caps, applies or turns a proposal
 * into a card. Hard rules are code and are never proposed here.
 *
 * The reviewers count too (2026-10-25): until then this learned from the owner's 37 labels and never from the 3,288
 * flags and 5,574 passes the after-the-fact reviewer had judged. A pass judged `missed` is a miss; a flag judged noise or
 * harmful is a false alarm in its driver question's context, one judged useful a confirm, harmless only judged. A
 * low-confidence miss or false alarm is not counted (a low-confidence confirm is: doubt never loosens). Any loosening the
 * reviews contributed to goes to the owner as a pending card (`ownerOnly`), never applied by code.
 */
import { parseDrivers } from "../events.js";
import { crosses, isCannotTell, massOutside, optionProb } from "../families/common.js";
import type { QuestionBook } from "../question-book.js";
import type { AmygdalaStore } from "../store.js";
import type { ContextCount, Cutoff, Question, Situation, Verdict } from "../types.js";
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

/** The decisions a miss points at: the owner's miss labels, then the passes a reviewer judged missed (not low). */
function missedDecisions(d: RetuneDeps, sinceTs: number | undefined, windowDays: number): string[] {
  const ids: string[] = [];
  for (const label of d.store.listLabels({ kind: "miss", sinceTs, limit: 100_000 })) {
    if (label.targetKind === "decision") ids.push(label.targetId);
  }
  for (const r of d.store.reviewEvidence(sinceTs ?? d.now() - windowDays * DAY)) {
    if (r.kind === "pass" && r.verdict === "missed" && r.confidence !== "low")
      ids.push(r.decisionId);
  }
  return ids;
}

export async function tightenFromMisses(d: RetuneDeps, sinceTs?: number): Promise<ChangeOutcome[]> {
  const cfg = { ...DEFAULT_CFG, ...d.cfg };
  const view = viewFrom(d.book, d.store);
  // question → context → the tightest cut-off any miss in that context asks for
  const wanted = new Map<string, Map<string, Cutoff>>();
  const seen = new Set<string>();
  for (const decisionId of missedDecisions(d, sinceTs, cfg.windowDays)) {
    if (seen.has(decisionId)) continue;
    seen.add(decisionId);
    const dec = d.store.getDecision(decisionId);
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

/** What the reviewers say about one question in one context (2026-10-25). */
interface ReviewedContext {
  falseAlarms: number;
  confirms: number;
  judged: number;
  /** The driver question's verdicts on the flags judged noise or harmful. */
  alarms: Verdict[];
  sample: Situation;
}

/** The flag reviews of the window, per driver question and context. */
function reviewedContexts(d: RetuneDeps, since: number): Map<string, ReviewedContext> {
  const out = new Map<string, ReviewedContext>();
  const sits = new Map<string, Situation | undefined>();
  for (const r of d.store.reviewEvidence(since)) {
    if (r.kind !== "flag") continue;
    const falseAlarm = (r.verdict === "noise" || r.verdict === "harmful") && r.confidence !== "low";
    const confirm = r.verdict === "useful";
    const drivers = parseDrivers(r.reasonCode);
    if (drivers.length === 0) continue;
    if (!sits.has(r.situationId)) sits.set(r.situationId, d.store.situationRecord(r.situationId));
    const sit = sits.get(r.situationId);
    if (!sit) continue;
    const verdicts = falseAlarm ? d.store.queryVerdicts({ situationId: r.situationId }) : [];
    for (const q of drivers) {
      const key = `${q}\u0000${contextKey(sit, q)}`;
      let e = out.get(key);
      if (!e)
        out.set(key, (e = { falseAlarms: 0, confirms: 0, judged: 0, alarms: [], sample: sit }));
      e.judged++;
      if (confirm) e.confirms++;
      if (falseAlarm) {
        e.falseAlarms++;
        e.alarms.push(...verdicts.filter((v) => v.questionId === q && usable(v)));
      }
    }
  }
  return out;
}

export async function loosenFromFalseAlarms(d: RetuneDeps): Promise<ChangeOutcome[]> {
  const cfg = { ...DEFAULT_CFG, ...d.cfg };
  const since = d.now() - cfg.windowDays * DAY;
  const reviewed = reviewedContexts(d, since);
  const counts = new Map(
    d.store
      .listContextCounts({ sinceTs: since })
      .map((r) => [`${r.questionId}\u0000${r.contextKey}`, r]),
  );
  const ownerOk = (r: ContextCount | undefined): boolean =>
    r !== undefined &&
    r.falseAlarms >= cfg.minFalseAlarms &&
    r.confirms === 0 &&
    r.alarms > 0 &&
    r.falseAlarms / r.alarms >= cfg.minRatio;
  // A context the reviews speak of counts their verdicts with the owner's labels, over every alarm either judged.
  const reviewsOk = (r: ContextCount | undefined, rv: ReviewedContext): boolean => {
    const fa = (r?.falseAlarms ?? 0) + rv.falseAlarms;
    const judged = (r?.alarms ?? 0) + rv.judged;
    return (
      fa >= cfg.minFalseAlarms &&
      (r?.confirms ?? 0) + rv.confirms === 0 &&
      judged > 0 &&
      fa / judged >= cfg.minRatio
    );
  };
  const keys = [...new Set([...counts.keys(), ...reviewed.keys()])].filter((k) => {
    const rv = reviewed.get(k);
    return rv ? reviewsOk(counts.get(k), rv) : ownerOk(counts.get(k));
  });
  if (keys.length === 0) return [];
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
  for (const key of keys) {
    const [questionId = "", ctx = ""] = key.split("\u0000");
    const q0 = d.book.get(questionId);
    if (!q0 || q0.status !== "active") continue;
    const rv = reviewed.get(key);
    const alarms: Verdict[] = [...(rv?.alarms ?? [])];
    let sample: Situation | undefined = rv?.sample;
    if (counts.has(key)) {
      const all = verdictsOf(questionId);
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
        if (!sit || contextKey(sit, questionId) !== ctx) continue;
        sample = sit;
        alarms.push(...picked.filter(usable));
      }
    }
    if (!sample || alarms.length === 0) continue;
    const q = view(questionId, sample);
    if (!q) continue;
    const cutoff = loosenFor(q, alarms);
    if (!cutoff) continue;
    outcomes.push(
      await d.engine.propose(
        { kind: "cutoff", scope: "context", questionId, contextKey: ctx, cutoff },
        { proposedBy: "code", ...(rv ? { ownerOnly: true } : {}) },
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
