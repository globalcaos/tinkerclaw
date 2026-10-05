/**
 * The nightly lane (design doc §7.3 items 3 and 7): the free online retune first, then a worklist of the questions whose
 * replay cases fail, then (only when a proposer is given) one reword proposal per work item. The proposer is a language
 * model in production; it never grades itself, acceptance is entirely the change engine's replay. A work item carries
 * ids and scripted answers only, never a question's wording. Nothing here schedules, spawns or edits cron.
 */
import { loadReplayCorpus } from "../cases.js";
import type { Family } from "../families/types.js";
import type { CaseFile } from "../types.js";
import { replayCorpus, viewFrom } from "./replay.js";
import { retuneOnline, type RetuneDeps } from "./retune.js";
import type { ChangeOutcome, FailingCase, Proposer } from "./types.js";

export interface NightlyDeps extends RetuneDeps {
  families: () => Family[];
  casesRoot: string;
  proposer?: Proposer;
}

export interface WorkItem {
  questionId: string;
  failing: FailingCase[];
}

function expectedOf(c: CaseFile): string {
  return c.kind === "must-catch" ? `at least ${c.mustBeAtLeast}` : `at most ${c.mustBeAtMost}`;
}

export async function nightlyWorklist(d: NightlyDeps): Promise<WorkItem[]> {
  const corpus = loadReplayCorpus(d.casesRoot);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const results = replayCorpus(corpus, viewFrom(d.book, d.store), d.families());
  const items = new Map<string, FailingCase[]>();
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (r.ok || !c) continue;
    for (const questionId of Object.keys(c.answers ?? {})) {
      if (!d.book.get(questionId)) continue;
      const list = items.get(questionId) ?? [];
      list.push({
        caseId: c.id,
        expected: expectedOf(c),
        got: r.response,
        answers: structuredClone(c.answers ?? {}),
      });
      items.set(questionId, list);
    }
  }
  return [...items.keys()]
    .toSorted()
    .map((questionId) => ({ questionId, failing: items.get(questionId) ?? [] }));
}

export async function runNightly(d: NightlyDeps): Promise<{
  online: { tighten: ChangeOutcome[]; loosen: ChangeOutcome[] };
  worklist: WorkItem[];
  proposals: { questionId: string; outcome: ChangeOutcome }[];
}> {
  const online = await retuneOnline(d);
  const worklist = await nightlyWorklist(d);
  const proposals: { questionId: string; outcome: ChangeOutcome }[] = [];
  if (!d.proposer) return { online, worklist, proposals };
  for (const item of worklist) {
    const question = d.book.get(item.questionId);
    if (!question) continue;
    let candidate;
    try {
      candidate = await d.proposer({ question, failing: item.failing });
    } catch (err) {
      console.error("[amygdala] proposer failed", err);
      continue;
    }
    if (!candidate) continue;
    const outcome = await d.engine.propose(
      { kind: "reword", questionId: item.questionId, candidate },
      { proposedBy: "nightly-proposer" },
    );
    proposals.push({ questionId: item.questionId, outcome });
  }
  return { online, worklist, proposals };
}
