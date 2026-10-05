// The routing provider: THALAMUS's side of "one call, two jobs" (design doc section 10; paper P§4).
//
// WHAT THIS IS FOR. When the amygdala runs, it makes one Jev call per step. This provider registers with the core
// registry (`setRoutingReadProvider`), and the amygdala's `decide()` appends the routing questions to that call
// and hands the verdicts back. The routing side never adds a request, and never waits: it rides on a call the
// amygdala was making anyway, with the amygdala's own budget.
//
// WHICH QUESTIONS AT WHICH SEAM. `prompt`: the task read and the enhancement ranking. `pre-tool`: the step read
// for the step about to run. `post-tool` and `stop`: the outcome read. The reads land in `onRead`, which phase D
// points at the ledger.
//
// THE SAME PRIVACY GATE as the standalone reader: decided from the source before a question is offered. A source
// the gate refuses gets no routing questions, whatever the amygdala itself asks.

import type { JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import {
  outcomeReadFromVerdicts,
  stepReadFromVerdicts,
  type EnhancementQuestions,
  type OutcomeRead,
  type ProviderQuestion,
  type RoutingReadProvider,
  type RoutingSeam,
  type RoutingSituationView,
  type StepRead,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ReadInput, RoutingReader, TaskReadResult } from "./routing-reader.js";

export type ProviderRead =
  | { kind: "task"; result: TaskReadResult }
  | { kind: "step"; step: StepRead }
  | { kind: "outcome"; outcome: OutcomeRead; sessionKey: string; turnId: string };

export type ProviderDeps = {
  reader: RoutingReader;
  /** Where the session's task came from, e.g. "tinker" or "channel:whatsapp". */
  sourceOf: (sessionKey: string) => string;
  onRead: (r: ProviderRead) => void;
  now: () => number;
  /** How many outstanding task sets to remember while their verdicts are in flight. */
  keep?: number;
};

const label = (q: { id: string }, name: string, purpose: string): ProviderQuestion => ({
  ...(q as ProviderQuestion),
  name,
  purpose,
});

export function createRoutingProvider(d: ProviderDeps): RoutingReadProvider {
  // The option set a task question was asked with, needed to read its answers back.
  const pending = new Map<string, EnhancementQuestions | undefined>();
  const keep = d.keep ?? 64;

  const inputOf = (v: RoutingSituationView): ReadInput => ({
    id: v.id,
    ts: d.now(),
    sessionKey: v.sessionKey,
    text: v.request ?? "",
    source: d.sourceOf(v.sessionKey),
    synthetic: v.originKind === "synthetic",
  });

  return {
    questionsFor(seam: RoutingSeam, v: RoutingSituationView): ProviderQuestion[] {
      const input = inputOf(v);
      if (seam === "prompt") {
        const built = d.reader.taskQuestions(input);
        if (!built.allowed) return [];
        pending.set(v.id, built.enh);
        while (pending.size > keep) pending.delete(pending.keys().next().value as string);
        return built.questions.map((q) => label(q, q.id, "routing read"));
      }
      if (!d.reader.gate(input).allowed) return [];
      const qs = seam === "pre-tool" ? d.reader.stepQuestions() : d.reader.outcomeQuestions();
      return qs.map((q) => label(q, q.id, "routing read"));
    },

    observe(seam: RoutingSeam, v: RoutingSituationView, verdicts: JevVerdict[]): void {
      const input = inputOf(v);
      const env = { id: v.id, ts: input.ts, sessionKey: v.sessionKey, callIndex: 0 };
      if (seam === "prompt") {
        const enh = pending.get(v.id);
        pending.delete(v.id);
        d.onRead({ kind: "task", result: d.reader.interpretTask(input, verdicts, enh) });
      } else if (seam === "pre-tool") {
        d.onRead({ kind: "step", step: stepReadFromVerdicts(env, verdicts) });
      } else {
        d.onRead({
          kind: "outcome",
          outcome: outcomeReadFromVerdicts(env, verdicts),
          sessionKey: v.sessionKey,
          turnId: v.turnId,
        });
      }
    },
  };
}
