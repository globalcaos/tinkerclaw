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
import { DEFAULT_CWD, DEFAULT_DISALLOWED_TOOLS, PROVIDER_ID } from "./defaults.js";
import type {
  CcContentBlock,
  CcStreamStdoutAssistantMessage,
  CcStreamStdoutLine,
  CcStreamStdoutResult,
  CcStreamStdoutStreamEvent,
  CcUsage,
} from "./protocol.js";
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

export function createClaudeCodeStreamFn(opts: CreateStreamFnInput = {}): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      const modelInfo = { api: model.api, provider: model.provider, id: model.id };
      const cwd = opts.cwd ?? DEFAULT_CWD;
      const disallowedTools = opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
      const sessionKey = opts.sessionKey ?? "agent:main:main";

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
        log.info(`emit start content.len=${p.content.length}`);
        stream.push({ type: "start", partial: p });
      };
      const pushThinkingStart = () => {
        if (thinkingStarted) {
          return;
        }
        thinkingStarted = true;
        log.info(`emit thinking_start`);
        stream.push({ type: "thinking_start", contentIndex: 0, partial: buildPartial() });
      };
      const pushThinkingEnd = () => {
        if (!thinkingStarted || thinkingEnded) {
          return;
        }
        thinkingEnded = true;
        log.info(`emit thinking_end content.len=${accumulatedThinking.length}`);
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
        log.info(`emit text_start contentIndex=${textIndex()}`);
        stream.push({ type: "text_start", contentIndex: textIndex(), partial: buildPartial() });
      };
      const pushTextEnd = () => {
        if (!textStarted || textEnded) {
          return;
        }
        textEnded = true;
        log.info(`emit text_end contentIndex=${textIndex()} content.len=${accumulatedText.length}`);
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
        log.info(
          `emit text_delta contentIndex=${textIndex()} delta.len=${delta.length} accumulated.len=${accumulatedText.length}`,
        );
        stream.push({
          type: "text_delta",
          contentIndex: textIndex(),
          delta,
          partial: buildPartial(),
        });
      };

      const onStreamLine = (evt: WorkerEvent) => {
        if (evt.type !== "stream_line") {
          return;
        }
        const line = evt.line;
        if (!line || typeof line !== "object") {
          return;
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
          // claude --verbose stream-json emits whole-block assistant messages
          // rather than per-token deltas. Turn each non-empty block into one
          // delta. Empty-string thinking blocks (claude's signed-but-empty
          // extended-thinking marker) are skipped — emitting zero-length
          // thinking events confuses pi-agent-core's attempt reader.
          const blocks = (line as CcStreamStdoutAssistantMessage).message?.content ?? [];
          for (const b of blocks) {
            const typed = b as CcContentBlock;
            if (
              typed.type === "text" &&
              typeof typed.text === "string" &&
              typed.text.length > 0 &&
              !accumulatedText
            ) {
              pushTextDelta(typed.text);
            } else if (
              typed.type === "thinking" &&
              typeof typed.thinking === "string" &&
              typed.thinking.length > 0 &&
              !accumulatedThinking
            ) {
              pushThinkingDelta(typed.thinking);
            }
          }
        }
      };

      const userText = extractUserText(context.messages ?? []);
      log.info(
        `turn start sessionKey=${sessionKey} userText.len=${userText.length} systemPrompt.len=${(context.systemPrompt ?? "").length}`,
      );

      try {
        worker.on("stream_line", onStreamLine);
        const finalLine = await worker.send({
          userText,
          signal: options?.signal,
        });
        worker.off("stream_line", onStreamLine);

        pushStart();
        pushThinkingEnd();
        pushTextEnd();

        const result = finalLine as CcStreamStdoutResult;
        const usage = buildUsage(result.usage);
        const stopReason: StopReason = result.is_error ? "error" : "stop";

        log.info(
          `turn result sessionKey=${sessionKey} subtype=${result.subtype} is_error=${result.is_error} num_turns=${result.num_turns} duration_ms=${result.duration_ms} result_text=${(result.result ?? "").slice(0, 500)}`,
        );

        const finalMessage: AssistantMessage & { errorMessage?: string } = {
          role: "assistant",
          content: buildContent(),
          stopReason,
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage,
          timestamp: Date.now(),
        };
        if (result.is_error && typeof result.result === "string" && result.result.trim()) {
          finalMessage.errorMessage = result.result;
        }

        log.info(
          `emit done reason=${stopReason === "error" ? "error" : "stop"} content.len=${finalMessage.content.length} text_block=${finalMessage.content.some((c) => (c as { type?: string }).type === "text")}`,
        );
        stream.push({
          type: "done",
          reason: stopReason === "error" ? "error" : "stop",
          message: finalMessage,
        });
      } catch (err) {
        worker.off("stream_line", onStreamLine);
        log.error(`claude-code turn failed: ${formatErrorMessage(err)}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: formatErrorMessage(err),
            api: modelInfo.api,
            provider: modelInfo.provider,
            model: modelInfo.id,
            usage: buildUsage(undefined),
            timestamp: Date.now(),
          } as AssistantMessage & { stopReason: "error"; errorMessage: string },
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
