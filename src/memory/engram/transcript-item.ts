/**
 * FORK 2026-10-25 — fetch one item of a session transcript by its id: the engine behind the
 * total-recall plugin's `recall({ id })`.
 *
 * An evicted tool result leaves a marker in context that names its toolCallId
 * (eviction-marker.ts). The transcript on disk was never edited, so it still holds the whole
 * result: this module finds it there and returns it, or a slice of it. The same lookup answers a
 * transcript entry id (the `id` field of a transcript line), which a compaction marker gives as
 * its address.
 *
 * The caller passes ONE transcript, its own chat's. A scan of every transcript would cost seconds
 * on the gateway's one event loop (transcript-index.ts measured 7 s over 418 MB), and an evicted
 * result's marker only ever sits in the chat that evicted it.
 */
import { existsSync, readFileSync } from "node:fs";
import { contentText } from "./eviction-marker.js";

export const RECALL_BY_ID_DEFAULT_LENGTH = 20_000;
export const RECALL_BY_ID_MAX_LENGTH = 100_000;

export type TranscriptItem = {
  kind: "tool_result" | "entry";
  role: string;
  toolName?: string;
  when: string;
  text: string;
};

/**
 * The tool result whose toolCallId is `id`, else the transcript entry whose id is `id`.
 *
 * A transcript is an append-only tree: a context-engine rewrite appends a shortened copy of a
 * message and leaves the original in place, so one toolCallId can match several lines. The longest
 * text is the whole one, and that is the copy an evicted marker promises.
 */
export function findTranscriptItem(filePath: string, id: string): TranscriptItem | undefined {
  if (!id || !existsSync(filePath)) {
    return undefined;
  }
  let toolResult: TranscriptItem | undefined;
  let entry: TranscriptItem | undefined;
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.includes(id)) {
      continue;
    }
    let row: {
      id?: unknown;
      type?: unknown;
      timestamp?: unknown;
      content?: unknown;
      message?: { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown };
    };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const when = typeof row.timestamp === "string" ? row.timestamp : "";
    const message = row.message;
    if (message?.role === "toolResult" && message.toolCallId === id) {
      const text = contentText(message.content);
      if (!toolResult || text.length > toolResult.text.length) {
        toolResult = {
          kind: "tool_result",
          role: "toolResult",
          toolName: typeof message.toolName === "string" ? message.toolName : undefined,
          when,
          text,
        };
      }
    } else if (row.id === id && !entry) {
      entry = {
        kind: "entry",
        role:
          typeof message?.role === "string"
            ? message.role
            : typeof row.type === "string"
              ? row.type
              : "",
        when,
        text: contentText(message ? message.content : row.content),
      };
    }
  }
  return toolResult ?? entry;
}

export type RecallByIdOutput =
  | { id: string; found: false; reason: string }
  | {
      id: string;
      found: true;
      kind: TranscriptItem["kind"];
      role: string;
      toolName?: string;
      when: string;
      totalChars: number;
      offset: number;
      text: string;
      /** Where the next slice starts; absent when this slice reaches the end. */
      nextOffset?: number;
    };

/** One page of an item: `length` chars from `offset`, both clamped to what exists. */
export function sliceTranscriptItem(
  id: string,
  item: TranscriptItem,
  offset?: number,
  length?: number,
): RecallByIdOutput {
  const total = item.text.length;
  const start = Math.min(total, Math.max(0, Math.floor(offset ?? 0)));
  const size = Math.min(
    RECALL_BY_ID_MAX_LENGTH,
    Math.max(1, Math.floor(length ?? RECALL_BY_ID_DEFAULT_LENGTH)),
  );
  const end = Math.min(total, start + size);
  return {
    id,
    found: true,
    kind: item.kind,
    role: item.role,
    ...(item.toolName ? { toolName: item.toolName } : {}),
    when: item.when,
    totalChars: total,
    offset: start,
    text: item.text.slice(start, end),
    ...(end < total ? { nextOffset: end } : {}),
  };
}
