import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * FORK 2026-08-15 (the architect: "leave messages in the chat after each phase finishes with the amount
 * of time it took, so we have a measurable way to see how much time we are investing in each
 * phase").
 *
 * WHY THIS LIVES IN THE HOOK RUNNER AND NOT IN THE PLUGINS.
 *
 * The first cut of turn-phase narration emitted from inside two plugins — total-recall and
 * prefrontal. It produced ONE event on a normal turn, so the UI's breadcrumb (which draws only
 * FINISHED steps) had nothing to draw and never rendered once. Two independent reasons, both
 * structural rather than accidental:
 *
 *   1. total-recall's emit sat AFTER its warm-pack early return, so the common path skipped it.
 *      A narrator placed inside a stage only narrates the branch it happens to be written on.
 *   2. A plugin can only narrate itself. The gap the architect is measuring is the SUM of
 *      several stages, and the stages that are slow are not always the ones with a plugin in
 *      them.
 *
 * `runModifyingHook` is the single funnel every agent hook passes through, on every path
 * (embedded runner and agent-harness both reach it). Instrumenting it means each narrated stage
 * reports itself once, with a duration measured around the actual work, and a hook added later
 * narrates itself for free.
 *
 * TIMINGS ARE MEASURED HERE, SERVER-SIDE, and shipped on the completion event. The UI used to
 * derive durations from the gap between arrival times, which silently folded network and
 * event-loop latency into whatever stage happened to be running. `ms` is the wall time the stage
 * actually held.
 */

/**
 * The pre-model hooks worth narrating, and the words the UI shows for them.
 *
 * Deliberately an ALLOWLIST. Every hook in the system passes through the funnel, including the
 * post-answer ones (`llm_output`, `agent_end`), and narrating those would put rows in the chat
 * for work the user is not waiting on. Adding a name here is the whole cost of narrating a new
 * stage.
 */
const TURN_PHASE_LABELS: Record<string, string> = {
  before_compaction: "compacting context",
  agent_turn_prepare: "preparing the turn",
  before_prompt_build: "recalling memories",
  before_model_resolve: "choosing a model",
  before_agent_start: "assembling the prompt",
};

export function turnPhaseLabelForHook(hookName: string): string | undefined {
  return TURN_PHASE_LABELS[hookName];
}

const hookSpanLog = createSubsystemLogger("hooks");

/**
 * FORK 2026-08-22 — PER-PLUGIN TIMING INSIDE A NARRATED STAGE.
 *
 * The phase row above measures the WHOLE hook chain, and the architect reads that row as the
 * name it carries: "recalling memories 12.7s". But `before_prompt_build` has EIGHT registered
 * handlers — skill-workshop, diffs, active-memory, memory-lancedb, computational-humor,
 * prefrontal (twice), total-recall and identity-persistence — and they run sequentially inside
 * that one number. Three of them are independent memory-retrieval plugins.
 *
 * So a stage label is not a stage. Optimising the retrieval pack from 19.5s to ~1s moved ONE
 * participant, and the row it lives in barely moved, because nobody could see that the row was
 * a sum. That is the same mistake this whole latency effort has now made twice: reading an
 * aggregate as if it were a component.
 *
 * Emitted only for hooks on the narration allowlist — every hook in the system passes through
 * the funnel, and timing the post-answer ones would be noise for work nobody waits on. No
 * duration threshold, for the reason given in `turn-span.ts`: a fast stage that is never
 * written down is indistinguishable from one that never ran.
 */
export function logHookHandlerSpan(hookName: string, pluginId: string, ms: number): void {
  if (!TURN_PHASE_LABELS[hookName]) {
    return;
  }
  hookSpanLog.info(`[hook-span] hook=${hookName} plugin=${pluginId} ms=${ms}`);
}

/** One handler's contribution to a narrated stage. `id` is the plugin id, `ms` its wall time. */
export type TurnPhasePluginTiming = { id: string; ms: number };

export type TurnPhaseSpan = {
  /** Record one handler's time. Called once per plugin, in the order they ran. */
  recordHandler: (pluginId: string, ms: number) => void;
  end: () => void;
};

function emit(d: {
  runId: string;
  sessionKey: string;
  phase: string;
  label: string;
  ms?: number;
  plugins?: TurnPhasePluginTiming[];
}): void {
  try {
    emitAgentEvent({
      runId: d.runId,
      sessionKey: d.sessionKey,
      stream: "turn-phase",
      // Explicit fields only. A `{...d}` spread here leaked `runId`/`sessionKey` INTO `data`,
      // duplicating what the envelope already carries one level up — observed live on
      // 2026-08-15. Harmless to the parser, but `data` is the contract the UI reads and it
      // should carry the phase and nothing else.
      data:
        d.ms === undefined
          ? { phase: d.phase, label: d.label }
          : {
              phase: d.phase,
              label: d.label,
              ms: d.ms,
              // Only on the completion event, and only when there is something to say. An
              // empty array would render an empty breakdown, which reads as "no plugins ran"
              // rather than "this build does not report them".
              ...(d.plugins && d.plugins.length > 0 ? { plugins: d.plugins } : {}),
            },
    });
  } catch {
    // Narration must never be able to fail a turn. A dropped phase costs a chat row.
  }
}

/**
 * Open a narrated span for `hookName`, or return undefined when this hook is not narrated or the
 * context cannot attribute it to a run. Callers MUST call `.end()` in a `finally`, so a hook that
 * throws still closes its span rather than leaving the UI showing that stage forever.
 */
export function beginTurnPhase(hookName: string, ctx: unknown): TurnPhaseSpan | undefined {
  const label = TURN_PHASE_LABELS[hookName];
  if (!label) {
    return undefined;
  }
  const c = ctx as { runId?: unknown; sessionKey?: unknown } | null | undefined;
  const runId = typeof c?.runId === "string" && c.runId ? c.runId : undefined;
  const sessionKey = typeof c?.sessionKey === "string" && c.sessionKey ? c.sessionKey : undefined;
  // Without both, the UI cannot decide which tab the phase belongs to, and a mis-attributed
  // phase is worse than a missing one — it would paint another session's chat.
  if (!runId || !sessionKey) {
    return undefined;
  }
  const startedAt = Date.now();
  let ended = false;
  const plugins: TurnPhasePluginTiming[] = [];
  emit({ runId, sessionKey, phase: hookName, label });
  return {
    recordHandler: (pluginId: string, ms: number) => {
      // Bounded: a pathological registry cannot make one chat row unbounded. 32 is well past
      // the largest real chain (before_prompt_build, at eight).
      if (plugins.length < 32) {
        plugins.push({ id: pluginId, ms });
      }
    },
    end: () => {
      if (ended) {
        return;
      }
      ended = true;
      emit({ runId, sessionKey, phase: hookName, label, ms: Date.now() - startedAt, plugins });
    },
  };
}
