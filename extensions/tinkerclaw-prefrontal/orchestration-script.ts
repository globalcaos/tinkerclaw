/**
 * SS0 / capability-parity A1 (2026-06-04): the orchestration-script executor.
 *
 * Runs a JARVIS-AUTHORED orchestration script natively (the same surface the
 * borrowed Claude Code Workflow tool exposes): the script body is an async
 * function with `agent / parallel / pipeline / phase / log / args` in scope and
 * `return`s its result.
 *
 * TRUST MODEL (not a sandbox, by design): this is Jarvis's own code running in
 * Jarvis's own self-hosted gateway — a single trusted principal that already runs
 * arbitrary code (bash, file edits, subagent spawns). The script therefore runs
 * with full privilege; it grants no capability Jarvis lacks. The only inputs are
 * Jarvis-authored, so there is no untrusted-input path to isolate. Footguns
 * (a sync infinite loop) are the author's responsibility, the same as any recipe.
 */

import type { createOrchestrationRuntime } from "./orchestration-runtime.js";

type Runtime = ReturnType<typeof createOrchestrationRuntime>;

/** Logger sink for `log(msg)` calls inside a script (narrator line in production). */
export type OrchestrationLog = (message: string) => void;

// The AsyncFunction constructor is not a global binding; reach it via a prototype.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

/**
 * Execute an orchestration script. `script` is the async-function BODY (use
 * `return` to yield a result). The runtime primitives, an optional `args` value,
 * and a `log` sink are injected as parameters. A throwing script rejects (errors
 * surface — never swallowed).
 */
export async function runOrchestrationScript(
  runtime: Runtime,
  script: string,
  args?: unknown,
  log?: OrchestrationLog,
): Promise<unknown> {
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", script);
  return fn(
    runtime.agent,
    runtime.parallel,
    runtime.pipeline,
    runtime.phase,
    log ?? (() => {}),
    args,
  );
}
