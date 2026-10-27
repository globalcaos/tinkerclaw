import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
/**
 * J3 `j.fractal.run` for the background Fractal turn (TINKER_UI_DESIGN_BIBLE/logging.md §4.12).
 *
 * Since 2026-10-08 the Tinker page sends the turn that reflects on run P as a run of its own,
 * `fractal-<P>` (extensions/tinkerclaw-tinker-bridge/src/fork-parent.ts). Those runs wrote
 * `run.done` and `turn.span` rows but no `j.fractal.run`: the only emitter sat in the triage lane,
 * off since 09-19, so the Fractal success rate read 0 rows while 49 runs happened.
 *
 * The row needs two facts no single producer holds. The outcome is known where `run.done` is
 * written (turn-events.ts recordRunDone). The tool calls are not: on the Claude Code provider the
 * worker runs its own tools, so the gateway's tool wrapper never sees them (`tool.done` covers 2
 * of the 49 runs). Both the tinker-bridge and the embedded runner announce every tool on the
 * agent-events bus (`stream: "tool"`, phase `start` with name and args, phase `result` with
 * `isError`), so one listener tallies each `fractal-*` run and recordRunDone spends the tally.
 *
 * A file counts as written when a file-edit tool (Claude Code `Write`/`Edit`/`MultiEdit`/
 * `NotebookEdit`, gateway `write`/`edit`/`apply_patch`) finished without an error; a path is
 * counted once however often it is edited, and an `apply_patch` call, which carries its paths
 * inside the patch, counts once. A write made through a shell command is not seen.
 *
 * Like `run.done`, one row per ATTEMPT: a failover retry writes a second row under the same run id.
 * No listener, no row: a process that never called startFractalRunTally (a test, a CLI) cannot
 * tell clean from durable, and an invented `clean` would be the very zero this exists to remove.
 * A run that never reaches `run.done` (the gateway died under it) leaves its tally until the cap
 * evicts it.
 */
import { onAgentEvent, type AgentEventPayload } from "../agent-events.js";
import { emitJFractalRun, type JFractalRunOutcome } from "./j-rows.js";

export const FRACTAL_RUN_ID_PREFIX = "fractal-";
/** Runs tallied at once; a few run beside each other at most, so this only bounds a leak. */
export const FRACTAL_TALLY_CAP = 64;

/** Lower-cased tool names whose successful call writes a file. */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

interface RunTally {
  toolCalls: number;
  /** Write calls waiting for their result: toolCallId → the file they target. */
  readonly pendingWrites: Map<string, string>;
  readonly files: Set<string>;
}

interface TallyState {
  unsubscribe: (() => void) | null;
  readonly runs: Map<string, RunTally>;
}

function tallyState(): TallyState {
  return resolveGlobalSingleton<TallyState>(Symbol.for("openclaw.fractalRunTally.state"), () => ({
    unsubscribe: null,
    runs: new Map(),
  }));
}

export function isFractalRunId(runId: string | undefined | null): runId is string {
  return typeof runId === "string" && runId.startsWith(FRACTAL_RUN_ID_PREFIX);
}

function tallyFor(runId: string): RunTally {
  const runs = tallyState().runs;
  let tally = runs.get(runId);
  if (tally === undefined) {
    tally = { toolCalls: 0, pendingWrites: new Map(), files: new Set() };
    runs.set(runId, tally);
    if (runs.size > FRACTAL_TALLY_CAP) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) {
        runs.delete(oldest);
      }
    }
  }
  return tally;
}

/** The file a write call targets: its path argument, or the call itself when it names none. */
function writeTarget(args: unknown, toolCallId: string): string {
  const record = (args ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return `call:${toolCallId}`;
}

function noteToolEvent(evt: AgentEventPayload): void {
  if (evt.stream !== "tool" || !isFractalRunId(evt.runId)) {
    return;
  }
  const data = evt.data as {
    phase?: unknown;
    name?: unknown;
    toolCallId?: unknown;
    args?: unknown;
    isError?: unknown;
  };
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (data.phase === "start") {
    const tally = tallyFor(evt.runId);
    tally.toolCalls += 1;
    const name = typeof data.name === "string" ? data.name.toLowerCase() : "";
    if (FILE_WRITE_TOOLS.has(name)) {
      const target = writeTarget(data.args, toolCallId);
      if (toolCallId) {
        tally.pendingWrites.set(toolCallId, target);
      } else {
        tally.files.add(target); // no id to pair a result with: counted on start
      }
    }
    return;
  }
  if (data.phase === "result" && toolCallId) {
    const tally = tallyState().runs.get(evt.runId);
    const target = tally?.pendingWrites.get(toolCallId);
    if (tally === undefined || target === undefined) {
      return;
    }
    tally.pendingWrites.delete(toolCallId);
    if (data.isError !== true) {
      tally.files.add(target);
    }
  }
}

/** The gateway starts the tally once (server.impl.ts, beside the events writer). Idempotent. */
export function startFractalRunTally(): () => void {
  const state = tallyState();
  if (state.unsubscribe === null) {
    state.unsubscribe = onAgentEvent(noteToolEvent);
  }
  return stopFractalRunTally;
}

export function stopFractalRunTally(): void {
  const state = tallyState();
  state.unsubscribe?.();
  state.unsubscribe = null;
  state.runs.clear();
}

/**
 * The `j.fractal.run` row for a finished attempt of a `fractal-*` run, from turn-events.ts
 * recordRunDone. Spends the run's tally, so the next attempt counts from zero.
 */
export function recordFractalRunDone(
  run: { readonly runId: string; readonly sessionKey?: string },
  outcome: "completed" | "aborted" | "error",
  durMs: number,
): void {
  const state = tallyState();
  if (!isFractalRunId(run.runId) || state.unsubscribe === null) {
    return;
  }
  const tally = state.runs.get(run.runId);
  state.runs.delete(run.runId);
  const filesWritten = tally?.files.size ?? 0;
  const label: JFractalRunOutcome =
    outcome !== "completed" ? "failed" : filesWritten > 0 ? "durable" : "clean";
  emitJFractalRun({
    outcome: label,
    durMs,
    filesWritten,
    toolCalls: tally?.toolCalls ?? 0,
    sessionKey: run.sessionKey ?? null,
    runId: run.runId,
  });
}

export function resetFractalRunTallyForTest(): void {
  stopFractalRunTally();
}
