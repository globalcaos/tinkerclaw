import fs from "node:fs";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "../agents/usage.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import {
  resolveSessionTranscriptCandidates,
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "./session-transcript-files.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type SessionTitleFieldsCacheEntry = SessionTitleFields & {
  mtimeMs: number;
  size: number;
};

const sessionTitleFieldsCache = new Map<string, SessionTitleFieldsCacheEntry>();
const MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES = 5000;

function readSessionTitleFieldsCacheKey(
  filePath: string,
  opts?: { includeInterSession?: boolean },
) {
  const includeInterSession = opts?.includeInterSession === true ? "1" : "0";
  return `${filePath}\t${includeInterSession}`;
}

function getCachedSessionTitleFields(cacheKey: string, stat: fs.Stats): SessionTitleFields | null {
  const cached = sessionTitleFieldsCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    sessionTitleFieldsCache.delete(cacheKey);
    return null;
  }
  // LRU bump
  sessionTitleFieldsCache.delete(cacheKey);
  sessionTitleFieldsCache.set(cacheKey, cached);
  return {
    firstUserMessage: cached.firstUserMessage,
    lastMessagePreview: cached.lastMessagePreview,
  };
}

function setCachedSessionTitleFields(cacheKey: string, stat: fs.Stats, value: SessionTitleFields) {
  sessionTitleFieldsCache.set(cacheKey, {
    ...value,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  while (sessionTitleFieldsCache.size > MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES) {
    const oldestKey = sessionTitleFieldsCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionTitleFieldsCache.delete(oldestKey);
  }
}

export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record.__openclaw && typeof record.__openclaw === "object" && !Array.isArray(record.__openclaw)
      ? (record.__openclaw as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const hasTreeEntries = lines.some((line) => {
    if (!line.trim()) {
      return false;
    }
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; parentId?: unknown };
      return parsed.type !== "session" && typeof parsed.id === "string" && "parentId" in parsed;
    } catch {
      return false;
    }
  });
  let branchEntries: SessionEntry[] | null = null;
  if (hasTreeEntries) {
    try {
      branchEntries = SessionManager.open(filePath).getBranch();
    } catch {
      branchEntries = null;
    }
  }

  if (branchEntries) {
    const messages: unknown[] = [];
    let messageSeq = 0;
    for (const entry of branchEntries) {
      if (entry.type === "message" && entry.message) {
        messageSeq += 1;
        messages.push(
          attachOpenClawTranscriptMeta(entry.message, {
            ...(typeof entry.id === "string" ? { id: entry.id } : {}),
            seq: messageSeq,
          }),
        );
        continue;
      }

      if (entry.type === "compaction") {
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        messageSeq += 1;
        const summary = typeof entry.summary === "string" ? entry.summary : undefined;
        const tokensBefore =
          typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore)
            ? entry.tokensBefore
            : undefined;
        const tokensAfter =
          typeof entry.tokensAfter === "number" && Number.isFinite(entry.tokensAfter)
            ? entry.tokensAfter
            : undefined;
        messages.push({
          role: "system",
          content: [{ type: "text", text: summary?.trim() || "Compaction" }],
          timestamp,
          __openclaw: {
            kind: "compaction",
            id: typeof entry.id === "string" ? entry.id : undefined,
            seq: messageSeq,
            ...(summary?.trim() ? { summary: summary.trim() } : {}),
            ...(typeof tokensBefore === "number" ? { tokensBefore } : {}),
            ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
          },
        });
      }
    }
    return messages;
  }

  const messages: unknown[] = [];
  let messageSeq = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messageSeq += 1;
        messages.push(
          attachOpenClawTranscriptMeta(parsed.message, {
            ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
            seq: messageSeq,
          }),
        );
        continue;
      }

      // Compaction entries are not "message" records, but they're useful context for debugging.
      // Emit a lightweight synthetic message that the Web UI can render as a divider.
      if (parsed?.type === "compaction") {
        const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        messageSeq += 1;
        const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
        const tokensBefore =
          typeof parsed.tokensBefore === "number" && Number.isFinite(parsed.tokensBefore)
            ? parsed.tokensBefore
            : undefined;
        const tokensAfter =
          typeof parsed.tokensAfter === "number" && Number.isFinite(parsed.tokensAfter)
            ? parsed.tokensAfter
            : undefined;
        messages.push({
          role: "system",
          content: [{ type: "text", text: summary?.trim() || "Compaction" }],
          timestamp,
          __openclaw: {
            kind: "compaction",
            id: typeof parsed.id === "string" ? parsed.id : undefined,
            seq: messageSeq,
            ...(summary?.trim() ? { summary: summary.trim() } : {}),
            ...(typeof tokensBefore === "number" ? { tokensBefore } : {}),
            ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
          },
        });
      }

      // FORK 2026-04-25: tinker-bridge tool entries — surface tool_use/tool_result
      // blocks in chat history so Tinker can replay them on session reload.
      // The bundled tinker-bridge stream pushes these into a per-run buffer
      // (`extensions/tinkerclaw-tinker-bridge/src/tool-buffer.ts`) and the fork
      // `onTurnComplete` hook drains the buffer with `appendCustomEntry`. The
      // entry shape matches the live `agent.stream:"tool"` event payload that
      // Tinker already renders (`tinker-ui/src/app.ts:1512`), so we just emit
      // a synthetic message of the right role here and Tinker pairs them with
      // its existing tool-bubble logic.
      if (parsed?.type === "custom" && parsed?.customType === "tinker-bridge-tool") {
        const data = (parsed as { data?: Record<string, unknown> }).data ?? {};
        const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
        if (data.phase === "start" && toolCallId && typeof data.name === "string") {
          messageSeq += 1;
          // FORK (Mechanism A): carry the persisted `textOffset` (the count of
          // assistant-text chars accumulated in the turn's coalesced text
          // BEFORE this tool fired) onto the synthetic tool_use message so the
          // reorder pass can slice the coalesced assistant text back into
          // interleaved per-segment messages. Old entries lack the field →
          // `undefined`, which the reorder pass treats as "no offset" and
          // falls back to the legacy splice-before-text behavior.
          const textOffset =
            typeof data.textOffset === "number" && Number.isFinite(data.textOffset)
              ? data.textOffset
              : undefined;
          messages.push({
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolCallId,
                name: data.name,
                input: (data.args as Record<string, unknown>) ?? {},
                _purpose: typeof data.purpose === "string" ? data.purpose : undefined,
              },
            ],
            timestamp,
            __openclaw: {
              kind: "tinker-bridge-tool",
              phase: "start",
              id: typeof parsed.id === "string" ? parsed.id : undefined,
              seq: messageSeq,
              ...(textOffset !== undefined ? { textOffset } : {}),
            },
          });
        } else if (data.phase === "result" && toolCallId) {
          messageSeq += 1;
          const resultText =
            typeof data.result === "string"
              ? data.result
              : data.result != null
                ? JSON.stringify(data.result)
                : "";
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: resultText,
                is_error: Boolean(data.isError),
              },
            ],
            timestamp,
            __openclaw: {
              kind: "tinker-bridge-tool",
              phase: "result",
              id: typeof parsed.id === "string" ? parsed.id : undefined,
              seq: messageSeq,
            },
          });
        }
      }
    } catch {
      // ignore bad lines
    }
  }
  return reorderTinkerBridgeToolBlocks(messages);
}

/**
 * FORK 2026-04-25: tinker-bridge tool entries are appended in `onTurnComplete`,
 * which fires AFTER the assistant text was already persisted, so they trail
 * the assistant message in jsonl order. The natural reading order in chat
 * is `[user → tool_use → tool_result → … → assistant text]`, not
 * `[user → assistant text → … → tool_use → tool_result]`. There can also be
 * intervening `compaction` system entries between the assistant text and
 * the tool block, so a simple back-to-back swap is not enough — we must
 * find the assistant text message the tools belong to and splice them
 * back in front of it.
 *
 * Heuristic: a tinker-bridge-tool block always belongs to the most recent
 * assistant *text* message that came before it in jsonl order, ignoring
 * any system/compaction entries in between. Walk the array; whenever we
 * encounter a tinker-bridge-tool message, splice it into the position
 * immediately before that assistant message.
 */
type ReorderMaybe = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  timestamp?: number;
  __openclaw?: { kind?: string; phase?: string; textOffset?: number; seq?: number };
};

// FORK 2026-06-20 (cc-bridge → tinker-bridge rename): recognise the legacy "cc-bridge-tool" kind
// in pre-rename history so old tool bubbles still reorder/render after the rename.
function isTinkerBridgeTool(m: unknown): boolean {
  const kind = (m as ReorderMaybe | null)?.__openclaw?.kind;
  return kind === "tinker-bridge-tool" || kind === "cc-bridge-tool";
}

function isAssistantText(m: unknown): boolean {
  const msg = m as ReorderMaybe | null;
  if (!msg || msg.role !== "assistant") {
    return false;
  }
  if (msg.__openclaw?.kind === "tinker-bridge-tool" || msg.__openclaw?.kind === "cc-bridge-tool") {
    return false;
  }
  if (!Array.isArray(msg.content)) {
    return true;
  }
  return msg.content.some((c) => c?.type === "text" || c?.type === "thinking");
}

function reorderTinkerBridgeToolBlocks(messages: unknown[]): unknown[] {
  // Pass 1 (LEGACY, byte-identical to the original behavior): tinker-bridge tool
  // entries trail the assistant text in jsonl order; splice each one in front of
  // the most-recent assistant *text* message so the natural reading order is
  // `[user → tool_use → tool_result → … → assistant text]`. Orphaned tools (no
  // preceding assistant text) append at the end as a safe fallback.
  const out: unknown[] = [];
  for (const m of messages) {
    if (!isTinkerBridgeTool(m)) {
      out.push(m);
      continue;
    }
    let target = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (isAssistantText(out[i])) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      out.splice(target, 0, m);
    } else {
      out.push(m);
    }
  }

  // Pass 2 (FORK — Mechanism A): DISABLED 2026-06-25. The offset-slice segmentation is
  // correct in isolation (unit-tested) and `textOffset` is persisted fine, BUT a downstream
  // chat.history coalescing step RE-MERGES the adjacent assistant segments back into the
  // single blob AND drops the interleaved tool messages — verified live: a new tool-using
  // turn returned 0 tool messages + the recombined 93-char blob (regression vs the legacy
  // path, which keeps the tool bubbles). Until that coalescing is fixed (it lives in the
  // contended chat-display-projection.ts), fall back to the byte-identical legacy Pass-1
  // output so new turns keep their tool bubbles; Mechanism B (render-side splitReasoningFromAnswer)
  // already splits the coalesced answer for both new and old turns. `segmentTinkerBridgeTurnsByTextOffset`
  // is retained (with its tests) for when the projection re-merge is fixed.
  return out;
}

/**
 * FORK (Mechanism A): re-segment the legacy-ordered output. After Pass 1 a
 * tinker-bridge turn appears as a contiguous run of tool messages immediately
 * followed by its single coalesced assistant-text message:
 *   `[…, tool_use1, tool_result1, tool_use2, tool_result2, assistantText, …]`
 * If every tool_use in that run carries a `textOffset`, slice `assistantText`
 * at the ascending offsets and re-emit interleaved:
 *   `[…, assistant(seg0), tool_use1, tool_result1, assistant(seg1), tool_use2,
 *      tool_result2, assistant(segFinal), …]`
 * where `segFinal = text[lastOffset:]` (the rest of the text — never a fixed
 * end index, because the final answer is appended to accumulatedText AFTER the
 * offsets were recorded on the tail-recover path). Whitespace-only / zero-length
 * segments are skipped (two tools at the same offset → no segment between them).
 *
 * Any run with a missing offset on even one tool_use is left byte-identical to
 * Pass 1, so old/offset-less turns and every non-tinker-bridge session are
 * unaffected.
 */
function segmentTinkerBridgeTurnsByTextOffset(messages: unknown[]): unknown[] {
  const isToolUse = (m: unknown): boolean =>
    isTinkerBridgeTool(m) && (m as ReorderMaybe).__openclaw?.phase === "start";

  const result: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // A turn's tool run is a contiguous block of tinker-bridge-tool messages.
    if (!isTinkerBridgeTool(m)) {
      result.push(m);
      continue;
    }
    // Collect the full contiguous run of tool messages starting at i.
    let j = i;
    while (j < messages.length && isTinkerBridgeTool(messages[j])) {
      j += 1;
    }
    const run = messages.slice(i, j);
    const next = messages[j];

    const toolUses = run.filter(isToolUse) as ReorderMaybe[];
    const everyToolUseHasOffset =
      toolUses.length > 0 && toolUses.every((t) => typeof t.__openclaw?.textOffset === "number");

    // Eligible only when the block is immediately followed by the turn's single
    // coalesced assistant-text message AND every tool_use carries an offset.
    if (everyToolUseHasOffset && isAssistantText(next)) {
      const assistant = next as ReorderMaybe;
      const fullText = (assistant.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text ?? "")
        .join("");

      // Pair each tool_use with the offset it fired at, in jsonl order; sort the
      // tool_use blocks ascending by offset (the legacy run is already in fire
      // order, but sort defensively to honor the "ascending offsets" contract).
      // Each tool_use's matching tool_result(s) follow it in the run; keep the
      // run's relative order for emission while slicing by sorted offsets.
      const offsets = toolUses
        .map((t) => t.__openclaw?.textOffset as number)
        .slice()
        .sort((a, b) => a - b);

      // segments[0..offsets.length-1] are the inter-offset slices; the FINAL
      // segment (index offsets.length) is the rest of the text after the last
      // offset — everything the tail-recover path appended after offsets were
      // recorded. Clamp each offset into range and never let it run backwards.
      const segments: string[] = [];
      let prev = 0;
      for (const off of offsets) {
        const clamped = Math.max(prev, Math.min(off, fullText.length));
        segments.push(fullText.slice(prev, clamped));
        prev = clamped;
      }
      segments.push(fullText.slice(prev));

      const makeAssistantSegment = (text: string): unknown => ({
        role: "assistant",
        content: [{ type: "text", text }],
        ...(typeof assistant.timestamp === "number" ? { timestamp: assistant.timestamp } : {}),
        __openclaw: {
          ...(assistant.__openclaw ?? {}),
          kind: "tinker-bridge-segment",
        },
      });

      const pushSegment = (text: string): void => {
        // GUARD: never emit empty / whitespace-only assistant messages (two
        // tools at the same offset → empty inter-segment → skipped).
        if (text.trim().length === 0) {
          return;
        }
        result.push(makeAssistantSegment(text));
      };

      // Split the run into tool-units: each tool_use plus the (zero or more)
      // tool_result messages that follow it up to the next tool_use. Emit
      // seg0, then unit0's messages, seg1, unit1's messages, …, segFinal.
      const units: unknown[][] = [];
      for (const r of run) {
        if (isToolUse(r) || units.length === 0) {
          units.push([r]);
        } else {
          units[units.length - 1].push(r);
        }
      }

      pushSegment(segments[0] ?? "");
      for (let u = 0; u < units.length; u++) {
        for (const r of units[u]) {
          result.push(r);
        }
        // The segment that follows this tool-unit. units.length === offsets.length
        // === segments.length - 1, so segments[u + 1] always exists.
        pushSegment(segments[u + 1] ?? "");
      }

      // Skip past the run AND the consumed assistant-text message.
      i = j; // points at `next`; loop's i++ will move past it
      continue;
    }

    // Not eligible — leave the run byte-identical to Pass 1.
    for (const r of run) {
      result.push(r);
    }
    i = j - 1; // continue after the run (loop i++ moves to j)
  }
  return result;
}

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
  resolveSessionTranscriptCandidates,
} from "./session-transcript-files.fs.js";

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

const MAX_LINES_TO_SCAN = 10;

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  provenance?: unknown;
};

export function readSessionTitleFieldsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  const cached = getCachedSessionTitleFields(cacheKey, stat);
  if (cached) {
    return cached;
  }

  if (stat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, stat, empty);
    return empty;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = stat.size;

    // Head (first user message)
    let firstUserMessage: string | null = null;
    try {
      const chunk = readTranscriptHeadChunk(fd);
      if (chunk) {
        firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
      }
    } catch {
      // ignore head read errors
    }

    // Tail (last message preview)
    let lastMessagePreview: string | null = null;
    try {
      lastMessagePreview = readLastMessagePreviewFromOpenTranscript({ fd, size });
    } catch {
      // ignore tail read errors
    }

    const result = { firstUserMessage, lastMessagePreview };
    setCachedSessionTitleFields(cacheKey, stat, result);
    return result;
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const normalized = stripInlineDirectiveTagsForDisplay(part.text).text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function readTranscriptHeadChunk(fd: number, maxBytes = 8192): string | null {
  const buf = Buffer.alloc(maxBytes);
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buf.toString("utf-8", 0, bytesRead);
}

function extractFirstUserMessageFromTranscriptChunk(
  chunk: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user") {
        continue;
      }
      if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function withOpenTranscriptFd<T>(filePath: string, read: (fd: number) => T | null): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    return read(fd);
  } catch {
    // file read error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const chunk = readTranscriptHeadChunk(fd);
    if (!chunk) {
      return null;
    }
    return extractFirstUserMessageFromTranscriptChunk(chunk, opts);
  });
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

function readLastMessagePreviewFromOpenTranscript(params: {
  fd: number;
  size: number;
}): string | null {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  fs.readSync(params.fd, buf, 0, readLen, readStart);

  const chunk = buf.toString("utf-8");
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return null;
    }
    return readLastMessagePreviewFromOpenTranscript({ fd, size });
  });
}

export type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

function extractTranscriptUsageCost(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function resolvePositiveUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractLatestUsageFromTranscriptChunk(
  chunk: string,
  /**
   * FORK 2026-07-28 — the model's context window, threaded solely to ARM the plausibility
   * guard in `deriveSessionTotalTokens`. That guard rejects a value larger than the window
   * (it cannot be a context size), but it is OPT-IN BY ARGUMENT: called without a window it
   * silently does nothing. This was the one call site of five that omitted it, so a transcript
   * line carrying the cc-bridge turn aggregate was laundered into a "fresh" session total —
   * defeating the fix everywhere else. Omitting it again re-opens that path.
   */
  contextWindow?: number,
): SessionTranscriptUsageSnapshot | null {
  const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const snapshot: SessionTranscriptUsageSnapshot = {};
  let sawSnapshot = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawInputTokens = false;
  let sawOutputTokens = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let costUsdTotal = 0;
  let sawCost = false;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message =
        parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
          ? (parsed.message as Record<string, unknown>)
          : undefined;
      if (!message) {
        continue;
      }
      const role = typeof message.role === "string" ? message.role : undefined;
      if (role && role !== "assistant") {
        continue;
      }
      const usageRaw =
        message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
          ? message.usage
          : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
            ? parsed.usage
            : undefined;
      const usage = normalizeUsage(usageRaw);
      const totalTokens = resolvePositiveUsageNumber(
        deriveSessionTotalTokens({ usage, contextTokens: contextWindow }),
      );
      const costUsd = extractTranscriptUsageCost(usageRaw);
      const modelProvider =
        typeof message.provider === "string"
          ? message.provider.trim()
          : typeof parsed.provider === "string"
            ? parsed.provider.trim()
            : undefined;
      const model =
        typeof message.model === "string"
          ? message.model.trim()
          : typeof parsed.model === "string"
            ? parsed.model.trim()
            : undefined;
      // FORK 2026-07-31 — TRANSCRIPT-ONLY SENTINELS. `provider:"openclaw"` assistant entries with
      // model `delivery-mirror` (channel delivery mirror, src/config/sessions/transcript.ts) or
      // `gateway-injected` (restart warnings / abort envelopes, see
      // src/gateway/server-methods/chat-transcript-inject.ts) are records the gateway wrote into
      // the transcript ITSELF, not model output. This scan feeds the SESSION ROW, so a sentinel
      // that reaches `snapshot.model` poisons every downstream reader of that row: the Tinker UI
      // thinking indicator loses its provider colour (a grey dot reading "gatewa..." while opus
      // was answering) and the Models panel counts live runs under "gateway-injected". Only
      // `delivery-mirror` was excluded here before; `gateway-injected` leaked. NOTE the real
      // injected envelope carries `usage.cost.total: 0`, which makes `hasMeaningfulUsage` true —
      // so the zero-usage early-continue below never catches it and this guard is the only stop.
      // KEEP IN SYNC — no shared module owns this list yet; the other copies are:
      //   - src/agents/embedded-agent-runner/replay-history.ts (TRANSCRIPT_ONLY_OPENCLAW_MODELS)
      //   - src/agents/embedded-agent-subscribe.handlers.messages.ts
      //     (isTranscriptOnlyOpenClawAssistantMessage)
      //   - tinker-ui/src/transcript-only-models.ts (UI-side filter)
      const isTranscriptOnlySentinel =
        modelProvider === "openclaw" &&
        (model === "delivery-mirror" || model === "gateway-injected");
      const hasMeaningfulUsage =
        hasNonzeroUsage(usage) ||
        typeof totalTokens === "number" ||
        (typeof costUsd === "number" && Number.isFinite(costUsd));
      const hasModelIdentity = Boolean(modelProvider || model);
      if (!hasMeaningfulUsage && !hasModelIdentity) {
        continue;
      }
      if (isTranscriptOnlySentinel && !hasMeaningfulUsage) {
        continue;
      }

      sawSnapshot = true;
      if (!isTranscriptOnlySentinel) {
        if (modelProvider) {
          snapshot.modelProvider = modelProvider;
        }
        if (model) {
          snapshot.model = model;
        }
      }
      if (typeof usage?.input === "number" && Number.isFinite(usage.input)) {
        inputTokens += usage.input;
        sawInputTokens = true;
      }
      if (typeof usage?.output === "number" && Number.isFinite(usage.output)) {
        outputTokens += usage.output;
        sawOutputTokens = true;
      }
      if (typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead)) {
        cacheRead += usage.cacheRead;
        sawCacheRead = true;
      }
      if (typeof usage?.cacheWrite === "number" && Number.isFinite(usage.cacheWrite)) {
        cacheWrite += usage.cacheWrite;
        sawCacheWrite = true;
      }
      if (typeof totalTokens === "number") {
        snapshot.totalTokens = totalTokens;
        snapshot.totalTokensFresh = true;
      }
      if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
        costUsdTotal += costUsd;
        sawCost = true;
      }
    } catch {
      // skip malformed lines
    }
  }

  if (!sawSnapshot) {
    return null;
  }
  if (sawInputTokens) {
    snapshot.inputTokens = inputTokens;
  }
  if (sawOutputTokens) {
    snapshot.outputTokens = outputTokens;
  }
  if (sawCacheRead) {
    snapshot.cacheRead = cacheRead;
  }
  if (sawCacheWrite) {
    snapshot.cacheWrite = cacheWrite;
  }
  if (sawCost) {
    snapshot.costUsd = costUsdTotal;
  }
  return snapshot;
}

export function readLatestSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  /**
   * FORK 2026-07-28 — pass the session's context window whenever the caller knows it, so the
   * plausibility guard downstream is ARMED. Optional to keep existing call sites valid, but a
   * caller that has the window and omits it silently re-opens the turn-aggregate path.
   */
  contextWindow?: number,
): SessionTranscriptUsageSnapshot | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) {
      return null;
    }
    const chunk = fs.readFileSync(fd, "utf-8");
    return extractLatestUsageFromTranscriptChunk(chunk, contextWindow);
  });
}

const PREVIEW_READ_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const PREVIEW_MAX_LINES = 200;

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) {
    return "tool";
  }
  switch (normalizeLowercaseStringOrEmpty(role)) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  const role = normalizeLowercaseStringOrEmpty(message.role);
  if (role === "assistant") {
    const assistantText = extractAssistantVisibleText(message);
    if (assistantText) {
      const normalized = stripInlineDirectiveTagsForDisplay(assistantText).text.trim();
      return normalized ? normalized : null;
    }
    return null;
  }
  if (typeof message.content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.content).text.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) =>
        typeof entry?.text === "string" ? stripInlineDirectiveTagsForDisplay(entry.text).text : "",
      )
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.text).text.trim();
    return normalized ? normalized : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  return hasToolCall(message as Record<string, unknown>);
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  return extractToolCallNames(message as Record<string, unknown>);
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }
  for (const entry of message.content) {
    const raw = normalizeLowercaseStringOrEmpty(entry?.type);
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") {
      continue;
    }
    return `[${raw}]`;
  }
  return null;
}

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) {
          text += ` +${overflow}`;
        }
      }
    }
    if (!text) {
      text = extractMediaSummary(message);
    }
    if (!text) {
      continue;
    }
    let trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

function readRecentMessagesFromTranscript(
  filePath: string,
  maxMessages: number,
  readBytes: number,
): TranscriptPreviewMessage[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return [];
    }

    const readStart = Math.max(0, size - readBytes);
    const readLen = Math.min(size, readBytes);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptPreviewMessage | undefined;
        if (msg && typeof msg === "object") {
          collected.push(msg);
          if (collected.length >= maxMessages) {
            break;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return collected.toReversed();
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const boundedItems = Math.max(1, Math.min(maxItems, 50));
  const boundedChars = Math.max(20, Math.min(maxChars, 2000));

  for (const readSize of PREVIEW_READ_SIZES) {
    const messages = readRecentMessagesFromTranscript(filePath, boundedItems, readSize);
    if (messages.length > 0 || readSize === PREVIEW_READ_SIZES[PREVIEW_READ_SIZES.length - 1]) {
      return buildPreviewItems(messages, boundedItems, boundedChars);
    }
  }

  return [];
}
