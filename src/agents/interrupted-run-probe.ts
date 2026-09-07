/**
 * FORK 2026-07-31: probe a session transcript for a tool call that was still in
 * flight when the process died.
 *
 * WHY THIS EXISTS: when the OpenClaw gateway is restarted mid-run, a
 * tinker-bridge agent is SIGTERMed. The streamed assistant TEXT is already
 * persisted to the session transcript, but the `tool_use` content block for the
 * tool that was in flight is NOT — so the restart-recovery heuristic sees a
 * plain assistant-text tail and reads it as "this turn already completed", and
 * the interruption becomes invisible.
 *
 * tinker-bridge does not put tool calls inside the assistant message (that would
 * make pi-agent-core re-execute them — see `extensions/tinkerclaw-tinker-bridge`
 * `stream.ts:buildContent`). It records them as SEPARATE transcript records:
 *
 *   {type:'custom', customType:'tinker-bridge-tool', id, parentId, timestamp,
 *    data:{runId, phase:'start'|'result', toolCallId, name?, args?, startedAt?,
 *          result?, isError?, endedAt?}}
 *
 * The ONLY durable proof that a tool was in flight is therefore a `phase:'start'`
 * record whose `data.toolCallId` never received a matching `phase:'result'`
 * record. This module reads that proof straight off disk, deliberately bypassing
 * `readSessionMessages` (which shapes/reorders records into synthetic chat
 * messages and drops anything malformed) so the recovery path depends only on
 * the raw persisted evidence.
 */

import fs from "node:fs";

export type DanglingToolCall = {
  toolCallId: string;
  name?: string;
  runId?: string;
  startedAt?: number;
};

/** Tail window size — see the BOUNDED SCAN comment in `findDanglingToolCall`. */
const DEFAULT_MAX_RECORDS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Returns the LAST `tinker-bridge-tool` start record that never received a
 * matching result, or null if every start was paired (or the file is absent /
 * has no such records).
 *
 * Runs synchronously: it is called once per session on the gateway boot path,
 * alongside the existing sync `readSessionMessages`.
 */
export function findDanglingToolCall(
  transcriptPath: string,
  opts?: { maxRecords?: number },
): DanglingToolCall | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    // Missing file, unreadable file, permission error — all mean "no proof of an
    // interrupted tool call". Never throw: this runs during gateway boot.
    return null;
  }

  const requestedMax = opts?.maxRecords;
  const maxRecords =
    typeof requestedMax === "number" && Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.floor(requestedMax)
      : DEFAULT_MAX_RECORDS;

  const allLines = raw.split(/\r?\n/);
  // BOUNDED SCAN: real transcripts reach ~4.5 MB / 2000+ records and this runs
  // once per session at boot, so we only parse the tail window. That is not a
  // compromise on correctness: a dangling start is by construction the last
  // thing the dying process wrote for that turn, so it always lands in the tail.
  // Anything older than the window either got its result (paired, hence not
  // dangling) or belongs to a turn that ended long ago and is not recoverable.
  const lines = allLines.length > maxRecords ? allLines.slice(-maxRecords) : allLines;

  const resultIds = new Set<string>();
  const starts: DanglingToolCall[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A SIGTERM can leave a torn final line. Ignoring unparseable lines is
      // exactly the failure mode this probe has to survive.
      continue;
    }

    const record = asRecord(parsed);
    if (!record || record.type !== "custom" || record.customType !== "tinker-bridge-tool") {
      continue;
    }
    const data = asRecord(record.data);
    if (!data) {
      continue;
    }
    const toolCallId = data.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) {
      continue;
    }

    if (data.phase === "result") {
      resultIds.add(toolCallId);
      continue;
    }
    if (data.phase !== "start") {
      continue;
    }

    starts.push({
      toolCallId,
      ...(typeof data.name === "string" ? { name: data.name } : {}),
      ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
      ...(typeof data.startedAt === "number" && Number.isFinite(data.startedAt)
        ? { startedAt: data.startedAt }
        : {}),
    });
  }

  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    if (start && !resultIds.has(start.toolCallId)) {
      return start;
    }
  }
  return null;
}
