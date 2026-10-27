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
//
// ROUNDS (2026-10-25). The row also counts the task's model calls (`stream: "call"`, one per round, both lanes) and,
// for each note or past chat the anticipation note pointed at, the round in which a tool call first touched it (its
// file name or session id in the call's arguments). That is the measure of the post's claim: with the pointers on the
// desk, does round 1 already know where to look (`anticipate-report.ts`).

import type { EnhancementCard, Shortlist, UsageMark } from "openclaw/plugin-sdk/fork-thalamus";
import type { PointerUse, ThalamusStore, UseRow } from "./store.js";

export type ToolStart = { name?: unknown; args?: unknown; toolCallId?: unknown };

/** A pointer as it is recorded when the list is made: never its label, only its address. */
export type PointerShown = Omit<PointerUse, "usedRound">;

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
  /** Why the list is not Jev's (see `UseRow.skipReason`); absent when Jev answered. */
  skip?: string;
  skipDetail?: string;
  /** The note and past-chat pointers found for the task (empty: looked, none fits); absent when the legs are off. */
  pointers?: PointerShown[];
  /** Why no pointer was looked for, or the index was not ready. */
  pointerSkip?: string;
};

type Used = UseRow["used"][number];

type RunUse = {
  ts: number;
  info?: ShownInfo;
  used: Map<string, Used>;
  jevMs?: number;
  /** Model calls seen for the run, from the call events. */
  rounds: number;
  /** Pointer id -> the round a tool call first touched it. */
  pointerUse: Map<string, number>;
};

/** What a tool call's arguments must contain for it to count as opening the pointer. */
const pointerNeedles = (p: PointerShown): string[] =>
  p.kind === "note"
    ? [p.id.split("/").pop() ?? p.id].filter((n) => n.length >= 6)
    : [p.id, p.id.slice(0, 8)].filter((n) => n.length >= 8);

const argsText = (args: unknown): string => {
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
};

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
      r = { ts: d.now(), used: new Map(), rounds: 0, pointerUse: new Map() };
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

    /** How long the Jev call took. It may arrive after the prompt went on without it; a run that has ended ignores it. */
    noteJevMs(runId: string, ms: number): void {
      const run = runs.get(runId);
      if (run) run.jevMs = ms;
    },

    /**
     * A model call event of the run. `callIndex` is the call's 0-based ordinal in the run, so the rounds are the highest
     * one plus one; an event without it counts when the call ends. Only a run the list was made for is counted.
     */
    onCall(runId: string, data: { phase?: unknown; callIndex?: unknown }): void {
      const run = runs.get(runId);
      if (!run) {
        return;
      }
      const i = data.callIndex;
      if (typeof i === "number" && Number.isInteger(i) && i >= 0) {
        run.rounds = Math.max(run.rounds, i + 1);
      } else if (data.phase === "end") {
        run.rounds += 1;
      }
    },

    /** A tool call started. Attributed to an enhancement when it opens its manual or runs its tool. */
    onToolStart(runId: string, data: ToolStart): void {
      if (typeof data.name !== "string" || !data.name) return;
      const pointed = runs.get(runId);
      const shownPointers = pointed?.info?.pointers ?? [];
      if (pointed && shownPointers.length > 0) {
        const text = argsText(data.args);
        for (const p of shownPointers) {
          if (!pointed.pointerUse.has(p.id) && pointerNeedles(p).some((n) => text.includes(n))) {
            pointed.pointerUse.set(p.id, Math.max(1, pointed.rounds));
          }
        }
      }
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
        ...(run.info?.skip ? { skipReason: run.info.skip } : {}),
        ...(run.info?.skipDetail ? { skipDetail: run.info.skipDetail } : {}),
        ...(run.jevMs !== undefined ? { jevMs: run.jevMs } : {}),
        ...(run.rounds > 0 ? { rounds: run.rounds } : {}),
        ...(run.info?.pointers
          ? {
              pointers: run.info.pointers.map((p) => {
                const r = run.pointerUse.get(p.id);
                return r === undefined ? { ...p } : { ...p, usedRound: r };
              }),
            }
          : {}),
        ...(run.info?.pointerSkip ? { pointerSkip: run.info.pointerSkip } : {}),
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
