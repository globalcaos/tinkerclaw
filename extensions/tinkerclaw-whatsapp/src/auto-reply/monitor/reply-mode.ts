/**
 * FORK 2026-05-20: WhatsApp inbound `[reply-mode]` prelude block.
 *
 * Until 2026-05-20 the prelude told Jarvis WHO sent the message but never
 * WHO will read his reply. That caused the second DM context bug: Jarvis
 * answered "do you want me to email it to you?" inside a draft going out
 * verbatim to a third party. From the LLM's seat the conversation looked
 * like the owner asking a question; from the WhatsApp wire the answer was being
 * piped straight to the contact.
 *
 * This module derives an unambiguous reply-mode tag from message flags and
 * renders a hard-edge block at the top of the prelude so subsequent
 * generation is grounded:
 *
 *   • outbound-draft         — the owner typed in this chat with the trigger
 *                              prefix; reply is a message the owner wants sent
 *                              to the contact.
 *   • outbound-auto-reply    — contact wrote, Jarvis is auto-replying on
 *                              the owner's behalf; reply goes to the contact.
 *   • owner-management       — the owner is talking to Jarvis privately (the
 *                              owner self-chat / management channel); reply
 *                              stays between the owner and Jarvis. The current
 *                              code path detects this via the
 *                              `isOwnerSelfChat` flag (true when senderJid
 *                              equals selfJid or chatJid equals selfLid).
 */

import type { WebInboundMessage } from "../../inbound/types.js";

export type ReplyMode = "outbound-draft" | "outbound-auto-reply" | "owner-management";

function detectOwnerSelfChat(msg: WebInboundMessage): boolean {
  const sj = msg.senderJid;
  if (sj && msg.selfJid && sj === msg.selfJid) {
    if (msg.chatId === msg.senderJid || msg.from === msg.senderJid) {
      return true;
    }
  }
  if (msg.selfLid && msg.chatId === msg.selfLid) {
    return true;
  }
  return false;
}

export function deriveReplyMode(msg: WebInboundMessage): ReplyMode {
  if (detectOwnerSelfChat(msg)) {
    return "owner-management";
  }
  if (msg.fromMe && msg.ownerPrefixTriggered) {
    return "outbound-draft";
  }
  return "outbound-auto-reply";
}

export function buildReplyModeBlock(params: {
  mode: ReplyMode;
  recipientName: string | null;
  recipientPhone: string | null;
}): string {
  const recipient = params.recipientName ?? params.recipientPhone ?? "the chat partner";

  const lines: string[] = ["[reply-mode]"];
  lines.push(`mode: ${params.mode}`);
  switch (params.mode) {
    case "owner-management":
      lines.push(`recipient: the owner (owner self-chat)`);
      lines.push(`Your reply stays private between you and the owner. Meta-questions,`);
      lines.push(`internal reasoning, and follow-up offers ("want me to send X?") are fine here.`);
      break;
    case "outbound-draft":
      lines.push(`recipient: ${recipient}`);
      lines.push(`The owner addressed you in his chat with ${recipient}. Your reply is the`);
      lines.push(
        `message that will be sent verbatim to ${recipient} through the owner's WhatsApp.`,
      );
      lines.push(`Write the deliverable directly (a polished message addressed to ${recipient}),`);
      lines.push(
        `NOT a meta-discussion with the owner. Do not ask the owner "want me to send this?" —`,
      );
      lines.push(`whatever you write IS what gets sent. If you need a clarification, ask`);
      lines.push(`${recipient} in-message, not the owner.`);
      break;
    case "outbound-auto-reply":
      lines.push(`recipient: ${recipient}`);
      lines.push(`You are auto-replying on the owner's behalf to ${recipient}. Your reply will`);
      lines.push(`be sent verbatim through the owner's WhatsApp. Do not address the owner with`);
      lines.push(`meta-questions; write the message ${recipient} should receive.`);
      break;
  }
  lines.push("[/reply-mode]");
  return lines.join("\n");
}
