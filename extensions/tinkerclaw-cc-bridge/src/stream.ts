/**
 * FORK: tinkerclaw-cc-bridge — OpenClaw StreamFn.
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
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { buildErrorEnvelope } from "../../../src/fork/error-envelope.js";
import { emitAgentEvent } from "../../../src/infra/agent-events.js";
import {
  DEFAULT_CWD,
  DEFAULT_DISALLOWED_TOOLS,
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
import { thinkLevelToMaxThinkingTokens } from "./thinking-budget.js";
import { recordToolEvent } from "./tool-buffer.js";
import { getPool } from "./worker-pool.js";
import type { WorkerEvent } from "./worker.js";

const log = createSubsystemLogger("tinkerclaw-cc-bridge");

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
// Exported so the sibling cc-bridge test unit can exercise it directly.
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
// the cc-bridge key was the same → same worker → same `--resume <oldId>`
// → claude-cli's memory survived a "session reset". That broke the bible
// §5.5 contract that /new and /clear should reset BOTH the UI and the
// underlying context.
//
// Fix: hash the OpenClaw sessionId into the key. Now a reset that mints
// a new sessionId yields a new cc-bridge key, which the worker pool
// treats as a brand-new session (no `--resume`, no inherited context).
// The old map entry under the previous hash is left behind as orphaned
// state — `getResumeSessionId` will never look it up again because no
// future request will derive that same key. Cheap; no explicit cleanup
// needed for now.
function deriveSessionKey(
  explicit: string | undefined,
  systemPrompt: string | undefined,
  openclawSessionId: string | undefined,
): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const promptPart = systemPrompt ?? "";
  const idPart = openclawSessionId ?? "";
  if (!promptPart && !idPart) {
    return "agent:main:main";
  }
  // djb2 hash over `${systemPrompt}\u0001${sessionId}` — the SOH separator
  // keeps a 32KB persona prompt with a colliding hash from being mistaken
  // for a 32KB persona prompt with a different sessionId.
  let h = 5381;
  const combined = `${promptPart}\u0001${idPart}`;
  for (let i = 0; i < combined.length; i++) {
    h = ((h << 5) + h + combined.charCodeAt(i)) | 0;
  }
  return `cc-sp-${(h >>> 0).toString(16).padStart(8, "0")}`;
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
      // the cc-bridge worker pool — without it the systemPrompt-only hash
      // kept the same `--resume` session alive across resets.
      const pipedOptions = (options ?? {}) as {
        __openclawRunId?: string;
        __openclawSessionKey?: string;
        __openclawSessionId?: string;
        __openclawThinkLevel?: string;
      };
      const runId = pipedOptions.__openclawRunId;
      const openclawSessionKey = pipedOptions.__openclawSessionKey;
      const openclawSessionId = pipedOptions.__openclawSessionId;
      // FORK 2026-06-11: per-run think level smuggled through pi-ai options
      // (mirrors the other __openclaw* fields). The cast is untyped, so this
      // name must match the writer EXACTLY or it silently flatlines.
      const thinkLevel = pipedOptions.__openclawThinkLevel;
      const sessionKey = deriveSessionKey(opts.sessionKey, context.systemPrompt, openclawSessionId);
      // FORK 2026-06-11: per-call EFFORT truth-tuple stream. Computed
      // server-side so it reports the same facts at EVERY UI level (incl
      // Auto), independent of whether the client requested thinking. The
      // configured budget mirrors worker.ts:628-630 — the actual
      // MAX_THINKING_TOKENS the worker pins for this run (undefined for
      // off/unset → reported as 0). `hadRealThinking` distinguishes a genuine
      // reasoning stream from the lone "[redacted reasoning]" placeholder
      // (≤18 chars) pushed by the redacted_thinking arm.
      const configuredBudget = thinkLevelToMaxThinkingTokens(
        thinkLevel,
        maxOutputTokensFor(model.id),
      );
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
        emitAgentEvent({
          runId,
          sessionKey: openclawSessionKey,
          stream: "effort",
          data: {
            phase: final ? "final" : "live",
            thinkLevel: thinkLevel ?? "off",
            configuredBudget: configuredBudget ?? 0,
            thinkingChars: accumulatedThinking.length,
            hadRealThinking:
              accumulatedThinking.length > 0 &&
              !(sawRedactedThinking && accumulatedThinking.length <= 18),
            redacted: sawRedactedThinking,
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
      const blockTextSeen = new Map<number, string>();
      const blockThinkingSeen = new Map<number, string>();

      // FORK 2026-05-28 — per-turn text-block index tracker. Anthropic's
      // streaming API guarantees `content_block_delta.index` and every text
      // block in `assistant.message.content` carries an array position.
      // When the index advances between text deltas (typically a tool_use
      // block fired between two pieces of prose), emit a lifecycle event so
      // Tinker UI splits the streaming bubble. Same mechanism as the
      // tool_use trigger at app.ts:2396, but earlier on the timeline (the
      // pre-tool narration becomes its own bubble instead of piling into
      // one with all subsequent narrations).
      let activeTextBlockIndex: number | null = null;
      const emitTextBlockBreak = (fromIndex: number | null, toIndex: number) => {
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
          },
        });
      };

      const emitToolStart = (
        toolCallId: string,
        name: string,
        args: unknown,
        narration: string,
      ) => {
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
            // FORK 2026-06-07 (Phase 1a): mark cc-bridge tool starts so the
            // learned-intuition plugin runs the REAL prudence ensemble on them.
            ccBridge: true,
          },
        });
        // FORK 2026-06-07 (Phase 1a): the per-tool gate decision is now produced by
        // the learned-intuition plugin (it owns the ONNX prudence nets). It subscribes
        // to the `ccBridge` tool-start event emitted just above, runs the REAL ensemble,
        // and emits + persists the amygdala-decision. The rule-based stand-in lived here.
        // FORK 2026-04-25: also buffer the event so onTurnComplete can persist
        // it as a `customType: "cc-bridge-tool"` entry. Without this, history
        // reload in Tinker shows only the user prompt + 64-char opener.
        recordToolEvent(runId, {
          phase: "start",
          toolCallId,
          name,
          args: argsRecord,
          purpose: narration || undefined,
          startedAt: Date.now(),
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
        thinkLevel,
        // FORK 2026-05-10: thread the openclaw agent sessionId through so
        // session-map can index by it for the across-restart resume path.
        openclawSessionId,
        // FORK 2026-05-30: thread the CANONICAL openclaw session key
        // (`agent:main:main`) so the worker can export it as TC_SESSION_KEY
        // for the jarvis voice gate + chat.inject routing (see worker.ts).
        openclawSessionKey,
      });

      // FORK 2026-05-11: emit lifecycle:start so the TUI's activeRuns map
      // picks up this run and renders the thinking indicator + side panels
      // (sessions, model, prefrontal). Without this, cc-bridge runs only
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
          parts.push({ type: "thinking", thinking: accumulatedThinking });
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

      const pushThinkingDelta = (delta: string) => {
        pushStart();
        pushThinkingStart();
        accumulatedThinking += delta;
        emitEffort(false);
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
        // sessionKey=cc-sp-4b620f70). Catch it here at the actual push site
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
        accumulatedText += delta;
        log.info(
          `[duprep] text_delta source=${source} sessionKey=${sessionKey} contentIndex=${textIndex()} delta.len=${delta.length} accumulated.len=${accumulatedText.length} preview=${JSON.stringify(previewDelta(delta))}`,
        );
        // FORK 2026-05-25 (revised 2026-05-26) — duplicate-delta detector.
        // Original version sliced only the LAST (head.length + 40) chars of
        // the accumulator and missed the common case where the duplicate
        // starts at position 0 of the accumulator (model regenerated the
        // whole opening sentence). Revised: scan the FULL pre-append
        // accumulator for the delta's 60-char head. If found, the same
        // content was already streamed — WARN. The 2026-05-28 BLOCKED guard
        // above now drops the cumulative-source variant outright; this
        // detector remains active to cover any other source (e.g. duplicated
        // content_block_delta payloads from upstream) for diagnostic
        // visibility without false-positive dropping.
        if (delta.length >= 60) {
          const head = delta.slice(0, 60);
          const tail = accumulatedText.slice(0, accumulatedText.length - delta.length);
          if (tail.length >= 60 && tail.includes(head)) {
            log.warn(
              `[duprep] WARN duplicate delta detected — head already in accumulator sessionKey=${sessionKey} source=${source} delta.len=${delta.length} head.sample=${JSON.stringify(head.replace(/\n/g, "↵"))}`,
            );
          }
        }
        stream.push({
          type: "text_delta",
          contentIndex: textIndex(),
          delta,
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
      const turnStartedAt = Date.now();
      let linesSeen = 0;
      let lastProgressLogAt = 0;
      let lastLineAt = turnStartedAt;
      const watchdog = setInterval(() => {
        const silentMs = Date.now() - lastLineAt;
        if (silentMs > 45_000) {
          log.warn(
            `claude silent for ${Math.round(silentMs / 1000)}s (sessionKey=${sessionKey}, lines=${linesSeen}, text.len=${accumulatedText.length}, thinking.len=${accumulatedThinking.length})`,
          );
        }
      }, 45_000);

      // FORK 2026-05-11: pi-ai idle-timer heartbeat (closes brainstorm item #5).
      //
      // Why this exists: cc-bridge intentionally suppresses tool_use stream
      // events to pi-ai (FORK 2026-04-22, see tool-loop.md — forwarding them
      // would re-execute via OpenClaw's exec tool). During long claude-cli
      // tool chains this means pi-agent-core's `streamWithIdleTimeout` sees
      // NO events for the duration of the tool work and SIGTERMs the run
      // at the idle threshold. Mitigation today is provider-level
      // `timeoutSeconds: 600` from the cc-bridge plugin overlay
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
        handleLine(line);
      };

      const handleLine = (line: CcStreamStdoutLine) => {
        const t = (line as { type?: string }).type;
        if (t === "stream_event") {
          const ev = (line as CcStreamStdoutStreamEvent).event;
          if (!ev) {
            return;
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
            if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
              if (activeTextBlockIndex !== null && activeTextBlockIndex !== blockIndex) {
                emitTextBlockBreak(activeTextBlockIndex, blockIndex);
              }
              activeTextBlockIndex = blockIndex;
              pushTextDelta(ev.delta.text, "content_block_delta");
              const prev = blockTextSeen.get(blockIndex) ?? "";
              blockTextSeen.set(blockIndex, prev + ev.delta.text);
            } else if (
              ev.delta.type === "thinking_delta" &&
              typeof ev.delta.thinking === "string"
            ) {
              pushThinkingDelta(ev.delta.thinking);
              const prev = blockThinkingSeen.get(blockIndex) ?? "";
              blockThinkingSeen.set(blockIndex, prev + ev.delta.thinking);
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
          const blocks = (line as CcStreamStdoutAssistantMessage).message?.content ?? [];
          for (let bi = 0; bi < blocks.length; bi++) {
            const typed = blocks[bi] as CcContentBlock;
            if (typed.type === "text" && typeof typed.text === "string") {
              const cumulative = typed.text;
              const prev = blockTextSeen.get(bi) ?? "";
              if (cumulative.length > prev.length && cumulative.startsWith(prev)) {
                const delta = cumulative.slice(prev.length);
                // FORK 2026-05-26 (task-mpkw1a0b-9jsfy "Response rendering"):
                // duplicate-emit guard. Claude-cli's `assistant` cumulative
                // message has been observed (sessionKey=cc-sp-1b6f2ca4 logs
                // at 11:29:16) emitting cumulative=2*prev — the SAME 217-char
                // block re-appended onto its prior 217-char self. The slice
                // computation then yields a 217-char delta that's a verbatim
                // copy of prev's content, and pushTextDelta doubles the
                // bubble. Detect via a 60-char prefix match: if the proposed
                // delta's first 60 chars equal prev's first 60 chars (both
                // long enough to be unique-by-content), DROP the delta and
                // still advance blockTextSeen so we don't re-encounter the
                // same condition on the next assistant emit. Soft fix at the
                // cc-bridge layer; the upstream SDK quirk persists but no
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
                  blockTextSeen.set(bi, cumulative);
                  continue;
                }
                // First-ever delta of a NEW non-zero block index means the
                // model has just resumed emitting text after a tool_use
                // chain — clear pending narration so the post-tool prose
                // doesn't get attributed to a stale upcoming tool.
                if (bi > 0 && prev === "") {
                  pendingToolNarration = "";
                  // FORK 2026-05-28 — same boundary, also fire the bubble
                  // break for the UI. Covers the path where claude-cli's
                  // cumulative `assistant` message arrives without prior
                  // fine-grained content_block_delta events (block index
                  // advances only via this loop iteration).
                  if (activeTextBlockIndex !== null && activeTextBlockIndex !== bi) {
                    emitTextBlockBreak(activeTextBlockIndex, bi);
                  }
                  activeTextBlockIndex = bi;
                }
                pushTextDelta(delta, "assistant_cumulative");
                pendingToolNarration += delta;
                blockTextSeen.set(bi, cumulative);
              }
            } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
              const cumulative = typed.thinking;
              const prev = blockThinkingSeen.get(bi) ?? "";
              if (cumulative.length > prev.length && cumulative.startsWith(prev)) {
                const delta = cumulative.slice(prev.length);
                pushThinkingDelta(delta);
                blockThinkingSeen.set(bi, cumulative);
              }
            } else if ((typed.type as string) === "redacted_thinking") {
              // FORK 2026-06-11: extended-thinking blocks that the API redacts
              // arrive as `redacted_thinking` with no readable `thinking`
              // field. Surface a single placeholder so the reasoning bubble
              // isn't silently empty. Gate on blockThinkingSeen so cumulative
              // re-emits of the same assistant message push it only ONCE per
              // block index — same dedupe contract as the `thinking` arm.
              if (!blockThinkingSeen.has(bi)) {
                sawRedactedThinking = true;
                pushThinkingDelta("[redacted reasoning]");
                blockThinkingSeen.set(bi, "[redacted reasoning]");
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
      };

      const rawUserText = extractUserText(context.messages ?? []);
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
        "<!-- TINKERCLAW chat-row contract -->",
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
      const userText = rawUserText + NARRATION_USER_DIRECTIVE;
      log.info(
        `turn start sessionKey=${sessionKey} userText.len=${userText.length} systemPrompt.len=${(context.systemPrompt ?? "").length}`,
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
          finalLine = await worker.send({
            userText,
            signal: options?.signal,
          });
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
        // Reconcile against `result.result`:
        //   - If `result.result.startsWith(accumulatedText)` → emit the tail
        //     as deltas so live UIs catch up. Common case: stream missed the
        //     post-tool block but the result line includes everything.
        //   - Else if streamed length is much shorter (< 50% of result),
        //     the streams diverged; trust `result.result` as the truth and
        //     replace. Live UI sees a corrective delta.
        //   - Else leave the streamed accumulation alone (likely matches).
        if (typeof result.result === "string" && result.result.length > 0) {
          const resTxt = result.result;
          const streamedLen = accumulatedText.length;
          if (resTxt.length > streamedLen && resTxt.startsWith(accumulatedText)) {
            const tail = resTxt.slice(streamedLen);
            log.info(
              `tail-recover: streamed ${streamedLen}B, result_text ${resTxt.length}B, recovering ${tail.length}B (prefix-match)`,
            );
            pushTextDelta(tail, "tail_recover_prefix");
          } else if (resTxt.length > streamedLen * 2 + 50) {
            // Streams diverged enough to suggest the streamed accumulation
            // is just the preamble; replace with the result line.
            log.info(
              `tail-recover: streamed ${streamedLen}B, result_text ${resTxt.length}B, replacing (diverged)`,
            );
            // Compute "what to push so accumulated == result_text". Simplest:
            // push the difference as a fresh delta after a separator, but if
            // accumulated text was just an opener it's cleaner to overwrite.
            // pi-agent-core consumers honor whatever `accumulatedText` we
            // pass into buildContent + the final `done` message, so reset
            // the stored value directly here.
            const overwriteDelta = streamedLen > 0 ? `\n\n${resTxt}` : resTxt;
            pushTextDelta(overwriteDelta, "tail_recover_diverged");
          }
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
