/**
 * FORK: tinkerclaw-tinker-bridge — OpenClaw StreamFn.
 *
 * Translates claude's stream-json NDJSON into pi-ai's AssistantMessageEvent
 * stream (the format OpenClaw's embedded runner consumes). Modeled on
 * extensions/ollama/src/stream.ts.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Usage,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildErrorEnvelope } from "openclaw/plugin-sdk/fork-error-envelope";
import {
  type CallPromptParts,
  type CallTelemetryEvent,
  type CompactionTelemetryEvent,
  allocateCallIndex,
  compactionTokenCount,
  emitCallTelemetry,
  emitCompactionTelemetry,
} from "openclaw/plugin-sdk/fork-telemetry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { decideChannelReply, isChatChannelRun } from "./channel-reply.js";
import {
  type CliCompactionEnd,
  CHAT_ROW_CONTRACT_MARKER,
  describeCliCommandOutcome,
  extractCliCommand,
} from "./cli-command.js";
import { type CliContextSource, cliContextFor } from "./cli-context.js";
import {
  DEFAULT_CWD,
  DEFAULT_DISALLOWED_TOOLS,
  FAST_FAIL_INIT_SILENT_MS,
  FAST_FAIL_MAX_INIT_LINES,
  maxOutputTokensFor,
  PROVIDER_ID,
} from "./defaults.js";
import { registerInflightWorker, unregisterInflightWorker } from "./inflight-worker-registry.js";
import type {
  CcContentBlock,
  CcStreamStdoutAssistantMessage,
  CcStreamStdoutLine,
  CcStreamStdoutResult,
  CcStreamStdoutStreamEvent,
  CcStreamStdoutUserMessage,
  CcUsage,
} from "./protocol.js";
import { ensureAdoptionScan, markReattachClaimed, resumedTurnFields } from "./restart-reattach.js";
import { noteThalamusSubagentCall } from "./thalamus-worker-seam.js";
import { thinkLevelToMaxThinkingTokens } from "./thinking-budget.js";
import { recordToolEvent } from "./tool-buffer.js";
import { resolveTranscriptPath } from "./transcript-path.js";
import { parseUnpromptedWakeMarker, UNPROMPTED_TURN_GONE_TEXT } from "./unprompted-turn.js";
import { getPool } from "./worker-pool.js";
import type { WorkerEvent } from "./worker.js";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

export type CreateStreamFnInput = {
  sessionKey?: string;
  cwd?: string;
  binary?: string;
  disallowedTools?: string[];
};

function buildUsage(cu: CcUsage | undefined): Usage {
  const input = cu?.input_tokens ?? 0;
  const output = cu?.output_tokens ?? 0;
  const cacheRead = cu?.cache_read_input_tokens ?? 0;
  const cacheWrite = cu?.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function extractUserText(messages: Array<{ role: string; content: unknown }>): string {
  // Use the LAST user turn as the new prompt. OpenClaw sends the full history
  // but claude's persistent session already owns prior context internally.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") {
      continue;
    }
    if (typeof m.content === "string") {
      return m.content;
    }
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
    }
  }
  return "";
}

// FORK 2026-06-11: flatten a tool_result `content` (string | block[]) into a
// single string. Extracted verbatim from the inline tool_result arm so the
// new web_search_tool_result arm (server-side web tools) reuses the EXACT
// same flattening. Behavior preserved: string -> itself; block[] -> text
// blocks joined by "\n" with empties filtered; anything else -> "".
// Exported so the sibling tinker-bridge test unit can exercise it directly.
export function flattenResultContent(content: string | CcContentBlock[]): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => {
            if (!c || typeof c !== "object") {
              return "";
            }
            const typedBlock = c as { type?: string; text?: string };
            return typedBlock.type === "text" && typeof typedBlock.text === "string"
              ? typedBlock.text
              : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
}

// FORK 2026-06-19 (bug B — "duplication of text in the answers"): trim a streaming "restart" overlap.
//
// claude-cli (with --include-partial-messages) interleaves fine-grained content_block_delta events
// with cumulative `assistant` message re-emits. When block indices misalign or a block is re-sent,
// the same prose is appended twice ("Good catches…Good catches…## 💬 ANSWER…"). The legacy guards
// only DROPPED a clean 60-char *prefix* restart on the assistant_cumulative source (keyed per block
// index), so partial / offset / cross-block re-sends slipped through and rendered as a doubled answer.
//
// This helper inspects the boundary between what we've already accumulated and the incoming delta: if
// the delta BEGINS by repeating the TAIL of `acc` (the exact signature of a re-send), the overlapping
// prefix is trimmed; if the whole delta is a re-send, "" is returned (caller drops it). It is
// deliberately conservative — it only acts on an overlap of at least `minLen` chars, so a delta that
// legitimately opens with a short repeat ("Step 1:" / "Step 2:", a repeated word) is left untouched.
// Source-agnostic and cross-block because it compares against the GLOBAL accumulator tail, not a
// per-block buffer.
export function dedupStreamingOverlap(acc: string, delta: string, minLen = 60): string {
  if (!delta || acc.length < minLen || delta.length < minLen) {
    return delta;
  }
  const maxK = Math.min(acc.length, delta.length);
  for (let k = maxK; k >= minLen; k--) {
    if (acc.endsWith(delta.slice(0, k))) {
      return delta.slice(k);
    }
  }
  return delta;
}

// FORK 2026-04-20 (extended 2026-04-27): derive a stable per-session
// worker-pool key. The OpenClaw `createStreamFn` ctx doesn't expose the
// active session key, and `opts.sessionKey` was always undefined (the
// previous code in index.ts read a non-existent field off `model`). Every
// call fell back to the literal "agent:main:main", so 3 parallel subagents
// collapsed onto ONE worker — they queued serially and two hung forever
// waiting for the third.
//
// Hashing the system prompt alone kept workers distinct per session across
// turns, but it ALSO kept Jarvis pinned to the same claude-cli `--resume`
// session forever: `performGatewaySessionReset` rotates the OpenClaw
// sessionId on /new and /reset, but the systemPrompt hash is unchanged so
// the tinker-bridge key was the same → same worker → same `--resume <oldId>`
// → claude-cli's memory survived a "session reset". That broke the bible
// §5.5 contract that /new and /clear should reset BOTH the UI and the
// underlying context.
//
// Fix: hash the OpenClaw sessionId into the key. Now a reset that mints
// a new sessionId yields a new tinker-bridge key, which the worker pool
// treats as a brand-new session (no `--resume`, no inherited context).
// The old map entry under the previous hash is left behind as orphaned
// state — `getResumeSessionId` will never look it up again because no
// future request will derive that same key. Cheap; no explicit cleanup
// needed for now.
// FORK 2026-07-29: key on the STABLE PREFIX of the system prompt, not the whole
// thing.
//
// `src/agents/system-prompt.ts` deliberately splits the prompt at
// SYSTEM_PROMPT_CACHE_BOUNDARY, and its own comment says why: "Keep large stable
// prompt context above this seam so Anthropic-family transports can reuse it
// across labs and turns. Dynamic group/session additions and volatile project
// context below it are the primary cache invalidators." Everything below the
// seam — Dynamic Project Context, Group Chat Context, the provider dynamic
// suffix, the heartbeat block, and the `## Runtime` line — is per-turn volatile
// BY DESIGN.
//
// Hashing the whole prompt fed all of that into the worker-pool key, so the pool
// missed constantly and spawned a cold claude-cli per turn. Measured over 142
// captured turns of agent:main:main (~/.openclaw/forensic-dumps): the `runtime`
// section alone had 55 distinct values, and 2026-07-28 shows 109 "spawning
// claude" events against ~101 turn-starts.
//
// The marker is duplicated as a literal rather than imported. This file DOES cross
// into core — see the `openclaw/plugin-sdk/*` imports at the top — but only through
// DECLARED SDK subpaths, which is the sanctioned route under FOUNDATION #9: this
// extension is `publishToClawHub: true`, so its tarball ships only its own directory
// and a relative `../../../src/**` reach could not resolve on a user's disk at all.
// (A FORK_EXTENSION_ALLOWLIST entry in scripts/check-no-extension-src-imports.ts
// would only silence the lint; the tarball would still fail to resolve.)
//
// The constant is nonetheless NOT imported, for two reasons: nothing publishes it
// through a plugin-sdk subpath, and `SYSTEM_PROMPT_CACHE_BOUNDARY`
// (src/agents/system-prompt-cache-boundary.ts) is newline-wrapped — "\n<!-- ... -->\n"
// — so it is not a drop-in for the bare marker matched here.
// `extensions/anthropic-vertex/stream-runtime.test.ts` duplicates it for the same
// reason. It is a stable protocol string, and if it ever changed the failure is
// benign: `stableSystemPromptPrefix` finds no marker and returns the whole prompt —
// a colder pool, never a mis-keyed one.
const SYSTEM_PROMPT_CACHE_BOUNDARY_MARKER = "<!-- OPENCLAW_CACHE_BOUNDARY -->";

/**
 * The part of the system prompt that identifies the WORKER, not the TURN.
 * Falls back to the whole prompt when the marker is absent (subagents and
 * minimal-mode prompts do not always emit it) — never silently key on "".
 */
export function stableSystemPromptPrefix(systemPrompt: string | undefined): string {
  const full = systemPrompt ?? "";
  const idx = full.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY_MARKER);
  return idx === -1 ? full : full.slice(0, idx);
}

function deriveSessionKey(
  explicit: string | undefined,
  systemPrompt: string | undefined,
  openclawSessionId: string | undefined,
): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const promptPart = stableSystemPromptPrefix(systemPrompt);
  const idPart = openclawSessionId ?? "";
  if (!promptPart && !idPart) {
    return "agent:main:main";
  }
  // djb2 hash over `${systemPrompt}\u0001${sessionId}` — the SOH separator
  // keeps a 32KB persona prompt with a colliding hash from being mistaken
  // for a 32KB persona prompt with a different sessionId.
  // NOTE: promptPart is the STABLE PREFIX (see the 2026-07-29 block above), not
  // the whole system prompt — the volatile suffix is deliberately excluded.
  let h = 5381;
  const combined = `${promptPart}\u0001${idPart}`;
  for (let i = 0; i < combined.length; i++) {
    h = ((h << 5) + h + combined.charCodeAt(i)) | 0;
  }
  return `tinker-sp-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// FORK 2026-06-23 (BRIDGE FIX 2/3 — fast-fail init-only stall): pure decision
// FORK 2026-08-25 (the architect: "the original chat just swallowed intermediate
// thinking text") — content-block identity for a whole turn.
//
// An Anthropic content-block `index` is unique only WITHIN one assistant
// message, and claude-cli emits every step of its tool loop as a separate
// message whose indices restart at 0. Measured on a live opus-5 run:
//   msg1 = [thinking(0), text(1), tool_use(2)]
//   msg2 = [text(0), tool_use(1)]
//   msg3 = [text(0)]
// Keyed on the bare index, msg2's and msg3's prose collide on key 0 — two
// unrelated narrations treated as ONE growing block. That is what swallowed the
// intermediate text: the streaming paths either glued them into a single bubble
// with no separator, or dropped the second outright because it does not prefix
// the first. Pairing the index with the owning message id keeps every step's
// prose its own block, which is also what makes the UI's bubble break fire.
//
// Exported (pure, no side effects) so the boundary rule is unit-tested without
// spawning a real claude-cli worker.
//
// FORK 2026-08-28 (the architect: "There seems to be a disconnect between what Jarvis
// answers and what is visible in the chat") — the message id was necessary but
// NOT sufficient, because the two ingest paths NUMBERED the same block
// differently:
//   • content_block_delta keys on Anthropic's ABSOLUTE block index (`ev.index`);
//     with extended thinking on, thinking is block 0 and the prose is block 1.
//   • the cumulative `assistant` line keys on the LOOP POSITION in
//     `message.content[]`, and an in-progress cumulative message OMITS the
//     thinking block — so the very same prose sits at position 0.
// One block, two keys (`msg:1` and `msg:0`), which broke BOTH mechanisms that
// hang off the key: `emitTextBlockBreak` fired a SPURIOUS bubble split, and
// `blockTextSeen` missed so the whole block was re-emitted (then blocked).
// Measured over a 5h journald window (35,186 lines): 1,423 text_block_break
// events, 727 of them same-message, and the same-message index-transition set
// was EXACTLY {("1","0"): 727} — zero other patterns — against 716 `[duprep]
// WARN BLOCKED duplicate assistant_cumulative emit` lines. Rendered-DOM receipt
// (snapshot 12:40:52Z, inside #messages): one bubble ends "…the classic
// stale-dist trap - I'll" and the next opens "confirm which copy the live UI
// actually loads." One sentence, two bubbles, mid-clause.
//
// Fix: a TYPE-SCOPED ORDINAL. Both paths key on `${messageId}:text:${nth}` /
// `${messageId}:thinking:${nth}`, counting only WITHIN a type. That is invariant
// to whether the cumulative message carries the thinking block (or any tool_use
// block) at all — which the absolute-index-vs-position pair never was. The
// alternative (reconstructing an absolute index by offsetting `bi` by the number
// of thinking blocks seen for that message) was rejected: it needs the delta
// path's thinking-block count to be complete and correctly attributed BEFORE the
// first cumulative frame lands, so one dropped or reordered content_block_start
// silently shifts every later key. Type-scoped ordinals have no such coupling.
//
// The delta path learns each block's type from `content_block_start`; when that
// event is absent it falls back to the type implied by the delta itself, which
// is always known at the call site. `keyFor` (message-scoped ABSOLUTE index) is
// retained: no ingest path uses it any more, but it is the property pinned by
// stream.block-key.test.ts and it remains the honest answer to "which raw index
// did this message use?" for diagnostics.
//
// FORK 2026-09-24 (the architect: "in nearly every thinking message … the messages show
// twice") — a per-frame ordinal is only right while a message holds ONE block of
// each kind. claude-cli writes one `assistant` frame PER BLOCK, right after that
// block's deltas and before its content_block_stop, so every one-block frame
// counted itself as ordinal 0. Opus 5.5 at effort xhigh sends TWO thinking
// blocks per message (an empty signed one, then the narration): the narration's
// frame resolved to the empty block's key, found prev "", and pushed the whole
// text again on top of the deltas — "X\n\nX" in 17 of one turn's 30 thinking
// messages. A frame with one block of a kind is the block the delta path touched
// LAST of that kind, so it takes that block's key (`keyForFrameBlock`); frames
// holding several blocks of a kind, or arriving with no stream events at all,
// keep the ordinal. Tests: stream.thinking-frames.test.ts.
export type BlockKind = "text" | "thinking";

/**
 * The ordinal bucket a content block counts against, or null for blocks that
 * carry no accumulated prose (tool_use, server_tool_use, tool_result, …).
 * `redacted_thinking` counts as a thinking block so both paths agree on the
 * ordinal of any LATER real thinking block in the same message.
 */
export function blockKindOf(type: unknown): BlockKind | null {
  if (type === "text") {
    return "text";
  }
  if (type === "thinking" || type === "redacted_thinking") {
    return "thinking";
  }
  return null;
}

export function createBlockKeyTracker(): {
  noteMessage: (id: unknown) => void;
  noteBlockStart: (index: unknown, type: unknown) => void;
  keyFor: (index: number) => string;
  keyForStreamIndex: (index: number, kind: BlockKind) => string;
  keyForContentOrdinal: (kind: BlockKind, ordinal: number) => string;
  keyForFrameBlock: (kind: BlockKind, ordinal: number, sameKindInFrame: number) => string;
} {
  let currentMessageId = "m0";
  // Absolute block index -> the "<kind>:<ordinal>" it was assigned, for the
  // CURRENT message only. Cleared when the message id changes, because Anthropic
  // restarts block indices at 0 in every new assistant message.
  const assignedByIndex = new Map<number, string>();
  const nextOrdinal: Record<BlockKind, number> = { text: 0, thinking: 0 };
  // The absolute index the delta path touched last, per kind, in the CURRENT message.
  const lastStreamedIndex = new Map<BlockKind, number>();

  // Idempotent: an index announced by content_block_start and then streamed by
  // content_block_delta must resolve to the SAME ordinal, not consume two.
  const assign = (index: number, kind: BlockKind): string => {
    lastStreamedIndex.set(kind, index);
    const existing = assignedByIndex.get(index);
    if (existing !== undefined && existing.startsWith(`${kind}:`)) {
      return existing;
    }
    const assigned = `${kind}:${nextOrdinal[kind]++}`;
    assignedByIndex.set(index, assigned);
    return assigned;
  };

  return {
    noteMessage: (id: unknown): void => {
      const next = typeof id === "string" && id ? id : "";
      if (!next || next === currentMessageId) {
        return;
      }
      currentMessageId = next;
      assignedByIndex.clear();
      lastStreamedIndex.clear();
      nextOrdinal.text = 0;
      nextOrdinal.thinking = 0;
    },
    noteBlockStart: (index: unknown, type: unknown): void => {
      const kind = blockKindOf(type);
      if (kind === null || typeof index !== "number") {
        return;
      }
      assign(index, kind);
    },
    keyFor: (index: number): string => `${currentMessageId}:${index}`,
    keyForStreamIndex: (index: number, kind: BlockKind): string =>
      `${currentMessageId}:${assign(index, kind)}`,
    keyForContentOrdinal: (kind: BlockKind, ordinal: number): string =>
      `${currentMessageId}:${kind}:${ordinal}`,
    keyForFrameBlock: (kind: BlockKind, ordinal: number, sameKindInFrame: number): string => {
      const streamed = lastStreamedIndex.get(kind);
      if (sameKindInFrame === 1 && streamed !== undefined) {
        return `${currentMessageId}:${assign(streamed, kind)}`;
      }
      return `${currentMessageId}:${kind}:${ordinal}`;
    },
  };
}

export type BlockKeyTracker = ReturnType<typeof createBlockKeyTracker>;

/**
 * The key of every block in one cumulative `assistant` frame, in order; "" for a
 * block that carries no prose (tool_use, server_tool_use, …). The ordinal is
 * consumed by TYPE, up front, so a malformed block cannot desync the blocks
 * after it.
 */
export function keysForAssistantFrame(
  keys: BlockKeyTracker,
  blocks: ReadonlyArray<{ type?: unknown }>,
): string[] {
  const kinds = blocks.map((block) => blockKindOf(block?.type));
  const total: Record<BlockKind, number> = { text: 0, thinking: 0 };
  for (const kind of kinds) {
    if (kind !== null) {
      total[kind]++;
    }
  }
  const nth: Record<BlockKind, number> = { text: 0, thinking: 0 };
  return kinds.map((kind) =>
    kind === null ? "" : keys.keyForFrameBlock(kind, nth[kind]++, total[kind]),
  );
}

// predicate for the stream watchdog. Returns true when a turn has clearly
// wedged during init — it has produced NO visible text and NO thinking and
// only a tiny handful of init stream lines, yet has been alive longer than the
// init-silent threshold. Exported (pure, no side effects) so the behavior is
// unit-tested directly without spawning a real claude-cli worker.
//
// CRITICAL non-regression: the `linesSeen <= maxInitLines` gate means a
// legitimately-long heavy TOOL turn — which streams MANY lines while text.len
// and thinking.len stay 0 — is NEVER fast-failed. Only a turn that is both
// content-empty AND line-quiet (the init-wedge signature) qualifies.
//
// FORK 2026-09-25 (context-window-panel.md §6.1 A6 (i)): a COMPACTION wears that
// signature and is not a wedge. The CLI's compaction runs 2–3.6 minutes and says
// nothing but a `system/status` `compacting` line (re-sent every 30 s only while a
// precomputed one is pending), so at the 90 s tick a `/compact` turn has text 0,
// thinking 0 and a handful of lines, and this predicate SIGTERMed it mid-compaction.
// `compacting` is true for a turn that IS `/compact` (cli-command.ts) and for any turn
// while the CLI's own `compacting` status is latched (createCompactionLineReader). The
// turn stays bounded by the request timeout and the user's Stop.
export function shouldFastFailInitStall(args: {
  elapsedMs: number;
  textLen: number;
  thinkingLen: number;
  linesSeen: number;
  initSilentMs?: number;
  maxInitLines?: number;
  /** A compaction is running (see above): never a wedge, whatever else holds. */
  compacting?: boolean;
}): boolean {
  const initSilentMs = args.initSilentMs ?? FAST_FAIL_INIT_SILENT_MS;
  const maxInitLines = args.maxInitLines ?? FAST_FAIL_MAX_INIT_LINES;
  return (
    args.compacting !== true &&
    args.elapsedMs > initSilentMs &&
    args.textLen === 0 &&
    args.thinkingLen === 0 &&
    args.linesSeen <= maxInitLines
  );
}

// FORK 2026-08-28 (R3 — "what the gateway answers must be exactly what the chat
// shows"): the tail-recover decision, made explicit and total.
//
// After a turn ends the bridge reconciles its own `accumulatedText` against
// claude-cli's authoritative `result.result`. Until today it recovered in
// exactly two shapes — `result.result.startsWith(accumulatedText)` (append the
// tail) and `result.result.length > streamedLen * 2 + 50` (treat the stream as a
// preamble and replace). In a TOOL-LOOP turn NEITHER holds: `accumulatedText` is
// every step's narration concatenated and is normally LONGER than
// `result.result`, which is the final answer alone. Control fell off the end of
// the `if` with no else, no log line and no recovery.
//
// Measured over the same 5h window: 130 completed turns, `grep -c 'tail-recover'`
// = 0 — neither arm fired ONCE. Cross-check: turn tinker-sp-c2e8f69c ended
// final_text_len=5992 with result_text="Blocked too. So here's where it stands."
// (the accumulator is longer than the result ⇒ both arms false). Same shape on
// 114 of the 130 turns. A net that never fires and never logs is
// indistinguishable from a net that is not there.
//
// So: a third arm (CONTAINMENT) plus an explicit verdict for every turn.
//   prefix          — the result extends what we streamed; append the tail.
//   diverged        — the result dwarfs the stream; the stream was a preamble.
//   missing         — the result's head is NOWHERE in the stream, i.e. the final
//                     answer never streamed. Append it. This is the arm that was
//                     absent, and the only one that can make an invisible answer
//                     visible.
//   already-present — the result's head is in the stream; nothing to do.
//   no-result       — claude-cli sent no result text at all.
// (The caller also logs a sixth verdict, `error-envelope`, from the is_error
// early-return, which replaces the accumulator wholesale and cannot recover.)
//
// This function only ever APPENDS or does nothing — it has no arm that drops or
// caps content. Pure and exported so every verdict is exercised without spawning
// a worker.
export type TailRecoverVerdict =
  | "prefix"
  | "diverged"
  | "missing"
  | "already-present"
  | "no-result";

/**
 * Head length for the containment probe — the same 60-char "long enough to be
 * unique by content" threshold the [duprep] guards in this file already use.
 */
export const TAIL_RECOVER_HEAD_LEN = 60;

export function classifyTailRecover(args: { streamed: string; result: string; headLen?: number }): {
  verdict: TailRecoverVerdict;
  append: string;
} {
  const { streamed, result } = args;
  if (!result) {
    return { verdict: "no-result", append: "" };
  }
  const streamedLen = streamed.length;
  if (result.length > streamedLen && result.startsWith(streamed)) {
    return { verdict: "prefix", append: result.slice(streamedLen) };
  }
  if (result.length > streamedLen * 2 + 50) {
    return { verdict: "diverged", append: streamedLen > 0 ? `\n\n${result}` : result };
  }
  // CONTAINMENT. `head` is the WHOLE result when the result is shorter than the
  // probe, which makes the test exact for the short finals that dominate the
  // tool-loop shape (the 39-char "Blocked too. So here's where it stands.").
  const head = result.slice(0, args.headLen ?? TAIL_RECOVER_HEAD_LEN);
  if (streamed.includes(head)) {
    return { verdict: "already-present", append: "" };
  }
  return { verdict: "missing", append: streamedLen > 0 ? `\n\n${result}` : result };
}

// FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A8) — the cc-bridge
// producer of the per-model-call contract (the call stream): one event per phase of every API call
// the CLI makes, read off the stdout lines Step 0 measured (§6.0 a).
//
//   send   {type:"system", subtype:"status", status:"requesting"} — the CLI's own per-request
//          marker, measured right before its message_start (a stdin write would be once per
//          TURN, and a tool loop is many calls inside one turn)
//   usage  stream_event message_start — message.usage input / cache_read / cache_creation
//   end    stream_event message_delta — usage (output, and the final input side) + stop_reason
//
// The contract's owner is src/infra/call-telemetry.ts, reached through the published subpath
// `openclaw/plugin-sdk/fork-telemetry` (src/plugin-sdk/fork-telemetry.ts). The tracker below
// produces the owner's own CallTelemetryEvent, the owner's emitCallTelemetry builds the wire
// payload and publishes it, and the owner's allocateCallIndex numbers this lane's calls.
//
// MIRROR RETIRED 2026-09-24. Until that subpath existed this file could not import the owner, so
// it rebuilt the payload to the same shape, kept its own per-run call counter and wrote the stream
// literal itself, under a RATCHET note that the two builders must agree key for key. The mirrored
// builder, its count rule and its counter are deleted: the owner is again the only shipped file
// that writes the literal, and a change to the contract reaches this lane with no second edit.
// What stays here is the line MAPPING, which belongs to this lane alone.
//
// What the tracker does when the stream leaves the happy path:
//   - A call it can no longer follow is ENDED, never left open: a second `requesting` (the CLI
//     retried), a second message_start before any message_delta, the `result` line and the
//     stream fn's `finally` each close it with an `end` carrying only what was measured, so a
//     timeline block drawn from send to end cannot grow forever.
//   - message_start with no `requesting` before it still opens a call (a CLI that does not send
//     the marker); only the send is missing, and nothing is invented in its place.
//   - A stream_event with a `parent_tool_use_id` belongs to a subagent the CLI ran inside a tool;
//     its prompt is not this session's context, so it is not read. UNVERIFIED: whether the CLI
//     sends `requesting` for those requests too. If it does, each shows as a send that the next
//     main-thread request ends empty.
//   - message_start's `output_tokens` is the count at first byte, not the call's output: output
//     is read from message_delta only.
//   - Absent, not zero: a count that is missing, null, negative or not finite is omitted (the
//     owner's compactionTokenCount rule, imported rather than mirrored); a reported 0 is kept.

/**
 * What every call event of this lane carries. §6.0 (a) measured per-call usage on this stream, so
 * every count is the CLI's own; an event without counts vouches only for its timestamp, which is
 * observed too.
 */
const CC_BRIDGE_CALL = { lane: "cc-bridge", provenance: "exact" } as const;

function readCallPromptParts(usage: unknown): CallPromptParts {
  const fields = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  return {
    input: compactionTokenCount(fields.input_tokens),
    cacheRead: compactionTokenCount(fields.cache_read_input_tokens),
    cacheWrite: compactionTokenCount(fields.cache_creation_input_tokens),
  };
}

/** What the tracker tells a sub-agent counter: the same counts it reads for a main-thread call, keyed by the parent tool call. */
export type SubagentStreamEvent = {
  phase: "start" | "end";
  parentToolUseId: string;
  t: number;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
};

/**
 * Pure: turns the CLI's stdout lines into the owner's call events. `nextCallIndex` numbers each new
 * call; `now` is the observation time the caller stamps on every event a line produces.
 */
export function createBridgeCallTracker(
  nextCallIndex: () => number,
  /**
   * FORK 2026-09-30 (THALAMUS v4 D5, design F7): told of each sub-agent call (a `parent_tool_use_id` event) so a
   * plugin can COUNT them. It never changes what the tracker returns: the per-call feed still skips them. Absent: as before.
   */
  onSubagentEvent?: (event: SubagentStreamEvent) => void,
): {
  observe: (line: CcStreamStdoutLine, now: number) => CallTelemetryEvent[];
  close: (now: number) => CallTelemetryEvent[];
} {
  let open: { callIndex: number; usageRead: boolean } | null = null;
  const close = (now: number): CallTelemetryEvent[] => {
    if (!open) {
      return [];
    }
    const ended: CallTelemetryEvent = {
      phase: "end",
      callIndex: open.callIndex,
      t: now,
      ...CC_BRIDGE_CALL,
    };
    open = null;
    return [ended];
  };
  const observe = (line: CcStreamStdoutLine, now: number): CallTelemetryEvent[] => {
    const record = line as { type?: unknown; subtype?: unknown; status?: unknown };
    if (record.type === "system" && record.subtype === "status" && record.status === "requesting") {
      const frames = close(now);
      const call = { callIndex: nextCallIndex(), usageRead: false };
      open = call;
      frames.push({ phase: "send", callIndex: call.callIndex, t: now, ...CC_BRIDGE_CALL });
      return frames;
    }
    if (record.type === "result") {
      return close(now);
    }
    if (record.type !== "stream_event") {
      return [];
    }
    const streamLine = line as CcStreamStdoutStreamEvent & { parent_tool_use_id?: unknown };
    if (typeof streamLine.parent_tool_use_id === "string" && streamLine.parent_tool_use_id) {
      if (onSubagentEvent) {
        const sub = streamLine.event;
        if (sub?.type === "message_start") {
          const message = sub.message as { model?: unknown; usage?: unknown } | undefined;
          onSubagentEvent({
            phase: "start",
            parentToolUseId: streamLine.parent_tool_use_id,
            t: now,
            ...(typeof message?.model === "string" && message.model
              ? { model: message.model }
              : {}),
            ...readCallPromptParts(message?.usage),
          });
        } else if (sub?.type === "message_delta") {
          const usage =
            sub.usage && typeof sub.usage === "object"
              ? (sub.usage as Record<string, unknown>)
              : {};
          onSubagentEvent({
            phase: "end",
            parentToolUseId: streamLine.parent_tool_use_id,
            t: now,
            ...readCallPromptParts(usage),
            output: compactionTokenCount(usage.output_tokens),
          });
        }
      }
      return [];
    }
    const ev = streamLine.event;
    if (ev?.type === "message_start") {
      const frames: CallTelemetryEvent[] = open?.usageRead ? close(now) : [];
      const call = open ?? { callIndex: nextCallIndex(), usageRead: false };
      call.usageRead = true;
      open = call;
      const parts = readCallPromptParts((ev.message as { usage?: unknown } | undefined)?.usage);
      if (Object.values(parts).some((value) => value !== undefined)) {
        frames.push({
          phase: "usage",
          callIndex: call.callIndex,
          t: now,
          ...CC_BRIDGE_CALL,
          ...parts,
        });
      }
      return frames;
    }
    if (ev?.type === "message_delta" && open) {
      const call = open;
      open = null;
      const usage =
        ev.usage && typeof ev.usage === "object" ? (ev.usage as Record<string, unknown>) : {};
      const stopReason = ev.delta?.stop_reason;
      return [
        {
          phase: "end",
          callIndex: call.callIndex,
          t: now,
          ...CC_BRIDGE_CALL,
          ...readCallPromptParts(usage),
          output: compactionTokenCount(usage.output_tokens),
          ...(typeof stopReason === "string" && stopReason ? { stopReason } : {}),
        },
      ];
    }
    return [];
  };
  return { observe, close };
}

/**
 * FORK 2026-09-29 (bible tinker-ui.md §5.8AB): the stop reason a stdout line reports for the
 * TOP-LEVEL call, from a `stream_event` message_delta or a block-complete `assistant` line.
 * Undefined for lines of a subagent call (parent_tool_use_id) and for lines without one.
 */
export function topLevelStopReasonOf(line: unknown): string | undefined {
  if (!line || typeof line !== "object") {
    return undefined;
  }
  const rec = line as {
    type?: unknown;
    parent_tool_use_id?: unknown;
    event?: { type?: unknown; delta?: { stop_reason?: unknown } };
    message?: { stop_reason?: unknown };
  };
  if (rec.parent_tool_use_id) {
    return undefined;
  }
  const raw =
    rec.type === "stream_event" && rec.event?.type === "message_delta"
      ? rec.event.delta?.stop_reason
      : rec.type === "assistant"
        ? rec.message?.stop_reason
        : undefined;
  return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * The typed outcome for a turn the CLI ended with stop_reason "refusal". A fact the CLI states,
 * not a classification, so it is built here rather than by src/fork/turn-outcome.ts (which the
 * bridge cannot import without a plugin-sdk subpath); the shape is TurnOutcome's.
 */
export function bridgeRefusalOutcome(): {
  kind: "refusal";
  recoverable: false;
  headline: string;
  detail: string;
  source: "cli";
} {
  return {
    kind: "refusal",
    recoverable: false,
    headline: "The model refused to answer",
    detail: 'Claude stopped this turn with stop_reason "refusal".',
    source: "cli",
  };
}

/**
 * The stream fn's two hooks: `observe` every stdout line, `close` once the turn is over. A no-op
 * without a runId, like every other agent event this file emits. Calls are numbered by the owner's
 * allocateCallIndex on the cc-bridge lane: per RUN, so a retried attempt continues the numbering,
 * and apart from the embedded lane's count for the same run. No try/catch around publishing: the
 * owner's emitCallTelemetry hands the event to notifyListeners, which isolates each listener's
 * throw.
 *
 * FORK 2026-10-02 (owner: "I see some sent information is unitemised ... assign it a bucket") —
 * `contextFor` finds the CLI transcript's reader (cli-context.ts) at each call. A `usage` frame then
 * carries `composition`: the billed prompt (input + cacheRead + cacheWrite) split into the panel's
 * buckets from what the CLI's own transcript recorded, summing to that billed figure exactly. The
 * read is wrapped: transcript I/O never breaks the call stream, it only leaves the frame without a
 * composition. send and end frames never carry one.
 */
export function createBridgeCallTelemetry(
  runId: string | undefined,
  sessionKey: string | undefined,
  contextFor?: () => CliContextSource | undefined,
): { observe: (line: CcStreamStdoutLine) => void; close: () => void } {
  if (!runId) {
    return { observe: () => undefined, close: () => undefined };
  }
  const target = { runId, sessionKey };
  let compositionFailureLogged = false;
  const withComposition = (event: CallTelemetryEvent): CallTelemetryEvent => {
    if (event.phase !== "usage" || !contextFor) {
      return event;
    }
    const billed = (event.input ?? 0) + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0);
    if (!(billed > 0)) {
      return event;
    }
    try {
      const reader = contextFor();
      if (!reader) {
        return event;
      }
      reader.refresh();
      const composition = reader.compose(billed);
      return composition ? { ...event, composition } : event;
    } catch (err) {
      if (!compositionFailureLogged) {
        compositionFailureLogged = true;
        log.warn(`call composition skipped for run ${runId}: ${formatErrorMessage(err)}`);
      }
      return event;
    }
  };
  const tracker = createBridgeCallTracker(
    () => allocateCallIndex(runId, "cc-bridge"),
    (e) =>
      noteThalamusSubagentCall({
        sessionKey,
        phase: e.phase,
        parentToolUseId: e.parentToolUseId,
        t: e.t,
        model: e.model,
        inputTokens: e.input,
        cacheReadTokens: e.cacheRead,
        cacheWriteTokens: e.cacheWrite,
        outputTokens: e.output,
      }),
  );
  const publish = (events: CallTelemetryEvent[]) => {
    for (const event of events) {
      emitCallTelemetry(target, withComposition(event));
    }
  };
  return {
    observe: (line) => publish(tracker.observe(line, Date.now())),
    close: () => publish(tracker.close(Date.now())),
  };
}

// FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A3, finding F3a) — the
// cc-bridge producer of the A1 compaction contract, for the claude CLI's OWN compactions. Its
// owner is src/infra/compaction-telemetry.ts, reached through openclaw/plugin-sdk/fork-telemetry.
//
// WHY. On this lane the model reads the CLI's own transcript, so the CLI's compaction is the only
// one that shrinks what it sees (F1 / F2). Before this reader the gateway never heard of it:
// worker.ts forwards every parsed stdout line as a stream_line, and handleLine below had no arm
// for `system`, so the line died there. The panel counted 0 compactions on the lane that compacts
// most, and nothing could pulse through a compaction that runs 2-3.6 minutes.
//
// THE LINES (§6.0 b: the CLI's own stream-json schema, claude CLI 2.1.281):
//   start  {type:"system", subtype:"status", status:"compacting"}. RE-SENT every 30 s while a
//          precomputed compaction is pending, so it is LATCHED: one start per compaction.
//   end    {type:"system", subtype:"compact_boundary", compact_metadata:{pre_tokens, post_tokens?,
//          duration_ms?, ...}}: completed, with the CLI's own figures as tokensBefore /
//          tokensAfter / durationMs. The latch resets here, so a second compaction starts again.
//   end    {type:"system", subtype:"status", status:null, compact_result:"failed"}: the CLI gave
//          the compaction up and sends no boundary. completed:false, no figures, latch reset, so
//          the start is not left open. Code-evident in the installed CLI (its auto-compaction
//          path sends failed with no boundary, and success beside one); not yet observed live.
//
// CHOICES, each against the alternative it rejects:
//   - Snake_case `compact_metadata` only. camelCase `compactMetadata` is the TRANSCRIPT's
//     spelling; a fallback to it would hide a change in the stream's shape behind a second path.
//   - `cumulative_dropped_tokens` is never read. It is a running total across every earlier
//     compaction (the CLI's own description), so as tokensDropped it would overstate every
//     compaction after the first. tokensDropped stays absent; the consumer has before and after.
//   - trigger is always "cli-internal", whatever the metadata's own trigger ("auto" or "manual")
//     says: A1's trigger names the EXECUTOR, and on this lane that is the CLI either way.
//   - A compact_result of "success" is not an end: the boundary is, and mapping both would count
//     one compaction twice.
//   - A boundary with no start before it still ends; nothing is invented in the start's place.
//     And no end is invented at turn end for a start that saw no boundary: a precomputed
//     compaction can finish in a later turn, and a fabricated completed:false would be false.
//   - Absent, not zero: every figure passes through the owner's compactionTokenCount.
// The wire literal stays in the owner (context-window-panel.md gate 7): this file hands it events.

/** Every compaction event of this lane: the CLI decided it, and the CLI measured it. */
const CLI_COMPACTION = {
  trigger: "cli-internal",
  lane: "cc-bridge",
  provenance: "exact",
} as const;

/**
 * Pure: the compaction events one stdout line carries (none or one). ONE reader per turn; the
 * start latch is its only state, and `isCompacting` exposes it to the fast-fail watchdog, which
 * must not read a compaction's silence as an init wedge (A6 (i)).
 */
export function createCompactionLineReader(): {
  read: (line: CcStreamStdoutLine) => CompactionTelemetryEvent[];
  isCompacting: () => boolean;
} {
  let compacting = false;
  const read = (line: CcStreamStdoutLine): CompactionTelemetryEvent[] => {
    const record = line as {
      type?: unknown;
      subtype?: unknown;
      status?: unknown;
      compact_result?: unknown;
      compact_metadata?: unknown;
    };
    if (record.type !== "system") {
      return [];
    }
    if (record.subtype === "compact_boundary") {
      compacting = false;
      const metadata =
        record.compact_metadata && typeof record.compact_metadata === "object"
          ? (record.compact_metadata as Record<string, unknown>)
          : {};
      const tokensBefore = compactionTokenCount(metadata.pre_tokens);
      const tokensAfter = compactionTokenCount(metadata.post_tokens);
      const durationMs = compactionTokenCount(metadata.duration_ms);
      return [
        {
          phase: "end",
          completed: true,
          ...CLI_COMPACTION,
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(tokensAfter !== undefined ? { tokensAfter } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      ];
    }
    if (record.subtype !== "status") {
      return [];
    }
    if (record.compact_result === "failed") {
      compacting = false;
      return [{ phase: "end", completed: false, ...CLI_COMPACTION }];
    }
    if (record.status === "compacting" && !compacting) {
      compacting = true;
      return [{ phase: "start", ...CLI_COMPACTION }];
    }
    return [];
  };
  return { read, isCompacting: () => compacting };
}

export function createClaudeCodeStreamFn(opts: CreateStreamFnInput = {}): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      const modelInfo = { api: model.api, provider: model.provider, id: model.id };
      const cwd = opts.cwd ?? DEFAULT_CWD;
      const disallowedTools = opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;

      // FORK (2026-04-24, extended 2026-04-27): OpenClaw's embedded runner
      // smuggles the current run/session identity into options via
      // `__openclawRunId` / `__openclawSessionKey` / `__openclawSessionId`
      // (see `src/agents/embedded-agent-runner/run/attempt.ts`). The runId +
      // sessionKey attribute live `stream:"tool"` agent events so the UI
      // can render tool bubbles with purpose titles. The sessionId is used
      // BELOW in `deriveSessionKey` to make /new and /reset cascade into
      // the tinker-bridge worker pool — without it the systemPrompt-only hash
      // kept the same `--resume` session alive across resets.
      const pipedOptions = (options ?? {}) as {
        __openclawRunId?: string;
        __openclawSessionKey?: string;
        __openclawSessionId?: string;
        __openclawThinkLevel?: string;
        // FORK 2026-09-30 (lifecycles.md L4b): this call continues a turn a restart interrupted
        // (attempt.ts continueFromTranscript), with the resume text to send if no worker holds it.
        __openclawContinuation?: { fallbackText?: string };
        // FORK 2026-10-02 (channel-reply): the run's normalized message channel ("webchat" for
        // Tinker, "whatsapp", ...). A chat-channel run gets its final message stamped below.
        __openclawMessageChannel?: string;
      };
      const runId = pipedOptions.__openclawRunId;
      const continuation = pipedOptions.__openclawContinuation;
      const openclawSessionKey = pipedOptions.__openclawSessionKey;
      const openclawSessionId = pipedOptions.__openclawSessionId;
      const messageChannel = pipedOptions.__openclawMessageChannel;
      // FORK 2026-06-11: per-run think level smuggled through pi-ai options
      // (mirrors the other __openclaw* fields). The cast is untyped, so this
      // name must match the writer EXACTLY or it silently flatlines.
      const optionThinkLevel = pipedOptions.__openclawThinkLevel;
      const sessionKey = deriveSessionKey(opts.sessionKey, context.systemPrompt, openclawSessionId);
      // FORK 2026-06-11: per-call EFFORT truth-tuple stream. Computed
      // server-side so it reports the same facts at EVERY UI level (incl
      // Auto), independent of whether the client requested thinking. The
      // configured budget mirrors worker.ts:628-630 — the actual
      // MAX_THINKING_TOKENS the worker pins for this run (undefined for
      // off/unset → reported as 0). `hadRealThinking` distinguishes a genuine
      // reasoning stream from the lone "[redacted reasoning]" placeholder
      // (≤18 chars) pushed by the redacted_thinking arm.
      let lastEffortEmitAt = 0;
      let sawRedactedThinking = false;
      const emitEffort = (final: boolean, extra?: Record<string, unknown>) => {
        if (!runId) {
          return;
        }
        const now = Date.now();
        if (!final && now - lastEffortEmitAt < 1500) {
          return;
        }
        lastEffortEmitAt = now;
        // FORK 2026-06-26 (eeg effort-truth, the architect): the EEG debugs the automatic
        // effort allocator (AUEFALAL) — it MUST graph the level actually REQUESTED,
        // not a guess re-derived from how much the model reasoned. The per-call
        // option is the first-choice source (an explicit /think pin — incl. "off" —
        // threads here and must win), but it is ABSENT on warm-worker reuse /
        // deferred respawn while the executing worker is still budgeting at the
        // allocator-chosen level (worker.ts:385 → MAX_THINKING_TOKENS). Fall back to
        // the worker's own pinned level so the event never self-reports a bare "off"
        // when a concrete level was applied. Without this the bridge emitted "" and
        // eeg-trace re-derived the column from thinkingChars (the bogus weave).
        const effectiveThinkLevel = optionThinkLevel ?? worker.thinkLevel;
        const configuredBudget = thinkLevelToMaxThinkingTokens(
          effectiveThinkLevel,
          maxOutputTokensFor(model.id),
        );
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "effort",
          data: {
            phase: final ? "final" : "live",
            // FORK 2026-06-13 (eeg): self-describe the ACTUAL model running so the
            // seismograph colours by the real model even in Auto (the architect 2026-06-13).
            model: model.id,
            thinkLevel: effectiveThinkLevel ?? "off",
            configuredBudget: configuredBudget ?? 0,
            thinkingChars: accumulatedThinking.length,
            hadRealThinking:
              accumulatedThinking.length > 0 &&
              !(sawRedactedThinking && accumulatedThinking.length <= 18),
            redacted: sawRedactedThinking,
            // FORK 2026-10-01 (bug-log [chat-divergence], cause 4): the frozen turn this run took
            // over, if any (resumeFields below), so a page that missed the run's start learns it.
            ...resumeFields,
            ...(extra ?? {}),
          },
        });
      };
      const toolLastNarration = new Map<string, string>();
      let pendingToolNarration = "";
      // FORK 2026-04-27: per-block-index cumulative state so each text /
      // thinking block in `assistant.message.content` accumulates
      // independently. Without this, a post-tool text block would be
      // dropped because its content does not prefix the preamble's text.
      //
      // FORK 2026-08-25 (the architect: "the original chat just swallowed intermediate
      // thinking text") — THE KEY IS NOW PER-MESSAGE, NOT PER-TURN. A content
      // block index is only unique WITHIN one assistant message, and claude-cli
      // emits every step of the tool loop as its OWN message whose indices
      // restart at 0. Measured on a live opus-5 run: msg1 = [thinking(0),
      // text(1), tool_use(2)], msg2 = [text(0), tool_use(1)], msg3 = [text(0)].
      // Keyed on the raw index, msg2's and msg3's narration collided on key 0,
      // which broke BOTH paths at once:
      //   • partial deltas appended msg3's prose onto msg2's under the same key,
      //     so two separate narrations fused into ONE bubble with no separator
      //     ("…before merging.488 species researched…" — observed verbatim in
      //     the rendered DOM);
      //   • the cumulative `assistant` path gates on
      //     `cumulative.startsWith(prev)`, and msg3's text does not start with
      //     msg2's, so the whole block was silently DROPPED — never emitted at all.
      // Both are "swallowed intermediate text".
      //
      // FORK 2026-08-28 — message identity alone was still not enough: the two
      // paths NUMBERED the same block differently (absolute `ev.index` vs the
      // loop position in a cumulative message that omits thinking), so one text
      // block answered to both `msg:1` and `msg:0` — 727 spurious same-message
      // bubble splits and ~716 whole-block re-emits in a single 5h window. The
      // key is now message identity + a TYPE-SCOPED ORDINAL; the derivation and
      // its evidence live on createBlockKeyTracker above.
      const blockTextSeen = new Map<string, string>();
      const blockThinkingSeen = new Map<string, string>();
      // Identity of the assistant message currently streaming. `message_start`
      // (partial mode) and the cumulative `assistant` line carry the SAME
      // `message.id`, so both paths derive the same key without double-counting.
      const blockKeys = createBlockKeyTracker();
      const noteAssistantMessage = blockKeys.noteMessage;
      // Both ingest paths key through the tracker (the cumulative path via
      // keysForAssistantFrame) and never through a raw index again — that
      // identity is what makes a same-message text_block_break impossible unless
      // the text block genuinely changed.
      const noteBlockStart = blockKeys.noteBlockStart;
      const streamBlockKey = blockKeys.keyForStreamIndex;

      // FORK 2026-05-28 — per-turn text-block tracker. When the active text
      // block changes between deltas (a tool_use fired between two pieces of
      // prose, or — since 2026-08-25 — a new assistant message began), emit a
      // lifecycle event so Tinker UI splits the streaming bubble. Same mechanism
      // as the tool_use trigger at app.ts:2396, but earlier on the timeline (the
      // pre-tool narration becomes its own bubble instead of piling into
      // one with all subsequent narrations).
      let activeTextBlockIndex: string | null = null;
      const emitTextBlockBreak = (fromIndex: string | null, toIndex: string) => {
        if (!runId) {
          return;
        }
        log.info(
          `text_block_break from=${fromIndex ?? "null"} to=${toIndex} sessionKey=${sessionKey}`,
        );
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "lifecycle",
          data: {
            phase: "text-block-break",
            fromIndex,
            toIndex,
            // FORK 2026-10-01: the frozen turn this run took over, if any (resumeFields below).
            ...resumeFields,
          },
        });
      };

      const emitToolStart = (
        toolCallId: string,
        name: string,
        args: unknown,
        narration: string,
      ) => {
        // FORK 2026-10-02 (channel-reply): the same textOffset recorded below, kept per call id
        // (first sighting wins) so the turn end can split narration from the answer.
        if (!toolTextOffsets.has(toolCallId)) {
          toolTextOffsets.set(toolCallId, accumulatedText.length);
        }
        if (!runId) {
          return;
        }
        toolLastNarration.set(toolCallId, narration);
        log.info(
          `tool.start name=${name} id=${toolCallId.slice(0, 12)} narration.len=${narration.length}`,
        );
        const argsRecord = (args ?? {}) as Record<string, unknown>;
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "tool",
          data: {
            phase: "start",
            name,
            toolCallId,
            args: argsRecord,
            purpose: narration || undefined,
            // FORK 2026-06-07 (Phase 1a): mark tinker-bridge tool starts so the
            // learned-intuition plugin runs the REAL prudence ensemble on them.
            tinkerBridge: true,
          },
        });
        // FORK 2026-06-07 (Phase 1a): the per-tool gate decision is now produced by
        // the learned-intuition plugin (it owns the ONNX prudence nets). It subscribes
        // to the `tinkerBridge` tool-start event emitted just above, runs the REAL ensemble,
        // and emits + persists the amygdala-decision. The rule-based stand-in lived here.
        // FORK 2026-04-25: also buffer the event so onTurnComplete can persist
        // it as a `customType: "tinker-bridge-tool"` entry. Without this, history
        // reload in Tinker shows only the user prompt + 64-char opener.
        recordToolEvent(runId, {
          phase: "start",
          toolCallId,
          name,
          args: argsRecord,
          purpose: narration || undefined,
          startedAt: Date.now(),
          // FORK (Mechanism A): record WHERE in the turn's coalesced text this
          // tool fired — the count of assistant-text chars accumulated BEFORE
          // the tool start. The read path slices the single coalesced text at
          // these ascending offsets to reconstruct interleaved per-segment
          // assistant messages. NB: text appended on the tail-recover path
          // (`result.result` reconciliation below) lands AFTER every offset was
          // recorded, so the read path treats the final segment as "rest of
          // text", never a fixed end index.
          textOffset: accumulatedText.length,
        });
      };

      const emitToolResult = (toolCallId: string, resultText: string, isError: boolean) => {
        if (!runId) {
          return;
        }
        log.info(
          `tool.result id=${toolCallId.slice(0, 12)} is_error=${isError} stdout.len=${resultText.length}`,
        );
        const purpose = toolLastNarration.get(toolCallId) || undefined;
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "tool",
          data: {
            phase: "result",
            toolCallId,
            result: resultText,
            isError,
            purpose,
          },
        });
        recordToolEvent(runId, {
          phase: "result",
          toolCallId,
          result: resultText,
          isError,
          purpose,
          endedAt: Date.now(),
        });
        toolLastNarration.delete(toolCallId);
      };

      const pool = getPool();
      // FORK 2026-09-30 (L4b): a worker the last gateway left (file transport) is adopted before
      // any turn picks one, or this turn would spawn a second claude on the same CLI session.
      // Once per process; afterwards an already-settled promise.
      await ensureAdoptionScan();
      const worker = pool.getOrCreate({
        sessionKey,
        binary: opts.binary,
        cwd,
        systemPromptAppend: context.systemPrompt,
        disallowedTools,
        model: model.id,
        // FORK 2026-06-11: thread the per-run think level into the worker so
        // the spawned Claude Code worker can apply the requested reasoning
        // budget for this run (WorkerSpawnParams now accepts thinkLevel).
        thinkLevel: optionThinkLevel,
        // FORK 2026-05-10: thread the openclaw agent sessionId through so
        // session-map can index by it for the across-restart resume path.
        openclawSessionId,
        // FORK 2026-05-30: thread the CANONICAL openclaw session key
        // (`agent:main:main`) so the worker can export it as TC_SESSION_KEY
        // for the jarvis voice gate + chat.inject routing (see worker.ts).
        openclawSessionKey,
      });
      // FORK 2026-09-30 (lifecycles.md L4b): the worker still holds the turn a restart froze
      // (adopted at boot, file transport). This run takes it instead of starting a new one.
      const resumingTurn = worker.hasPendingTurn?.() === true;
      // FORK 2026-10-01 (bug-log.md [chat-divergence], cause 4): this run also NAMES that turn, on
      // its lifecycle start below and on its later text-block breaks and effort events (a page that
      // reconnects after the start learns it from those). It has a NEW id and the worker replays the
      // turn from its first byte; without the name the webchat anchored the replay to no prompt, or
      // to one sent after the restart, and the answer appeared twice. Read before resumeTurn, which
      // clears the turn.
      const resumeFields = resumedTurnFields(resumingTurn ? (worker.frozenTurn?.() ?? null) : null);
      if (resumingTurn) {
        log.info(
          `[reattach] run ${runId ?? "?"} takes the frozen turn of run ${resumeFields.resumesRunId ?? "?"} (started ${resumeFields.resumesTurnStartedAt ?? "?"}) sessionKey=${sessionKey}`,
        );
      }

      // FORK 2026-05-11: emit lifecycle:start so the TUI's activeRuns map
      // picks up this run and renders the thinking indicator + side panels
      // (sessions, model, prefrontal). Without this, tinker-bridge runs only
      // emit stream:"tool" events, which don't activate the indicator —
      // the TUI stays on the local "sending..." placeholder until reply.
      // Idempotent vs the embedded runner's handleAgentStart: same runId
      // means Map.set overwrites cleanly.
      if (runId) {
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "lifecycle",
          data: {
            phase: "start",
            startedAt: Date.now(),
            model: model.id,
            modelProvider: model.provider,
            sessionKey: openclawSessionKey,
            // FORK 2026-10-01: the frozen turn this run takes, if any (resumesRunId,
            // resumesTurnStartedAt; tinker-ui live-continuation.ts ResumedTurn).
            ...resumeFields,
          },
        });
      }

      // FORK 2026-06-11: surface the warm-worker think-level LAG. If the pool
      // deferred a think-level change because the worker was busy mid-turn,
      // emit it once so the UI can badge "requested X (pending respawn)" on
      // this run. Read-once (clears on read), so the badge auto-resolves on
      // the turn after the worker recycles.
      if (runId) {
        const pendingLevel = pool.takeThinkLevelPending(sessionKey);
        if (pendingLevel) {
          emitAgentEvent({
            runId,
            sessionKey: openclawSessionKey,
            stream: "lifecycle",
            data: {
              phase: "think-level-pending",
              requested: pendingLevel.requested ?? "off",
              running: pendingLevel.running ?? "off",
            },
          });
        }
      }

      let streamStarted = false;
      let thinkingStarted = false;
      let thinkingEnded = false;
      let textStarted = false;
      let textEnded = false;
      let accumulatedText = "";
      let accumulatedThinking = "";
      const toolTextOffsets = new Map<string, number>();
      // FORK 2026-06-25 (metadata completeness — forward the thinking signature):
      // Claude's stream closes each extended-thinking block with a `signature_delta`
      // (and the cumulative `assistant` message's thinking block carries the same
      // `signature`). It's the opaque token the Anthropic API uses to verify
      // extended-thinking integrity for multi-turn continuity. The bridge already
      // accumulates the thinking TEXT but dropped this signature on the floor. We
      // capture the last non-empty signature seen and stamp it onto the persisted
      // `ThinkingContent.thinkingSignature` in buildContent(), so the replayed /
      // multi-turn message carries the metadata Anthropic provides instead of
      // losing it at the bridge boundary. (Live pi-ai stream events have no
      // signature slot, so this only enriches the FINAL/persisted message — which
      // is the part that matters for continuity.)
      let accumulatedThinkingSignature = "";
      // FORK (2026-04-22): tool_use blocks from claude-cli are NOT materialized
      // into the final AssistantMessage.content. claude-cli executes tools
      // internally and the UI learns about them through its own session-log
      // tail (claude writes `~/.claude/projects/<uuid>/*.jsonl` with full
      // tool_use/tool_result blocks). Putting toolCall blocks in OpenClaw's
      // assistant-message content triggered pi-agent-core's agent-loop to
      // re-execute them via the OpenClaw exec tool, which hit the prefrontal
      // "Exploration required" gate and surfaced as red "Something went
      // wrong" bubbles for every claude internal bash call. See
      // `extensions/prefrontal/exploration-gate.ts:105`.
      const textIndex = () => (thinkingStarted ? 1 : 0);

      const buildContent = (): (TextContent | ThinkingContent)[] => {
        const parts: (TextContent | ThinkingContent)[] = [];
        if (accumulatedThinking) {
          // FORK 2026-06-25: stamp the accumulated thinking signature onto the
          // persisted block so it survives into the final AssistantMessage (and
          // thus the OpenClaw transcript) for multi-turn continuity. Only set the
          // field when we actually captured one — an empty/absent signature stays
          // absent (the slot is optional upstream).
          const thinkingPart: ThinkingContent = { type: "thinking", thinking: accumulatedThinking };
          if (accumulatedThinkingSignature) {
            thinkingPart.thinkingSignature = accumulatedThinkingSignature;
          }
          parts.push(thinkingPart);
        }
        if (accumulatedText) {
          parts.push({ type: "text", text: accumulatedText });
        }
        return parts;
      };

      const buildPartial = (stopReason: StopReason = "stop", usage?: Usage): AssistantMessage => ({
        role: "assistant",
        content: buildContent(),
        stopReason,
        api: modelInfo.api,
        provider: modelInfo.provider,
        model: modelInfo.id,
        usage: usage ?? buildUsage(undefined),
        timestamp: Date.now(),
      });

      const pushStart = () => {
        if (streamStarted) {
          return;
        }
        streamStarted = true;
        const p = buildPartial();
        if (log.debug) {
          log.debug(`emit start content.len=${p.content.length}`);
        }
        stream.push({ type: "start", partial: p });
        recordPush();
      };
      const pushThinkingStart = () => {
        if (thinkingStarted) {
          return;
        }
        thinkingStarted = true;
        if (log.debug) {
          log.debug(`emit thinking_start`);
        }
        stream.push({ type: "thinking_start", contentIndex: 0, partial: buildPartial() });
        recordPush();
      };
      const pushThinkingEnd = () => {
        if (!thinkingStarted || thinkingEnded) {
          return;
        }
        thinkingEnded = true;
        if (log.debug) {
          log.debug(`emit thinking_end content.len=${accumulatedThinking.length}`);
        }
        stream.push({
          type: "thinking_end",
          contentIndex: 0,
          content: accumulatedThinking,
          partial: buildPartial(),
        });
        recordPush();
      };
      const pushTextStart = () => {
        if (textStarted) {
          return;
        }
        textStarted = true;
        if (log.debug) {
          log.debug(`emit text_start contentIndex=${textIndex()}`);
        }
        stream.push({ type: "text_start", contentIndex: textIndex(), partial: buildPartial() });
        recordPush();
      };
      const pushTextEnd = () => {
        if (!textStarted || textEnded) {
          return;
        }
        textEnded = true;
        if (log.debug) {
          log.debug(
            `emit text_end contentIndex=${textIndex()} content.len=${accumulatedText.length}`,
          );
        }
        // FORK 2026-05-25 (task-mpkw1a0b-9jsfy): thinking-vs-text overlap
        // detector. Top hypothesis for the duplicate-sentence bug: Claude's
        // extended-thinking block restates a sentence verbatim inside the
        // visible text block, and the rendered bubble shows both. Scan
        // accumulatedThinking for any 60+char span that also appears
        // verbatim in accumulatedText; log a sample if found. Tagged
        // "[duprep]" for grep.
        if (accumulatedThinking.length >= 60 && accumulatedText.length >= 60) {
          const overlapMin = 60;
          let firstOverlapAt = -1;
          let overlapSample = "";
          for (let i = 0; i + overlapMin <= accumulatedThinking.length; i += 20) {
            const probe = accumulatedThinking.slice(i, i + overlapMin);
            const hit = accumulatedText.indexOf(probe);
            if (hit >= 0) {
              firstOverlapAt = hit;
              overlapSample = probe;
              break;
            }
          }
          if (firstOverlapAt >= 0) {
            log.warn(
              `[duprep] WARN thinking-text overlap detected sessionKey=${sessionKey} thinking.len=${accumulatedThinking.length} text.len=${accumulatedText.length} overlapAt=${firstOverlapAt} sample=${JSON.stringify(overlapSample.replace(/\n/g, "↵"))}`,
            );
          } else {
            log.info(
              `[duprep] no thinking-text overlap sessionKey=${sessionKey} thinking.len=${accumulatedThinking.length} text.len=${accumulatedText.length}`,
            );
          }
        }
        stream.push({
          type: "text_end",
          contentIndex: textIndex(),
          content: accumulatedText,
          partial: buildPartial(),
        });
        recordPush();
      };

      // FORK 2026-05-25 (task-mpkw1a0b-9jsfy "Response rendering"):
      // diagnostic instrumentation for the duplicate-text bug. Per user:
      // "put logs wherever you see fit so that the next time we get to
      // this problem again you have answers." Goal: when the user sees
      // an identical sentence twice in a row in an assistant bubble,
      // these logs let us pin the source — Claude's thinking-vs-text
      // overlap, duplicate stream-line delivery, or a concat-stage bug.
      //
      // Strategy: log first/last 60 chars (single-line, no newlines) of
      // every delta + accumulated length. Tagged "[duprep]" for grep.
      const previewDelta = (s: string): string => {
        const flat = s.replace(/\n/g, "↵").replace(/\r/g, "");
        if (flat.length <= 120) return flat;
        return `${flat.slice(0, 60)} … ${flat.slice(-60)}`;
      };

      // Per-delta [duprep] traces are firehose-level (one line every ~2s per live
      // stream, delta.len=0 included — 2026-07-20 they drowned the journal). Gate
      // them behind TINKER_DUPREP_TRACE=1; the WARN-level duprep tripwires below
      // stay unconditional.
      const duprepTrace = process.env.TINKER_DUPREP_TRACE === "1";
      const pushThinkingDelta = (delta: string) => {
        pushStart();
        pushThinkingStart();
        accumulatedThinking += delta;
        emitEffort(false);
        if (duprepTrace)
          log.info(
            `[duprep] thinking_delta sessionKey=${sessionKey} delta.len=${delta.length} accumulated.len=${accumulatedThinking.length} preview=${JSON.stringify(previewDelta(delta))}`,
          );
        stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: buildPartial() });
        recordPush();
      };

      // FORK 2026-05-26 (task-mpkw1a0b-9jsfy "Response rendering"):
      // tag every pushTextDelta with its caller so the next log capture
      // tells us which handler (content_block_delta vs assistant_cumulative
      // vs heartbeat) sourced the duplicate. Without this tag, I had to
      // GUESS from timing alone — the user called this out: "Differentiate
      // what you know vs what you assume … recognize what you don't know
      // for certain." Future regressions will have the source on the line.
      const pushTextDelta = (delta: string, source: string = "unknown") => {
        pushStart();
        if (thinkingStarted) {
          pushThinkingEnd();
        }
        pushTextStart();
        // FORK 2026-05-28 — defense-in-depth assistant-cumulative blocker.
        // The block-scoped guard at the assistant handler (lines 661-672)
        // depends on blockTextSeen index alignment between content_block_delta
        // (keyed by Anthropic's ev.index) and the assistant handler (keyed by
        // message.content[] array position). When claude-cli reorders blocks
        // or omits earlier blocks (e.g. thinking) from in-progress assistant
        // messages, the keys diverge, prev resolves to "" (too short for the
        // 60-char gate), and the cumulative re-emits content already pushed
        // via content_block_delta — the user sees the answer parroted twice
        // in the same bubble with no separator (observed 2026-05-28 12:32:01
        // sessionKey=tinker-sp-4b620f70). Catch it here at the actual push site
        // against the GLOBAL accumulator: if the delta's 60-char head is
        // already present anywhere in what we've accumulated for this turn,
        // it's the upstream SDK quirk. Scoped to assistant_cumulative ONLY —
        // the content_block_delta source can legitimately repeat 60-char
        // openings (e.g. "Step 1: ..." / "Step 2: ...").
        if (source === "assistant_cumulative" && delta.length >= 60) {
          const head = delta.slice(0, 60);
          if (accumulatedText.length >= 60 && accumulatedText.includes(head)) {
            log.warn(
              `[duprep] WARN BLOCKED duplicate assistant_cumulative emit (head already in accumulator) sessionKey=${sessionKey} delta.len=${delta.length} accumulated.len=${accumulatedText.length} head.sample=${JSON.stringify(head.slice(0, 60).replace(/\n/g, "↵"))}`,
            );
            return;
          }
        }
        // FORK 2026-06-19 (bug B) — replaces the old WARN-only "duplicate delta detected" probe with
        // an ACTUAL fix: trim/drop any streaming-restart overlap where this delta re-sends the tail of
        // what we've already accumulated (the partial / offset / cross-block re-sends the per-block
        // 60-char prefix guard above missed). Conservative (60-char minimum) so legit short repeats
        // stay. See dedupStreamingOverlap. The 2026-05-28 assistant_cumulative head-anywhere BLOCKED
        // guard above still runs first for the clean full-block-restart case.
        const deduped = dedupStreamingOverlap(accumulatedText, delta);
        if (deduped.length !== delta.length) {
          log.warn(
            `[duprep] WARN trimmed streaming-overlap sessionKey=${sessionKey} source=${source} removed=${delta.length - deduped.length} kept=${deduped.length}`,
          );
        }
        if (!deduped) {
          return;
        }
        accumulatedText += deduped;
        if (duprepTrace)
          log.info(
            `[duprep] text_delta source=${source} sessionKey=${sessionKey} contentIndex=${textIndex()} delta.len=${deduped.length} accumulated.len=${accumulatedText.length} preview=${JSON.stringify(previewDelta(deduped))}`,
          );
        stream.push({
          type: "text_delta",
          contentIndex: textIndex(),
          delta: deduped,
          partial: buildPartial(),
        });
        recordPush();
      };

      // FORK 2026-04-20: progress heartbeat so we can tell from the gateway
      // log whether claude is silently thinking vs actually stuck. Logs
      // first-line-received and then every 30s/50 lines thereafter with a
      // compact summary. Watchdog fires a WARN if nothing arrives for 45s
      // so a silent hang is visible instead of invisible until the 900s
      // hard timeout.
      // FORK 2026-09-25 (context-window-panel.md §6.1 A6 (i)): read the user text before the
      // watchdog below, which needs to know whether this turn IS a CLI command (cli-command.ts;
      // `/compact` only). Such a turn goes out as the bare command: the chat-row contract further
      // down is for the model, and appended to `/compact` it would become the compaction's
      // summarization instructions. worker.send asks the same predicate for its stdin line.
      // A continuation whose worker is gone (it died, or ran on the pipe transport) has no turn to
      // take: the CLI session already holds the interrupted prompt, so it gets the resume text,
      // never that prompt a second time.
      const rawUserText =
        continuation && !resumingTurn && continuation.fallbackText
          ? continuation.fallbackText
          : extractUserText(context.messages ?? []);
      const cliCommand = extractCliCommand(rawUserText);
      const turnStartedAt = Date.now();
      let linesSeen = 0;
      let lastProgressLogAt = 0;
      let lastLineAt = turnStartedAt;
      // FORK 2026-06-23 (BRIDGE FIX 2/3): fire-once guard so the fast-fail abort
      // below kills the worker exactly once. The tick is lowered to ~15s (cheap)
      // so the fast-fail check fires near the FAST_FAIL_INIT_SILENT_MS threshold
      // instead of overshooting by up to a full 45s window. The original 45s
      // silent-WARN still uses lastLineAt so its cadence is unchanged.
      let fastFailFired = false;
      const watchdog = setInterval(() => {
        const silentMs = Date.now() - lastLineAt;
        if (silentMs > 45_000) {
          log.warn(
            `claude silent for ${Math.round(silentMs / 1000)}s (sessionKey=${sessionKey}, lines=${linesSeen}, text.len=${accumulatedText.length}, thinking.len=${accumulatedThinking.length})`,
          );
        }
        // FORK 2026-06-23 (BRIDGE FIX 2/3 — fast-fail init-only stall): abort an
        // init-wedged turn early rather than burning the full request timeout.
        // The linesSeen gate keeps long heavy tool turns (many lines, text.len=0)
        // safe — see shouldFastFailInitStall. Killing the worker reuses the
        // proven SIGTERM teardown so `worker.send` rejects and the existing catch
        // surfaces a normal timeout-style error envelope.
        const elapsedMs = Date.now() - turnStartedAt;
        if (
          !fastFailFired &&
          shouldFastFailInitStall({
            elapsedMs,
            textLen: accumulatedText.length,
            thinkingLen: accumulatedThinking.length,
            linesSeen,
            // A6 (i): a `/compact` turn is a compaction from its first line; any other turn is one
            // while the CLI's `compacting` status is latched. (compactionLines is declared below;
            // the first tick runs 15 s after run() passed every declaration, and the only await in
            // run() is worker.send.)
            compacting: cliCommand !== null || compactionLines.isCompacting(),
          })
        ) {
          fastFailFired = true;
          log.error(
            `[fast-fail] init-only for ${elapsedMs}ms text.len=0 thinking.len=0 lines=${linesSeen} — aborting early`,
          );
          // FORK 2026-09-03: name the cause. Without it this kill reached the
          // user as "Gateway restarted — I'm resuming it automatically", false
          // twice over: nothing restarted here and nothing resumes. The literal
          // is matched by `classifyAbortCause` in src/fork/error-envelope.ts.
          worker.kill("SIGTERM", "fast-fail-init-stall");
        }
      }, 15_000);

      // FORK 2026-05-11: pi-ai idle-timer heartbeat (closes brainstorm item #5).
      //
      // Why this exists: tinker-bridge intentionally suppresses tool_use stream
      // events to pi-ai (FORK 2026-04-22, see tool-loop.md — forwarding them
      // would re-execute via OpenClaw's exec tool). During long claude-cli
      // tool chains this means pi-agent-core's `streamWithIdleTimeout` sees
      // NO events for the duration of the tool work and SIGTERMs the run
      // at the idle threshold. Mitigation today is provider-level
      // `timeoutSeconds: 600` from the tinker-bridge plugin overlay
      // (bible §11.6e / config-shape.md T2), but that's load-bearing —
      // lower it accidentally and the 2026-05-05 incident comes back.
      //
      // What this does: every 25s of silence (well under the 120s default
      // and the 600s overlay), push an empty `text_delta` or `thinking_delta`
      // through the pi-ai stream, depending on which content block is
      // currently active. Empty delta is a no-op for accumulated content
      // (string concat with "" preserves the value) but yields an event
      // through `iterator.next()` so `streamWithIdleTimeout` resets its
      // timer.
      //
      // What this does NOT do: emit a tool_use block (would re-execute);
      // emit text outside an active content block (would violate pi-ai's
      // protocol invariants — text_delta requires a preceding text_start).
      // If neither thinking nor text is active (very early turn or the
      // gap between text_end and the final `done` event), the heartbeat
      // is suppressed — both windows are short and the idle timer can
      // ride them comfortably.
      let lastPiAiPushAt = turnStartedAt;
      const HEARTBEAT_INTERVAL_MS = 25_000;
      const recordPush = () => {
        lastPiAiPushAt = Date.now();
      };
      const heartbeat = setInterval(() => {
        const silentMs = Date.now() - lastPiAiPushAt;
        if (silentMs < HEARTBEAT_INTERVAL_MS) {
          return;
        }
        if (textStarted && !textEnded) {
          stream.push({
            type: "text_delta",
            contentIndex: textIndex(),
            delta: "",
            partial: buildPartial(),
          });
          recordPush();
        } else if (thinkingStarted && !thinkingEnded) {
          stream.push({
            type: "thinking_delta",
            contentIndex: 0,
            delta: "",
            partial: buildPartial(),
          });
          recordPush();
        }
        // else: no active content block — pi-ai protocol invariants would be
        // violated by an empty delta here, so we let this short window pass
        // unprotected. The idle timer is wide enough that this is safe.
      }, HEARTBEAT_INTERVAL_MS);

      // FORK 2026-09-24 (A8): per-API-call events for the call stream, off the same stdout lines,
      // in their own function (createBridgeCallTelemetry) so the line router below stays untouched.
      // `openclawSessionKey`, not `sessionKey`: the latter is the worker-pool hash.
      // FORK 2026-10-02: the third argument finds the CLI's own transcript at each call, from the
      // worker's CLI session id (its init line) and cwd, so every usage frame is itemised
      // (cli-context.ts). Undefined until the CLI has named its session.
      const callTelemetry = createBridgeCallTelemetry(runId, openclawSessionKey, () => {
        const cliSessionId = worker.sessionId;
        const workerCwd = worker.cwd;
        if (!cliSessionId || !workerCwd) {
          return undefined;
        }
        return cliContextFor(resolveTranscriptPath(workerCwd, cliSessionId));
      });
      // FORK 2026-09-24 (A3): the CLI's own compactions, read by handleLine's `system` arm. ONE
      // reader per turn, never one per stream fn: this stream fn serves every session, and a latch
      // shared between them would hide one session's start behind another's.
      const compactionLines = createCompactionLineReader();
      // FORK 2026-09-25 (A6 (i)): the last compaction end this turn heard, quoted by a command
      // turn's outcome line (describeCliCommandOutcome). Set by handleLine's `system` arm.
      let lastCompactionEnd: CliCompactionEnd | null = null;
      const onStreamLine = (evt: WorkerEvent) => {
        if (evt.type !== "stream_line") {
          return;
        }
        const line = evt.line;
        if (!line || typeof line !== "object") {
          return;
        }
        linesSeen++;
        lastLineAt = Date.now();
        if (linesSeen === 1) {
          log.info(
            `first stream line after ${lastLineAt - turnStartedAt}ms sessionKey=${sessionKey}`,
          );
        } else if (linesSeen % 50 === 0 || lastLineAt - lastProgressLogAt > 30_000) {
          log.info(
            `progress sessionKey=${sessionKey} lines=${linesSeen} elapsed=${Math.round((lastLineAt - turnStartedAt) / 1000)}s text.len=${accumulatedText.length} thinking.len=${accumulatedThinking.length}`,
          );
          lastProgressLogAt = lastLineAt;
        }
        callTelemetry.observe(line);
        handleLine(line);
      };

      // FORK 2026-09-29 (bible tinker-ui.md §5.8AB): the CLI's own stop reason for the TOP-LEVEL
      // call (a subagent's call inside a tool carries parent_tool_use_id and is ignored). The
      // bridge persists every turn as `stop`, so without this a refusal reached the chat as an
      // ordinary (often empty or thinking-only) answer.
      let lastTopLevelStopReason: string | undefined;
      const handleLine = (line: CcStreamStdoutLine) => {
        const t = (line as { type?: string }).type;
        lastTopLevelStopReason = topLevelStopReasonOf(line) ?? lastTopLevelStopReason;
        if (t === "stream_event") {
          const ev = (line as CcStreamStdoutStreamEvent).event;
          if (!ev) {
            return;
          }
          // FORK 2026-08-25 — a new assistant message restarts content-block
          // indices at 0, so its identity has to be recorded BEFORE any of its
          // block events are keyed. See the blockTextSeen note above.
          if ((ev as { type?: string }).type === "message_start") {
            noteAssistantMessage((ev as { message?: { id?: unknown } }).message?.id);
          }
          // FORK 2026-08-28 — record the TYPE each absolute block index carries.
          // This is the only place the delta path can learn that index 1 is prose
          // and index 0 was thinking; without it the type-scoped ordinal has to be
          // inferred from the first delta, which is a strictly weaker signal (a
          // block whose start we saw but whose deltas have not arrived yet would
          // take the wrong ordinal). protocol.ts types `event` as an open map, so
          // the two fields are read through a widened view, as elsewhere here.
          if ((ev as { type?: string }).type === "content_block_start") {
            const started = ev as { index?: unknown; content_block?: { type?: unknown } };
            noteBlockStart(started.index, started.content_block?.type);
          }
          if (ev.type === "content_block_delta" && ev.delta) {
            // FORK 2026-05-24 — the Anthropic API event includes `index`
            // (content block index). We MUST keep block{Text,Thinking}Seen
            // in sync with what fine-grained deltas have pushed so the
            // cumulative `assistant` handler below doesn't re-emit the
            // same text. Before this sync, enabling --include-partial-
            // messages (commit 3e343cb5ee) duplicated every block: the
            // text streamed once via content_block_delta.text_delta and
            // then AGAIN when the block-complete `assistant` message
            // arrived (its prev=blockTextSeen[index]="" → it sliced the
            // whole cumulative as a "new" delta and pushed it). User saw
            // "Good catches…Good catches…## 💬 ANSWER…" in the bubble.
            const blockIndex =
              typeof (ev as { index?: unknown }).index === "number"
                ? ((ev as { index?: number }).index as number)
                : 0;
            // FORK 2026-08-28 — `blockIndex` stays the handle Anthropic streams
            // under, but the KEY is now its type-scoped ordinal, resolved per
            // arm because only the arm knows the block's type when
            // content_block_start was missed. `msg:text:0` here is the SAME key
            // the cumulative path derives for position 0 of a message that omits
            // the thinking block — which is the whole point.
            if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
              const key = streamBlockKey(blockIndex, "text");
              if (activeTextBlockIndex !== null && activeTextBlockIndex !== key) {
                emitTextBlockBreak(activeTextBlockIndex, key);
              }
              activeTextBlockIndex = key;
              pushTextDelta(ev.delta.text, "content_block_delta");
              const prev = blockTextSeen.get(key) ?? "";
              blockTextSeen.set(key, prev + ev.delta.text);
            } else if (
              ev.delta.type === "thinking_delta" &&
              typeof ev.delta.thinking === "string"
            ) {
              const key = streamBlockKey(blockIndex, "thinking");
              pushThinkingDelta(ev.delta.thinking);
              const prev = blockThinkingSeen.get(key) ?? "";
              blockThinkingSeen.set(key, prev + ev.delta.thinking);
            } else if (
              ev.delta.type === "signature_delta" &&
              typeof ev.delta.signature === "string" &&
              ev.delta.signature
            ) {
              // FORK 2026-06-25: Anthropic closes an extended-thinking block with a
              // `signature_delta` carrying the opaque integrity token. Capture the
              // last non-empty one so buildContent() can stamp it onto the persisted
              // thinking block (multi-turn continuity). Purely metadata — no stream
              // event is pushed for it (pi-ai has no signature slot on thinking_delta).
              accumulatedThinkingSignature = ev.delta.signature;
            }
          }
          return;
        }
        if (t === "assistant") {
          // claude's stream-json NDJSON emits periodic `assistant` messages
          // with CUMULATIVE text. Treat each update as a potential delta:
          // slice off whatever we've already pushed, emit the remainder.
          // This gives real-time streaming to the UI even when claude isn't
          // sending finer-grained `content_block_delta` events.
          //
          // FORK 2026-04-27 — multi-block fix: claude-cli emits SEPARATE
          // text blocks before and after tool_use chains. Tracking a single
          // `accumulatedText` and gating updates on
          // `cumulative.startsWith(accumulatedText)` worked for the
          // preamble (block 0) but silently dropped the post-tool summary
          // (block N), because block N's text didn't start with block 0's
          // text. The result: the OpenClaw transcript persisted only the
          // preamble (~120 chars) while claude-cli had actually emitted a
          // 1KB+ briefing — Tinker reload showed user prompt + 4 tool
          // bubbles + tiny opener with no answer. Track per-block-index
          // cumulative state so each block's deltas append independently
          // to the global `accumulatedText`.
          // FORK 2026-08-25 — same per-message keying as the delta path. In
          // partial mode `message_start` already recorded this id; re-noting it
          // is a no-op. Without partial events this is the ONLY place the new
          // message is seen, and it is what stops a fresh block's text from
          // being measured against the PREVIOUS message's block-0 text (which
          // it does not prefix, so the whole block was dropped).
          noteAssistantMessage((line as CcStreamStdoutAssistantMessage).message?.id);
          const blocks = (line as CcStreamStdoutAssistantMessage).message?.content ?? [];
          // FORK 2026-08-28 — count text and thinking blocks SEPARATELY and key on
          // the type-scoped ordinal, never on `bi`. That is what makes `msg:text:0`
          // here mean the SAME block as `msg:text:0` on the delta path, even though
          // the delta path saw it at absolute index 1 behind a thinking block this
          // frame omits. Keyed on `bi`, those two were `msg:0` and `msg:1`: 727
          // spurious breaks, ~716 whole-block re-emits.
          const frameKeys = keysForAssistantFrame(blockKeys, blocks);
          for (let bi = 0; bi < blocks.length; bi++) {
            const typed = blocks[bi] as CcContentBlock;
            const key = frameKeys[bi] ?? "";
            if (typed.type === "text" && typeof typed.text === "string") {
              const cumulative = typed.text;
              const prev = blockTextSeen.get(key) ?? "";
              if (cumulative.length > prev.length && cumulative.startsWith(prev)) {
                const delta = cumulative.slice(prev.length);
                // FORK 2026-05-26 (task-mpkw1a0b-9jsfy "Response rendering"):
                // duplicate-emit guard. Claude-cli's `assistant` cumulative
                // message has been observed (sessionKey=tinker-sp-1b6f2ca4 logs
                // at 11:29:16) emitting cumulative=2*prev — the SAME 217-char
                // block re-appended onto its prior 217-char self. The slice
                // computation then yields a 217-char delta that's a verbatim
                // copy of prev's content, and pushTextDelta doubles the
                // bubble. Detect via a 60-char prefix match: if the proposed
                // delta's first 60 chars equal prev's first 60 chars (both
                // long enough to be unique-by-content), DROP the delta and
                // still advance blockTextSeen so we don't re-encounter the
                // same condition on the next assistant emit. Soft fix at the
                // tinker-bridge layer; the upstream SDK quirk persists but no
                // longer leaks into the UI.
                const DUPLICATE_GUARD_MIN_LEN = 60;
                const isDuplicateRestart =
                  prev.length >= DUPLICATE_GUARD_MIN_LEN &&
                  delta.length >= DUPLICATE_GUARD_MIN_LEN &&
                  delta.startsWith(prev.slice(0, DUPLICATE_GUARD_MIN_LEN));
                if (isDuplicateRestart) {
                  log.warn(
                    `[duprep] WARN dropping duplicate assistant emit sessionKey=${sessionKey} bi=${bi} prev.len=${prev.length} delta.len=${delta.length} sample=${JSON.stringify(delta.slice(0, 60).replace(/\n/g, "↵"))}`,
                  );
                  blockTextSeen.set(key, cumulative);
                  continue;
                }
                // First-ever delta of a text block the turn has not streamed
                // before means the model has just resumed emitting prose (after
                // a tool_use chain, or in a brand-new assistant message) — clear
                // pending narration so it isn't attributed to a stale tool.
                //
                // FORK 2026-08-25 — the guard used to read `bi > 0 && prev === ""`.
                // The `bi > 0` half silently excluded exactly the case that broke:
                // a new assistant message puts its text at index 0 (measured:
                // msg2 = [text(0)], msg3 = [text(0)]), so no break was emitted
                // between two consecutive narrations and they rendered glued
                // together in one bubble. The block KEY changing is the real
                // boundary; the raw index is not.
                if (prev === "") {
                  pendingToolNarration = "";
                  // FORK 2026-05-28 — same boundary, also fire the bubble
                  // break for the UI. Covers the path where claude-cli's
                  // cumulative `assistant` message arrives without prior
                  // fine-grained content_block_delta events (block index
                  // advances only via this loop iteration).
                  if (activeTextBlockIndex !== null && activeTextBlockIndex !== key) {
                    emitTextBlockBreak(activeTextBlockIndex, key);
                  }
                  activeTextBlockIndex = key;
                }
                pushTextDelta(delta, "assistant_cumulative");
                pendingToolNarration += delta;
                blockTextSeen.set(key, cumulative);
              }
            } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
              const cumulative = typed.thinking;
              const prev = blockThinkingSeen.get(key) ?? "";
              if (cumulative.length > prev.length && cumulative.startsWith(prev)) {
                const delta = cumulative.slice(prev.length);
                pushThinkingDelta(delta);
                blockThinkingSeen.set(key, cumulative);
              }
              // FORK 2026-06-25: the complete cumulative thinking block carries the
              // final `signature` (CcContentBlock.thinking already declares the slot).
              // Capture it whenever present — this is the most reliable source (the
              // streamed signature_delta may be missed if the block arrived only via
              // the cumulative assistant re-emit). buildContent() stamps it onto the
              // persisted ThinkingContent for multi-turn continuity.
              if (typeof typed.signature === "string" && typed.signature) {
                accumulatedThinkingSignature = typed.signature;
              }
            } else if ((typed.type as string) === "redacted_thinking") {
              // FORK 2026-06-11: extended-thinking blocks that the API redacts
              // arrive as `redacted_thinking` with no readable `thinking`
              // field. Surface a single placeholder so the reasoning bubble
              // isn't silently empty. Gate on blockThinkingSeen so cumulative
              // re-emits of the same assistant message push it only ONCE per
              // block index — same dedupe contract as the `thinking` arm.
              if (!blockThinkingSeen.has(key)) {
                sawRedactedThinking = true;
                pushThinkingDelta("[redacted reasoning]");
                blockThinkingSeen.set(key, "[redacted reasoning]");
              }
            } else if (typed.type === "tool_use" && typeof typed.id === "string") {
              // FORK (2026-04-24): emit a live `stream: "tool"` agent event so
              // the UI shows a tool row with the narration as its title. The
              // block is NOT added to the final AssistantMessage.content — it
              // only lives as a UI-side event (see buildContent for rationale).
              emitToolStart(
                typed.id,
                typeof typed.name === "string" ? typed.name : "unknown",
                typed.input,
                pendingToolNarration.trim(),
              );
              pendingToolNarration = "";
            } else if ((typed.type as string) === "server_tool_use") {
              // FORK 2026-06-11: server-side tools (web_search / web_fetch)
              // surface as `server_tool_use` blocks carrying the lowercase
              // API tool name — the UI already friendly-labels those. Same
              // body shape as the tool_use arm; the block is NOT materialized
              // into AssistantMessage.content (see buildContent rationale).
              // protocol.ts's CcContentBlock union doesn't model this
              // discriminant (that file is owned by another unit), so read
              // the fields through a widened view.
              const stu = typed as unknown as { id?: unknown; name?: unknown; input?: unknown };
              if (typeof stu.id === "string") {
                emitToolStart(
                  stu.id,
                  typeof stu.name === "string" ? stu.name : "unknown",
                  stu.input,
                  pendingToolNarration.trim(),
                );
                pendingToolNarration = "";
              }
            }
          }
          return;
        }
        if (t === "user") {
          // FORK (2026-04-24): claude-cli echoes tool_result blocks back to us
          // as `user`-role stream lines between turns. Convert them into live
          // `stream: "tool"` phase=result events so the UI can pair them with
          // their tool_use rows and show the full output on expand.
          const blocks = (line as CcStreamStdoutUserMessage).message?.content ?? [];
          for (const b of blocks) {
            const typed = b as CcContentBlock;
            if (typed.type === "tool_result" && typeof typed.tool_use_id === "string") {
              emitToolResult(
                typed.tool_use_id,
                flattenResultContent(typed.content),
                Boolean(typed.is_error),
              );
            } else if ((typed.type as string) === "web_search_tool_result") {
              // FORK 2026-06-11: server-side web_search results echo back as
              // a `web_search_tool_result` user block keyed by tool_use_id.
              // Pair it with its server_tool_use row using the SAME flatten +
              // emitToolResult path as a normal tool_result. CcContentBlock
              // (protocol.ts, another unit's file) doesn't model this
              // discriminant, so read fields through a widened view.
              const wr = typed as unknown as {
                tool_use_id?: unknown;
                content?: unknown;
                is_error?: unknown;
              };
              if (typeof wr.tool_use_id === "string") {
                emitToolResult(
                  wr.tool_use_id,
                  flattenResultContent(wr.content as string | CcContentBlock[]),
                  Boolean(wr.is_error),
                );
              }
            }
          }
          return;
        }
        if (t === "system") {
          // FORK 2026-09-24 (A3): until this arm every `system` line stopped here unread, the
          // CLI's compaction included (F3a). The reader answers only the compaction lines; init
          // and the `requesting` status (the call tracker's, above) come back empty.
          if (runId) {
            for (const event of compactionLines.read(line)) {
              emitCompactionTelemetry({ runId, sessionKey: openclawSessionKey }, event);
              if (event.phase === "end") {
                lastCompactionEnd = event;
              }
            }
          }
          return;
        }
      };

      // FORK 2026-04-27: claude-cli's `-p` print mode tends to suppress
      // pre-tool narration even when the system prompt explicitly demands
      // it — the model treats print-mode runs as "execute tools quietly,
      // summarize once at the end." The user-message slot has much
      // stronger pull on output behaviour than `--append-system-prompt`,
      // so we append a short, named directive to every user turn. Keeps
      // the original prompt verbatim above the directive; cheap (~280
      // chars per turn) and survives compaction.
      const NARRATION_USER_DIRECTIVE = [
        "",
        "",
        CHAT_ROW_CONTRACT_MARKER,
        "Before EVERY tool call in your response, emit one assistant text",
        "sentence stating (a) the artifact (real file path or symbol or",
        "literal string searched) and (b) the question/move it serves —",
        "in plain language a non-engineer could follow. That sentence",
        "becomes the tool row's collapsed title in the chat UI; an empty",
        "narration leaves a useless wall of greps. Banned phrasings include",
        '"performing an action", "running a command", "reading a section',
        'of the code", "checking something", "applying a fix", or any bare',
        "verb without an object. Required for the FIRST tool call too —",
        "no silent kickoff.",
      ].join("\n");
      const userText = cliCommand === null ? rawUserText + NARRATION_USER_DIRECTIVE : cliCommand;
      // FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]; unprompted-turn.ts): a run a
      // worker's wake started. It takes the turn the CLI started on its own, below.
      const wakeId =
        cliCommand === null && !resumingTurn ? parseUnpromptedWakeMarker(rawUserText) : null;
      log.info(
        `turn start sessionKey=${sessionKey} userText.len=${userText.length} systemPrompt.len=${(context.systemPrompt ?? "").length}${cliCommand === null ? "" : ` cliCommand=${cliCommand.split(/\s/, 1)[0]}`}`,
      );

      // FORK 2026-04-19: emit `start` immediately so the UI thinking
      // indicator fires while claude is doing tool calls / thinking —
      // not just when text deltas arrive. Previously this was lazy,
      // meaning long tool-call chains (>60s of no text) left the UI
      // with no visible activity.
      pushStart();

      try {
        worker.on("stream_line", onStreamLine);
        // FORK (P4): mark this worker as the live turn for the session so a
        // mid-answer steered message folds into THIS turn via worker.steer
        // (live claude-cli stdin). Cleared in the finally whether send resolves
        // or throws — the steer window is exactly the duration of worker.send.
        if (openclawSessionId) {
          registerInflightWorker(openclawSessionId, worker);
        }
        let finalLine: Awaited<ReturnType<typeof worker.send>>;
        try {
          if (resumingTurn) {
            // FORK 2026-09-30 (L4b): replay the frozen turn from its start, then thaw it.
            markReattachClaimed(openclawSessionKey);
            const resumed = worker.resumeTurn({ signal: options?.signal });
            if (!continuation) {
              // The architect's own prompt reached this worker before recovery did: it joins the
              // resumed turn, as any prompt sent mid-turn does.
              const steered = worker.steer(userText);
              log.info(`[reattach] a new prompt joined the resumed turn (steered=${steered})`);
            }
            finalLine = await resumed;
          } else if (wakeId !== null) {
            // The CLI has already answered: it is sent nothing. The holder is this run's worker
            // unless the pool key moved since; then it is found by the turn's id.
            const holder =
              worker.unpromptedTurn?.()?.id === wakeId
                ? worker
                : (pool.findUnpromptedHolder?.(wakeId) ?? null);
            if (holder) {
              log.info(
                `[unprompted-turn] run ${runId ?? "?"} takes ${wakeId} sessionKey=${sessionKey}${holder === worker ? "" : ` (held by ${holder.sessionKey})`}`,
              );
              if (holder !== worker) {
                holder.on("stream_line", onStreamLine);
              }
              try {
                finalLine = await holder.takeUnpromptedTurn({
                  id: wakeId,
                  signal: options?.signal,
                });
              } finally {
                if (holder !== worker) {
                  holder.off("stream_line", onStreamLine);
                }
              }
            } else {
              log.warn(
                `[unprompted-turn] run ${runId ?? "?"}: ${wakeId} is gone (a prompt joined it, or its worker stopped); nothing sent to the CLI sessionKey=${sessionKey}`,
              );
              finalLine = {
                type: "result",
                subtype: "success",
                session_id: worker.sessionId ?? "",
                is_error: false,
                num_turns: 0,
                duration_ms: 0,
                result: UNPROMPTED_TURN_GONE_TEXT,
              };
            }
          } else {
            finalLine = await worker.send({
              userText,
              signal: options?.signal,
              // FORK 2026-10-01: recorded with the turn in meta.json, so that a restart's next
              // gateway can name the run this turn belonged to (resumedTurnFields above).
              ...(runId ? { runId } : {}),
            });
          }
        } finally {
          if (openclawSessionId) {
            unregisterInflightWorker(openclawSessionId, worker);
          }
        }
        worker.off("stream_line", onStreamLine);
        clearInterval(watchdog);
        clearInterval(heartbeat);

        pushStart();
        pushThinkingEnd();
        // FORK 2026-05-04 (truncation fix): pushTextEnd() used to fire HERE,
        // before the tail-recover reconciliation below. That caused the
        // text_end event (and the consumer's force=true block-chunker drain)
        // to land on the streamed-scratch text — typically a 100-byte
        // preamble — so when tail-recover later emitted text_delta with the
        // 2KB+ result_text, those late deltas arrived AFTER text_end.
        // Downstream embedded-agent-subscribe.handleMessageEnd then skipped the
        // safety re-send because lastBlockReplyText was already set, silently
        // dropping the actual answer. Now pushTextEnd() fires only after the
        // result is reconciled (lines below + the error path), so text_end
        // always carries the final accumulated text.

        const result = finalLine as CcStreamStdoutResult;
        const usage = buildUsage(result.usage);

        log.info(
          `turn result sessionKey=${sessionKey} subtype=${result.subtype} is_error=${result.is_error} num_turns=${result.num_turns} duration_ms=${result.duration_ms} output_tokens=${usage.output} final_text_len=${accumulatedText.length} result_text=${(result.result ?? "").slice(0, 500)}`,
        );
        // FORK 2026-06-11: fire the FINAL effort tuple ONCE here, where usage +
        // result are in scope and BEFORE the is_error early-return below — so
        // the terminal tuple lands on success AND on error/max-turns terminal
        // paths (the is_error arm returns early without reaching turn end).
        emitEffort(true, { output_tokens: usage.output, num_turns: result.num_turns });
        // FORK 2026-05-29 (truncation diagnostic): if the model stopped because
        // it hit the output-token ceiling, the answer is genuinely cut mid-
        // generation — distinct from a UI/display truncation. Surface it loudly
        // so the next "truncated" report is unambiguous. error_max_turns is the
        // agent-loop cap; a max_tokens stop is the per-message output cap.
        if (result.subtype === "error_max_turns") {
          log.warn(
            `TRUNCATION SUSPECT sessionKey=${sessionKey} hit agent-loop cap (error_max_turns) after ${result.num_turns} turns — answer may be cut. final_text_len=${accumulatedText.length}`,
          );
        }

        // FORK 2026-06-11: surface ANY non-success terminal subtype (e.g.
        // error_during_execution, error_max_turns, error) as a lifecycle
        // event so Tinker UI can badge the turn as incomplete instead of
        // silently rendering whatever partial text streamed. Mirrors the
        // runId-guard + emitAgentEvent(stream:"lifecycle") pattern from
        // emitTextBlockBreak. The is_error path below still emits a full
        // ErrorEnvelope; this also covers non-error-but-not-success subtypes.
        if (runId && result.subtype && result.subtype !== "success") {
          emitAgentEvent({
            runId,
            sessionKey: openclawSessionKey,
            stream: "lifecycle",
            data: { phase: "turn-incomplete", subtype: result.subtype },
          });
        }

        // On provider error (e.g. 401 auth, 400 billing), build a structured
        // ErrorEnvelope and emit it as the ONLY text of the turn. Previous
        // implementation appended the envelope to any claude-streamed error
        // prose, which meant the envelope wasn't at position 0 and the UI's
        // startsWith check missed it; the text then rendered as markdown,
        // which stripped the `__ERR_ENV__` underscores as emphasis syntax.
        // Now we RESET accumulated text and emit a clean final message.
        if (result.is_error && typeof result.result === "string" && result.result.trim()) {
          const rawErr = result.result.trim();
          // FORK 2026-08-28 — this path returns BEFORE the tail-recover
          // reconciliation below and deliberately REPLACES accumulatedText with
          // the envelope, so no recovery is possible or wanted here. Log the
          // verdict anyway: "one [tail-recover] line per turn that reached a
          // result" is what makes `grep -c '[tail-recover]'` a real denominator
          // instead of a count silently missing every error turn. Logged before
          // the reset below, so `streamed` is the real streamed length.
          log.info(
            `[tail-recover] verdict=error-envelope streamed=${accumulatedText.length} result=${rawErr.length} append=0 sessionKey=${sessionKey}`,
          );
          const envelope = buildErrorEnvelope({
            raw: rawErr,
            sessionKey,
            llm: {
              provider: modelInfo.provider,
              model: modelInfo.id,
              durationMs: result.duration_ms,
            },
          });
          accumulatedText = `__ERR_ENV__:${JSON.stringify(envelope)}`;
          accumulatedThinking = "";
          const finalMessage: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: accumulatedText }],
            stopReason: "stop",
            api: modelInfo.api,
            provider: modelInfo.provider,
            model: modelInfo.id,
            usage,
            timestamp: Date.now(),
          };
          // pi-agent-core honors the finalMessage from a "done" event and
          // replaces any partial streamed content with it. No need to keep
          // flushing text_start/end events — the message_end event drives
          // the UI's final render.
          pushTextEnd();
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          return;
        }

        // FORK 2026-04-27: claude-cli's stream emits a `result` line at the
        // end of every successful turn with `result_text` containing the
        // FULL final assistant output. In dense tool chains the post-tool
        // summary often arrives only via this `result_text` and never
        // appears as a separate `assistant.content` text block — so the
        // streamed `accumulatedText` ends at the preamble (~120 chars)
        // while `result.result` carries the actual answer (1KB+ or more).
        //
        // FORK 2026-08-28 — the decision now lives in `classifyTailRecover`
        // (pure, unit-tested, append-only) and the verdict is ALWAYS logged. The
        // old inline version had two arms and NO else, so on a tool-loop turn —
        // where `accumulatedText` is every step's narration concatenated and is
        // LONGER than the final answer — it fell through in silence: 130
        // completed turns in a 5h window, `grep -c 'tail-recover'` = 0. The added
        // `missing` arm is the one that matters: it appends `result.result` when
        // the answer's head appears NOWHERE in what we streamed. `result.result`
        // is claude-cli's own final text, independent of every accumulator bug
        // upstream of it, which is why this is the right place for the net.
        // Nothing is ever dropped or capped here — the only actions are "append"
        // and "do nothing".
        const resTxt = typeof result.result === "string" ? result.result : "";
        // FORK 2026-09-25 (context-window-panel.md §6.1 A6 (i)): a command turn answers with ONE
        // line built from what the CLI reported (describeCliCommandOutcome), never with nothing.
        // A text-less `stop` message is an EMPTY RESPONSE to the embedded runner
        // (src/agents/embedded-agent-runner/run/incomplete-turn.ts): it re-prompts the model to
        // "produce the visible answer now", a full turn on the context that was just compacted,
        // and then shows "Agent couldn't generate a response". Append-only, like every other
        // verdict here: whatever the CLI streamed stays.
        const cliOutcome =
          cliCommand === null
            ? null
            : describeCliCommandOutcome({
                command: cliCommand,
                compaction: lastCompactionEnd,
                resultText: resTxt,
                isError: result.is_error === true,
              });
        const tailRecover =
          cliOutcome === null
            ? classifyTailRecover({ streamed: accumulatedText, result: resTxt })
            : {
                verdict: "cli-command" as const,
                append: accumulatedText ? `\n\n${cliOutcome}` : cliOutcome,
              };
        // UNCONDITIONAL: one line per turn that reached a result, so "it did
        // nothing" is a RECORDED verdict rather than an absence of evidence.
        // Do not put this behind an `if` — that is exactly how the old net
        // managed to be inert for 130 turns without anyone noticing.
        log.info(
          `[tail-recover] verdict=${tailRecover.verdict} streamed=${accumulatedText.length} result=${resTxt.length} append=${tailRecover.append.length} sessionKey=${sessionKey}`,
        );
        if (tailRecover.verdict === "missing") {
          log.warn(
            `[tail-recover] WARN final answer absent from the stream — appending result.result sessionKey=${sessionKey} streamed=${accumulatedText.length} result=${resTxt.length} head.sample=${JSON.stringify(resTxt.slice(0, 60).replace(/\n/g, "↵"))}`,
          );
        }
        if (tailRecover.append) {
          pushTextDelta(tailRecover.append, `tail_recover_${tailRecover.verdict}`);
        }

        const finalMessage: AssistantMessage = {
          role: "assistant",
          content: buildContent(),
          stopReason: "stop",
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage,
          timestamp: Date.now(),
        };
        // FORK 2026-09-29 (bible tinker-ui.md §5.8AB): a refusal keeps stopReason "stop" on
        // purpose. "error" would engage the runner's failover and channel error formatting,
        // and a refusal must surface, not fail over. It rides as a typed `outcome`, which the
        // history projection keeps and the UI renders as a refusal notice.
        if (lastTopLevelStopReason === "refusal") {
          Object.assign(finalMessage, { outcome: bridgeRefusalOutcome() });
          log.info(`[outcome] refusal sessionKey=${sessionKey}`);
        }
        // FORK 2026-10-02 (channel-reply): a chat channel gets the answer, never the narration
        // the contract has the model write before each tool. The text stays whole here (Tinker
        // slices it at the offsets); the stamp tells the runner which part to deliver. One log
        // line per chat-channel turn, so a `source=empty-final-segment` case can be counted.
        if (isChatChannelRun(messageChannel)) {
          const decision = decideChannelReply({
            text: accumulatedText,
            toolTextOffsets: [...toolTextOffsets.values()],
          });
          const line = `[channel-reply] verdict=${decision.verdict} source=${decision.source} channel=${messageChannel} tools=${toolTextOffsets.size} narration=${decision.narrationChars} final=${decision.finalChars} sessionKey=${openclawSessionKey ?? sessionKey}`;
          if (decision.source === "empty-final-segment") {
            log.warn(line);
          } else {
            log.info(line);
          }
          if (decision.stamp) {
            Object.assign(finalMessage, { channelReply: decision.stamp });
          }
        }

        if (log.debug) {
          log.debug(
            `emit done reason=stop content.len=${finalMessage.content.length} text_block=${finalMessage.content.some((c) => (c as { type?: string }).type === "text")}`,
          );
        }
        pushTextEnd();
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      } catch (err) {
        worker.off("stream_line", onStreamLine);
        clearInterval(watchdog);
        clearInterval(heartbeat);
        const rawErr = formatErrorMessage(err);
        log.error(
          `claude-code turn failed after ${Math.round((Date.now() - turnStartedAt) / 1000)}s (${linesSeen} stream lines, text.len=${accumulatedText.length}, thinking.len=${accumulatedThinking.length}): ${rawErr}`,
        );
        // Same envelope-as-text trick as the is_error path: deliver the
        // error as a normal assistant turn carrying the __ERR_ENV__ sentinel
        // so the UI can render it as a red (or orange if recoverable) bubble
        // with full detail instead of a generic "Agent couldn't generate a
        // response" incomplete-turn banner.
        //
        // FORK 2026-09-03 (SIGTERM cause attribution): `rawErr` is the worker's
        // exit message and carries `reason=[<abort cause>]`
        // (worker.ts::onExit). buildErrorEnvelope classifies the SIGTERM from
        // that cause, so a user Stop, an idle timeout, the run deadline, a
        // fast-fail stall and a real gateway restart no longer collapse into one
        // (mostly false) "Gateway restarted — I'm resuming it automatically"
        // bubble. Nothing extra to pass here — do NOT strip, truncate or
        // reformat `rawErr` on its way in, or the cause is lost.
        const envelope = buildErrorEnvelope({
          raw: rawErr,
          sessionKey,
          llm: {
            provider: modelInfo.provider,
            model: modelInfo.id,
          },
        });
        pushStart();
        pushTextStart();
        const envelopeText = `__ERR_ENV__:${JSON.stringify(envelope)}`;
        accumulatedText += envelopeText;
        stream.push({
          type: "text_delta",
          contentIndex: textIndex(),
          delta: envelopeText,
          partial: buildPartial(),
        });
        pushTextEnd();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: buildContent(),
            stopReason: "stop",
            api: modelInfo.api,
            provider: modelInfo.provider,
            model: modelInfo.id,
            usage: buildUsage(undefined),
            timestamp: Date.now(),
          },
        });
      } finally {
        // FORK 2026-09-24 (A8): end a call still open here (an abort, a thrown send, a stream with
        // no message_delta) so no timeline block is left growing. A no-op after a `result` line.
        callTelemetry.close();
        // FORK 2026-05-11: matching lifecycle:end so the TUI's activeRuns
        // entry is evicted (sessions / model / prefrontal panels go idle).
        if (runId) {
          emitAgentEvent({
            runId,
            sessionKey: openclawSessionKey,
            stream: "lifecycle",
            data: {
              phase: "end",
              endedAt: Date.now(),
              model: model.id,
              modelProvider: model.provider,
              sessionKey: openclawSessionKey,
            },
          });
        }
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export const _debug = { PROVIDER_ID };
