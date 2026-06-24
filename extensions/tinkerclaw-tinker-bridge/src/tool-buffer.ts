/**
 * FORK (2026-04-25): per-run tool-event buffer for tinker-bridge.
 *
 * tinker-bridge cannot put tool_use blocks in the assistant message (the comment
 * around `buildContent` in `stream.ts` explains why — pi-agent-core would
 * re-execute them via OpenClaw's exec tool and trip the prefrontal gate).
 * That keeps live LLM context clean but leaves the OpenClaw session
 * transcript with no record of the tool calls — so when Tinker reloads
 * `agent:main:main` from history, every tinker-bridge turn looks empty.
 *
 * This module buffers tool start/result events keyed by the OpenClaw
 * `runId`. The fork's `onTurnComplete` hook drains the buffer at the end of
 * the turn and persists each event as a `customType: "tinker-bridge-tool"`
 * entry on the active session via `sessionManager.appendCustomEntry`.
 * Tinker's session-history loader picks those up and renders the same
 * single-line-collapsed / expandable bubble it shows for live tool events.
 *
 * The buffer is in-process state — it is not persisted to disk. If the
 * gateway crashes mid-turn the events are lost, but the user already lost
 * the turn at that point so this is a tolerable failure mode.
 */
import type { ToolBufferedEvent } from "./tool-buffer.types.js";

const buffers = new Map<string, ToolBufferedEvent[]>();

export function recordToolEvent(runId: string | undefined, event: ToolBufferedEvent): void {
  if (!runId) {
    return;
  }
  let arr = buffers.get(runId);
  if (!arr) {
    arr = [];
    buffers.set(runId, arr);
  }
  arr.push(event);
}

/** Atomically read + clear all buffered events for a runId. */
export function consumeToolEventsForRun(runId: string): ToolBufferedEvent[] {
  const arr = buffers.get(runId);
  if (!arr) {
    return [];
  }
  buffers.delete(runId);
  return arr;
}

/** Drop a buffer without reading it (called when a turn aborts). */
export function discardToolEventsForRun(runId: string): void {
  buffers.delete(runId);
}

export type { ToolBufferedEvent };
