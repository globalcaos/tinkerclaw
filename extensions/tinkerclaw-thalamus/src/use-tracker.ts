// Use observation (design doc section 13A.5; paper P§7.3): what the agent DID, as the harness saw it.
//
// WHAT THIS IS FOR. To improve the text Jev reads, the loop needs to know which enhancement the agent actually used.
// The label is the tool calls of the task, attributed by `attributeToolUsage` (`src/fork/usage-attribution.ts`), the
// same code that draws the chat chips. It is never the model's prose and never a second detector.
//
// ONE ROW PER TASK. The row joins the list that was shown (in order, with its probabilities) to what was used (on the
// list or off it, and where on it), and to how the task ended. A task where a list was computed but nothing was used
// is recorded too: an unused list is evidence.
//
// `how` an enhancement was used (as written, adapted, merged) is not visible in a tool call. It starts as `unknown`
// and the nightly loop fills it from the transcript where Jev may read it.

import type { EnhancementCard, Shortlist, UsageMark } from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusStore, UseRow } from "./store.js";

export type ToolStart = { name?: unknown; args?: unknown; toolCallId?: unknown };

export type ShownInfo = {
  sessionKey: string;
  source: string;
  private: boolean;
  list: Shortlist;
  questionVersion: number;
  /** The list was shown in a shuffled order (overnight job, `learning.shuffle`, enforce). */
  shuffled?: boolean;
  /** The task's kind of work from the local read. */
  taskKind?: string;
};

type Used = UseRow["used"][number];

type RunUse = { ts: number; info?: ShownInfo; used: Map<string, Used> };

const MAX_RUNS = 256;

export function createUseTracker(d: {
  store: () => ThalamusStore | undefined;
  cards: () => ReadonlyMap<string, EnhancementCard>;
  attribute: (call: { name: string; args?: unknown; toolCallId?: string }) => UsageMark[];
  now: () => number;
  mode: () => string;
}) {
  const runs = new Map<string, RunUse>();

  const runOf = (runId: string): RunUse => {
    let r = runs.get(runId);
    if (!r) {
      r = { ts: d.now(), used: new Map() };
      runs.set(runId, r);
      while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
    }
    return r;
  };

  return {
    /** The list computed for this task, shown to the agent or not. */
    noteShown(runId: string, info: ShownInfo): void {
      runOf(runId).info = info;
    },

    /** A tool call started. Attributed to an enhancement when it opens its manual or runs its tool. */
    onToolStart(runId: string, data: ToolStart): void {
      if (typeof data.name !== "string" || !data.name) return;
      let marks: UsageMark[];
      try {
        marks = d.attribute({
          name: data.name,
          args: data.args,
          ...(typeof data.toolCallId === "string" ? { toolCallId: data.toolCallId } : {}),
        });
      } catch {
        return;
      }
      if (marks.length === 0) return;
      const run = runOf(runId);
      for (const m of marks) {
        const cardId = `${m.kind}:${m.name}`;
        if (run.used.has(cardId)) continue;
        const entry = run.info?.list.entries.find((e) => e.cardId === cardId);
        run.used.set(cardId, {
          cardId,
          onList: entry !== undefined,
          ...(entry ? { rank: entry.rank } : {}),
          via: m.via,
          how: "unknown",
        });
      }
    },

    /** The task ended. Writes the row (when there is anything to say) and forgets the run. */
    finish(runId: string, outcome: "done" | "retried"): UseRow | undefined {
      const run = runs.get(runId);
      runs.delete(runId);
      if (!run || (!run.info && run.used.size === 0)) return undefined;
      const cards = d.cards();
      const shown = run.info?.list.entries ?? [];
      const versions: Record<string, number> = {};
      for (const id of [...shown.map((e) => e.cardId), ...run.used.keys()]) {
        const v = cards.get(id)?.version;
        if (v !== undefined) versions[id] = v;
      }
      const row: UseRow = {
        taskId: runId,
        ts: run.ts,
        session: run.info?.sessionKey ?? "",
        source: run.info?.source ?? "",
        private: run.info?.private ?? false,
        shuffled: run.info?.shuffled ?? false,
        shown: [...shown],
        noneFits: run.info?.list.noneFitsProb ?? 1,
        listShown: run.info?.list.shown ?? false,
        listReason: run.info?.list.reason ?? "not-asked",
        listSource: run.info?.list.source ?? "local",
        used: [...run.used.values()],
        outcome,
        cardVersions: versions,
        questionVersion: run.info?.questionVersion ?? 0,
        mode: d.mode(),
        ...(run.info?.taskKind ? { taskKind: run.info.taskKind } : {}),
      };
      try {
        d.store()?.upsertUse(row);
      } catch {
        /* recording must never break a run */
      }
      return row;
    },

    open: (): number => runs.size,
  };
}

export type UseTracker = ReturnType<typeof createUseTracker>;
