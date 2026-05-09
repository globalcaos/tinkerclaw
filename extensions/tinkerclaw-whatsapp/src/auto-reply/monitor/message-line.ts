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

/**
 * FORK 2026-05-09: thread-escalation hint. The `[recent-thread]` block
 * eagerly inlines the last ~6 messages of the current chat. When the question
 * needs older or wider context (mentioned-but-not-shown people, weeks-old
 * recommendations, cross-chat lookups), Jarvis must escalate via the
 * `whatsapp_history` tool. This hint hands him the exact `until` cursor and
 * tool shape so he doesn't have to re-derive them.
 *
 * Rendered with the chat JID + the oldest timestamp shown in the
 * `[recent-thread]` block (ISO-8601 UTC). When no `[recent-thread]` is
 * present (no prior history), `<oldest_ts>` falls back to the inbound's own
 * timestamp.
 */
function buildThreadEscalationHint(params: { chatJid: string; oldestUnixSec: number }): string {
  const oldestIso = new Date(params.oldestUnixSec * 1000).toISOString();
  return [
    "[thread-escalation]",
    "If the [recent-thread] block above doesn't cover what the user is asking about,",
    "read further back in this chat by calling the `whatsapp_history` tool:",
    `  action="search", chat="${params.chatJid}", until="${oldestIso}", limit=20`,
    "Repeat with progressively older `until` values until you have enough context, or",
    "until the messages are no longer relevant to the question. For cross-chat lookups,",
    'add `query="<keyword>"` (full-text search across all chats).',
    "Default to escalating once before answering when the user references something",
    'not in the prelude (e.g. "ese libro", "lo que dije ayer", "el plan que comentamos").',
    "[/thread-escalation]",
  ].join("\n");
}

export function formatReplyContext(msg: WebInboundMsg) {
  const replyTo = getReplyContext(msg);
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

/**
 * Build the agent-facing prelude for an inbound WhatsApp message.
 *
 * Composition (top to bottom):
 *   1. `[people-profiles]` static hint — how to look up names referenced in the body.
 *   2. `[sender-profile slug=…]…[/sender-profile]` — pre-resolved profile of the sender (when known).
 *   3. `[recent-thread last=N]…[/recent-thread]` — last ~6 messages of this chat, oldest-first.
 *   4. `[thread-escalation]` hint — exact `whatsapp_history` tool call to read further back.
 *
 * Each block is appended only when its prefetch yields content. Trailing blank
 * lines separate blocks. The function never throws — prefetch failures
 * collapse to empty sections.
 *
 * Designed to be prepended directly to `BodyForAgent` in process-message.ts.
 * NOT wrapped in `formatInboundEnvelope` — that wrap is for the legacy `Body`
 * (echo detection, fan-out history rendering); the prelude rides the modern
 * `BodyForAgent` path that the LLM actually consumes.
 */
export function buildInboundPrelude(params: { msg: WebInboundMsg }): string {
  const { msg } = params;
  const senderProfile = (() => {
    try {
      return prefetchSenderProfile({
        senderE164: msg.senderE164,
        senderJid: msg.senderJid,
      });
    } catch {
      return null;
    }
  })();
  const senderProfileBlock = senderProfile ? `${senderProfile.block}\n\n` : "";

  const chatJid = msg.chatId || msg.from;
  const recent = (() => {
    try {
      return prefetchRecentThread({
        chatJid,
        beforeTimestamp: msg.timestamp,
        ownerLabel: msg.fromMe ? "Owner" : "Owner",
      });
    } catch {
      return null;
    }
  })();
  const threadBlock = recent ? `${recent.block}\n\n` : "";

  const oldestUnixSec =
    recent?.oldestUnixSec ??
    (msg.timestamp ? Math.floor(msg.timestamp / 1000) : Math.floor(Date.now() / 1000));
  const escalationBlock = `${buildThreadEscalationHint({ chatJid, oldestUnixSec })}\n\n`;

  return `${PEOPLE_PROFILE_HINT}\n\n${senderProfileBlock}${threadBlock}${escalationBlock}`;
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
  // FORK 2026-05-09: share the prelude builder with process-message so the
  // BodyForAgent path receives the same blocks. The legacy envelope-shaped
  // Body keeps its peoplePreamble for echo detection / fan-out history.
  const peoplePreamble = buildInboundPrelude({ msg });
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
