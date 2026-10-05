/**
 * FORK 2026-10-02 (owner: "I see some sent information is unitemised, why is that? Can you fix it
 * and assign it a bucket?") — what each claude CLI call's prompt is made of, read from the CLI's
 * own transcript.
 *
 * WHY. The CONTEXT WINDOW panel's call timeline stacks every call's billed prompt by bucket and
 * hatches whatever the buckets do not cover as "unitemised". On this lane the only composition it
 * had was the gateway's anatomy row, and that row describes the gateway's MIRROR transcript, not
 * what the CLI sends. Measured: the row itemised 126,558 tokens with toolResults 0 while each CLI
 * call billed ~200-540k, so most of every call was hatched. TINKER_UI_DESIGN_BIBLE/
 * context-window-panel.md F6 names why the gateway never looked: on cc-bridge "the producer cannot
 * see the pack ... reading a multi-MB CLI transcript per turn on the gateway loop is the stall
 * class removed on 2026-09-21..23". The CLI's transcript (~/.claude/projects/<encoded cwd>/
 * <session id>.jsonl, transcript-path.ts) records nearly all of what it sends, so this module
 * reads it WITHOUT that stall (COST, below), and stream.ts puts the result on each `usage` frame as
 * `composition` (the A8 contract, src/infra/call-telemetry.ts CALL_COMPOSITION_KEYS).
 *
 * THE BUCKETS. Running sums in CHARS, turned into tokens only by the one anatomy estimator
 * (estimateTokens, through openclaw/plugin-sdk/fork-telemetry):
 *   systemPrompt   attachment prompt_snapshot.systemPrompt. REPLACED by each snapshot (the latest
 *                  wins), and a compaction keeps it.
 *   moralCode      every moral-code block, from the one published MORAL_CODE_MARKER
 *                  (src/moral-code/contract.ts, through plugin-sdk/state-paths, raw or JSON-escaped)
 *                  to the closing tag derived from its tag name, wherever it sits: the system prompt
 *                  (its own replace-on-snapshot figure), hook context, a user prompt (the resume
 *                  prefix). A block with no closing tag runs to the end of its text. A 0 is a
 *                  measured 0: the prompt carries no moral code.
 *   injectedFiles  instructions.files (each file's content, else its JSON), and the rest of the
 *                  hook context.
 *   skills         skill_listing.content.
 *   toolSchemas    deferred_tools_delta.addedLines and mcp_instructions_delta.addedBlocks (JSON),
 *                  plus r0, below.
 *   conversation   assistant text, thinking and tool_use input (JSON); user text that is not the
 *                  current prompt (meta records, text beside a tool_result, earlier prompts, the
 *                  compaction summary); every other attachment, as JSON (small reminders).
 *   toolResults    the text of tool_result blocks (images skipped).
 *   userMessage    the current prompt: a user record with string content or text blocks, not meta
 *                  and with no tool_result, plus queued_command prompts. The next prompt moves it
 *                  into conversation.
 * A `system` compact_boundary resets every bucket but the system-prompt snapshot (and its moral
 * code); r0 is kept.
 *
 * HOOK CONTEXT IS READ AS THE CLI SENDS IT, NOT AS THE HOOK PRINTED IT. Checked in the installed
 * CLI (2.1.287) and on the transcripts: hook_success.stdout is the hook's raw output and never
 * reaches the model; a hook_success's `content` is sent only for SessionStart, UserPromptSubmit
 * and UserPromptExpansion, and only when it is not empty; hook_additional_context.content is what
 * is sent. A hook's additionalContext longer than 10,000 chars is saved to a file and replaced by
 * a ~2,000-char preview that names the file, so the 40,329-char moral-code pack the tinkerclaw-core
 * SessionStart hook prints reaches the model as that preview: moralCode reads 480 tokens on the
 * three newest sessions, not the pack's ~11.5k. Counting stdout would draw ~12.8k tokens the model
 * never received.
 *
 * WHAT THE TRANSCRIPT DOES NOT HOLD: r0. Claude Code's built-in tool definitions are sent with
 * every call and never written down. At the FIRST call of a session, billed (input + cacheRead +
 * cacheWrite) minus everything itemised before it is a near-constant remainder. Over the 60 newest
 * sessions: 31.1k-36.4k tokens on opus 5.5, sonnet 5.5, opus 5 and fable 5.1 (51 of 52; one
 * opus 5 session with a smaller system prompt read 23.7k), 9.7k-10.6k on haiku 4.5 and sonnet 4.6
 * (8), which get a smaller tool set. It is measured once per transcript and added to
 * toolSchemas on every call. The CLI writes a call's assistant record only after its message_start,
 * so at the session's first `usage` frame the transcript holds no usage yet; compose() then takes r0
 * from that call's own billed prompt, which is the same figure the file yields a moment later.
 *
 * THE ESTIMATOR UNDERCOUNTS WHAT A SESSION ADDS. ceil(chars / 3.5) is low on code and JSON: on four
 * sessions the billed growth was 1.6-2.0x the estimated growth, and by the last call of the three
 * newest sessions billed exceeded the itemised sum (r0 included) by 79k-109k tokens. That error
 * lives in what the session added, so the reconciliation puts it there.
 *
 * RECONCILIATION (compose): residual = billed - sum of the buckets. A positive residual is shared
 * over conversation, toolResults and userMessage in proportion to their tokens (all three 0: all of
 * it to conversation). A negative one is taken off those three in proportion, never below 0; when
 * they cannot absorb it, every bucket is scaled down instead. Largest-remainder rounding then makes
 * the integers sum to `billed` exactly, so nothing is left unitemised.
 *
 * COST, AND WHY THIS IS NOT F6's STALL. That stall was a whole multi-MB transcript read per turn.
 * Here each reader keeps a byte offset (cliContextFor caches one per transcript, LRU 32), and
 * refresh() reads only the bytes the CLI appended since the previous call (sync open/fstat/read
 * from the offset, a trailing partial line kept for next time): 39 KB per call at the median of
 * the 60 newest sessions (17-359 KB on average per session). The whole file
 * is read ONCE per reader, on its first call after a gateway start: 21-52 ms for the 2.4-5.7 MB
 * transcripts measured. A transcript over 64 MB on that first read is skipped and compose()
 * returns undefined, because a sync parse of that size would stall every session the gateway
 * serves. A file that shrank or was replaced is read again from the start. A missing or unreadable
 * file reads nothing and throws nothing.
 */
import fs from "node:fs";
import {
  type CallComposition,
  type CallCompositionKey,
  CALL_COMPOSITION_KEYS,
  estimateTokens,
} from "openclaw/plugin-sdk/fork-telemetry";
import { MORAL_CODE_MARKER } from "openclaw/plugin-sdk/state-paths";

/** What the call telemetry needs from a transcript reader (stream.ts createBridgeCallTelemetry). */
export type CliContextSource = {
  /** Read whatever the CLI appended since the last refresh. Never throws. */
  refresh(): void;
  /**
   * The billed prompt split into the panel's buckets, all 8 keys, summing to `billed` exactly.
   * Undefined when `billed` is not > 0 or nothing was ever read.
   */
  compose(billed: number): CallComposition | undefined;
};

export type CliContextReader = CliContextSource & {
  /**
   * The buckets as itemised, before reconciliation: tokens per key (toolSchemas includes r0) and
   * r0 itself. Undefined when nothing was read. For tests and measurements.
   */
  itemised(): { tokens: Record<CallCompositionKey, number>; r0: number | undefined } | undefined;
};

/** A first read larger than this is skipped (COST, above). */
export const CLI_CONTEXT_MAX_FIRST_READ_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * The moral code's closing tag, DERIVED from the one published marker (src/moral-code/contract.ts,
 * through plugin-sdk/state-paths, as moral-code-delivery.ts reaches it) the way
 * src/agents/context-anatomy.ts derives it, so no second spelling of the tag exists here. A marker
 * that is not an opening tag leaves it undefined, and every block then runs to the end of its text.
 */
const MORAL_CODE_TAG_NAME = /^<([A-Za-z0-9_-]+)/.exec(MORAL_CODE_MARKER)?.[1];
const MORAL_CODE_CLOSE = MORAL_CODE_TAG_NAME ? `</${MORAL_CODE_TAG_NAME}>` : undefined;
/** The marker as it reads inside JSON-encoded text (`source=\"…\"`), as context-anatomy.ts matches it. */
const MORAL_CODE_MARKER_JSON = JSON.stringify(MORAL_CODE_MARKER).slice(1, -1);
/** The hook events whose hook_success `content` the CLI sends (HOOK CONTEXT, above). */
const HOOK_SUCCESS_SENT_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "UserPromptExpansion",
]);
/** The buckets a residual is reconciled against: what the session added. */
const DYNAMIC_KEYS: readonly CallCompositionKey[] = ["conversation", "toolResults", "userMessage"];

type RunningKey = Exclude<CallCompositionKey, "systemPrompt">;

function emptyRunning(): Record<RunningKey, number> {
  return {
    moralCode: 0,
    injectedFiles: 0,
    skills: 0,
    toolSchemas: 0,
    conversation: 0,
    toolResults: 0,
    userMessage: 0,
  };
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

/** The text of a string, a block, or a list of either. Image and document blocks have none. */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("");
  }
  const rec = asRecord(value);
  if (!rec || rec.type === "image" || rec.type === "document") {
    return "";
  }
  return textOf(rec.text ?? rec.content ?? "");
}

function jsonLength(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** The earliest moral-code opening tag at or after `from`, raw or JSON-escaped. */
function findMoralCodeOpen(text: string, from: number): { at: number; length: number } | undefined {
  const raw = text.indexOf(MORAL_CODE_MARKER, from);
  const json = text.indexOf(MORAL_CODE_MARKER_JSON, from);
  if (raw < 0 && json < 0) {
    return undefined;
  }
  return raw >= 0 && (json < 0 || raw <= json)
    ? { at: raw, length: MORAL_CODE_MARKER.length }
    : { at: json, length: MORAL_CODE_MARKER_JSON.length };
}

/** Chars inside moral-code blocks (every occurrence; an unclosed one runs to the end) and the rest. */
export function splitMoralCode(text: string): { moral: number; other: number } {
  let moral = 0;
  let from = 0;
  for (;;) {
    const open = findMoralCodeOpen(text, from);
    if (!open) {
      break;
    }
    const close = MORAL_CODE_CLOSE ? text.indexOf(MORAL_CODE_CLOSE, open.at + open.length) : -1;
    const end = close < 0 || !MORAL_CODE_CLOSE ? text.length : close + MORAL_CODE_CLOSE.length;
    moral += end - open.at;
    from = end;
  }
  return { moral, other: text.length - moral };
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Non-negative reals → integers summing to `target`: floor each, then +1 by largest remainder. */
function largestRemainder(values: number[], target: number): number[] {
  const floors = values.map((v) => Math.max(0, Math.floor(v)));
  let short = target - sum(floors);
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .toSorted((a, b) => b.frac - a.frac || a.i - b.i)
    .map((entry) => entry.i);
  for (let k = 0; short > 0; k = (k + 1) % order.length) {
    floors[order[k]] += 1;
    short -= 1;
  }
  // Float error can only leave `short` a hair above 0; this is a guard, not a path.
  while (short < 0) {
    const largest = floors.indexOf(Math.max(...floors));
    floors[largest] -= 1;
    short += 1;
  }
  return floors;
}

/**
 * RECONCILIATION (header): itemised tokens per bucket → integers that sum to `target` exactly,
 * the error put on the buckets the session added. Pure.
 */
export function reconcileComposition(
  tokens: Record<CallCompositionKey, number>,
  target: number,
): Record<CallCompositionKey, number> {
  const keys = CALL_COMPOSITION_KEYS;
  const original = keys.map((k) => Math.max(0, Number.isFinite(tokens[k]) ? tokens[k] : 0));
  const values = [...original];
  const total = sum(original);
  const dynamic = DYNAMIC_KEYS.map((k) => keys.indexOf(k));
  const dynamicTotal = sum(dynamic.map((i) => original[i]));
  const residual = target - total;
  if (residual > 0) {
    if (dynamicTotal === 0) {
      values[keys.indexOf("conversation")] += residual;
    } else {
      for (const i of dynamic) {
        values[i] += (residual * original[i]) / dynamicTotal;
      }
    }
  } else if (residual < 0) {
    const deficit = -residual;
    if (deficit <= dynamicTotal) {
      for (const i of dynamic) {
        values[i] = Math.max(0, original[i] - (deficit * original[i]) / dynamicTotal);
      }
    } else {
      const factor = target / total;
      for (let i = 0; i < values.length; i++) {
        values[i] = original[i] * factor;
      }
    }
  }
  const rounded = largestRemainder(values, target);
  const out = {} as Record<CallCompositionKey, number>;
  keys.forEach((k, i) => {
    out[k] = rounded[i];
  });
  return out;
}

/** One transcript, read incrementally. See the header for every rule. */
export function createCliContextReader(transcriptPath: string): CliContextReader {
  let offset = 0;
  let identity: string | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let parsedAny = false;
  let systemPromptChars = 0;
  let moralInSystemPromptChars = 0;
  let running = emptyRunning();
  let r0: number | undefined;
  /** message.ids already seen while looking for the first call's usage; dropped once r0 is set. */
  let usageIdsSeen: Set<string> | null = new Set();

  const startOver = () => {
    offset = 0;
    pending = Buffer.alloc(0);
    parsedAny = false;
    systemPromptChars = 0;
    moralInSystemPromptChars = 0;
    running = emptyRunning();
    r0 = undefined;
    usageIdsSeen = new Set();
  };

  const addSplit = (text: string, rest: RunningKey) => {
    const { moral, other } = splitMoralCode(text);
    running.moralCode += moral;
    running[rest] += other;
  };

  const tokensNow = (): Record<CallCompositionKey, number> => ({
    moralCode: estimateTokens(running.moralCode + moralInSystemPromptChars),
    systemPrompt: estimateTokens(systemPromptChars),
    injectedFiles: estimateTokens(running.injectedFiles),
    skills: estimateTokens(running.skills),
    toolSchemas: estimateTokens(running.toolSchemas),
    conversation: estimateTokens(running.conversation),
    toolResults: estimateTokens(running.toolResults),
    userMessage: estimateTokens(running.userMessage),
  });

  const onAttachment = (attachment: Rec) => {
    switch (attachment.type) {
      case "prompt_snapshot": {
        const pieces = Array.isArray(attachment.systemPrompt)
          ? attachment.systemPrompt
          : [attachment.systemPrompt];
        let moral = 0;
        let other = 0;
        for (const piece of pieces) {
          const split = splitMoralCode(textOf(piece));
          moral += split.moral;
          other += split.other;
        }
        systemPromptChars = other;
        moralInSystemPromptChars = moral;
        return;
      }
      case "instructions": {
        const files = attachment.files;
        if (!Array.isArray(files)) {
          running.injectedFiles += jsonLength(files);
          return;
        }
        for (const file of files) {
          const content = asRecord(file)?.content;
          running.injectedFiles += typeof content === "string" ? content.length : jsonLength(file);
        }
        return;
      }
      case "skill_listing":
        running.skills += textOf(attachment.content).length;
        return;
      case "deferred_tools_delta":
        running.toolSchemas += jsonLength(attachment.addedLines);
        return;
      case "mcp_instructions_delta":
        running.toolSchemas += jsonLength(attachment.addedBlocks);
        return;
      case "hook_additional_context": {
        const items = Array.isArray(attachment.content) ? attachment.content : [attachment.content];
        for (const item of items) {
          addSplit(textOf(item), "injectedFiles");
        }
        return;
      }
      case "hook_success": {
        const content = textOf(attachment.content);
        if (
          content &&
          typeof attachment.hookEvent === "string" &&
          HOOK_SUCCESS_SENT_EVENTS.has(attachment.hookEvent)
        ) {
          addSplit(content, "injectedFiles");
        }
        return;
      }
      case "queued_command":
        running.userMessage += textOf(attachment.prompt).length;
        return;
      default:
        running.conversation += jsonLength(attachment);
    }
  };

  const startPrompt = (texts: string[]) => {
    running.conversation += running.userMessage;
    running.userMessage = 0;
    for (const text of texts) {
      addSplit(text, "userMessage");
    }
  };

  const onUser = (record: Rec, message: Rec) => {
    const content = message.content;
    const isMeta = record.isMeta === true;
    const isSummary = record.isCompactSummary === true;
    if (typeof content === "string") {
      if (isMeta || isSummary) {
        addSplit(content, "conversation");
      } else {
        startPrompt([content]);
      }
      return;
    }
    if (!Array.isArray(content)) {
      return;
    }
    const texts: string[] = [];
    let hasToolResult = false;
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type === "tool_result") {
        hasToolResult = true;
        running.toolResults += textOf(block.content).length;
      } else if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (typeof raw === "string") {
        texts.push(raw);
      }
    }
    if (texts.length === 0) {
      return;
    }
    if (isMeta || isSummary || hasToolResult) {
      for (const text of texts) {
        addSplit(text, "conversation");
      }
    } else {
      startPrompt(texts);
    }
  };

  const onAssistant = (message: Rec) => {
    if (r0 === undefined && usageIdsSeen && message.model !== "<synthetic>") {
      const id = typeof message.id === "string" ? message.id : undefined;
      const firstRecordOfMessage = id === undefined || !usageIdsSeen.has(id);
      if (id !== undefined) {
        usageIdsSeen.add(id);
      }
      const usage = asRecord(message.usage);
      if (firstRecordOfMessage && usage) {
        const part = (key: string) => {
          const v = usage[key];
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
        };
        const billed0 =
          part("input_tokens") +
          part("cache_read_input_tokens") +
          part("cache_creation_input_tokens");
        if (billed0 > 0) {
          r0 = Math.max(0, billed0 - sum(Object.values(tokensNow())));
          usageIdsSeen = null;
        }
      }
    }
    const content = Array.isArray(message.content) ? message.content : [message.content];
    for (const raw of content) {
      if (typeof raw === "string") {
        running.conversation += raw.length;
        continue;
      }
      const block = asRecord(raw);
      if (block?.type === "text") {
        running.conversation += textOf(block.text).length;
      } else if (block?.type === "thinking") {
        running.conversation += textOf(block.thinking).length;
      } else if (block?.type === "tool_use") {
        running.conversation += jsonLength(block.input ?? {});
      }
    }
  };

  const onRecord = (record: Rec) => {
    if (record.isSidechain === true) {
      return; // a subagent's context, not this session's
    }
    if (record.type === "system") {
      if (record.subtype === "compact_boundary") {
        running = emptyRunning();
      }
      return;
    }
    if (record.type === "attachment") {
      const attachment = asRecord(record.attachment);
      if (attachment) {
        onAttachment(attachment);
      }
      return;
    }
    const message = asRecord(record.message);
    if (!message) {
      return;
    }
    if (record.type === "user") {
      onUser(record, message);
    } else if (record.type === "assistant") {
      onAssistant(message);
    }
  };

  const onLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    let record: Rec | undefined;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return; // malformed line: skipped
    }
    if (!record) {
      return;
    }
    parsedAny = true;
    try {
      onRecord(record);
    } catch {
      // a record of an unexpected shape adds nothing
    }
  };

  const ingest = (bytes: Buffer) => {
    const data = pending.length > 0 ? Buffer.concat([pending, bytes]) : bytes;
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      pending = Buffer.from(data);
      return;
    }
    pending = Buffer.from(data.subarray(lastNewline + 1));
    // A newline byte never sits inside a multi-byte UTF-8 sequence, so this cut decodes cleanly.
    for (const line of data.toString("utf8", 0, lastNewline).split("\n")) {
      onLine(line);
    }
  };

  const refresh = () => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(transcriptPath, "r");
      const stat = fs.fstatSync(fd);
      const id = `${stat.dev}:${stat.ino}`;
      if (stat.size < offset || (identity !== null && identity !== id)) {
        startOver();
      }
      identity = id;
      if (offset === 0 && stat.size > CLI_CONTEXT_MAX_FIRST_READ_BYTES) {
        return;
      }
      while (offset < stat.size) {
        const want = Math.min(READ_CHUNK_BYTES, stat.size - offset);
        const buffer = Buffer.allocUnsafe(want);
        const got = fs.readSync(fd, buffer, 0, want, offset);
        if (got <= 0) {
          break;
        }
        offset += got;
        ingest(buffer.subarray(0, got));
      }
    } catch {
      // missing or unreadable: nothing read this time
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  };

  const itemised = () => {
    if (!parsedAny) {
      return undefined;
    }
    const tokens = tokensNow();
    tokens.toolSchemas += r0 ?? 0;
    return { tokens, r0 };
  };

  const compose = (billed: number): CallComposition | undefined => {
    if (typeof billed !== "number" || !Number.isFinite(billed) || billed <= 0) {
      return undefined;
    }
    const target = Math.round(billed);
    if (target <= 0 || !parsedAny) {
      return undefined;
    }
    const tokens = tokensNow();
    // r0 not read yet: this is the session's first call, whose assistant record the CLI writes only
    // after message_start, so ITS billed prompt is the one r0 is measured on (header, r0).
    tokens.toolSchemas += r0 ?? Math.max(0, target - sum(Object.values(tokens)));
    return reconcileComposition(tokens, target);
  };

  return { refresh, compose, itemised };
}

/** Transcripts whose reader is kept, so reads stay incremental across turns; least recent dropped first. */
const READERS_TRACKED = 32;
const readers = new Map<string, CliContextReader>();

/** The cached reader of one transcript path (LRU, at most 32). */
export function cliContextFor(transcriptPath: string): CliContextReader {
  const existing = readers.get(transcriptPath);
  if (existing) {
    readers.delete(transcriptPath);
    readers.set(transcriptPath, existing);
    return existing;
  }
  const reader = createCliContextReader(transcriptPath);
  readers.set(transcriptPath, reader);
  if (readers.size > READERS_TRACKED) {
    const oldest = readers.keys().next().value;
    if (oldest !== undefined) {
      readers.delete(oldest);
    }
  }
  return reader;
}

/** Test-only: forget every cached reader. */
export function resetCliContextReadersForTest(): void {
  readers.clear();
}
