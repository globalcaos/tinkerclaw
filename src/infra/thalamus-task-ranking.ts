// The seam between THALAMUS and Broca's matcher for ONE ranked result per task (Broca retrieval v2, phase E).
//
// WHAT THIS IS FOR. Both readers want the same thing at the start of a task: which skills, recipes and plugins fit, split
// into a direct USE and an INSPIRE. Asking Jev twice for it, or ranking twice and getting two answers, is what the
// 2026-10-05 review found wrong. The Thalamus runtime registers a ranker here; the first hook of a run that asks starts
// it, the second gets the same promise. The matcher (priority 20) runs before the short-list seam (priority 0), so
// either may be first. With no ranker registered (Thalamus off) `requestTaskRanking` answers undefined and each reader
// does what it did before.
//
// The state lives on `globalThis` under a Symbol.for key, like the other Thalamus seams, so both extensions agree on it
// whatever copy of this module each bundle holds.

import type { TaskRanking } from "../shared/enhancement-task-rank.js";

export type TaskRankInput = {
  runId: string;
  sessionKey: string;
  text: string;
  trigger?: string;
  /** `inputProvenance.kind` of the run, when the gateway recorded one. */
  provenanceKind?: string;
  /** The user turn before this one in the chat, for a request that has no subject of its own. */
  previousUserText?: string;
};

export type TaskRanker = (input: TaskRankInput) => Promise<TaskRanking>;

const KEY = Symbol.for("openclaw.thalamus.taskRanker");
const MAX_RUNS = 128;
type State = { ranker?: TaskRanker; runs: Map<string, Promise<TaskRanking>> };
type Slot = { [KEY]?: State };

const state = (): State => {
  const g = globalThis as Slot;
  return (g[KEY] ??= { runs: new Map() });
};

/** Register the ranker; the returned function removes it (and only it) and forgets the runs it answered. */
export function registerTaskRanker(r: TaskRanker): () => void {
  const s = state();
  s.ranker = r;
  s.runs.clear();
  return () => {
    if (s.ranker === r) {
      s.ranker = undefined;
      s.runs.clear();
    }
  };
}

/**
 * The ranking for this run, started by the first caller and shared with every later one (a retry of the same run, the other
 * hook). Never throws: a ranker that fails gives an unranked result with `why: "error"`.
 */
export function requestTaskRanking(input: TaskRankInput): Promise<TaskRanking> | undefined {
  const s = state();
  const ranker = s.ranker;
  if (!ranker) return undefined;
  const key = input.runId || `${input.sessionKey}\u0000${input.text}`;
  const held = s.runs.get(key);
  if (held) return held;
  const started = Promise.resolve()
    .then(() => ranker(input))
    .catch((): TaskRanking => ({ ranked: false, runId: input.runId, why: "error" }));
  s.runs.set(key, started);
  while (s.runs.size > MAX_RUNS) s.runs.delete(s.runs.keys().next().value as string);
  return started;
}

export const hasTaskRanker = (): boolean => state().ranker !== undefined;
