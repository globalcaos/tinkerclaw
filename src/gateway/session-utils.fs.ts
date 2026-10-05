import fs from "node:fs";
import os from "node:os";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "../agents/usage.js";
import {
  classifyErrorText,
  ERROR_ENVELOPE_MARKER,
  outcomeFromEnvelope,
  splitErrorEnvelope,
  type TurnOutcome,
} from "../fork/turn-outcome.js";
import {
  attributeToolUsage,
  getUsageRegistry,
  mergeUsageMarks,
  type UsageMark,
  type UsageRegistry,
} from "../fork/usage-attribution.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import {
  attachPromptKeysToUserRows,
  findStrandedPromptRows,
  PROMPT_KEY_CUSTOM_TYPE,
  type PromptKeyMarkerRef,
  readPromptKeyMarkerRef,
  spliceStrandedPromptRows,
} from "./prompt-key-marker.js";
import {
  buildRestartNoticeRow,
  isRestartNoticeData,
  RESTART_NOTICE_CUSTOM_TYPE,
} from "./restart-notice.js";
import {
  resolveSessionTranscriptCandidates,
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "./session-transcript-files.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";
import {
  __resetTranscriptIndexRegistryForTest,
  type BranchView,
  getTranscriptIndex,
  type IndexFidelity,
  noteLegacyLoaderFallback,
  noteTranscriptParentCycle,
  walkParentChain,
} from "./transcript-index.js";

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

/**
 * FORK 2026-09-07 — the ONLY trustworthy saving on an engram-mode compaction record.
 *
 * A pointer-manifest compaction writes `{ summary, tokensBefore, details:{ tokensEvicted } }` and
 * NO `tokensAfter`, so the chat banner's `tokensBefore → tokensAfter` pair never forms and it
 * falls back to printing `tokensBefore` alone. That number is not this session's size: measured
 * live, a session whose conversation was 175,850 tokens produced `tokensBefore: 7,855,029` (a
 * store-wide running total), so the banner read "7855k tok compacted" for a compaction that
 * actually freed 128,260. Surface the explicit counter and let the renderer prefer it.
 */
function readEvictedTokens(entry: { details?: unknown }): number | undefined {
  const details = entry.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const evicted = (details as { tokensEvicted?: unknown }).tokensEvicted;
  return typeof evicted === "number" && Number.isFinite(evicted) && evicted > 0
    ? evicted
    : undefined;
}

/**
 * FORK 2026-09-07 (the architect: "I can see a message like it was me prompting it but with some strange
 * html code") — hide the internal runtime-context envelope on the HISTORY path too.
 *
 * OpenClaw injects runtime events (a finished subagent, a cron result) into the conversation as a
 * role:"user" message wrapped in `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> … <<<END…>>>`. That is how
 * the runtime talks to the agent, which is why it wears the USER's role — and therefore the user's
 * own bubble. The live stream already hides it (live-chat-projector.ts calls
 * stripInternalRuntimeContext on every assistant event), but this reader — which serves
 * `chat.history` — never did. Net effect: invisible while it happened, and back on screen as
 * "something you apparently typed" the moment the tab was reloaded or switched to. 3,249 such
 * entries were sitting in 273 transcripts when this was found.
 *
 * Returns null when nothing survives, so a pure-envelope message disappears instead of leaving an
 * empty bubble. Non-text blocks (tool_use, images) are preserved and keep a message alive.
 */
function stripRuntimeContextFromMessage(message: unknown): unknown | null {
  if (!message || typeof message !== "object") {
    return message;
  }
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") {
    if (!hasInternalRuntimeContext(content)) {
      return message;
    }
    const stripped = stripInternalRuntimeContext(content);
    return stripped.trim() ? { ...(message as object), content: stripped } : null;
  }

  if (!Array.isArray(content)) {
    return message;
  }
  if (
    !content.some(
      (block) =>
        typeof (block as { text?: unknown })?.text === "string" &&
        hasInternalRuntimeContext((block as { text: string }).text),
    )
  ) {
    return message;
  }

  let sawOtherBlock = false;
  let sawText = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== "string") {
      sawOtherBlock = true;
      nextContent.push(block);
      continue;
    }
    const stripped = stripInternalRuntimeContext(text);
    if (!stripped.trim()) {
      continue;
    }
    sawText = true;
    nextContent.push({ ...(block as object), text: stripped });
  }
  if (!sawText && !sawOtherBlock) {
    return null;
  }
  return { ...(message as object), content: nextContent };
}

/**
 * FORK 2026-09-23 (M20, chat.history rehaul task 2) — the ONE resolution both
 * `readSessionMessages` (for its cache-key stat) and `readSessionMessagesUncached` (for the
 * actual read) go through. Resolving twice from the same inputs would normally agree, but a
 * `sessionFile` override plus a same-tick filesystem change is exactly the kind of divergence a
 * cache must never allow: the stat and the bytes it gates MUST name the same file.
 */
export function resolveSessionTranscriptReadPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * FORK 2026-09-23 (M20) — `chat.history` is polled ~22x/min per open tab, and until now every
 * call re-read and re-parsed the WHOLE transcript (10-24 MB on busy sessions) even when nothing
 * had changed since the previous call. Cache keyed on the resolved file's (ino, size, mtimeMs):
 * a rename/replace onto the same path changes ino, and a truncate-then-rewrite back to the same
 * byte count still moves mtimeMs, so both correctly count as a miss. This is PERMANENT — the
 * incremental transcript index (task 4) replaces only the tree LOADER underneath
 * (readTranscriptFileMessages); this wrapper stays on top of that too, skips re-projection on idle
 * polls, and also covers legacy flat transcripts the index never serves. Small cap (16), LRU by
 * re-insertion: this is a last-render cache for a handful of concurrently open tabs, not a
 * working set.
 */
type CachedTranscriptRead = {
  ino: number;
  size: number;
  mtimeMs: number;
  epoch: string | null;
  messages: readonly unknown[];
};

const transcriptReadCache = new Map<string, CachedTranscriptRead>();
const TRANSCRIPT_READ_CACHE_MAX_ENTRIES = 16;

/** Test-only reset: the result cache AND the TranscriptIndex registry beneath it. */
export function __resetTranscriptReadCacheForTest(): void {
  transcriptReadCache.clear();
  __resetTranscriptIndexRegistryForTest();
}

/**
 * A transcript's served rows plus the cursor epoch they are numbered under: the TranscriptIndex
 * epoch when the index served the read (unchanged across plain appends, new after a rewrite or a
 * branch switch), null for flat transcripts and legacy-loader reads, which carry no incremental
 * identity.
 */
export type SessionMessagesRead = { epoch: string | null; messages: unknown[] };

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  return readSessionMessagesWithCursor(sessionId, storePath, sessionFile).messages;
}

export function readSessionMessagesWithCursor(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): SessionMessagesRead {
  const filePath = resolveSessionTranscriptReadPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return { epoch: null, messages: [] };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // Vanished between resolution and stat (rare TOCTOU) — fall through to the uncached path,
    // which re-resolves and returns [] itself if nothing is there any more.
    return {
      epoch: null,
      messages: readSessionMessagesUncached(sessionId, storePath, sessionFile),
    };
  }

  const cached = transcriptReadCache.get(filePath);
  if (
    cached &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    // LRU touch: delete+re-insert so this key becomes the most-recently-used for eviction order.
    transcriptReadCache.delete(filePath);
    transcriptReadCache.set(filePath, cached);
    // The cached array is frozen (shared across hits); each caller gets its OWN fresh array so
    // it can never mutate what the next cache hit hands out. Message objects inside are shared —
    // callers must treat them as read-only (see Step 4 in the M20 plan: the chat.history
    // projection is copy-on-write end to end).
    return { epoch: cached.epoch, messages: cached.messages.slice() };
  }

  const read = readTranscriptFileMessages(filePath);
  transcriptReadCache.delete(filePath);
  transcriptReadCache.set(filePath, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    epoch: read.epoch,
    messages: Object.freeze(read.messages.slice()),
  });
  if (transcriptReadCache.size > TRANSCRIPT_READ_CACHE_MAX_ENTRIES) {
    const oldestKey = transcriptReadCache.keys().next().value;
    if (typeof oldestKey === "string") {
      transcriptReadCache.delete(oldestKey);
    }
  }
  return read;
}

/**
 * `readSessionMessages` without the result cache above (the TranscriptIndex beneath still
 * applies). `resolvedFilePath`, when passed, is used verbatim instead of re-resolving — see
 * resolveSessionTranscriptReadPath's fork note. Callers outside this file always omit it and get
 * the historical self-resolving behaviour.
 */
export function readSessionMessagesUncached(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  resolvedFilePath?: string | null,
): unknown[] {
  const filePath =
    resolvedFilePath !== undefined
      ? resolvedFilePath
      : resolveSessionTranscriptReadPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return [];
  }
  return readTranscriptFileMessages(filePath).messages;
}

/**
 * One transcript file → served rows, with no result cache. Production always uses the default
 * "auto" (the index where it can represent the file exactly, or where a duplicated id makes its
 * leaf chain loop; else the legacy loader); "legacy" skips the index and exists for the parity
 * test's reference read. Neither path ever runs pi's getBranch() (fix-cycle-hang).
 */
export function readTranscriptFileMessages(
  filePath: string,
  treeLoader: "auto" | "legacy" = "auto",
): SessionMessagesRead {
  if (treeLoader === "auto") {
    const indexed = loadTreeTranscriptFromIndex(filePath);
    if (indexed === "missing") {
      return { epoch: null, messages: [] };
    }
    if (indexed) {
      return { epoch: indexed.epoch, messages: projectTreeTranscript(indexed) };
    }
  }
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const tree = loadTreeTranscriptLegacy(filePath, lines);
  return {
    epoch: null,
    messages: tree ? projectTreeTranscript(tree) : projectFlatTranscript(lines),
  };
}

/**
 * FORK 2026-09-23 (chat.history rehaul task 4, ruling R8) — a tree transcript is served in two
 * steps: a LOADER yields raw pi entries, and ONE projection (projectTreeTranscript) turns them into
 * the rows chat.history serves. Keeping the projection single-sourced is what lets a second,
 * incremental loader be proven row-for-row identical to this one instead of re-implementing it.
 */
type TreeTranscriptEntries = {
  /** The served branch, root → leaf (what pi's `getBranch()` returns, walked cycle-safely). */
  branchEntries: readonly SessionEntry[];
  /** Every entry in file order (pi `getEntries()`), for stranded-row detection. */
  allEntries: readonly SessionEntry[];
};

/**
 * The original loader: probe the whole file for tree entries, then `SessionManager.open`, which
 * reads the file again and may migrate (and rewrite) an older-version transcript. null = not a
 * tree transcript, or pi could not open it: the caller serves the flat fallback. The branch is
 * readSessionBranchCycleSafe's, never pi's getBranch() (fix-cycle-hang): every file the index
 * declines lands here, and some of those loop in pi's graph without the index having seen it (the
 * line that closes the loop has no newline yet; a "legacy" reference read never asks the index).
 */
function loadTreeTranscriptLegacy(
  filePath: string,
  lines: readonly string[],
): TreeTranscriptEntries | null {
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
  if (!hasTreeEntries) {
    return null;
  }
  try {
    const sm = SessionManager.open(filePath);
    const walked = readSessionBranchCycleSafe(sm);
    if (walked.cycleAt !== null) {
      noteTranscriptParentCycle(filePath, walked.cycleAt, "legacy");
    }
    return { branchEntries: walked.branch, allEntries: sm.getEntries() };
  } catch {
    return null;
  }
}

/**
 * FORK 2026-09-24 (fix-cycle-hang) — pi's `getBranch()` with the visited set it lacks: the same
 * walk (transcript-index.ts walkParentChain) over pi's OWN index (`getLeafId` / `getEntry`, so
 * pi's migration and last-copy-wins are pi's, not re-derived). Identical to `sm.getBranch()`
 * wherever the chain ends; on a loop, where getBranch() never returns, it returns the leaf's chain
 * up to the first repeated id and reports that id as `cycleAt`. Any caller about to call
 * getBranch() on a transcript it did not just write belongs here.
 */
export function readSessionBranchCycleSafe(sm: Pick<SessionManager, "getLeafId" | "getEntry">): {
  branch: SessionEntry[];
  cycleAt: string | null;
} {
  return walkParentChain(sm.getLeafId(), (id) => sm.getEntry(id));
}

/**
 * The incremental loader (task 4): TranscriptIndex parses only the bytes appended since its last
 * refresh, where the legacy loader parses the whole file twice on every call. It serves a file only
 * when it provably reads what pi would read — a current-version header at byte 0 (anything older is
 * pi's to migrate on open, ruling R5) and no line pi represents differently (IndexFidelity) — and
 * when the legacy probe would call it a tree transcript (some entry has a `parentId` key, R4).
 * null = hand the file to the legacy loader. "missing" = it vanished between stat and open, which
 * is served like any missing transcript: no rows, not an exception.
 *
 * FORK 2026-09-24 (fix-cycle-hang) — a leaf chain that loops (IndexFidelity.parentCycleAt) is
 * served from here even though the duplicated id that usually makes the loop is a fidelity gap.
 * With every other gap absent, the index and pi read the same graph: last copy wins the id, the
 * leaf is the last entry line, and allEntries() keeps every copy as pi's getEntries() does. pi's
 * own walk of that graph never returns, and this index already holds the walk that does
 * (walkParentChain: the leaf's chain up to the first repeated id), so the file is not re-read and
 * re-parsed whole on every change just to walk the same graph again. A loop combined with any
 * OTHER gap (an older header pi must migrate, R5; a line only pi indexes; an unterminated tail)
 * still goes to the legacy loader: there the two graphs differ, and that loader walks pi's graph
 * cycle-safely too (readSessionBranchCycleSafe).
 */
function loadTreeTranscriptFromIndex(
  filePath: string,
): (TreeTranscriptEntries & { epoch: string }) | "missing" | null {
  const index = getTranscriptIndex(filePath);
  let view: BranchView;
  try {
    view = index.refresh();
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "missing" : null;
  }
  const indexed = index.allEntries();
  if (!indexed.some((entry) => entry.hasParentKey)) {
    return null; // not a tree transcript: the flat path is the legacy loader's by design
  }
  const fidelity = index.fidelity();
  const cycleAt = fidelity.parentCycleAt;
  // A loop's duplicated id is not a reason to leave the index (fork note above); every OTHER gap
  // still goes to the legacy loader, which walks cycle-safely.
  const reason = indexFidelityGap(cycleAt === null ? fidelity : { ...fidelity, duplicateIds: 0 });
  if (reason !== null) {
    noteLegacyLoaderFallback(filePath, reason);
    return null;
  }
  if (cycleAt !== null) {
    noteTranscriptParentCycle(filePath, cycleAt, "index");
  }
  return {
    epoch: view.epoch,
    branchEntries: view.entries.map((entry) => entry.raw as SessionEntry),
    allEntries: indexed.map((entry) => entry.raw as SessionEntry),
  };
}

/**
 * Why the index cannot serve a tree transcript row-for-row as pi reads it, or null if it can. A
 * parent-chain loop is deliberately not a reason here: loadTreeTranscriptFromIndex waives only the
 * duplicate-ids gap for it. Exported for the loop-routing CONTROL test.
 */
export function indexFidelityGap(fidelity: IndexFidelity): string | null {
  if (!isCurrentSessionHeader(fidelity.header)) {
    const version = (fidelity.header as { type?: unknown; version?: unknown } | undefined)?.version;
    return (fidelity.header as { type?: unknown } | undefined)?.type === "session"
      ? `header version ${String(version)}`
      : "no session header";
  }
  if (fidelity.unindexedLines > 0) {
    return "unindexed-lines";
  }
  if (fidelity.duplicateIds > 0) {
    return "duplicate-ids";
  }
  return fidelity.unterminatedTail ? "unterminated-tail" : null;
}

/** pi's own header test (loadEntriesFromFile) plus "needs no migration on open". */
function isCurrentSessionHeader(header: unknown): boolean {
  if (!header || typeof header !== "object") {
    return false;
  }
  const { type, id, version } = header as { type?: unknown; id?: unknown; version?: unknown };
  return type === "session" && typeof id === "string" && version === CURRENT_SESSION_VERSION;
}

// ── FORK 2026-09-29 (U7): per-turn usage marks and served prompt errors ────────────────────────

/**
 * FORK 2026-09-29 (plan: jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-
 * outcomes.md, unit U7). The history half of the chat's usage chips and typed outcomes. Both jobs run
 * in the ONE projection the tree and flat loaders share, so an index read and a legacy read of the
 * same file stay row-for-row equal (session-utils.fs.index-parity.test.ts).
 *
 * USAGE. Every tool call of a turn goes through attributeToolUsage (src/fork/usage-attribution.ts):
 * assistant tool-call blocks, and the tinker-bridge's `tinker-bridge-tool` start records, which the
 * tree projection reads here but still never serves (~40k of them in 120 transcripts). The turn's
 * merged marks ride on its served user row as `__openclaw.usage`. A turn is what the chat SHOWS as
 * one: from a served prompt row to the next. A prompt the runtime-context envelope hid entirely (a
 * finished subagent, a cron result) opens no turn, so the marks of the run it started sit on the
 * prompt the reader sees above those rows, which is also the row the live path stamps (plan D4).
 * Nothing is read from the model's prose.
 *
 * COST (plan review focus 5). Measured 2026-09-29 on the biggest recent transcript (24.7 MB, 5,165
 * tool calls): attributing every fast-path call took 548 ms with warm registry caches, nearly all of
 * it in long Bash commands. Three layers keep chat.history where it was:
 *   1. the plan's fast path: read / exec / Bash / shell / Skill, `mcp__*`, and plugin-owned names;
 *   2. an argument gate on read and exec (USAGE_ARGUMENT_HINT). Same transcript: 1,452 of 5,165
 *      calls still reached attributeToolUsage (151 ms), and 0 of its 153 marks were lost;
 *   3. a memo keyed by the call's own object, holding gated-out calls too. The TranscriptIndex hands
 *      back the SAME parsed entries on every refresh, so re-projecting after an append costs one
 *      WeakMap lookup per old call. A read/exec attribution depends only on the file system (a
 *      SKILL.md next to the path, the recipe roots from OPENCLAW_HOME and the package root), none
 *      of which the 60 s registry rebuild re-reads from config, so a memoised result is that call's
 *      history rather than a cache a config change can stale. It lives as long as the index keeps
 *      the entry (a rewrite, a branch switch or a restart rebuilds it). The legacy loader parses
 *      fresh objects every time, so a file it serves pays the gated pass on every change, on top of
 *      the whole-file re-read it already pays.
 *
 * PROMPT ERRORS. The embedded runner records a failed prompt as a pi `custom` entry
 * (`openclaw:prompt-error`, embedded-agent-runner/run/attempt.ts) that nothing served, so a turn that
 * died of an LLM idle timeout showed the prompt and then nothing, for good. It is now served as an
 * assistant row with `stopReason:"error"`, `errorMessage` and a typed `outcome` (turn-outcome.ts,
 * source "prompt-error"), but only when it is what ENDED its run. Census 2026-09-29, 396 entries in
 * the 300 newest transcripts:
 *   - 320 sit in a run that went on to answer: a retry, a fallback model, or the tinker-bridge
 *     appending its answer 1-5 s after the embedded prompt aborted. Serving those would paint a
 *     failure bubble inside an answered turn, so any later assistant row (or later prompt error) of
 *     the same run hides it;
 *   - when the run's latest assistant row already says error or aborted, that row is the bubble and
 *     the prompt error would be a second one;
 *   - 253 are aborts ("This operation was aborted"). Every one either answered or carries pi's own
 *     `aborted` row, so an outcome classified `aborted` is never served from here;
 *   - what remains is the 53 idle timeouts that ended their run with nothing on screen.
 * A run is bounded by user-role messages, and a hidden runtime-context prompt starts one too (it is
 * a new run even though it opens no chat turn). The served row is display-only: a tail heuristic over
 * readSessionMessages must skip `__openclaw.kind` "prompt-error" the way it skips compaction rows.
 *
 * SEQ. A servable prompt error SPENDS a seq whether or not it is served. Being served depends on rows
 * that may not exist yet, and a plain append keeps the cursor epoch (chat-history-cursor.ts), so a row
 * served now and hidden after the next append must not renumber the rows after it. The hidden one
 * leaves a gap. A client whose cursor names it gets an `anchor_missing` reset, which is also how that
 * client drops the bubble: a delta can add rows but never retract one.
 */
const PROMPT_ERROR_CUSTOM_TYPE = "openclaw:prompt-error";
/** A transcript entry's ISO timestamp in ms, or undefined when it has none. */
function entryTimestampMs(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}
/** The tinker-bridge's per-call records; `cc-bridge-tool` is the pre-rename name (16 transcripts). */
const BRIDGE_TOOL_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "tinker-bridge-tool",
  "cc-bridge-tool",
]);
/**
 * Every block spelling this repo persists a tool call under, lower-cased (utils/transcript-tools.ts,
 * agents/tool-call-id.ts, agents/session-transcript-repair.ts).
 */
const TOOL_CALL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "toolcall",
  "tooluse",
  "functioncall",
  "tool_use",
  "tool_call",
]);
/** Tools whose marks come from a path or command argument (normalizeToolName maps bash → exec). */
const USAGE_ARGUMENT_TOOLS: ReadonlySet<string> = new Set(["read", "exec", "bash", "shell"]);
/** usage-attribution.ts READ_PATH_KEYS ∪ EXEC_COMMAND_KEYS ∪ its workdir keys. */
const USAGE_ARGUMENT_KEYS = [
  "command",
  "cmd",
  "workdir",
  "cwd",
  "path",
  "file_path",
  "filePath",
  "target",
] as const;
/**
 * A necessary condition of usage-attribution.ts's read and exec rules, checked before its shell
 * reader runs: a skill mark needs `/skills/` in the resolved path, a recipe mark a `.md` path or a
 * `recipe-state` call. A relative path resolves against the gateway's own cwd and home, because this
 * file calls attributeToolUsage WITHOUT its `homeDir`/`cwd` override, so the gate is off whenever
 * either of those matches (ambientPathMayCarryUsage). Passing that override, or widening those rules,
 * means widening this gate in the same change.
 */
const USAGE_ARGUMENT_HINT = /skills|\.md|recipe-state/;
const NO_USAGE_MARKS: readonly UsageMark[] = Object.freeze([]);

let historyUsageRegistryForTest: UsageRegistry | undefined;
/** read/exec attributions, keyed by the object the call was read from (fork note: COST). */
let historyUsageMemo = new WeakMap<object, readonly UsageMark[]>();

/** Test seam: attribute history against `registry` instead of the real roots; undefined restores. */
export function __setHistoryUsageRegistryForTest(registry: UsageRegistry | undefined): void {
  historyUsageRegistryForTest = registry;
  historyUsageMemo = new WeakMap();
  transcriptReadCache.clear();
}

function ambientPathMayCarryUsage(): boolean {
  try {
    return USAGE_ARGUMENT_HINT.test(process.cwd()) || USAGE_ARGUMENT_HINT.test(os.homedir());
  } catch {
    return true; // cannot tell: attribute every call rather than miss a mark
  }
}

function argumentsMayCarryUsage(args: unknown): boolean {
  if (typeof args === "string") {
    return USAGE_ARGUMENT_HINT.test(args); // usage-attribution parses a JSON-string argument
  }
  if (!args || typeof args !== "object") {
    return false;
  }
  const record = args as Record<string, unknown>;
  return USAGE_ARGUMENT_KEYS.some((key) => {
    const value = record[key];
    return typeof value === "string" && USAGE_ARGUMENT_HINT.test(value);
  });
}

type HistoryUsageCollector = {
  /** A served prompt row, at `index` of the served list, opens the next turn. */
  openTurn(index: number): void;
  /** One tool call of the open turn, served or not; `source` is the object it was read from. */
  addCall(name: string, args: unknown, toolCallId: string | undefined, source: object): void;
  /** Stamp the open turn's marks onto its user row. */
  finish(): void;
};

function createHistoryUsageCollector(messages: unknown[]): HistoryUsageCollector {
  let registry: UsageRegistry | undefined;
  let gateArguments: boolean | undefined;
  let userIndex = -1;
  let found: UsageMark[] = [];
  const resolveRegistry = (): UsageRegistry =>
    (registry ??= historyUsageRegistryForTest ?? getUsageRegistry());
  const attribute = (name: string, args: unknown, toolCallId: string | undefined) =>
    attributeToolUsage({ name, args, ...(toolCallId ? { toolCallId } : {}) }, resolveRegistry());
  const flush = () => {
    if (userIndex >= 0 && found.length > 0) {
      messages[userIndex] = attachTurnUsage(messages[userIndex], found);
    }
    found = [];
  };
  return {
    openTurn(index) {
      flush();
      userIndex = index;
    },
    addCall(rawName, args, toolCallId, source) {
      const name = rawName.trim();
      if (userIndex < 0 || !name) {
        return; // no served prompt above it to carry the marks
      }
      try {
        const lower = name.toLowerCase();
        let marks: readonly UsageMark[];
        if (USAGE_ARGUMENT_TOOLS.has(lower)) {
          let memo = historyUsageMemo.get(source);
          if (!memo) {
            gateArguments ??= !ambientPathMayCarryUsage();
            const fresh =
              gateArguments && !argumentsMayCarryUsage(args)
                ? NO_USAGE_MARKS
                : attribute(name, args, toolCallId);
            memo = fresh.length > 0 ? fresh : NO_USAGE_MARKS;
            historyUsageMemo.set(source, memo);
          }
          marks = memo;
        } else if (lower === "skill" || name.startsWith("mcp__")) {
          marks = attribute(name, args, toolCallId);
        } else if (resolveRegistry().pluginForTool(name)) {
          marks = attribute(name, args, toolCallId);
        } else {
          return;
        }
        found.push(...marks);
      } catch {
        // attribution must never cost the history its rows
      }
    },
    finish() {
      flush();
      userIndex = -1;
    },
  };
}

function attachTurnUsage(row: unknown, marks: readonly UsageMark[]): unknown {
  const prior = (row as { __openclaw?: { usage?: unknown } } | null)?.__openclaw?.usage;
  const usage = mergeUsageMarks(Array.isArray(prior) ? (prior as UsageMark[]) : [], marks);
  return usage.length > 0 ? attachOpenClawTranscriptMeta(row, { usage }) : row;
}

/** Every tool call an assistant message carries, whichever block spelling persisted it. */
function collectAssistantToolCalls(message: unknown, usage: HistoryUsageCollector): void {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const call = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
    };
    if (
      typeof call.type === "string" &&
      TOOL_CALL_BLOCK_TYPES.has(call.type.toLowerCase()) &&
      typeof call.name === "string"
    ) {
      // By presence, not by spelling: both fields turn up on both spellings on disk.
      usage.addCall(
        call.name,
        call.arguments !== undefined ? call.arguments : call.input,
        typeof call.id === "string" ? call.id : undefined,
        block,
      );
    }
  }
}

function collectBridgeToolCall(
  entry: { customType?: unknown; data?: unknown },
  usage: HistoryUsageCollector,
): void {
  if (typeof entry.customType !== "string" || !BRIDGE_TOOL_CUSTOM_TYPES.has(entry.customType)) {
    return;
  }
  const data = entry.data;
  if (!data || typeof data !== "object") {
    return;
  }
  const record = data as { phase?: unknown; name?: unknown; args?: unknown; toolCallId?: unknown };
  if (record.phase === "start" && typeof record.name === "string") {
    usage.addCall(
      record.name,
      record.args,
      typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      data,
    );
  }
}

/** A row that opens a run: role user, and not a bare tool_result carrier (Anthropic-shaped rows). */
function isPromptMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") {
    return false;
  }
  return !(
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => (block as { type?: unknown } | null)?.type === "tool_result")
  );
}

type PromptErrorEntryLike = { id?: unknown; timestamp?: unknown; data?: unknown };

function isPromptErrorEntry(entry: unknown): boolean {
  const record = entry as { type?: unknown; customType?: unknown } | null | undefined;
  return record?.type === "custom" && record.customType === PROMPT_ERROR_CUSTOM_TYPE;
}

function readPromptErrorData(entry: PromptErrorEntryLike): Record<string, unknown> {
  const data = entry.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * The outcome a prompt error would be served with, or undefined when it is never served whatever
 * follows it: the run's latest assistant row already typed the failure, or it classifies as an
 * abort. Decided from rows already written, so a later append cannot change it (fork note: SEQ).
 */
function servablePromptErrorOutcome(
  entry: PromptErrorEntryLike,
  lastAssistantStop: unknown,
): TurnOutcome | undefined {
  if (lastAssistantStop === "error" || lastAssistantStop === "aborted") {
    return undefined;
  }
  const raw = readPromptErrorData(entry).error;
  const text = typeof raw === "string" ? raw : "";
  const envelope = text.includes(ERROR_ENVELOPE_MARKER) ? splitErrorEnvelope(text).envelope : null;
  const outcome = envelope
    ? outcomeFromEnvelope(envelope)
    : classifyErrorText(text, { source: "prompt-error" });
  return outcome.kind === "aborted" ? undefined : outcome;
}

/**
 * Walk positions of the prompt errors that END their run: no assistant row and no later prompt error
 * follows them before the next prompt. Only computed once a walk meets a prompt error.
 */
function findRunEndingPromptErrors(
  count: number,
  entryAt: (index: number) => unknown,
): ReadonlySet<number> {
  const ending = new Set<number>();
  let runGoesOn = false;
  for (let index = count - 1; index >= 0; index -= 1) {
    const entry = entryAt(index);
    if (isPromptErrorEntry(entry)) {
      if (!runGoesOn) {
        ending.add(index);
      }
      runGoesOn = true;
      continue;
    }
    const message = (entry as { message?: unknown } | null | undefined)?.message;
    if (isPromptMessage(message)) {
      runGoesOn = false;
    } else if ((message as { role?: unknown } | null | undefined)?.role === "assistant") {
      runGoesOn = true;
    }
  }
  return ending;
}

function buildPromptErrorRow(
  entry: PromptErrorEntryLike,
  outcome: TurnOutcome,
  seq: number,
): Record<string, unknown> {
  const data = readPromptErrorData(entry);
  const runId = typeof data.runId === "string" && data.runId ? data.runId : undefined;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  const timestamp =
    typeof data.timestamp === "number" && Number.isFinite(data.timestamp)
      ? data.timestamp
      : Number.isFinite(at)
        ? at
        : Date.now();
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: typeof data.error === "string" ? data.error : "",
    timestamp,
    outcome,
    __openclaw: {
      kind: "prompt-error",
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      seq,
      ...(runId ? { runId } : {}),
    },
  };
}

function parseTranscriptLine(line: string | undefined): unknown {
  if (!line || !line.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function projectTreeTranscript({ branchEntries, allEntries }: TreeTranscriptEntries): unknown[] {
  const messages: unknown[] = [];
  // FORK 2026-09-08 (durable prompt key): chat.send's acceptance markers, collected at their
  // position in the walk and never rendered — no seq, nothing pushed. The marker PRECEDES the
  // user row pi persists (chat.send writes it before dispatch), so attachPromptKeysToUserRows
  // stamps the key forward onto that row; that key is what lets the client's outbox PROVE a
  // prompt was delivered (tinker-ui reconcileWithHistory) instead of replaying it into a second
  // run. See src/gateway/prompt-key-marker.ts.
  const promptKeyMarkers: PromptKeyMarkerRef[] = [];
  let messageSeq = 0;
  // FORK 2026-09-29 (U7): usage marks per turn, and the prompt errors that ended their run (fork
  // note above PROMPT_ERROR_CUSTOM_TYPE).
  const usage = createHistoryUsageCollector(messages);
  let lastAssistantStop: unknown;
  let runEnding: ReadonlySet<number> | undefined;
  for (const [index, entry] of branchEntries.entries()) {
    if (entry.type === "custom" && entry.customType === PROMPT_KEY_CUSTOM_TYPE) {
      const marker = readPromptKeyMarkerRef(entry.data, messages.length);
      if (marker) {
        promptKeyMarkers.push(marker);
      }
      continue;
    }
    if (entry.type === "custom") {
      if (entry.customType === PROMPT_ERROR_CUSTOM_TYPE) {
        const outcome = servablePromptErrorOutcome(entry, lastAssistantStop);
        if (outcome) {
          messageSeq += 1; // spent even when not served (fork note: SEQ)
          const ending = (runEnding ??= findRunEndingPromptErrors(
            branchEntries.length,
            (i) => branchEntries[i],
          ));
          if (ending.has(index)) {
            messages.push(buildPromptErrorRow(entry, outcome, messageSeq));
          }
        }
      } else if (entry.customType === RESTART_NOTICE_CUSTOM_TYPE) {
        // FORK 2026-09-29 (L4b): the restart notice is display-only — served here, never a message.
        if (isRestartNoticeData(entry.data)) {
          messageSeq += 1;
          messages.push(
            buildRestartNoticeRow(entry.data, {
              ...(typeof entry.id === "string" ? { id: entry.id } : {}),
              seq: messageSeq,
              timestamp: entryTimestampMs(entry.timestamp),
            }),
          );
        }
      } else {
        collectBridgeToolCall(entry, usage); // read for attribution, never served here
      }
      continue;
    }
    if (entry.type === "message" && entry.message) {
      const opensRun = isPromptMessage(entry.message);
      if (opensRun) {
        lastAssistantStop = undefined;
      } else if ((entry.message as { role?: unknown }).role === "assistant") {
        lastAssistantStop = (entry.message as { stopReason?: unknown }).stopReason;
        collectAssistantToolCalls(entry.message, usage);
      }
      // Strip BEFORE the seq bump: a message that is nothing but runtime context was never on
      // screen live, so it must not consume a sequence number here either.
      const visible = stripRuntimeContextFromMessage(entry.message);
      if (!visible) {
        continue;
      }
      messageSeq += 1;
      messages.push(
        attachOpenClawTranscriptMeta(visible, {
          ...(typeof entry.id === "string" ? { id: entry.id } : {}),
          seq: messageSeq,
        }),
      );
      if (opensRun) {
        usage.openTurn(messages.length - 1);
      }
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
      const evictedTokens = readEvictedTokens(entry);
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
          ...(typeof evictedTokens === "number" ? { evictedTokens } : {}),
        },
      });
    }
  }
  usage.finish();
  // FORK 2026-09-23 — prompts a concurrent append forked off this branch (sent while a turn was
  // running). Served keyed, at their place in time, so the outbox can retire them and the prompt
  // is on screen. See findStrandedPromptRows in prompt-key-marker.ts.
  const stranded: Array<{ row: Record<string, unknown>; ts: number }> = [];
  for (const s of findStrandedPromptRows(allEntries, branchEntries)) {
    const visible = stripRuntimeContextFromMessage(s.message);
    if (!visible) {
      continue;
    }
    const row = attachOpenClawTranscriptMeta(visible, {
      id: s.entryId,
      stranded: true,
    }) as Record<string, unknown>;
    stranded.push({ row: { ...row, idempotencyKey: s.idempotencyKey }, ts: s.ts });
  }
  return spliceStrandedPromptRows(attachPromptKeysToUserRows(messages, promptKeyMarkers), stranded);
}

function projectFlatTranscript(lines: readonly string[]): unknown[] {
  const messages: unknown[] = [];
  // FORK 2026-09-08 (durable prompt key): same collection on the flat (pre-tree) fallback.
  const promptKeyMarkers: PromptKeyMarkerRef[] = [];
  let messageSeq = 0;
  // FORK 2026-09-29 (U7): the tree walk's usage and prompt-error bookkeeping, same rules.
  const usage = createHistoryUsageCollector(messages);
  let lastAssistantStop: unknown;
  let runEnding: ReadonlySet<number> | undefined;
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        const opensRun = isPromptMessage(parsed.message);
        if (opensRun) {
          lastAssistantStop = undefined;
        } else if (parsed.message.role === "assistant") {
          lastAssistantStop = parsed.message.stopReason;
          collectAssistantToolCalls(parsed.message, usage);
        }
        // Same rule as the tree branch above — strip before the seq bump.
        const visible = stripRuntimeContextFromMessage(parsed.message);
        if (!visible) {
          continue;
        }
        messageSeq += 1;
        messages.push(
          attachOpenClawTranscriptMeta(visible, {
            ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
            seq: messageSeq,
          }),
        );
        if (opensRun) {
          usage.openTurn(messages.length - 1);
        }
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
        const evictedTokens = readEvictedTokens(parsed);
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
            ...(typeof evictedTokens === "number" ? { evictedTokens } : {}),
          },
        });
      }

      // FORK 2026-09-08 (durable prompt key): a marker is state, never a message — capture its
      // position and move on.
      if (parsed?.type === "custom" && parsed?.customType === PROMPT_KEY_CUSTOM_TYPE) {
        const marker = readPromptKeyMarkerRef(parsed.data, messages.length);
        if (marker) {
          promptKeyMarkers.push(marker);
        }
        continue;
      }

      // FORK 2026-09-29 (U7): a prompt error that ended its run is served (fork note above
      // PROMPT_ERROR_CUSTOM_TYPE), and every bridge tool record feeds its turn's usage marks.
      if (parsed?.type === "custom" && parsed?.customType === PROMPT_ERROR_CUSTOM_TYPE) {
        const outcome = servablePromptErrorOutcome(parsed, lastAssistantStop);
        if (outcome) {
          messageSeq += 1; // spent even when not served (fork note: SEQ)
          const ending = (runEnding ??= findRunEndingPromptErrors(lines.length, (i) =>
            parseTranscriptLine(lines[i]),
          ));
          if (ending.has(lineIndex)) {
            messages.push(buildPromptErrorRow(parsed, outcome, messageSeq));
          }
        }
        continue;
      }
      // FORK 2026-09-29 (L4b): the restart notice, same rule as the tree walk.
      if (parsed?.type === "custom" && parsed?.customType === RESTART_NOTICE_CUSTOM_TYPE) {
        if (isRestartNoticeData(parsed.data)) {
          messageSeq += 1;
          messages.push(
            buildRestartNoticeRow(parsed.data, {
              ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
              seq: messageSeq,
              timestamp: entryTimestampMs(parsed.timestamp),
            }),
          );
        }
        continue;
      }
      if (parsed?.type === "custom") {
        collectBridgeToolCall(parsed, usage);
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
  usage.finish();
  // FORK 2026-09-08 (durable prompt key): attach BEFORE the reorder — marker positions were
  // recorded against walk order, and reorderTinkerBridgeToolBlocks splices tool blocks backwards.
  // Attaching first is also sufficient: the reorder never moves user rows relative to each other.
  return reorderTinkerBridgeToolBlocks(attachPromptKeysToUserRows(messages, promptKeyMarkers));
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

/**
 * FORK 2026-09-23 (chat.history rehaul, plan task 6, ruling R6) — the sessions.list usage fallback
 * used to read the WHOLE transcript on every call (`fs.readFileSync`), the same cost this rehaul
 * removed from the chat.history path itself. Most sessions carry their latest usage snapshot near
 * the tail, so read that first; only a transcript whose relevant usage record(s) fall entirely
 * outside this window pays for a full scan.
 */
export const USAGE_TAIL_MAX_BYTES = 256 * 1024;

/**
 * Last `maxBytes` of the file via `fs.readSync` (never `fs.readFileSync` — the whole point is to
 * bound the read). `readStart` and `readLen` are computed from a `fstatSync` snapshot taken by the
 * caller BEFORE this runs; if the file shrinks in place between that stat and this read (a
 * concurrent truncate/rewrite), `fs.readSync` legitimately returns fewer bytes than requested —
 * that is not an error, it is exactly how a short read near EOF behaves. `Buffer.alloc` zero-fills,
 * so trusting the buffer's full declared length instead of the ACTUAL bytes read would glue a run
 * of NUL bytes directly onto the end of whatever real content was read — with no line break in
 * between, corrupting exactly the last (often newest) real line into invalid JSON, while any
 * earlier, still-intact line would keep parsing fine and mask the corruption. Slicing to `bytesRead`
 * is what makes the caller see only real bytes, ever.
 *
 * `readStart > 0` means the read landed mid-file: the leading partial line (which may also be a
 * torn multi-byte UTF-8 sequence — both look the same to the caller, garbage before the first
 * `\n`) is dropped rather than handed to a JSON parser that would silently choke on it.
 */
function readTranscriptTailChunk(fd: number, size: number, maxBytes: number): string {
  const readStart = Math.max(0, size - maxBytes);
  const readLen = Math.min(size, maxBytes);
  const buf = Buffer.alloc(readLen);
  let bytesRead = 0;
  if (readLen > 0) {
    bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
  }
  const raw = buf.subarray(0, bytesRead).toString("utf-8");
  if (readStart === 0) {
    return raw;
  }
  const firstNewline = raw.indexOf("\n");
  return firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
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
    const tailChunk = readTranscriptTailChunk(fd, stat.size, USAGE_TAIL_MAX_BYTES);
    const tailSnapshot = extractLatestUsageFromTranscriptChunk(tailChunk, contextWindow);
    if (tailSnapshot) {
      return tailSnapshot;
    }
    // Nothing usage-bearing in the tail — either the transcript has none at all, or the tail cut
    // it off entirely (the usage-bearing lines are earlier than this window). Either way only a
    // full scan can tell the difference, so fall back to it for correctness.
    const fullChunk = fs.readFileSync(fd, "utf-8");
    return extractLatestUsageFromTranscriptChunk(fullChunk, contextWindow);
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
