import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRetryAfterSeconds } from "../agents/rate-limit-reset.js";
import {
  isToolCallBlock,
  isToolResultBlock,
  resolveToolUseId,
  type ToolContentBlock,
} from "../chat/tool-content.js";
import type { SessionEntry } from "../config/sessions.js";
import { classifyErrorText, type TurnOutcome, type TurnOutcomeKind } from "../fork/turn-outcome.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { attachOpenClawTranscriptMeta } from "./session-utils.fs.js";

export const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

type ClaudeCliProjectEntry = {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  /**
   * FORK 2026-09-29 — the CLI's typed failure fields live at the TOP level of
   * the JSONL row, NOT inside `message`.
   */
  isApiErrorMessage?: unknown;
  error?: unknown;
  apiErrorStatus?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    /** `{ type:"refusal", category, explanation }` on a refused turn. */
    stop_details?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
};

type ClaudeCliMessage = NonNullable<ClaudeCliProjectEntry["message"]>;
type ClaudeCliUsage = ClaudeCliMessage["usage"];
type TranscriptLikeMessage = Record<string, unknown>;
type ToolNameRegistry = Map<string, string>;

function resolveHistoryHomeDir(homeDir?: string): string {
  return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}

export function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}

export function resolveClaudeCliBindingSessionId(
  entry: SessionEntry | undefined,
): string | undefined {
  const bindingSessionId = normalizeOptionalString(
    entry?.cliSessionBindings?.[CLAUDE_CLI_PROVIDER]?.sessionId,
  );
  if (bindingSessionId) {
    return bindingSessionId;
  }
  const legacyMapSessionId = normalizeOptionalString(entry?.cliSessionIds?.[CLAUDE_CLI_PROVIDER]);
  if (legacyMapSessionId) {
    return legacyMapSessionId;
  }
  const legacyClaudeSessionId = normalizeOptionalString(entry?.claudeCliSessionId);
  return legacyClaudeSessionId || undefined;
}

function resolveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveClaudeCliUsage(raw: ClaudeCliUsage) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = resolveFiniteNumber(raw.input_tokens);
  const output = resolveFiniteNumber(raw.output_tokens);
  const cacheRead = resolveFiniteNumber(raw.cache_read_input_tokens);
  const cacheWrite = resolveFiniteNumber(raw.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeClaudeCliContent(
  content: string | unknown[],
  toolNameRegistry: ToolNameRegistry,
): string | unknown[] {
  if (!Array.isArray(content)) {
    return cloneJsonValue(content);
  }

  const normalized: ToolContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      normalized.push(cloneJsonValue(item as ToolContentBlock));
      continue;
    }
    const block = cloneJsonValue(item as ToolContentBlock);
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "tool_use") {
      const id = normalizeOptionalString(block.id) ?? "";
      const name = normalizeOptionalString(block.name) ?? "";
      if (id && name) {
        toolNameRegistry.set(id, name);
      }
      if (block.input !== undefined && block.arguments === undefined) {
        block.arguments = cloneJsonValue(block.input);
      }
      block.type = "toolcall";
      delete block.input;
      normalized.push(block);
      continue;
    }
    if (type === "tool_result") {
      const toolUseId = resolveToolUseId(block);
      if (!block.name && toolUseId) {
        const toolName = toolNameRegistry.get(toolUseId);
        if (toolName) {
          block.name = toolName;
        }
      }
      normalized.push(block);
      continue;
    }
    normalized.push(block);
  }
  return normalized;
}

function getMessageBlocks(message: unknown): ToolContentBlock[] | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ToolContentBlock[]) : null;
}

function isAssistantToolCallMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") {
    return false;
  }
  const blocks = getMessageBlocks(message);
  return Boolean(blocks && blocks.length > 0 && blocks.every(isToolCallBlock));
}

function isUserToolResultMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user") {
    return false;
  }
  const blocks = getMessageBlocks(message);
  return Boolean(blocks && blocks.length > 0 && blocks.every(isToolResultBlock));
}

function coalesceClaudeCliToolMessages(messages: TranscriptLikeMessage[]): TranscriptLikeMessage[] {
  const coalesced: TranscriptLikeMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const next = messages[index + 1];
    if (!isAssistantToolCallMessage(current) || !isUserToolResultMessage(next)) {
      coalesced.push(current);
      continue;
    }

    const callBlocks = getMessageBlocks(current) ?? [];
    const resultBlocks = getMessageBlocks(next) ?? [];
    const callIds = new Set(
      callBlocks.map(resolveToolUseId).filter((id): id is string => Boolean(id)),
    );
    const allResultsMatch =
      resultBlocks.length > 0 &&
      resultBlocks.every((block) => {
        const toolUseId = resolveToolUseId(block);
        return Boolean(toolUseId && callIds.has(toolUseId));
      });
    if (!allResultsMatch) {
      coalesced.push(current);
      continue;
    }

    coalesced.push({
      ...current,
      content: [...callBlocks.map(cloneJsonValue), ...resultBlocks.map(cloneJsonValue)],
    });
    index += 1;
  }
  return coalesced;
}

// ── FORK 2026-09-29: typed outcomes for Claude CLI failure rows ──────────────
//
// WHY. Claude Code records a failed turn as a SYNTHETIC assistant entry whose
// typed fields sit at the TOP level of the JSONL row rather than inside
// `message`: `isApiErrorMessage:true`, a machine-readable `error` code and
// `apiErrorStatus`, with `message.model:"<synthetic>"`,
// `message.stop_reason:"stop_sequence"` and the human copy as the only text
// block. A refused turn is a different shape again:
// `message.stop_reason:"refusal"` plus `message.stop_details.explanation`,
// where the text block holds whatever partial answer streamed before the
// block landed.
//
// Census of ~/.claude/projects on 2026-09-29 (every row JSON-parsed, 8,631
// files) — 1,457 `isApiErrorMessage` rows (1,200 rate_limit, 131 server_error,
// 34 authentication_failed, 31 billing_error, 27 invalid_request = the
// safeguards copy, 17 unknown, 16 model_not_found, 1 max_output_tokens) plus
// 23 `stop_reason:"refusal"` rows (7 of them on those same error rows). Every
// one of them imported as an ordinary assistant answer, so after a reload a
// rate-limit wall read exactly like a reply.
//
// WHAT. Those rows now carry `stopReason:"error"`, `errorMessage` and a typed
// `outcome` (src/fork/turn-outcome.ts), so the UI renders one outcome bubble
// from the typed field instead of guessing from prose. The content blocks are
// untouched: a refusal keeps its partial answer above the bubble, and a client
// that knows nothing about `outcome` renders what it rendered before.
//
// WHY THE `error` CODE OVERRIDES THE TEXT. The CLI's copy is prose and often
// classifies wrong. Measured against classifyErrorText on 2026-09-29:
// "You've hit your weekly limit · resets 6pm (Europe/Madrid)" → `error` (it
// carries no rate-limit keyword at all) and "Failed to authenticate: OAuth
// session expired" → `error` ("authenticate"/"OAuth" miss the auth rule's word
// boundaries). The structured field is the signal the plan asks for; the text
// supplies only `detail` and the reset clock.

/**
 * The CLI's `error` code → the kind the plan fixes for it. Codes with no entry
 * (server_error, invalid_request, unknown, max_output_tokens, disabled) fall
 * through to the text classifier, which already reads them correctly —
 * measured: "API Error: 529 Overloaded…" → overload, the safeguards copy →
 * refusal.
 */
const CLAUDE_CLI_ERROR_KIND: Readonly<Record<string, TurnOutcomeKind>> = {
  rate_limit: "rate_limit",
  auth: "auth",
  authentication_failed: "auth",
  billing: "billing",
  billing_error: "billing",
  model_not_found: "error",
};

/**
 * One probe string per forced kind, run through `classifyErrorText` itself so
 * `recoverable` and `headline` are BORROWED from turn-outcome.ts rather than
 * copied into a second table here that could silently drift from it. The probe
 * text is discarded. If a probe ever stops yielding its own kind the override
 * degrades to the plain text classification instead of inventing a headline —
 * and `cli-session-history.outcome.test.ts` goes red.
 */
const CLAUDE_CLI_KIND_PROBE: Readonly<Partial<Record<TurnOutcomeKind, string>>> = {
  rate_limit: "429 rate limit",
  auth: "401 unauthorized",
  billing: "402 credit balance",
  refusal: "safeguards",
  error: "",
};

function extractClaudeCliText(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function claudeCliRefusalExplanation(message: ClaudeCliMessage): string | undefined {
  const raw = message.stop_details;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const details = raw as { type?: unknown; explanation?: unknown };
  if (details.type !== "refusal") {
    return undefined;
  }
  return normalizeOptionalString(details.explanation);
}

function isClaudeCliRefusal(message: ClaudeCliMessage): boolean {
  if (message.stop_reason === "refusal") {
    return true;
  }
  const raw = message.stop_details;
  return Boolean(raw && typeof raw === "object" && (raw as { type?: unknown }).type === "refusal");
}

/**
 * Classify CLI failure text, forcing `kind` when the structured `error` code
 * (or a refusal stop reason) knows better than the prose. `retryAfter` is
 * re-derived through the existing reset parser, because `classifyErrorText`
 * only looks for a reset when ITS OWN kind is recoverable — and for the
 * dominant rate-limit copy its own kind is `error`.
 */
function claudeCliOutcome(rawText: string, forcedKind: TurnOutcomeKind | undefined): TurnOutcome {
  const fromText = classifyErrorText(rawText, { source: "cli" });
  if (!forcedKind || forcedKind === fromText.kind) {
    return fromText;
  }
  const probe = CLAUDE_CLI_KIND_PROBE[forcedKind];
  if (probe === undefined) {
    return fromText;
  }
  const shaped = classifyErrorText(probe, { source: "cli" });
  if (shaped.kind !== forcedKind) {
    return fromText;
  }
  let retryAfter = shaped.recoverable ? fromText.retryAfter : undefined;
  if (shaped.recoverable && retryAfter === undefined && rawText.trim()) {
    try {
      retryAfter = resolveRetryAfterSeconds(rawText, Date.now());
    } catch {
      retryAfter = undefined;
    }
  }
  return {
    kind: forcedKind,
    recoverable: shaped.recoverable,
    headline: shaped.headline,
    ...(fromText.detail !== undefined ? { detail: fromText.detail } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    source: "cli",
  };
}

type ClaudeCliFailureFields = {
  stopReason: "error";
  errorMessage: string;
  outcome: TurnOutcome;
};

function resolveClaudeCliFailure(
  entry: ClaudeCliProjectEntry,
  content: string | unknown[],
): ClaudeCliFailureFields | undefined {
  const message = entry.message;
  if (!message) {
    return undefined;
  }
  const apiError = entry.isApiErrorMessage === true;
  const refusal = isClaudeCliRefusal(message);
  if (!apiError && !refusal) {
    return undefined;
  }
  const text = extractClaudeCliText(content);
  const explanation = refusal ? claudeCliRefusalExplanation(message) : undefined;
  // On an `isApiErrorMessage` row the text IS the error. On a plain refusal the
  // text is the partial answer that streamed first, so the block's own
  // explanation becomes the error message and the answer stays in `content`.
  const raw = apiError ? text || explanation || "" : explanation || text;
  const code = normalizeOptionalString(entry.error);
  const forcedKind: TurnOutcomeKind | undefined = refusal
    ? "refusal"
    : code
      ? CLAUDE_CLI_ERROR_KIND[code]
      : undefined;
  const outcome = claudeCliOutcome(raw, forcedKind);
  return { stopReason: "error", errorMessage: raw || outcome.headline, outcome };
}

function parseClaudeCliHistoryEntry(
  entry: ClaudeCliProjectEntry,
  cliSessionId: string,
  toolNameRegistry: ToolNameRegistry,
): TranscriptLikeMessage | null {
  // Claude Code records tool-injected reference material (for example the
  // workflow-authoring skill body) as a `user` entry with `isMeta: true`.
  // It is model context, not text authored by the human, and must never be
  // projected into WebChat as a user bubble.
  if (
    entry.isSidechain === true ||
    entry.isMeta === true ||
    !entry.message ||
    typeof entry.message !== "object"
  ) {
    return null;
  }
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const role = typeof entry.message.role === "string" ? entry.message.role : undefined;
  if ((type !== "user" && type !== "assistant") || role !== type) {
    return null;
  }

  const timestamp = resolveTimestampMs(entry.timestamp);
  const baseMeta = {
    importedFrom: CLAUDE_CLI_PROVIDER,
    cliSessionId,
    ...(normalizeOptionalString(entry.uuid) ? { externalId: entry.uuid } : {}),
  };

  const content =
    typeof entry.message.content === "string" || Array.isArray(entry.message.content)
      ? normalizeClaudeCliContent(entry.message.content, toolNameRegistry)
      : undefined;
  if (content === undefined) {
    return null;
  }

  if (type === "user") {
    return attachOpenClawTranscriptMeta(
      {
        role: "user",
        content,
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
      baseMeta,
    ) as TranscriptLikeMessage;
  }

  // FORK 2026-09-29 — a CLI failure row replaces the raw stop reason with the
  // typed triple; every other assistant row keeps exactly the shape it had.
  const failure = resolveClaudeCliFailure(entry, content);
  const statusFields: Record<string, unknown> = failure
    ? {
        stopReason: failure.stopReason,
        errorMessage: failure.errorMessage,
        outcome: failure.outcome,
      }
    : normalizeOptionalString(entry.message.stop_reason)
      ? { stopReason: entry.message.stop_reason }
      : {};

  return attachOpenClawTranscriptMeta(
    {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: CLAUDE_CLI_PROVIDER,
      ...(normalizeOptionalString(entry.message.model) ? { model: entry.message.model } : {}),
      ...statusFields,
      ...(resolveClaudeCliUsage(entry.message.usage)
        ? { usage: resolveClaudeCliUsage(entry.message.usage) }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
    baseMeta,
  ) as TranscriptLikeMessage;
}

export function resolveClaudeCliSessionFilePath(params: {
  cliSessionId: string;
  homeDir?: string;
}): string | undefined {
  const projectsDir = resolveClaudeProjectsDir(params.homeDir);
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${params.cliSessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ── FORK 2026-09-14: incremental, stat-keyed transcript cache ─────────────────────────────────
//
// WHY. Every `chat.history` poll re-read the bound claude-cli transcript in full and re-parsed
// it line by line ON THE MAIN THREAD. Measured on 2026-09-14 with seven open tabs: ~20 polls a
// minute, 3–7 MB per transcript, ≈60 MB/min of readFileSync + JSON.parse, 0.8–1.0 s per poll
// (0.19–0.29 s in calm windows), and the garbage it produced fed the multi-second GC stalls that
// made every chat look frozen. Idle tabs paid the same price as the active one: a transcript
// whose last line was written on 2026-09-07 was re-parsed 7 MB at a time all day.
//
// WHAT. Claude Code transcripts are append-only JSONL. The cache keeps, per transcript file, the
// messages parsed so far plus the byte offset they end at (always a '\n' boundary) and the
// (ino, size, mtimeMs) triple it last saw:
//   - unchanged triple           → serve from memory, zero I/O;
//   - grown, same inode, and the byte before the old offset is still '\n' → read ONLY the tail,
//                                  parse only the new complete lines, keep the old ones;
//   - anything else (shrunk, replaced inode, rewritten, older mtime, or the periodic re-verify)
//                                  → full re-read, exactly the old behaviour.
// A trailing line with no '\n' yet is parsed for THIS serve but not committed (offset stays
// before it), so a half-written line is never mistaken for a complete one and is re-read whole
// once its newline lands. Callers receive a fresh structural copy (objects/arrays cloned, strings
// shared) so nothing downstream can mutate the cached tree. Bounded: the least recently used
// transcript is evicted beyond CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES.
//
// WHAT IT DOES NOT CHANGE. The parse (`parseClaudeCliHistoryEntry`) and the tool-call/result
// coalescing (`coalesceClaudeCliToolMessages`) are untouched; coalescing still runs over the
// whole list whenever it changed, so a call/result pair split across two appends is merged the
// same way a single full parse merges it. What is served is byte-for-byte what a full read would
// serve — `cli-session-history.cache.test.ts` asserts that equivalence directly.

type CachedClaudeCliTranscript = {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes parsed and committed so far. Always ends on a '\n' boundary (or is 0). */
  offset: number;
  messages: TranscriptLikeMessage[];
  /** Messages parsed from a trailing line that had no '\n' yet — re-read on the next growth. */
  partialTail: TranscriptLikeMessage[];
  toolNameRegistry: ToolNameRegistry;
  coalesced: TranscriptLikeMessage[] | null;
  lastUsedAt: number;
  /** Last full read. Append-only is a contract we trust but re-verify on a slow clock. */
  verifiedAt: number;
};

export const CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES = 24;
const CLAUDE_CLI_TRANSCRIPT_REVERIFY_MS = 15 * 60_000;
const NEWLINE_BYTE = 0x0a;
const claudeCliTranscriptCache = new Map<string, CachedClaudeCliTranscript>();
const claudeCliTranscriptCacheStats = { hits: 0, tailReads: 0, fullReads: 0, resets: 0 };

function readFileByteRange(filePath: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function byteBeforeIsNewline(filePath: string, position: number): boolean {
  if (position <= 0) {
    return true;
  }
  try {
    const b = readFileByteRange(filePath, position - 1, position);
    return b.length === 1 && b[0] === NEWLINE_BYTE;
  } catch {
    return false;
  }
}

/** Split a byte chunk into the complete lines (each ending in '\n') and the trailing partial. */
function splitCompleteLines(chunk: Buffer): { complete: Buffer; partial: Buffer } {
  const cut = chunk.lastIndexOf(NEWLINE_BYTE);
  if (cut < 0) {
    return { complete: chunk.subarray(0, 0), partial: chunk };
  }
  return { complete: chunk.subarray(0, cut + 1), partial: chunk.subarray(cut + 1) };
}

function parseClaudeCliTranscriptLines(
  text: string,
  cliSessionId: string,
  toolNameRegistry: ToolNameRegistry,
  into: TranscriptLikeMessage[],
): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ClaudeCliProjectEntry;
      const message = parseClaudeCliHistoryEntry(parsed, cliSessionId, toolNameRegistry);
      if (message) {
        into.push(message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
}

/** Objects and arrays are copied, strings and other primitives shared. */
function cloneTranscriptTree<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneTranscriptTree(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneTranscriptTree(item);
    }
    return out as T;
  }
  return value;
}

function serveCachedClaudeCliTranscript(
  cached: CachedClaudeCliTranscript,
): TranscriptLikeMessage[] {
  cached.lastUsedAt = Date.now();
  if (!cached.coalesced) {
    cached.coalesced = coalesceClaudeCliToolMessages(
      cached.partialTail.length > 0 ? [...cached.messages, ...cached.partialTail] : cached.messages,
    );
  }
  return cached.coalesced.map((message) => cloneTranscriptTree(message));
}

function evictClaudeCliTranscriptCache(): void {
  while (claudeCliTranscriptCache.size > CLAUDE_CLI_TRANSCRIPT_CACHE_MAX_FILES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of claudeCliTranscriptCache) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    claudeCliTranscriptCache.delete(oldestKey);
  }
}

function fullReadClaudeCliTranscript(
  filePath: string,
  stat: fs.Stats,
  cliSessionId: string,
): CachedClaudeCliTranscript | null {
  let bytes: Buffer;
  try {
    bytes = readFileByteRange(filePath, 0, stat.size);
  } catch {
    return null;
  }
  const { complete, partial } = splitCompleteLines(bytes);
  const toolNameRegistry: ToolNameRegistry = new Map();
  const messages: TranscriptLikeMessage[] = [];
  parseClaudeCliTranscriptLines(
    complete.toString("utf-8"),
    cliSessionId,
    toolNameRegistry,
    messages,
  );
  const partialTail: TranscriptLikeMessage[] = [];
  if (partial.length > 0) {
    parseClaudeCliTranscriptLines(
      partial.toString("utf-8"),
      cliSessionId,
      new Map(toolNameRegistry),
      partialTail,
    );
  }
  const now = Date.now();
  return {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: complete.length,
    messages,
    partialTail,
    toolNameRegistry,
    coalesced: null,
    lastUsedAt: now,
    verifiedAt: now,
  };
}

function appendClaudeCliTranscriptTail(
  cached: CachedClaudeCliTranscript,
  filePath: string,
  stat: fs.Stats,
  cliSessionId: string,
): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileByteRange(filePath, cached.offset, stat.size);
  } catch {
    return false;
  }
  const { complete, partial } = splitCompleteLines(bytes);
  if (complete.length > 0) {
    parseClaudeCliTranscriptLines(
      complete.toString("utf-8"),
      cliSessionId,
      cached.toolNameRegistry,
      cached.messages,
    );
    cached.offset += complete.length;
  }
  cached.partialTail = [];
  if (partial.length > 0) {
    parseClaudeCliTranscriptLines(
      partial.toString("utf-8"),
      cliSessionId,
      new Map(cached.toolNameRegistry),
      cached.partialTail,
    );
  }
  cached.size = stat.size;
  cached.mtimeMs = stat.mtimeMs;
  cached.coalesced = null;
  return true;
}

export function readClaudeCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
}): TranscriptLikeMessage[] {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return [];
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cached = claudeCliTranscriptCache.get(filePath);
  if (cached) {
    const now = Date.now();
    const sameInode = cached.ino === stat.ino;
    const dueForReverify = now - cached.verifiedAt >= CLAUDE_CLI_TRANSCRIPT_REVERIFY_MS;
    if (
      sameInode &&
      !dueForReverify &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      claudeCliTranscriptCacheStats.hits += 1;
      return serveCachedClaudeCliTranscript(cached);
    }
    const appendOnly =
      sameInode &&
      !dueForReverify &&
      stat.size >= cached.offset &&
      stat.mtimeMs >= cached.mtimeMs &&
      byteBeforeIsNewline(filePath, cached.offset);
    if (appendOnly && appendClaudeCliTranscriptTail(cached, filePath, stat, params.cliSessionId)) {
      claudeCliTranscriptCacheStats.tailReads += 1;
      return serveCachedClaudeCliTranscript(cached);
    }
    claudeCliTranscriptCacheStats.resets += 1;
    claudeCliTranscriptCache.delete(filePath);
  }

  const fresh = fullReadClaudeCliTranscript(filePath, stat, params.cliSessionId);
  if (!fresh) {
    return [];
  }
  claudeCliTranscriptCacheStats.fullReads += 1;
  claudeCliTranscriptCache.set(filePath, fresh);
  evictClaudeCliTranscriptCache();
  return serveCachedClaudeCliTranscript(fresh);
}

/** Test seam for the transcript cache (never used by production code paths). */
export const __claudeCliTranscriptCacheTesting = {
  reset(): void {
    claudeCliTranscriptCache.clear();
    claudeCliTranscriptCacheStats.hits = 0;
    claudeCliTranscriptCacheStats.tailReads = 0;
    claudeCliTranscriptCacheStats.fullReads = 0;
    claudeCliTranscriptCacheStats.resets = 0;
  },
  stats(): { hits: number; tailReads: number; fullReads: number; resets: number } {
    return { ...claudeCliTranscriptCacheStats };
  },
  size(): number {
    return claudeCliTranscriptCache.size;
  },
  /** Force the periodic re-verify on the next read of `filePath` (simulates the 15-minute clock). */
  expireVerification(filePath: string): boolean {
    const cached = claudeCliTranscriptCache.get(filePath);
    if (!cached) {
      return false;
    }
    cached.verifiedAt = 0;
    return true;
  },
};

type ClaudeCliCompactBoundaryEntry = {
  type: "system";
  subtype?: unknown;
  content?: unknown;
  timestamp?: unknown;
  compactMetadata?: {
    trigger?: unknown;
    preTokens?: unknown;
  };
};

type ClaudeCliSummaryEntry = {
  type: "summary";
  summary?: unknown;
  leafUuid?: unknown;
  timestamp?: unknown;
};

export type ClaudeCliFallbackSeed = {
  summaryText?: string;
  recentTurns: TranscriptLikeMessage[];
};

function isCompactBoundary(entry: ClaudeCliProjectEntry): boolean {
  if (entry.type !== "system") {
    return false;
  }
  const subtype = (entry as ClaudeCliCompactBoundaryEntry).subtype;
  return typeof subtype === "string" && subtype === "compact_boundary";
}

function extractCompactBoundaryFallbackText(entry: ClaudeCliProjectEntry): string | undefined {
  const content = (entry as ClaudeCliCompactBoundaryEntry).content;
  return typeof content === "string" && content.trim() ? content.trim() : undefined;
}

function extractSummaryText(entry: ClaudeCliProjectEntry): string | undefined {
  if (entry.type !== "summary") {
    return undefined;
  }
  const summary = (entry as ClaudeCliSummaryEntry).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

export function readClaudeCliFallbackSeed(params: {
  cliSessionId: string;
  homeDir?: string;
}): ClaudeCliFallbackSeed | undefined {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  let pendingSummary: string | undefined;
  let lastSummary: string | undefined;
  let lastBoundaryFallback: string | undefined;
  let windowedTurns: TranscriptLikeMessage[] = [];
  const toolNameRegistry: ToolNameRegistry = new Map();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: ClaudeCliProjectEntry;
    try {
      parsed = JSON.parse(line) as ClaudeCliProjectEntry;
    } catch {
      continue;
    }

    const explicitSummary = extractSummaryText(parsed);
    if (explicitSummary) {
      pendingSummary = explicitSummary;
      continue;
    }

    if (isCompactBoundary(parsed)) {
      lastSummary = pendingSummary;
      pendingSummary = undefined;
      lastBoundaryFallback = extractCompactBoundaryFallbackText(parsed) ?? lastBoundaryFallback;
      windowedTurns = [];
      toolNameRegistry.clear();
      continue;
    }

    const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId, toolNameRegistry);
    if (message) {
      windowedTurns.push(message);
    }
  }

  const recentTurns = coalesceClaudeCliToolMessages(windowedTurns);
  const resolvedSummaryText = lastSummary ?? pendingSummary ?? lastBoundaryFallback;
  if (!resolvedSummaryText && recentTurns.length === 0) {
    return undefined;
  }
  return {
    ...(resolvedSummaryText ? { summaryText: resolvedSummaryText } : {}),
    recentTurns,
  };
}
