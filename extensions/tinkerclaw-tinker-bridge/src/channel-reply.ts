/**
 * FORK 2026-10-02 (channel-reply) — what a chat channel may receive from a coalesced turn.
 *
 * The narration contract (prompts/narration-contract.md) makes the model say one sentence
 * before every tool call. The bridge keeps all of a turn's prose in ONE text part
 * (`accumulatedText`) and records, per tool start, how many chars of it came before the tool
 * (`textOffset`). Tinker slices that text at the offsets and draws narration beside each tool
 * row. A chat channel got the whole text instead: on 2026-10-02 15:46 eleven narration
 * sentences glued to a trailing `NO_REPLY` went to a WhatsApp group, and 44 of 46 bridge
 * replies delivered to WhatsApp since 2026-09-01 opened with narration.
 *
 * The stored text never changes. For a non-webchat run the bridge stamps the final message
 * with `channelReply`, and the embedded runner (`src/fork/channel-reply.ts`, which owns the
 * reader and its validator) hands the payload builder the final segment, or the silent token,
 * instead of the whole text.
 */
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";

/** Same shape `src/fork/channel-reply.ts` validates; `textLength` pins it to one exact text. */
export type ChannelReplyStamp =
  | { kind: "silent"; textLength: number }
  | { kind: "final"; from: number; textLength: number };

export type ChannelReplySource =
  | "silent-final-segment"
  | "final-segment"
  | "no-tool-calls"
  | "no-narration"
  | "empty-final-segment";

export type ChannelReplyDecision = {
  verdict: "silent" | "final" | "whole";
  source: ChannelReplySource;
  /** Absent for `whole`: the channel gets the text exactly as before. */
  stamp?: ChannelReplyStamp;
  narrationChars: number;
  finalChars: number;
};

/** Tinker and the dashboard run as `webchat`; a run with no channel delivers nowhere. */
export function isChatChannelRun(channel: string | undefined): channel is string {
  return typeof channel === "string" && channel.length > 0 && channel !== "webchat";
}

/**
 * Splits the turn's text at the LAST tool start. Text after it is the answer; text before it
 * is narration. The silent check is the payload builder's own (`isSilentReplyPayloadText`), so
 * a final segment counts as silent exactly when a whole reply with that text would.
 */
export function decideChannelReply(params: {
  text: string;
  toolTextOffsets: readonly number[];
}): ChannelReplyDecision {
  const { text } = params;
  const offsets = params.toolTextOffsets.filter(
    (offset) => Number.isInteger(offset) && offset >= 0 && offset <= text.length,
  );
  if (offsets.length === 0) {
    return {
      verdict: "whole",
      source: "no-tool-calls",
      narrationChars: 0,
      finalChars: text.length,
    };
  }
  const from = Math.max(...offsets);
  const narration = text.slice(0, from);
  const finalSegment = text.slice(from);
  const sizes = { narrationChars: narration.length, finalChars: finalSegment.length };
  if (!narration.trim()) {
    return { verdict: "whole", source: "no-narration", ...sizes };
  }
  if (isSilentReplyPayloadText(finalSegment)) {
    return {
      verdict: "silent",
      source: "silent-final-segment",
      stamp: { kind: "silent", textLength: text.length },
      ...sizes,
    };
  }
  if (finalSegment.trim()) {
    return {
      verdict: "final",
      source: "final-segment",
      stamp: { kind: "final", from, textLength: text.length },
      ...sizes,
    };
  }
  return { verdict: "whole", source: "empty-final-segment", ...sizes };
}
