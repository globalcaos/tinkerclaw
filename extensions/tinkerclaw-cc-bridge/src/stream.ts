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
import { DEFAULT_CWD, DEFAULT_DISALLOWED_TOOLS, PROVIDER_ID } from "./defaults.js";
import type {
  CcContentBlock,
  CcStreamStdoutAssistantMessage,
  CcStreamStdoutLine,
  CcStreamStdoutResult,
  CcStreamStdoutStreamEvent,
  CcStreamStdoutUserMessage,
  CcUsage,
} from "./protocol.js";
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
      // (see `src/agents/pi-embedded-runner/run/attempt.ts`). The runId +
      // sessionKey attribute live `stream:"tool"` agent events so the UI
      // can render tool bubbles with purpose titles. The sessionId is used
      // BELOW in `deriveSessionKey` to make /new and /reset cascade into
      // the cc-bridge worker pool — without it the systemPrompt-only hash
      // kept the same `--resume` session alive across resets.
      const pipedOptions = (options ?? {}) as {
        __openclawRunId?: string;
        __openclawSessionKey?: string;
        __openclawSessionId?: string;
      };
      const runId = pipedOptions.__openclawRunId;
      const openclawSessionKey = pipedOptions.__openclawSessionKey;
      const openclawSessionId = pipedOptions.__openclawSessionId;
      const sessionKey = deriveSessionKey(opts.sessionKey, context.systemPrompt, openclawSessionId);
      const toolLastNarration = new Map<string, string>();
      let pendingToolNarration = "";
      // FORK 2026-04-27: per-block-index cumulative state so each text /
      // thinking block in `assistant.message.content` accumulates
      // independently. Without this, a post-tool text block would be
      // dropped because its content does not prefix the preamble's text.
      const blockTextSeen = new Map<number, string>();
      const blockThinkingSeen = new Map<number, string>();

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
          },
        });
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
        // FORK 2026-05-10: thread the openclaw agent sessionId through so
        // session-map can index by it for the across-restart resume path.
        openclawSessionId,
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
        stream.push({
          type: "text_end",
          contentIndex: textIndex(),
          content: accumulatedText,
          partial: buildPartial(),
        });
        recordPush();
      };

      const pushThinkingDelta = (delta: string) => {
        pushStart();
        pushThinkingStart();
        accumulatedThinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: buildPartial() });
        recordPush();
      };

      const pushTextDelta = (delta: string) => {
        pushStart();
        if (thinkingStarted) {
          pushThinkingEnd();
        }
        pushTextStart();
        accumulatedText += delta;
        if (log.debug) {
          log.debug(
            `emit text_delta contentIndex=${textIndex()} delta.len=${delta.length} accumulated.len=${accumulatedText.length}`,
          );
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
            if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
              pushTextDelta(ev.delta.text);
            } else if (
              ev.delta.type === "thinking_delta" &&
              typeof ev.delta.thinking === "string"
            ) {
              pushThinkingDelta(ev.delta.thinking);
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
                // First-ever delta of a NEW non-zero block index means the
                // model has just resumed emitting text after a tool_use
                // chain — clear pending narration so the post-tool prose
                // doesn't get attributed to a stale upcoming tool.
                if (bi > 0 && prev === "") {
                  pendingToolNarration = "";
                }
                pushTextDelta(delta);
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
              const resultText =
                typeof typed.content === "string"
                  ? typed.content
                  : Array.isArray(typed.content)
                    ? typed.content
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
              emitToolResult(typed.tool_use_id, resultText, Boolean(typed.is_error));
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
        const finalLine = await worker.send({
          userText,
          signal: options?.signal,
        });
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
        // Downstream pi-embedded-subscribe.handleMessageEnd then skipped the
        // safety re-send because lastBlockReplyText was already set, silently
        // dropping the actual answer. Now pushTextEnd() fires only after the
        // result is reconciled (lines below + the error path), so text_end
        // always carries the final accumulated text.

        const result = finalLine as CcStreamStdoutResult;
        const usage = buildUsage(result.usage);

        log.info(
          `turn result sessionKey=${sessionKey} subtype=${result.subtype} is_error=${result.is_error} num_turns=${result.num_turns} duration_ms=${result.duration_ms} result_text=${(result.result ?? "").slice(0, 500)}`,
        );

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
            pushTextDelta(tail);
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
            pushTextDelta(overwriteDelta);
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
