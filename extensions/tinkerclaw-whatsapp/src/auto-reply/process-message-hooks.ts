/**
 * FORK: Process-message hooks for the tinkerclaw-whatsapp plugin.
 *
 * - annotateOfflineRecovery: prepends advisory annotation to offline-recovered messages
 * - createThinkingReaction: WhatsApp progress indicator (alternating emoji reactions)
 *
 * The thinking reaction is copied from the upstream whatsapp extension
 * (extensions/whatsapp/src/auto-reply/monitor/thinking-reaction.ts) because
 * re-exporting from outside the plugin boundary is fragile.
 */

import { sendReactionWhatsApp } from "../send.js";

// ---------------------------------------------------------------------------
// Hook: Offline recovery annotation
// ---------------------------------------------------------------------------

/**
 * Prepend an advisory annotation to messages recovered while offline,
 * telling the agent to batch-review before acting.
 */
export function annotateOfflineRecovery(
  body: string,
  isOfflineRecovery: boolean | undefined,
  timestamp: number | undefined,
): string {
  if (!isOfflineRecovery) {
    return body;
  }
  const ageMs = timestamp ? Date.now() - timestamp : undefined;
  const ageLabel = ageMs != null ? `${Math.round(ageMs / 60_000)} minutes` : "unknown time";
  return (
    `[OFFLINE RECOVERY — This message was sent ${ageLabel} ago while you were offline. ` +
    `Read ALL recovered messages before responding. Do NOT act on each one individually. ` +
    `Summarize what was missed, acknowledge receipt, and ask for confirmation before taking action.]\n` +
    body
  );
}

// ---------------------------------------------------------------------------
// Hook: Thinking reaction (WhatsApp progress indicator)
// ---------------------------------------------------------------------------

const THINKING_EMOJIS = ["🤔", "🧐"] as const;
const HEARTBEAT_INTERVAL_MS = 1000;

export type ThinkingReactionContext = {
  messageId?: string;
  chatId?: string;
  senderJid?: string;
  accountId?: string;
};

export type ThinkingReactionController = {
  /** Start the alternating emoji heartbeat. Safe to call multiple times (idempotent). */
  start: () => void;
  /** Stop the heartbeat and remove the reaction. Safe to call multiple times (idempotent). */
  stop: () => void;
};

/**
 * Create a thinking reaction controller for a single inbound message.
 * Alternates between emoji reactions every ~1s as a visual heartbeat.
 * If the emoji stops toggling, the user knows processing hung.
 */
export function createThinkingReaction(ctx: ThinkingReactionContext): ThinkingReactionController {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let emojiIndex = 0;

  const react = (emoji: string) => {
    if (!ctx.messageId || !ctx.chatId) {
      return;
    }
    sendReactionWhatsApp(ctx.chatId, ctx.messageId, emoji, {
      verbose: false,
      fromMe: false,
      participant: ctx.senderJid,
      accountId: ctx.accountId,
    }).catch(() => {});
  };

  const start = () => {
    if (running || !ctx.messageId || !ctx.chatId) {
      return;
    }
    running = true;
    emojiIndex = 0;
    react(THINKING_EMOJIS[0]);
    timer = setInterval(() => {
      emojiIndex = (emojiIndex + 1) % THINKING_EMOJIS.length;
      react(THINKING_EMOJIS[emojiIndex]);
    }, HEARTBEAT_INTERVAL_MS);
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
    react("");
  };

  return { start, stop };
}
