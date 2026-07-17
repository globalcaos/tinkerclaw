/**
 * SS0 / capability-parity A1 (2026-06-04): the NATIVE orchestration runtime.
 *
 * `agent / parallel / pipeline / phase` are currently BORROWED from the Claude
 * Code Workflow tool via tinker-bridge — alive only while Claude Code drives the turn
 * and metered/at-risk from 2026-06-15. This module makes them native to Jarvis's
 * own gateway, built over the existing subagent-spawn substrate (a `spawn` dep,
 * defaulted in production to fork.subagents.spawn + agent.wait + chat.history,
 * mirroring real-participant.ts). Governed by J16 (SALIENCE).
 *
 * Typed-output validation (agent(prompt,{schema})) reuses the SS1 value-flow
 * primitives (recipe-types.ts + redispatch-budget.ts) — the schema re-dispatch
 * bound is J16-derived (deriveRedispatchBudget), never a frozen MAX.
 */

import os from "node:os";
import { agentWithSchema } from "./orchestration-schema.js";
import { classifyError, type ClassifiedError, type JsonSchema } from "./recipe-types.js";

/**
 * The settled outcome of one parallel()/pipeline() thunk, in input order.
 * `ok:true` carries the value; `ok:false` carries the ClassifiedError that the
 * thunk threw plus its input `index` — replacing the old silent `null` so a
 * failure surfaces a typed, attributable error instead of vanishing.
 */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ClassifiedError; index: number };

export interface AgentOpts {
  /** Optional JSON-Schema; when set, agent() returns the validated object. */
  schema?: JsonSchema;
  /** Display label for the spawned agent (observability). */
  label?: string;
  /**
   * Optional leaf model for this unit. The production runtime COERCES this to a
   * `claude-code/*` model (subscription-billed tinker-sp-* worker) — a non-claude-code
   * value is overridden, never honoured, so a fan-out can't silently spill onto
   * the metered API. Omit to inherit the runtime's default leaf model.
   */
  model?: string;
  /**
   * Optional thinking/effort level for this unit (e.g. "low", "medium", "high",
   * "max"). Forwarded to fork.subagents.spawn → child session thinkingLevel.
   * Omit to inherit the runtime default (none = off). Bible §5.84-A.
   */
  thinking?: string;
}

export interface OrchestrationDeps {
  /** Spawn one subagent and resolve to its final text. */
  spawn: (prompt: string, opts?: AgentOpts) => Promise<{ finalText: string }>;
  /** Phase-transition sink (wired to onRecipeState in production). */
  onPhase?: (title: string) => void;
}

/** Concurrency cap for parallel(): min(16, cores-2), at least 1. */
function concurrencyCap(): number {
  const cores = os.cpus?.().length ?? 4;
  return Math.max(1, Math.min(16, cores - 2));
}

export function createOrchestrationRuntime(deps: OrchestrationDeps) {
  /**
   * Spawn one subagent. Without a schema → its final text. With a schema → the
   * validated object (typed self-correction via SS1's bounded re-dispatch).
   */
  async function agent(prompt: string, opts?: AgentOpts): Promise<unknown> {
    // Never spawn with an empty/garbage prompt. A prior stage that timed out
    // chains '' and parallel/pipeline null-isolation chains null/undefined; if
    // such a value reached deps.spawn it would create a taskless orphan child.
    // Fail loudly here so the script surfaces the upstream gap instead.
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error(
        "orchestration agent(): empty prompt — refusing to spawn a taskless subagent. " +
          "A prior stage likely timed out or returned empty; guard it before chaining.",
      );
    }
    if (opts?.schema) {
      return agentWithSchema((p) => deps.spawn(p, opts), prompt, opts.schema);
    }
    const r = await deps.spawn(prompt, opts);
    return r.finalText;
  }

  /**
   * Run every thunk concurrently (capped), await ALL (a barrier), and return a
   * Settled<T> per thunk in input order. A thunk that throws is captured as
   * `{ ok:false, error, index }` (the error CLASSIFIED, never a silent null) — the
   * call itself never rejects (failure-isolation: one failure never sinks the
   * barrier). Filter successes with `.filter((r) => r.ok)`.
   */
  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<Settled<T>>> {
    const results: Array<Settled<T>> = new Array(thunks.length);
    let next = 0;
    const runWorker = async (): Promise<void> => {
      while (next < thunks.length) {
        const idx = next++;
        try {
          results[idx] = { ok: true, value: await thunks[idx]() };
        } catch (err) {
          // failure-isolation: classify the failure, attribute it to its input
          // index, and keep the barrier intact instead of dropping a silent null.
          const e = err as { kind?: ClassifiedError["kind"] };
          results[idx] = {
            ok: false,
            error: classifyError(e && e.kind ? e.kind : "execution-error", String(err)),
            index: idx,
          };
        }
      }
    };
    const workerCount = Math.min(concurrencyCap(), thunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  /**
   * Run each item through ALL stages independently — NO barrier between stages
   * (item A can be in stage 3 while B is still in stage 1). Each stage receives
   * (prevResult, originalItem, index) and yields a Settled<unknown> in input
   * order. A stage that throws drops that item to `{ ok:false, error, index }`
   * (the error CLASSIFIED, never a silent null) and skips its remaining stages.
   */
  async function pipeline<T>(
    items: T[],
    ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>
  ): Promise<Array<Settled<unknown>>> {
    return Promise.all(
      items.map(async (item, index): Promise<Settled<unknown>> => {
        let cur: unknown = item;
        for (const stage of stages) {
          try {
            cur = await stage(cur, item, index);
          } catch (err) {
            // drop this item (skip its remaining stages) but classify + attribute
            // the failure instead of dropping a silent null.
            const e = err as { kind?: ClassifiedError["kind"] };
            return {
              ok: false,
              error: classifyError(e && e.kind ? e.kind : "execution-error", String(err)),
              index,
            };
          }
        }
        return { ok: true, value: cur };
      }),
    );
  }

  /** Start a new phase (grouping label) — emitted to the onPhase sink. */
  function phase(title: string): void {
    try {
      deps.onPhase?.(title);
    } catch {
      // observability must never break the run
    }
  }

  return { agent, parallel, pipeline, phase };
}
