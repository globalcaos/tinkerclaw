// Jev replayed from what it actually said (Broca retrieval v2, phase C replay).
//
// WHAT THIS IS FOR. The ranking stage needs a held-out score before a live sample can say anything about it, and the
// ledger holds what Jev answered at the time of every task: the list it gave, with each card's probability. This builds the
// verdicts a mocked Jev would give if it said exactly that, so the new ranker (enhancement-rank.ts) can be run over recall's
// candidates for a past task and scored against what the agent used.
//
// WHAT IT IS NOT. It is not Jev ranking recall's candidates; it is the recorded answer fed through the new plumbing. A card
// the recorded list did not name gets no answer, so it stays local at its recall position, the same as a card Jev left
// unanswered would. The recorded list was made from the whole catalogue in another question shape, so this measures how the
// pipeline orders recorded Jev picks and recall's rest, not how well Jev would rank these fifteen. The live sample
// (scripts/broca-rank-live.ts) is the measurement of Jev itself.
//
// NO LEAK. The input is the recording alone (list source, shown cards with their probabilities), written before the agent
// acted. Nothing about what the agent went on to use is a parameter, so it cannot reach a verdict; a test pins that.
//
// WHAT WOULD CHANGE IT. A ledger that keeps Jev's raw per-question verdicts: then the replay would use those instead.

import type { JevVerdict } from "../infra/jev/types.js";
import {
  FLAT_RANK_QUESTION_ID,
  type RankedEntry,
  type RankItem,
  type RankQuestions,
} from "./enhancement-rank.js";

/** What the ledger kept about the list a task was shown. */
export type Recording = {
  listSource: "jev" | "local";
  shown: ReadonlyArray<{ cardId: string; prob: number }>;
};

const base = (questionId: string): Omit<JevVerdict, "answer" | "type" | "prob" | "confidence"> => ({
  id: `replay-${questionId}`,
  situationId: "replay",
  questionId,
  questionVersion: 1,
  cacheHit: false,
  latencyMs: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  ts: 0,
});

/** The verdicts a Jev that said what the ledger recorded would give for these questions. */
export function recordedVerdicts(
  items: readonly RankItem[],
  built: RankQuestions,
  rec: Recording,
): JevVerdict[] {
  if (rec.listSource === "local") {
    // Jev was silent when this task started. The ledger does not say why; the label is irrelevant to a hit.
    return built.questions.map((q) => ({
      ...base(q.id),
      type: "choice" as const,
      answer: "",
      prob: 0,
      confidence: 0,
      skipped: "timeout" as const,
    }));
  }
  const probOf = new Map(rec.shown.map((e) => [e.cardId, e.prob] as const));
  const out: JevVerdict[] = [];
  const shares: Record<string, number> = {};
  items.forEach((item, i) => {
    const p = probOf.get(item.cardId);
    if (p === undefined) return;
    const clamped = Math.min(1, Math.max(0, p));
    shares[`c${i + 1}`] = clamped;
    out.push({
      ...base(built.byItem[i].mode),
      type: "choice",
      answer: "USE",
      prob: clamped,
      confidence: 1,
      probs: { USE: clamped, INSPIRE: 0, NO: 1 - clamped },
    });
  });
  const named = Object.entries(shares);
  if (named.length === 0) return out;
  const best = named.toSorted((a, b) => b[1] - a[1])[0][0];
  const none = Math.max(0, 1 - named.reduce((a, [, v]) => a + v, 0));
  out.push({
    ...base(FLAT_RANK_QUESTION_ID),
    type: "choice",
    answer: none > shares[best] ? "none" : best,
    prob: Math.max(none, shares[best]),
    confidence: 1,
    probs: { ...shares, none },
  });
  return out;
}

/** Where the first used card sits on a ranked list, and whose entry it is. Undefined when none of them is on it. */
export function firstHit(
  list: ReadonlyArray<Pick<RankedEntry, "cardId" | "source">>,
  used: ReadonlySet<string>,
): { position: number; source: RankedEntry["source"] } | undefined {
  const at = list.findIndex((e) => used.has(e.cardId));
  return at < 0 ? undefined : { position: at, source: list[at].source };
}
