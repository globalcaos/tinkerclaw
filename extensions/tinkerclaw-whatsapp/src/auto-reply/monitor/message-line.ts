import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { getPrimaryIdentityId, getReplyContext, getSenderIdentity } from "../../identity.js";
import type { WebInboundMsg } from "../types.js";
import {
  formatInboundEnvelope,
  resolveMessagePrefix,
  type EnvelopeFormatOptions,
} from "./message-line.runtime.js";
import { prefetchSenderProfile } from "./people-prefetch.js";
import { prefetchRecentThread } from "./thread-prefetch.js";

// FORK 2026-05-04: people-profiles preamble. Two parts now:
//   (a) Sender's pre-resolved profile (name, role, manual context, rolling
//       summary, recent asks) — eliminates one mid-turn `people.resolve` round
//       trip and grounds the agent in who's writing.
//   (b) Tool-availability hint with the EXACT CLI invocations Jarvis uses to
//       look up *other* people referenced in the message body. Until 2026-05-04
//       he only had the abstract advice "call people.resolve" with no
//       indication of how — there are no `people.*` tools in his catalog;
//       the route is `openclaw gateway call`.
const PEOPLE_PROFILE_HINT = [
  "[people-profiles]",
  "For names mentioned in the body (other than the sender), look them up via:",
  '  openclaw gateway call people.resolve --params \'{"query":"<name>"}\'',
  '  openclaw gateway call people.read    --params \'{"slug":"<slug>"}\'',
  "Profile sections: Identity, Manual context, Rolling summary (~30d), Recent asks.",
  'Only say "I don\'t have context" after `people.resolve` returns null.',
].join("\n");

export function formatReplyContext(msg: WebInboundMsg) {
  const replyTo = getReplyContext(msg);
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

export function buildInboundLine(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  agentId: string;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
}) {
  const { cfg, msg, agentId, previousTimestamp, envelope } = params;
  // WhatsApp inbound prefix: channels.whatsapp.messagePrefix > legacy messages.messagePrefix > identity/defaults
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0,
  });
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext = formatReplyContext(msg);
  // FORK: prepend the people-profile hint to every WhatsApp inbound. Owner-
  // fromMe messages still get the hint+profile because the user's questions about
  // *other* people (e.g. "summarize the Xavi project") need the same grounding.
  const senderProfile = (() => {
    try {
      return prefetchSenderProfile({
        senderE164: msg.senderE164,
        senderJid: msg.senderJid,
      });
    } catch {
      // Prefetch failures must never break inbound processing.
      return null;
    }
  })();
  const senderProfileBlock = senderProfile ? `${senderProfile.block}\n\n` : "";
  // FORK 2026-05-04: also inline the last ~6 messages in this chat so the
  // agent has back-reference context without grepping the history DB.
  const threadBlock = (() => {
    try {
      const snippet = prefetchRecentThread({
        chatJid: msg.chatId || msg.from,
        beforeTimestamp: msg.timestamp,
        ownerLabel: msg.fromMe ? "the user" : "the user",
      });
      return snippet ? `${snippet}\n\n` : "";
    } catch {
      return "";
    }
  })();
  const peoplePreamble = `${PEOPLE_PROFILE_HINT}\n\n${senderProfileBlock}${threadBlock}`;
  const baseLine = `${peoplePreamble}${prefixStr}${msg.body}${replyContext ? `\n\n${replyContext}` : ""}`;
  const sender = getSenderIdentity(msg);

  // Wrap with standardized envelope for the agent.
  // For DMs: use senderE164 (who actually sent) instead of chat ID (who the conversation is with).
  // This distinguishes each sender in a shared DM (e.g. owner vs family member).
  const dmFrom = msg.senderE164 ?? msg.from?.replace(/^whatsapp:/, "");
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: msg.chatType === "group" ? msg.from : dmFrom,
    timestamp: msg.timestamp,
    body: baseLine,
    chatType: msg.chatType,
    sender: {
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.fromMe,
  });
}
