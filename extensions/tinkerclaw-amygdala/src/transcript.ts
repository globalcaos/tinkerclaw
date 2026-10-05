/**
 * Bounded read of the newest turn of a Claude Code transcript (Phase D charter, item 3). A transcript can be
 * hundreds of MB; the stop hook only needs what happened after the last prompt, so at most the last `maxBytes` are
 * read, the first partial line is dropped, and nothing here ever throws.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { classifyEffect } from "./effect-class.js";
import type { ToolRecordEntry } from "./types.js";

export interface TranscriptTail {
  toolRecord: ToolRecordEntry[];
  lastAssistantText: string | null;
  truncated: boolean;
  bytesRead: number;
}

const DEFAULT_MAX_BYTES = 262_144;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

const empty = (): TranscriptTail => ({
  toolRecord: [],
  lastAssistantText: null,
  truncated: false,
  bytesRead: 0,
});

function isPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return (content as Block[]).some(
    (b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
  );
}

/** The last `maxBytes` of a file as whole lines (the first, usually cut, line dropped). Throws on a read error. */
function readTailText(
  path: string,
  maxBytes: number,
): { text: string; start: number; got: number } {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, maxBytes));
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      from = nl === -1 ? got : nl + 1; // the first line is usually cut in half
    }
    return { text: buf.subarray(from, got).toString("utf8"), start, got };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * What the agent said it was about to do before the tool call `toolUseId`: its text since the last tool result or
 * prompt (the narration sentence every Tinker tool call carries). Personality's surprise compares the result with it
 * (2026-10-03: the field was never filled, 0 of 14,309 steps). Null when there is none; never throws.
 */
export function narrationBefore(
  path: string,
  toolUseId: string,
  o: { maxBytes?: number } = {},
): string | null {
  try {
    const { text } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);
    let said: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        // A tool result or a new prompt closes what was said before it.
        if (
          isPrompt(content) ||
          (Array.isArray(content) && (content as Block[]).some((b) => b?.type === "tool_result"))
        ) {
          said = [];
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
            said.push(b.text.trim());
          else if (b?.type === "tool_use" && b.id === toolUseId) {
            const out = said.join(" ").trim();
            // Under the redactor's 400-character free-text limit, or Jev gets a length instead of the sentence.
            return out ? out.slice(-380) : null;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function readTranscriptTail(path: string, o: { maxBytes?: number } = {}): TranscriptTail {
  try {
    const { text, start, got } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);

    let record: ToolRecordEntry[] = [];
    let byId = new Map<string, ToolRecordEntry>();
    let lastText: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; message?: { content?: unknown }; timestamp?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        if (isPrompt(content)) {
          record = [];
          byId = new Map();
          lastText = null;
          continue;
        }
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b?.type !== "tool_result" || !b.tool_use_id) continue;
            const entry = byId.get(b.tool_use_id);
            if (entry) entry.exit = b.is_error ? 1 : 0;
          }
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = b.text;
          else if (b?.type === "tool_use" && b.name) {
            const input =
              b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
            const cmd = typeof input.command === "string" ? input.command : null;
            const eff = classifyEffect(b.name, cmd, input).value;
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
            const entry: ToolRecordEntry = {
              tool: b.name,
              argsDigest: createHash("sha1")
                .update(JSON.stringify(input))
                .digest("hex")
                .slice(0, 12),
              exit: null,
              filesWritten: [],
              effects: eff ? [eff] : [],
              ts: Number.isFinite(ts) ? ts : 0,
            };
            record.push(entry);
            if (b.id) byId.set(b.id, entry);
          }
        }
      }
    }
    return {
      toolRecord: record,
      lastAssistantText: lastText,
      truncated: start > 0,
      bytesRead: got,
    };
  } catch {
    return empty();
  }
}
