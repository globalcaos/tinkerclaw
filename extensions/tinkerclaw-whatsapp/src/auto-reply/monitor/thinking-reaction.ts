/**
 * Thinking Reaction — visible progress indicator for WhatsApp.
 *
 * Alternates between two emojis (default 🤔↔🧐) on the inbound message every
 * ~1s while Jarvis processes, then sets a final "done" emoji (default ⚡) when
 * the reply is delivered. Gives the user immediate visual feedback that the
 * agent received the message AND that it's still working (heartbeat pattern).
 *
 * FORK-ISOLATED: This file is unique to our fork. Upstream will never touch it,
 * so merges are conflict-free. The integration points in process-message.ts are
 * minimal (two function calls).
 *
 * Defaults can be changed in two places (cloner-friendly):
 *   1. Code constants below (DEFAULT_THINKING_EMOJIS / DEFAULT_THINKING_FINAL_EMOJI).
 *   2. Per-deployment config — `channels.whatsapp.thinkingReaction` in
 *      `~/.openclaw/openclaw.json`. Recommended path; survives upstream merges.
 */

import { sendReactionWhatsApp } from "../../send.js";
// FORK 2026-05-04: sendReactionWhatsApp requires `cfg` in options; without
// it, requireRuntimeConfig() throws synchronously and the .catch in react()
// silently swallows. Fetch live config so heartbeat actually fires.
import { getRuntimeConfig } from "../config.runtime.js";

/**
 * Defaults — the heartbeat alternates between two emojis. The persona half is
 * resolved at `start()` time from `messagePrefix` (see `outbound-prefix.ts`)
 * so changing the icon flips the heartbeat too. Override the heartbeat
 * primary emoji and interval via `channels.whatsapp.thinkingReaction.{primaryEmoji,intervalMs}`
 * in openclaw.json — by default we use 🤔 paired with the persona icon (🤖).
 */
export const DEFAULT_THINKING_INTERVAL_MS = 1000;
/**
 * On stop(), the reaction is CLEARED (empty string) rather than left as a
 * "done" emoji. The "done" signal is delivered as a separate text message —
 * see `resolveDoneSeparator` in outbound-prefix.ts and `deliverWebReply` in
 * deliver-reply.ts.
 */
export const DEFAULT_THINKING_FINAL_EMOJI = "";

export type ThinkingReactionContext = {
  messageId?: string;
  chatId?: string;
  senderJid?: string;
  accountId?: string;
  /** Optional override for the alternating emojis. */
  emojis?: readonly string[];
  /** Optional override for the heartbeat interval (ms). */
  intervalMs?: number;
  /** Optional override for the final emoji applied on stop(). */
  finalEmoji?: string;
};

export type ThinkingReactionController = {
  /** Start the alternating heartbeat. Idempotent. */
  start: () => void;
  /** Stop the heartbeat and apply the final emoji (or clear if empty). Idempotent. */
  stop: () => void;
};

/**
 * Create a thinking reaction controller for a single inbound message.
 */
export function createThinkingReaction(ctx: ThinkingReactionContext): ThinkingReactionController {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let emojiIndex = 0;
  // FORK 2026-05-04: emojis MUST be supplied by caller (process-message.ts
  // resolves them via resolveThinkingEmojis using the live persona icon).
  // No hardcoded fallback here — falling back would defeat the
  // "icon-changes-everywhere" property.
  const emojis = ctx.emojis && ctx.emojis.length > 0 ? ctx.emojis : ["🤔", "🤖"];
  const intervalMs = ctx.intervalMs ?? DEFAULT_THINKING_INTERVAL_MS;
  const finalEmoji = ctx.finalEmoji ?? DEFAULT_THINKING_FINAL_EMOJI;

  const react = (emoji: string) => {
    if (!ctx.messageId || !ctx.chatId) {
      return;
    }
    let cfg;
    try {
      cfg = getRuntimeConfig();
    } catch (err) {
      console.log(
        `[thinking-reaction] react: getRuntimeConfig threw: ${String(err).slice(0, 200)}`,
      );
      return;
    }
    sendReactionWhatsApp(ctx.chatId, ctx.messageId, emoji, {
      verbose: false,
      fromMe: false,
      participant: ctx.senderJid,
      accountId: ctx.accountId,
      cfg,
    }).catch((err) => {
      console.log(
        `[thinking-reaction] react send failed (emoji=${JSON.stringify(emoji)}, chat=${ctx.chatId}): ${String(err).slice(0, 200)}`,
      );
    });
  };

  const start = () => {
    if (running || !ctx.messageId || !ctx.chatId) {
      return;
    }
    running = true;
    emojiIndex = 0;
    console.log(
      `[thinking-reaction] start chat=${ctx.chatId} msgId=${ctx.messageId} interval=${intervalMs}ms emojis=${emojis.join(",")}`,
    );
    react(emojis[0]);
    timer = setInterval(() => {
      emojiIndex = (emojiIndex + 1) % emojis.length;
      react(emojis[emojiIndex]);
    }, intervalMs);
  };

  const stop = () => {
    if (!running) {
      return;
    }
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    console.log(
      `[thinking-reaction] stop chat=${ctx.chatId} msgId=${ctx.messageId} final=${JSON.stringify(finalEmoji)}`,
    );
    react(finalEmoji);
  };

  return { start, stop };
}
