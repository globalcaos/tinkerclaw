/**
 * Thinking Reaction — visible progress indicator for WhatsApp groups.
 *
 * WhatsApp linked devices (Baileys) cannot show typing indicators in groups
 * (see https://github.com/WhiskeySockets/Baileys/issues/866).
 * This module provides a workaround: react with 🤔 when processing starts,
 * and remove the reaction when the reply is delivered.
 *
 * FORK-ISOLATED: This file is unique to our fork. Upstream will never touch it,
 * so merges are conflict-free. The integration points in process-message.ts are
 * minimal (two function calls).
 */

import { sendReactionWhatsApp } from "../../outbound.js";

const THINKING_EMOJIS = ["🤔", "🧐"] as const;
const HEARTBEAT_INTERVAL_MS = 1000;

export type ThinkingReactionContext = {
  messageId?: string;
  chatId?: string;
  senderJid?: string;
  accountId?: string;
};

export type ThinkingReactionController = {
  /** Start the alternating 🤔↔🧐 heartbeat. Safe to call multiple times (idempotent). */
  start: () => void;
  /** Stop the heartbeat and remove the reaction. Safe to call multiple times (idempotent). */
  stop: () => void;
};

/**
 * Create a thinking reaction controller for a single inbound message.
 * Alternates between 🤔 and 🧐 every ~1s as a visual heartbeat.
 * If the emoji stops toggling, the user knows processing hung.
 */
export function createThinkingReaction(ctx: ThinkingReactionContext): ThinkingReactionController {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let emojiIndex = 0;

  const react = (emoji: string) => {
    if (!ctx.messageId || !ctx.chatId) {return;}
    sendReactionWhatsApp(ctx.chatId, ctx.messageId, emoji, {
      verbose: false,
      fromMe: false,
      participant: ctx.senderJid,
      accountId: ctx.accountId,
    }).catch(() => {});
  };

  const start = () => {
    if (running || !ctx.messageId || !ctx.chatId) {return;}
    running = true;
    emojiIndex = 0;
    react(THINKING_EMOJIS[0]);
    timer = setInterval(() => {
      emojiIndex = (emojiIndex + 1) % THINKING_EMOJIS.length;
      react(THINKING_EMOJIS[emojiIndex]);
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stop = () => {
    if (!running) {return;}
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    react("");
  };

  return { start, stop };
}
