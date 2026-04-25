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

// FORK 2026-04-20: derive a stable per-session worker-pool key from the
// system prompt. The OpenClaw `createStreamFn` ctx doesn't expose the active
// session key, and `opts.sessionKey` was always undefined (the previous code
// in index.ts read a non-existent field off `model`). Every call fell back
// to the literal "agent:main:main", so 3 parallel subagents collapsed onto
// ONE worker -- they queued serially and two hung forever waiting for the
// third. Main Jarvis has a ~32KB persona/amygdala/fractal prompt; each
// subagent has a shorter task-embedded prompt. Hashing the prompt keeps
// workers distinct per session across turns while staying cheap.
function deriveSessionKey(explicit: string | undefined, systemPrompt: string | undefined): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  if (!systemPrompt || !systemPrompt.trim()) {
    return "agent:main:main";
  }
  // djb2 hash -- 8 hex chars is plenty for a handful of concurrent sessions.
  let h = 5381;
  for (let i = 0; i < systemPrompt.length; i++) {
    h = ((h << 5) + h + systemPrompt.charCodeAt(i)) | 0;
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
      const sessionKey = deriveSessionKey(opts.sessionKey, context.systemPrompt);

      // FORK (2026-04-24): OpenClaw's embedded runner smuggles the current
      // run's identity into options via `__openclawRunId` / `__openclawSessionKey`
      // (see `src/agents/pi-embedded-runner/run/attempt.ts`). We use them to
      // attribute live `stream: "tool"` agent events to the right run so the
      // UI can render tool calls with purpose titles + expandable output —
      // without putting toolCall blocks in the assistant message (which would
      // trigger re-execution through the prefrontal exec gate).
      const pipedOptions = (options ?? {}) as {
        __openclawRunId?: string;
        __openclawSessionKey?: string;
      };
      const runId = pipedOptions.__openclawRunId;
      const openclawSessionKey = pipedOptions.__openclawSessionKey;
      const toolLastNarration = new Map<string, string>();
      let pendingToolNarration = "";

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
      });

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
      };

      const pushThinkingDelta = (delta: string) => {
        pushStart();
        pushThinkingStart();
        accumulatedThinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: buildPartial() });
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
          const blocks = (line as CcStreamStdoutAssistantMessage).message?.content ?? [];
          for (const b of blocks) {
            const typed = b as CcContentBlock;
            if (typed.type === "text" && typeof typed.text === "string") {
              const cumulative = typed.text;
              if (
                cumulative.startsWith(accumulatedText) &&
                cumulative.length > accumulatedText.length
              ) {
                const delta = cumulative.slice(accumulatedText.length);
                pushTextDelta(delta);
                // FORK (2026-04-24): capture the delta as "pending narration"
                // — Jarvis writes one short purpose sentence right before a
                // tool_use, and we feed it into the emitted tool-start event
                // so the UI can use it as the row's one-line title.
                pendingToolNarration += delta;
              } else if (cumulative.length > 0 && !accumulatedText) {
                pushTextDelta(cumulative);
                pendingToolNarration += cumulative;
              }
            } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
              const cumulative = typed.thinking;
              if (
                cumulative.startsWith(accumulatedThinking) &&
                cumulative.length > accumulatedThinking.length
              ) {
                const delta = cumulative.slice(accumulatedThinking.length);
                pushThinkingDelta(delta);
              } else if (cumulative.length > 0 && !accumulatedThinking) {
                pushThinkingDelta(cumulative);
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

      const userText = extractUserText(context.messages ?? []);
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

        pushStart();
        pushThinkingEnd();
        pushTextEnd();

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
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          return;
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
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      } catch (err) {
        worker.off("stream_line", onStreamLine);
        clearInterval(watchdog);
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
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export const _debug = { PROVIDER_ID };
