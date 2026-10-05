/**
 * FORK 2026-10-02 (channel-reply) — the runner side of the cc-bridge's `channelReply` stamp.
 *
 * The bridge coalesces a whole tool-loop turn (one narration sentence before each tool call,
 * then the answer) into ONE text part. Tinker splits it at the recorded tool offsets; a chat
 * channel used to receive all of it, narration first. For a non-webchat run the bridge stamps
 * its final message (extensions/tinkerclaw-tinker-bridge/src/channel-reply.ts) and the runner
 * passes the payload builder the final segment, or the silent token, in place of the whole
 * text. The message itself, and so the transcript, is left as it is.
 */
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

export type ChannelReplyStamp =
  | { kind: "silent"; textLength: number }
  | { kind: "final"; from: number; textLength: number };

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function readChannelReplyStamp(message: unknown): ChannelReplyStamp | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const stamp = (message as { channelReply?: unknown }).channelReply;
  if (!stamp || typeof stamp !== "object") {
    return undefined;
  }
  const { kind, from, textLength } = stamp as Record<string, unknown>;
  if (kind === "silent" && isLength(textLength)) {
    return { kind, textLength };
  }
  if (kind === "final" && isLength(from) && isLength(textLength) && from <= textLength) {
    return { kind, from, textLength };
  }
  return undefined;
}

function assistantTextOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export type ChannelReplyResolution = {
  assistantTexts: string[];
  /** Absent: no stamp, the texts are passed through untouched. */
  applied?: "silent" | "final" | "length-mismatch";
};

/**
 * The texts the payload builder should see for this attempt. `assistant` must be the CURRENT
 * attempt's message: a stamp on an older message says nothing about this one. A stamp whose
 * `textLength` no longer matches the message's text is ignored, because its offset would cut
 * at the wrong place.
 */
export function resolveChannelReplyTexts(params: {
  assistantTexts: string[];
  assistant: unknown;
}): ChannelReplyResolution {
  const stamp = readChannelReplyStamp(params.assistant);
  if (!stamp) {
    return { assistantTexts: params.assistantTexts };
  }
  const text = assistantTextOf(params.assistant);
  if (text.length !== stamp.textLength) {
    return { assistantTexts: params.assistantTexts, applied: "length-mismatch" };
  }
  if (stamp.kind === "silent") {
    return { assistantTexts: [SILENT_REPLY_TOKEN], applied: "silent" };
  }
  return { assistantTexts: [text.slice(stamp.from)], applied: "final" };
}
