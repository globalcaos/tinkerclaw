/**
 * FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — resume an interrupted embedded turn
 * WITHOUT a prompt. pi-agent-core `Agent.continue()` picks the loop up from the transcript when the
 * last message is a user or tool-result message; this plans the messages so that holds:
 *   - a trailing aborted/empty assistant stub (an in-process restart aborting a held call) is
 *     dropped from the in-memory context;
 *   - a tool call the restart cut before its result is closed with an error result that says so,
 *     and the model decides whether to run it again (it is never re-run blindly);
 *   - a transcript that already ends in an answer is not continued (nothing was cut).
 * Pure: the caller persists `synthetic` before it continues, or a reload would find a tool call
 * with no result.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { STREAM_ERROR_FALLBACK_TEXT } from "../stream-message-shared.js";

type Block = { type?: string; id?: string; name?: string; text?: string };
type Msg = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  toolCallId?: string;
};

export type SyntheticToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  timestamp: number;
};

export type ContinuationPlan =
  | { ok: true; messages: AgentMessage[]; trimmed: number; synthetic: SyntheticToolResult[] }
  | { ok: false; reason: string };

export const CUT_TOOL_CALL_TEXT =
  "Not completed: a gateway restart stopped this tool call before it returned. " +
  "Check whether its effect is already in place before running it again.";

function blocks(m: Msg): Block[] {
  return Array.isArray(m.content) ? (m.content as Block[]) : [];
}

/**
 * A failed turn that produced nothing. Its only text may be the placeholder session-file repair and
 * replay normalization put into an empty error turn (stream-message-shared.ts): measured in a live
 * test 2026-09-30, where it made the plan read "ends in an assistant answer" and fall back.
 */
function isEmptyFailedStub(m: Msg): boolean {
  if (m.role !== "assistant" || (m.stopReason !== "aborted" && m.stopReason !== "error")) {
    return false;
  }
  return !blocks(m).some((b) => {
    if (b.type === "toolCall" || b.type === "tool_use") {
      return true;
    }
    const text = b.type === "text" ? (b.text ?? "").trim() : "";
    return text !== "" && text !== STREAM_ERROR_FALLBACK_TEXT;
  });
}

export function planContinuation(
  messages: AgentMessage[],
  now: number = Date.now(),
): ContinuationPlan {
  let end = messages.length;
  while (end > 0 && isEmptyFailedStub(messages[end - 1] as Msg)) {
    end -= 1;
  }
  if (end === 0) {
    return { ok: false, reason: "nothing to continue from" };
  }
  const trimmed = messages.length - end;
  let base = trimmed > 0 ? messages.slice(0, end) : messages;

  // Tool calls of the LAST assistant message that have no result after it.
  let lastAssistant = -1;
  for (let i = base.length - 1; i >= 0; i -= 1) {
    if ((base[i] as Msg).role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const synthetic: SyntheticToolResult[] = [];
  if (lastAssistant >= 0) {
    const answered = new Set(
      base
        .slice(lastAssistant + 1)
        .flatMap((m) => ((m as Msg).role === "toolResult" ? [(m as Msg).toolCallId] : [])),
    );
    for (const b of blocks(base[lastAssistant] as Msg)) {
      if ((b.type === "toolCall" || b.type === "tool_use") && b.id && !answered.has(b.id)) {
        synthetic.push({
          role: "toolResult",
          toolCallId: b.id,
          toolName: b.name ?? "unknown",
          content: [{ type: "text", text: CUT_TOOL_CALL_TEXT }],
          isError: true,
          timestamp: now,
        });
      }
    }
  }
  if (synthetic.length > 0) {
    base = [...base, ...(synthetic as unknown as AgentMessage[])];
  }
  // FORK 2026-10-05: the tail is the last message that is not `custom`. pi appends a turn's
  // runtime-context custom message right after its prompt, and convertToLlm sends a custom message
  // as user context, so [user][custom] is an unanswered prompt. A custom message after an answer
  // still ends in that answer.
  let tail = base.length - 1;
  while (tail >= 0 && (base[tail] as Msg).role === "custom") {
    tail -= 1;
  }
  const tailRole = tail >= 0 ? (base[tail] as Msg).role : undefined;
  if (tailRole !== "user" && tailRole !== "toolResult") {
    return { ok: false, reason: "the transcript ends in an assistant answer" };
  }
  return { ok: true, messages: base, trimmed, synthetic };
}
